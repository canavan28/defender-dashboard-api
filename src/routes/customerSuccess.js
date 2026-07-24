// src/routes/customerSuccess.js
//
// Customer Success scoring — event-ledger model. Each client's score is
// 10 (base) + sum of all event deltas, no ceiling. Two kinds of events:
//   - System-generated (sla_breach, autotask_review) — cannot be deleted,
//     only corrected by re-sync.
//   - Manual (google_review, positive_tbr, negative_tbr, manual_adjustment)
//     — entered by an exec, requires a note. CONFIRMED: any exec with
//     Customer Success access can delete any manual entry, not just their own.
//
// SLA breach definition CONFIRMED against useTicketMetrics.js (matches both
// the SLA Health tab's top-line breach rate and the tech-grading SLA score):
//   eligible  = ticket has firstResponseDueDateTime
//   breached  = no firstResponseDateTime, OR firstResponseDateTime is later
//               than firstResponseDueDateTime
// No queue/company/priority exclusions apply here — those only affect the
// separate response-time scoring metric in tech grading, not this breach flag.

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { autotaskClient, getHeaders } = require('../utils/autotask');
// NOTE: verifyApiKey is NOT re-applied here — index.js already applies it
// globally to everything under /api via `app.use('/api', verifyApiKey)`,
// so req.user is guaranteed populated by the time these handlers run.

const router = express.Router();

const DATA_FILE = path.join('/app/data', 'csScores.json');
const BASE_SCORE = 10;
const PAGE_SLEEP_MS = 400; // pace paginated calls, mirrors sla.js's existing sleep() pattern

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let cache = null;

function loadData() {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    // Migrate away from the old single shared `lastSync` checkpoint (bug:
    // it advanced even when a step failed, so a failed step would silently
    // skip its missed window on the next run instead of retrying it).
    // Deliberately NOT carrying the old value forward — dropping it forces
    // one full trailing-12-month re-pull to backfill whatever was missed,
    // then per-step checkpoints take over cleanly from there.
    if ('lastSync' in parsed) {
      delete parsed.lastSync;
    }
    parsed.lastSyncSlaBreaches = parsed.lastSyncSlaBreaches || null;
    parsed.lastSyncSurveys = parsed.lastSyncSurveys || null;
    cache = parsed;
  } catch (err) {
    cache = { clients: {}, lastSyncSlaBreaches: null, lastSyncSurveys: null };
  }
  return cache;
}

