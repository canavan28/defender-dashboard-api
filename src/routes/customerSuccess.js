// src/routes/customerSuccess.js
//
// Customer Success scoring — event ledger, revised in Phase 2 (Nov 2026).
//
// SCORE = 10 (base)
//       + SLA breaches × -0.25
//       + survey points (positive total capped at +10; negatives uncapped)
//       + manual entries
// Everything counts over a ROLLING 12-MONTH window: breaches, surveys and
// manual entries all stop counting a year after their date. No floor —
// scores can go negative (deliberately, until the real spread is reviewed).
//
// SYSTEM events (sla_breach, autotask_review) are REBUILT FROM SCRATCH on
// every sync over the trailing 12 months. The old sync appended events and
// never revisited them, which caused the -57 scores: a ticket that hadn't
// been answered yet at sync time got recorded as a breach forever, nothing
// ever expired, and every queue (alerts, sales, merged…) counted.
//
// MANUAL events (google_review, positive_tbr, negative_tbr,
// manual_adjustment) stay in the ledger permanently for history, but only
// count toward the score while they're under 12 months old. Any exec with
// Customer Success access can delete any manual entry.
//
// SLA breach rules (confirmed with Matt):
//   - breached = first response came after the due time, OR no first
//     response yet AND the due time has already passed
//   - RMM Resolved (status 20) never counts
//   - only these queues count: Client Portal, Support, Triage, After Hours,
//     Olaro Group. Excluded: Monitoring Alert, SaaS Alerts, Merged, Internal
//     Projects, Sales, Web Development, Co-Managed, Account Manager,
//     OnBoarding, Management, Hardware as a Service.
// Excluded companies: 0 (InfoTank internal), 344 (NJC), 626 ("Unspecified"
// placeholder), plus anything classified Web Dev (classification 19).

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { autotaskClient, getHeaders } = require('../utils/autotask');
const { requireOwner } = require('../middleware/auth');
// verifyApiKey is applied globally to /api in index.js, so req.user is set.

const router = express.Router();

const DATA_FILE = path.join('/app/data', 'csScores.json');
const PAGE_SLEEP_MS = 400;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Scoring rules ────────────────────────────────────────────────────────────
const BASE_SCORE = 10;
const BREACH_DELTA = -0.25;
const SURVEY_POSITIVE_CAP = 10;
const WINDOW_MONTHS = 12;

const QUEUE_NAMES = {
  5: 'Client Portal', 6: 'OnBoarding', 8: 'Monitoring Alert', 29682833: 'Support',
  29683378: 'InfoTank Internal Projects', 29683479: 'Merged Tickets', 29683480: 'Sales',
  29683481: 'Web Development', 29683482: 'Triage', 29683487: 'Co-Managed',
  29683491: 'Account Manager', 29683492: 'Management', 29683493: 'Hardware as a Service',
  29683494: 'SaaS Alerts', 29683496: 'After Hours', 29683497: 'Olaro Group',
};
const COUNTED_QUEUES = new Set([5, 29682833, 29683482, 29683496, 29683497]);
const RMM_RESOLVED_STATUS = 20;

const EXCLUDE_CS_COMPANIES = new Set([0, 344, 626]);
const WEB_DEV_CLASSIFICATION = 19;

const MANUAL_TYPES = ['google_review', 'positive_tbr', 'negative_tbr', 'manual_adjustment'];

// Piecewise-linear survey rating -> points. Confirmed with Matt:
// 1=-2, 2=-1, 3=-1, 4=0, 5=+1. Interpolates decimal ratings (e.g. 4.33).
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

const round2 = (n) => Math.round(n * 100) / 100;
const queueLabel = (id) => QUEUE_NAMES[id] || `Unknown queue ${id}`;

function windowStartDate() {
  const d = new Date();
  d.setMonth(d.getMonth() - WINDOW_MONTHS);
  return d;
}

// ── Storage ──────────────────────────────────────────────────────────────────
let cache = null;

function loadData() {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    delete parsed.lastSync; // legacy shared checkpoint, no longer used
    parsed.clients = parsed.clients || {};
    cache = parsed;
  } catch (err) {
    cache = { clients: {} };
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

// ── Score calculation ────────────────────────────────────────────────────────
// The single source of truth for a client's score. Every route uses this,
// so the list, the detail panel and the preview can never disagree.
function scoreBreakdown(client) {
  const startMs = windowStartDate().getTime();
  const inWindow = (e) => new Date(e.date).getTime() >= startMs;

  let breaches = 0;
  let surveys = 0;
  let surveyPositive = 0;
  let surveyNegative = 0;
  let manualPoints = 0;
  let manualCounted = 0;
  let manualExpired = 0;

  for (const e of client.events) {
    if (!inWindow(e)) {
      if (e.enteredBy !== null) manualExpired++;
      continue;
    }
    if (e.type === 'sla_breach') {
      breaches++;
    } else if (e.type === 'autotask_review') {
      surveys++;
      if (e.delta > 0) surveyPositive += e.delta;
      else surveyNegative += e.delta;
    } else {
      manualCounted++;
      manualPoints += e.delta;
    }
  }

  const breachPoints = breaches * BREACH_DELTA;
  const surveyPointsCounted = Math.min(surveyPositive, SURVEY_POSITIVE_CAP) + surveyNegative;
  const score = BASE_SCORE + breachPoints + surveyPointsCounted + manualPoints;

  return {
    score: round2(score),
    breakdown: {
      base: BASE_SCORE,
      breaches,
      breachPoints: round2(breachPoints),
      surveys,
      surveyPointsRaw: round2(surveyPositive + surveyNegative),
      surveyPointsCounted: round2(surveyPointsCounted),
      surveyCapApplied: surveyPositive > SURVEY_POSITIVE_CAP,
      manualCounted,
      manualPoints: round2(manualPoints),
      manualExpired,
    },
  };
}

// Full client record for the detail panel: score, breakdown, and each event
// marked with whether it still counts (false = older than 12 months).
function clientResponse(client) {
  const startMs = windowStartDate().getTime();
  const { score, breakdown } = scoreBreakdown(client);
  return {
    ...client,
    score,
    breakdown,
    rules: {
      base: BASE_SCORE,
      breachDelta: BREACH_DELTA,
      surveyPositiveCap: SURVEY_POSITIVE_CAP,
      windowMonths: WINDOW_MONTHS,
    },
    events: client.events.map((e) => ({
      ...e,
      counts: new Date(e.date).getTime() >= startMs,
    })),
  };
}

// ── AutoTask helpers ─────────────────────────────────────────────────────────
// Pagination on this zone (webservices14): continuation pages need POST, and
// the original filter body must be resent on every page.
async function queryAll(entity, body) {
  let items = [];
  const first = await autotaskClient.post(`/${entity}/query`, body);
  items = items.concat(first.data.items || []);
  let nextUrl = first.data.pageDetails?.nextPageUrl;
  while (nextUrl) {
    await sleep(PAGE_SLEEP_MS);
    const pageRes = await axios.post(nextUrl, body, { headers: getHeaders() });
    items = items.concat(pageRes.data.items || []);
    nextUrl = pageRes.data.pageDetails?.nextPageUrl;
  }
  return items;
}

// Company names + the full exclusion set for this run (fixed IDs plus any
// company currently classified Web Dev). Best-effort: on failure, falls back
// to the fixed IDs and no names.
async function fetchCompanyInfo() {
  const companies = await queryAll('Companies', {
    filter: [{ field: 'id', op: 'gte', value: 0 }],
  });
  const nameMap = {};
  const excludedIds = new Set(EXCLUDE_CS_COMPANIES);
  for (const c of companies) {
    if (c.id == null) continue;
    nameMap[String(c.id)] = c.companyName;
    if (Number(c.classification) === WEB_DEV_CLASSIFICATION) excludedIds.add(c.id);
  }
  return { nameMap, excludedIds };
}

// SurveyResults only carry ticketID; this resolves human-readable ticket
// numbers in batches using the 'in' operator.
async function fetchTicketNumberMap(ticketIds) {
  const unique = [...new Set(ticketIds.filter(Boolean))];
  const map = {};
  const CHUNK = 200;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const tickets = await queryAll('Tickets', {
      filter: [{ field: 'id', op: 'in', value: chunk }],
    });
    for (const t of tickets) map[t.id] = t.ticketNumber;
    if (i + CHUNK < unique.length) await sleep(PAGE_SLEEP_MS);
  }
  return map;
}

// Full detail on AutoTask errors of any status, not just axios's generic text.
function describeAutotaskError(err) {
  return {
    message: err.message,
    status: err.response?.status,
    url: err.config?.url,
    method: err.config?.method,
    data: err.response?.data,
  };
}