function saveData(data) {
  cache = data;
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function ensureClient(data, companyId, companyName) {
  const key = String(companyId);
  if (!data.clients[key]) {
    data.clients[key] = { companyId: key, companyName: companyName || null, events: [] };
  }
  if (companyName) data.clients[key].companyName = companyName;
  return data.clients[key];
}

function computeScore(client) {
  return BASE_SCORE + client.events.reduce((sum, e) => sum + e.delta, 0);
}

function dedupeExists(client, type, sourceKey, sourceValue) {
  return client.events.some(
    (e) => e.type === type && e.source && e.source[sourceKey] === sourceValue
  );
}

// Piecewise-linear survey rating -> points. Confirmed with Matt:
// 1=-2, 2=-1, 3=-1, 4=0, 5=+1. Handles decimal surveyRating values
// (e.g. 4.33) by interpolating within the relevant segment.
const SURVEY_CURVE = [
  { rating: 1, points: -2 },
  { rating: 2, points: -1 },
  { rating: 3, points: -1 },
  { rating: 4, points: 0 },
  { rating: 5, points: 1 },
];

function surveyRatingToPoints(rating) {
  const r = Math.max(1, Math.min(5, rating));
  for (let i = 0; i < SURVEY_CURVE.length - 1; i++) {
    const a = SURVEY_CURVE[i];
    const b = SURVEY_CURVE[i + 1];
    if (r >= a.rating && r <= b.rating) {
      const frac = (r - a.rating) / (b.rating - a.rating);
      return a.points + frac * (b.points - a.points);
    }
  }
  return 0;
}

// Follows AutoTask's pageDetails.nextPageUrl pagination, paced with a
// short sleep between pages to stay under rate limits. CONFIRMED against
// this instance (zone webservices14): despite AutoTask's general docs
// saying GET works for nextPageUrl continuation, this zone returns
// 405 "does not support http method 'GET'" — POST is required instead.
// The paging state is already encoded in the URL's querystring, so an
// empty body is sufficient.
async function queryAll(entity, body) {
  let items = [];
  const first = await autotaskClient.post(`/${entity}/query`, body);
  items = items.concat(first.data.items || []);
  let nextUrl = first.data.pageDetails?.nextPageUrl;
  while (nextUrl) {
    await sleep(PAGE_SLEEP_MS);
    const pageRes = await axios.post(nextUrl, {}, { headers: getHeaders() });
    items = items.concat(pageRes.data.items || []);
    nextUrl = pageRes.data.pageDetails?.nextPageUrl;
  }
  return items;
}

function trailing12MonthsISO() {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  return d.toISOString();
}

// Extracts full diagnostic detail from an AutoTask API error. The debug
// interceptor in autotask.js only logs response bodies for 429/500 — this
// makes sure errors of ANY status (like the 405 we hit on first sync) show
// up with enough detail to actually diagnose, instead of axios's generic
// "Request failed with status code X".
function describeAutotaskError(err) {
  return {
    message: err.message,
    status: err.response?.status,
    url: err.config?.url,
    method: err.config?.method,
    data: err.response?.data,
  };
}

// GET /api/customer-success/scores — summary list, all clients
router.get('/scores', (req, res) => {
  const data = loadData();
  const summary = Object.values(data.clients).map((c) => ({
    companyId: c.companyId,
    companyName: c.companyName,
    score: computeScore(c),
    eventCount: c.events.length,
  }));
  res.json(summary);
});

// GET /api/customer-success/scores/:companyId — full ledger for one client
router.get('/scores/:companyId', (req, res) => {
  const data = loadData();
  const client = data.clients[req.params.companyId];
  if (!client) return res.status(404).json({ error: 'No score record for this client yet' });
  res.json({ ...client, score: computeScore(client) });
});

// POST /api/customer-success/scores/:companyId/events — manual entry
// body: { type: 'google_review'|'positive_tbr'|'negative_tbr'|'manual_adjustment', delta: number, note: string, companyName?: string }
router.post('/scores/:companyId/events', (req, res) => {
  const { type, delta, note, companyName } = req.body;
  const enteredBy = req.user?.oid || null;

  const allowedManualTypes = ['google_review', 'positive_tbr', 'negative_tbr', 'manual_adjustment'];
  if (!allowedManualTypes.includes(type)) {
    return res.status(400).json({ error: `type must be one of ${allowedManualTypes.join(', ')}` });
  }
  if (typeof delta !== 'number' || Number.isNaN(delta)) {
    return res.status(400).json({ error: 'delta must be a number' });
  }
  if (!note || !note.trim()) {
    return res.status(400).json({ error: 'note is required for manual entries' });
  }

  const data = loadData();
  const client = ensureClient(data, req.params.companyId, companyName);
  client.events.push({
    id: `evt_${randomUUID()}`,
    type,
    delta,
    date: new Date().toISOString(),
    enteredBy,
    note,
  });
  saveData(data);
  res.json({ ...client, score: computeScore(client) });
});

// DELETE /api/customer-success/scores/:companyId/events/:eventId
// Confirmed: any exec with Customer Success access can delete any manual
// entry, not just their own. System-generated events (enteredBy === null)
// cannot be deleted here — they only get corrected by re-running /sync.
router.delete('/scores/:companyId/events/:eventId', (req, res) => {
  const data = loadData();
  const client = data.clients[req.params.companyId];
  if (!client) return res.status(404).json({ error: 'No score record for this client' });
  const idx = client.events.findIndex((e) => e.id === req.params.eventId);
  if (idx === -1) return res.status(404).json({ error: 'Event not found' });
  if (client.events[idx].enteredBy === null) {
    return res.status(400).json({ error: 'System-generated events cannot be deleted manually — correct via re-sync instead' });
  }
  client.events.splice(idx, 1);
  saveData(data);
  res.json({ ...client, score: computeScore(client) });
});

// POST /api/customer-success/sync — pulls SLA breaches + AutoTask survey
// results since each step's own last-successful-run checkpoint, appends
// system-generated events.
router.post('/sync', async (req, res) => {
  const data = loadData();
  const errors = [];
  const overrideSince = req.body?.since; // manual override, if provided, applies to both steps

  // First-ever sync (no checkpoint yet) defaults to trailing 12 months,
  // matching the Finance pillar's confirmed reporting window — not all-time,
  // to avoid pulling years of tickets/surveys in one shot.
  const slaSince = overrideSince || data.lastSyncSlaBreaches || trailing12MonthsISO();
  const surveySince = overrideSince || data.lastSyncSurveys || trailing12MonthsISO();

  // --- SLA breaches ---
  // Matches useTicketMetrics.js exactly: eligible = has firstResponseDueDateTime;
  // breached = no firstResponseDateTime, or it's later than the due date.
  // Filtered incrementally by createDate (ticket creation), same field the
  // rest of the dashboard uses for quarterly bucketing.
  // NEEDS VERIFICATION: the 'exist' filter operator below — confirm AutoTask's
  // REST API actually supports this op name (some AutoTask docs list it as
  // 'exist'/'notExist', but this hasn't been tested against your instance).
  // Also note: filtering by createDate means a ticket created just before
  // "since" whose due date only lapses after "since" could be missed on a
  // given incremental run — low-risk in practice since due dates are usually
  // set within the same day as creation, but flagging the tradeoff.
  let slaBreachesOk = false;
  try {
    const tickets = await queryAll('Tickets', {
      filter: [
        { field: 'createDate', op: 'gte', value: slaSince },
        { field: 'firstResponseDueDateTime', op: 'exist' },
      ],
    });
    for (const ticket of tickets) {
      if (!ticket.companyID) continue;
      const breached =
        !ticket.firstResponseDateTime ||
        new Date(ticket.firstResponseDateTime) > new Date(ticket.firstResponseDueDateTime);
      if (!breached) continue;

      const client = ensureClient(data, ticket.companyID);
      if (dedupeExists(client, 'sla_breach', 'ticketId', ticket.id)) continue;
      client.events.push({
        id: `evt_${randomUUID()}`,
        type: 'sla_breach',
        delta: -1,
        date: ticket.createDate,
        source: { ticketId: ticket.id },
        enteredBy: null,
      });
    }
    slaBreachesOk = true;
  } catch (err) {
    errors.push({ step: 'sla_breaches', since: slaSince, ...describeAutotaskError(err) });
  }

  // --- AutoTask survey results ---
  let surveysOk = false;
  try {
    const surveyResults = await queryAll('SurveyResults', {
      filter: [{ field: 'completeDate', op: 'gte', value: surveySince }],
    });
    for (const result of surveyResults) {
      if (result.surveyRating == null || !result.companyID) continue;
      const client = ensureClient(data, result.companyID);
      if (dedupeExists(client, 'autotask_review', 'surveyResultId', result.id)) continue;
      client.events.push({
        id: `evt_${randomUUID()}`,
        type: 'autotask_review',
        delta: surveyRatingToPoints(result.surveyRating),
        date: result.completeDate,
        source: { ticketId: result.ticketID, surveyResultId: result.id, rating: result.surveyRating },
        enteredBy: null,
      });
    }
    surveysOk = true;
  } catch (err) {
    errors.push({ step: 'autotask_survey', since: surveySince, ...describeAutotaskError(err) });
  }

  // Only advance a step's checkpoint if it actually succeeded — a failed
  // step must retry its full original window next time, not silently skip
  // ahead to "now". This is the exact bug that caused the first successful
  // sync to only look back a couple minutes instead of the full 12 months.
  const now = new Date().toISOString();
  if (slaBreachesOk) data.lastSyncSlaBreaches = now;
  if (surveysOk) data.lastSyncSurveys = now;

  saveData(data);
  res.json({ ok: true, errors });
});

module.exports = router;