// ── Build all system events for the trailing 12 months ───────────────────────
// Used by both /sync (which saves them) and /preview (which doesn't).
// breachEvents / surveyEvents are null if that step failed, so the caller
// can keep the previous events for that type instead of wiping them.
async function buildSystemEvents() {
  const now = new Date();
  const since = windowStartDate().toISOString();
  const errors = [];

  let nameMap = {};
  let excludedIds = new Set(EXCLUDE_CS_COMPANIES);
  try {
    const info = await fetchCompanyInfo();
    nameMap = info.nameMap;
    excludedIds = info.excludedIds;
  } catch (err) {
    errors.push({ step: 'company_info', ...describeAutotaskError(err) });
  }

  const totals = {
    ticketsChecked: 0,
    breachesCounted: 0,
    skippedNotYetDue: 0,
    skippedRmmResolved: 0,
    skippedExcludedCompany: 0,
    skippedExcludedQueue: {},
  };

  // --- SLA breaches ---
  let breachEvents = null;
  try {
    const raw = await queryAll('Tickets', {
      filter: [
        { field: 'createDate', op: 'gte', value: since },
        { field: 'firstResponseDueDateTime', op: 'exist' },
      ],
    });
    const tickets = [...new Map(raw.map((t) => [t.id, t])).values()];
    breachEvents = {};
    for (const t of tickets) {
      totals.ticketsChecked++;
      const due = new Date(t.firstResponseDueDateTime).getTime();
      const responded = t.firstResponseDateTime ? new Date(t.firstResponseDateTime).getTime() : null;
      const breached = responded == null ? due < now.getTime() : responded > due;
      if (!breached) {
        if (responded == null) totals.skippedNotYetDue++;
        continue;
      }
      if (!t.companyID || excludedIds.has(t.companyID)) { totals.skippedExcludedCompany++; continue; }
      if (t.status === RMM_RESOLVED_STATUS) { totals.skippedRmmResolved++; continue; }
      if (!COUNTED_QUEUES.has(t.queueID)) {
        const q = queueLabel(t.queueID);
        totals.skippedExcludedQueue[q] = (totals.skippedExcludedQueue[q] || 0) + 1;
        continue;
      }
      totals.breachesCounted++;
      const key = String(t.companyID);
      (breachEvents[key] = breachEvents[key] || []).push({
        id: `evt_${randomUUID()}`,
        type: 'sla_breach',
        delta: BREACH_DELTA,
        date: t.createDate,
        source: { ticketId: t.id, ticketNumber: t.ticketNumber, queue: queueLabel(t.queueID) },
        enteredBy: null,
      });
    }
  } catch (err) {
    breachEvents = null;
    errors.push({ step: 'sla_breaches', since, ...describeAutotaskError(err) });
  }

  // --- AutoTask surveys ---
  let surveyEvents = null;
  try {
    const results = await queryAll('SurveyResults', {
      filter: [{ field: 'completeDate', op: 'gte', value: since }],
    });
    let ticketNumberMap = {};
    try {
      ticketNumberMap = await fetchTicketNumberMap(results.map((r) => r.ticketID));
    } catch (err) {
      errors.push({ step: 'survey_ticket_numbers', ...describeAutotaskError(err) });
    }
    surveyEvents = {};
    for (const r of results) {
      if (r.surveyRating == null || !r.companyID || excludedIds.has(r.companyID)) continue;
      const key = String(r.companyID);
      (surveyEvents[key] = surveyEvents[key] || []).push({
        id: `evt_${randomUUID()}`,
        type: 'autotask_review',
        delta: surveyRatingToPoints(r.surveyRating),
        date: r.completeDate,
        source: {
          ticketId: r.ticketID,
          ticketNumber: ticketNumberMap[r.ticketID] || null,
          surveyResultId: r.id,
          rating: r.surveyRating,
        },
        enteredBy: null,
      });
    }
  } catch (err) {
    surveyEvents = null;
    errors.push({ step: 'autotask_survey', since, ...describeAutotaskError(err) });
  }

  return { generatedAt: now.toISOString(), windowStart: since, nameMap, excludedIds, breachEvents, surveyEvents, totals, errors };
}

// Applies freshly built system events to a ledger (in place). Only replaces a
// type whose step succeeded; manual events are never touched.
function applySystemEvents(data, built) {
  const { nameMap, excludedIds, breachEvents, surveyEvents } = built;

  for (const key of Object.keys(data.clients)) {
    if (excludedIds.has(Number(key))) delete data.clients[key];
  }

  const replace = (type, byClient) => {
    if (!byClient) return; // step failed — keep previous events of this type
    for (const c of Object.values(data.clients)) {
      c.events = c.events.filter((e) => e.type !== type);
    }
    for (const [key, events] of Object.entries(byClient)) {
      ensureClient(data, key, nameMap[key]).events.push(...events);
    }
  };
  replace('sla_breach', breachEvents);
  replace('autotask_review', surveyEvents);

  for (const [key, c] of Object.entries(data.clients)) {
    if (nameMap[key]) c.companyName = nameMap[key];
    c.events.sort((a, b) => new Date(a.date) - new Date(b.date));
    if (c.events.length === 0) delete data.clients[key];
  }
}

// ── Routes ───────────────────────────────────────────────────────────────────

// GET /api/customer-success/scores — summary list, all clients
router.get('/scores', (req, res) => {
  const data = loadData();
  const summary = Object.values(data.clients).map((c) => {
    const { score, breakdown } = scoreBreakdown(c);
    return {
      companyId: c.companyId,
      companyName: c.companyName,
      score,
      breaches: breakdown.breaches,
      surveys: breakdown.surveys,
      eventCount: c.events.length,
    };
  });
  res.json(summary);
});

// GET /api/customer-success/scores/:companyId — full ledger + breakdown
router.get('/scores/:companyId', (req, res) => {
  const data = loadData();
  const client = data.clients[req.params.companyId];
  if (!client) return res.status(404).json({ error: 'No score record for this client yet' });
  res.json(clientResponse(client));
});

// POST /api/customer-success/scores/:companyId/events — manual entry
router.post('/scores/:companyId/events', (req, res) => {
  const { type, delta, note, companyName } = req.body;
  if (!MANUAL_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of ${MANUAL_TYPES.join(', ')}` });
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
    enteredBy: req.user?.oid || null,
    note,
  });
  saveData(data);
  res.json(clientResponse(client));
});

// DELETE /api/customer-success/scores/:companyId/events/:eventId
// Manual entries only — system events are corrected by re-syncing.
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
  res.json(clientResponse(client));
});

// POST /api/customer-success/sync — rebuilds all system events for the
// trailing 12 months and saves them. Takes a minute or two.
router.post('/sync', async (req, res, next) => {
  try {
    const built = await buildSystemEvents();
    const data = loadData();
    applySystemEvents(data, built);
    if (built.breachEvents) data.lastSyncSlaBreaches = built.generatedAt;
    if (built.surveyEvents) data.lastSyncSurveys = built.generatedAt;
    data.rulesVersion = 2;
    saveData(data);
    res.json({ ok: true, errors: built.errors, totals: built.totals });
  } catch (err) {
    next(err);
  }
});

// GET /api/customer-success/preview — owner-only, READ-ONLY. Shows what each
// client's score would be after a sync right now, next to the saved score.
// Kept for checking future rule changes before they go live.
router.get('/preview', requireOwner, async (req, res, next) => {
  try {
    const built = await buildSystemEvents();
    const saved = loadData();
    const copy = JSON.parse(JSON.stringify(saved));
    applySystemEvents(copy, built);

    const ids = new Set(
      [...Object.keys(saved.clients), ...Object.keys(copy.clients)]
        .filter((key) => !built.excludedIds.has(Number(key)))
    );
    const clients = [...ids].map((key) => {
      const before = saved.clients[key];
      const after = copy.clients[key];
      const afterScore = after ? scoreBreakdown(after) : { score: BASE_SCORE, breakdown: null };
      return {
        companyId: key,
        companyName: (after || before).companyName,
        currentScore: before ? scoreBreakdown(before).score : null,
        newScore: afterScore.score,
        breakdown: afterScore.breakdown,
      };
    }).sort((a, b) => a.newScore - b.newScore);

    res.json({
      generatedAt: built.generatedAt,
      windowStart: built.windowStart,
      rules: {
        base: BASE_SCORE,
        breachDelta: BREACH_DELTA,
        surveyPositiveCap: SURVEY_POSITIVE_CAP,
        countedQueues: [...COUNTED_QUEUES].map(queueLabel),
        excludedCompanies: [...EXCLUDE_CS_COMPANIES],
        floor: null,
      },
      totals: built.totals,
      errors: built.errors,
      clients,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;