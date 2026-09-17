const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { autotaskClient, getHeaders } = require('../utils/autotask');
const { requireOwner } = require('../middleware/auth');

const DATA_FILE = '/app/data/reviewed.json';
const AUTOTASK_ZONE = (process.env.AUTOTASK_ZONE_URL || '').replace('/ATServicesRest', '') || 'https://ww14.autotask.net';

// ── Constants ─────────────────────────────────────────────────────────────────
const INCLUDE_QUEUES = [5, 29682833, 29683482, 29683496, 29683497];
const EXCLUDE_CATEGORIES = new Set([104]); // 104 = LUV Credit Card Requests
const FLAG_WINDOW_DAYS = 60; // Only flag tickets created within this many days
const TICKET_LOOKBACK_DAYS = 60; // How far back to pull tickets for review at all (shrunk from 6 months to cut AI Review runtime)
const LOW_PRIORITY = 4; // AutoTask priority 4 = Low — excluded from AI Review entirely
const AUTO_CLOSE_NOTE_TITLE_MATCH = 'Auto Closing ticket'; // Matches the "Auto Closing ticket. No response after X business days" note created by AutoTask's "Waiting on Customer" workflow rules. Confirmed via diagnostic testing (ticketID 'in' + title 'contains' on TicketNotes) — see /api/diagnostic/auto-close-notes-test. Per Matt: a ticket with this note means the customer never responded past the initial ticket-open message, and should ALWAYS be excluded from AI Review regardless of ticket content — this is not a real signal, and repeated instances are not a signal either.
const RMM_RESOLVED_STATUS = 20; // AutoTask ticket status "RMM Resolved" — confirmed via /api/diagnostic/ticket-fields
const SYSTEM_RESOURCE_ID = 4; // "Autotask Administrator" — the system account that authors workflow-rule notes. Confirmed via two real tickets (T20260725.0003, T20260916.0035/0023) that every automated workflow-rule note has creatorResourceID 4. A note with any OTHER creatorResourceID (including null, which is a customer reply via chat) means a real person or the chat-bot was involved.
const CLAUDE_MODEL = 'claude-opus-4-6';

const TECH_TIERS = {
  29682924: { name: 'Carlos Agundez', tier: 1 },
  29682927: { name: 'Ben Holliday', tier: 1 },
  29682910: { name: 'Brandon Emby', tier: 2 },
  29682889: { name: 'Matt Cartrett', tier: 2 },
  29682904: { name: 'Rob Coleman', tier: 3 },
  29682899: { name: 'Chris McDaniel', tier: 3 }
};

// ── Default prompts ───────────────────────────────────────────────────────────
const DEFAULT_TICKET_REVIEW_PROMPT = `You are reviewing IT support tickets for an MSP looking for issues needing executive attention.

WHAT TO LOOK FOR:
1. customer-health: Customer frustration, repeat issues, long resolution, multiple follow-ups
2. cross-customer: Same issue type across multiple users at the same company
3. escalation: Started with Tier 1 but required Tier 2 or Tier 3
4. tech-performance: Unusually long resolution, misdiagnosis, confusing back-and-forth
5. documentation: No notes, no resolution description
6. reopen: Ticket reopened after closure

SEVERITY:
- critical: Immediate executive attention required
- high: Review this week
- medium: Review when time allows
- low: Informational

TICKETS:
{{TICKETS}}

COMPANY GROUPINGS:
{{COMPANY_GROUPINGS}}

Return ONLY a JSON array of flagged tickets. If none warrant flagging return [].
Each item must have:
{
  "ticketNumber": "T20260101.0001",
  "severity": "critical|high|medium|low",
  "flagType": "customer-health|cross-customer|escalation|tech-performance|documentation|reopen",
  "summary": "One sentence summary",
  "reasons": ["Reason 1", "Reason 2"],
  "notesForExec": "Brief actionable note"
}`;

const DEFAULT_TREND_ANALYSIS_PROMPT = `You are analyzing long-term patterns in IT support data for an MSP executive team.

You have accumulated data from ticket reviews over the past 6 months. Identify meaningful patterns that warrant executive attention.

LOOK FOR:
1. COMPANY TRENDS: Companies with persistent issues over time, high flag rates, recurring issue types, or growing ticket volumes. Flag companies where the same problems keep appearing month after month.
2. TECH PATTERNS: Technicians with high escalation rates on specific issue types, unusually long resolution times, or consistent flag patterns. Note both concerning patterns and strong performers.
3. SENTIMENT SIGNALS: Companies showing signs of deteriorating relationship - high flag rates, long resolution times, escalations, repeat issues across multiple months.

COMPANY DATA ({{COMPANY_COUNT}} companies with 3+ tickets):
{{COMPANY_DATA}}

TECH DATA ({{TECH_COUNT}} techs with 5+ tickets):
{{TECH_DATA}}

Return ONLY a JSON object with this exact structure:
{
  "companyTrends": [{"companyName": "Acme Corp","severity": "critical|high|medium|low","headline": "One sentence describing the pattern","details": ["Detail point 1"],"recommendation": "What exec should do"}],
  "techPatterns": [{"techName": "Carlos Agundez","type": "concern|strength","headline": "One sentence describing the pattern","details": ["Detail point 1"],"recommendation": "What exec should do"}],
  "sentimentSignals": [{"companyName": "Acme Corp","severity": "critical|high|medium|low","signal": "One sentence describing the sentiment concern","supportingData": ["Data point 1"]}]
}

Only include items with genuine patterns worth executive attention. Return empty arrays if nothing significant found.`;

// ── In-memory run state (for fire-and-forget polling) ─────────────────────────
let runState = {
  running: false,
  progress: 0,      // 0-100
  phase: '',        // current phase label
  startedAt: null,
  error: null
};

// ── PII scrubbing ─────────────────────────────────────────────────────────────
function scrubPII(text) {
  if (!text) return '';
  return text
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, '[Email]')
    .replace(/\b(\+?1?\s?)?(\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})\b/g, '[Phone]')
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '[IP Address]')
    .replace(/\\\\[A-Za-z0-9_-]+\\[A-Za-z0-9_.$-]+/g, '[Device]')
    .replace(/\b[A-Za-z0-9_-]+-PC\b/gi, '[Device]')
    .replace(/\b[A-Za-z0-9_-]+-LAPTOP\b/gi, '[Device]')
    .replace(/\b[A-Za-z0-9_-]+-WS\b/gi, '[Device]')
    .replace(/\b[A-Za-z0-9.-]+\.(local|com|net|org|io)\b/gi, '[Domain]');
}

// ── File helpers ──────────────────────────────────────────────────────────────
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('[AIReview] Error loading data file:', err.message);
  }
  return { reviewed: {}, lastReviewRun: null, reviewStats: {}, exclusions: [], flags: [], trends: null, prompts: {}, ignoredTrends: [] };
}

function saveData(data) {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('[AIReview] Error saving data file:', err.message);
  }
}

function ticketUrl(ticketNumber) {
  return `${AUTOTASK_ZONE}/Autotask/AutotaskExtend/ExecuteCommand.aspx?Code=OpenTicketDetail&TicketNumber=${ticketNumber}`;
}

// ── Fetch all tickets for review using pagination ─────────────────────────────
async function fetchAllTicketsForReview() {
  const lookbackCutoff = new Date();
  lookbackCutoff.setDate(lookbackCutoff.getDate() - TICKET_LOOKBACK_DAYS);

  const queueFilter = {
    op: 'or',
    items: INCLUDE_QUEUES.map(id => ({ field: 'queueID', op: 'eq', value: id }))
  };

  const filter = [
    queueFilter,
    { field: 'createDate', op: 'gte', value: lookbackCutoff.toISOString() },
    { field: 'priority', op: 'noteq', value: LOW_PRIORITY }
  ];

  let allTickets = [];
  let nextPageUrl = null;

  const firstResponse = await autotaskClient.post('/Tickets/query', { filter, maxRecords: 500 });
  allTickets = [...(firstResponse.data.items || [])];
  nextPageUrl = firstResponse.data.pageDetails?.nextPageUrl || null;

  while (nextPageUrl) {
    await new Promise(r => setTimeout(r, 300));
    const response = await axios.post(nextPageUrl, { filter, maxRecords: 500 }, { headers: getHeaders() });
    allTickets = [...allTickets, ...(response.data.items || [])];
    nextPageUrl = response.data.pageDetails?.nextPageUrl || null;
  }

  // Filter out excluded categories (e.g. LUV Credit Card Requests = 104)
  const before = allTickets.length;
  allTickets = allTickets.filter(t => !EXCLUDE_CATEGORIES.has(t.ticketCategory));
  console.log(`[AIReview] Fetched ${before} tickets (last ${TICKET_LOOKBACK_DAYS} days, Low priority excluded), ${allTickets.length} after category filter`);
  return allTickets;
}

// ── Fetch company names ────────────────────────────────────────────────────────
async function fetchCompanyNames(companyIds) {
  if (!companyIds.length) return {};
  const companyMap = {};
  try {
    const CHUNK = 500;
    for (let i = 0; i < companyIds.length; i += CHUNK) {
      const chunk = companyIds.slice(i, i + CHUNK);
      const response = await autotaskClient.post('/Companies/query', {
        filter: [{ field: 'id', op: 'in', value: chunk }]
      });
      (response.data.items || []).forEach(c => {
        companyMap[String(c.id)] = c.companyName;
      });
      if (i + CHUNK < companyIds.length) await new Promise(r => setTimeout(r, 300));
    }
  } catch (err) {
    console.warn('[AIReview] Could not fetch company names:', err.message);
  }
  return companyMap;
}

// ── Find tickets that auto-closed with no customer response ──────────────────
// Confirmed via diagnostic testing that AutoTask's 'in' (on ticketID) and
// 'contains' (on title) filters combine correctly on TicketNotes. Chunked at
// 500 IDs per call (same convention as fetchCompanyNames) with pagination
// handling (same convention as fetchAllTicketsForReview) since a chunk of
// 500 tickets could plausibly return more than one page of matching notes.
async function fetchAutoClosedTicketIds(ticketIds) {
  const excludedIds = new Set();
  if (!ticketIds.length) return excludedIds;

  const CHUNK = 500;
  for (let i = 0; i < ticketIds.length; i += CHUNK) {
    const chunk = ticketIds.slice(i, i + CHUNK);
    const filter = [
      { field: 'ticketID', op: 'in', value: chunk },
      { field: 'title', op: 'contains', value: AUTO_CLOSE_NOTE_TITLE_MATCH }
    ];
    try {
      let nextPageUrl = null;
      const firstResponse = await autotaskClient.post('/TicketNotes/query', { filter, maxRecords: 500 });
      (firstResponse.data.items || []).forEach(n => excludedIds.add(n.ticketID));
      nextPageUrl = firstResponse.data.pageDetails?.nextPageUrl || null;

      while (nextPageUrl) {
        await new Promise(r => setTimeout(r, 300));
        const response = await axios.post(nextPageUrl, { filter, maxRecords: 500 }, { headers: getHeaders() });
        (response.data.items || []).forEach(n => excludedIds.add(n.ticketID));
        nextPageUrl = response.data.pageDetails?.nextPageUrl || null;
      }
    } catch (err) {
      console.warn('[AIReview] Could not check auto-closed notes for a chunk of tickets:', err.message);
    }
    if (i + CHUNK < ticketIds.length) await new Promise(r => setTimeout(r, 300));
  }
  return excludedIds;
}

// ── Find RMM-auto-resolved tickets with no human/customer involvement ────────
// Per Matt: RMM alerts sometimes open a ticket, then the RMM tool itself
// resolves the underlying issue and closes the ticket automatically, with no
// person ever touching it. Confirmed via diagnostic testing (T20260725.0003):
// these tickets have status RMM_RESOLVED and every note authored by the
// SYSTEM_RESOURCE_ID system account. This checks ALL notes on a ticket (no
// title filter, unlike fetchAutoClosedTicketIds) — returns the set of ticket
// IDs that have at least one note from someone/something other than the
// system account, and separately the set of ticket IDs a chunk failure
// prevented from being checked at all (those must NOT be assumed excluded —
// only tickets we could positively confirm have zero non-system notes should
// ever be skipped from Claude review).
async function fetchTicketNoteCheckResults(ticketIds) {
  const idsWithNonSystemNotes = new Set();
  const failedIds = new Set();
  if (!ticketIds.length) return { idsWithNonSystemNotes, failedIds };

  const CHUNK = 500;
  for (let i = 0; i < ticketIds.length; i += CHUNK) {
    const chunk = ticketIds.slice(i, i + CHUNK);
    const filter = [{ field: 'ticketID', op: 'in', value: chunk }];
    try {
      let nextPageUrl = null;
      const firstResponse = await autotaskClient.post('/TicketNotes/query', { filter, maxRecords: 500 });
      (firstResponse.data.items || []).forEach(n => {
        if (n.creatorResourceID !== SYSTEM_RESOURCE_ID) idsWithNonSystemNotes.add(n.ticketID);
      });
      nextPageUrl = firstResponse.data.pageDetails?.nextPageUrl || null;

      while (nextPageUrl) {
        await new Promise(r => setTimeout(r, 300));
        const response = await axios.post(nextPageUrl, { filter, maxRecords: 500 }, { headers: getHeaders() });
        (response.data.items || []).forEach(n => {
          if (n.creatorResourceID !== SYSTEM_RESOURCE_ID) idsWithNonSystemNotes.add(n.ticketID);
        });
        nextPageUrl = response.data.pageDetails?.nextPageUrl || null;
      }
    } catch (err) {
      console.warn('[AIReview] Could not check notes for a chunk of RMM-resolved tickets — leaving them in scope for Claude review rather than risking a wrong exclusion:', err.message);
      chunk.forEach(id => failedIds.add(id));
    }
    if (i + CHUNK < ticketIds.length) await new Promise(r => setTimeout(r, 300));
  }
  return { idsWithNonSystemNotes, failedIds };
}

// ── Shared reviewed-metadata fields (used for both AI-analyzed and auto-closed tickets) ──
function baseReviewMetadata(t, now) {
  const techIds = [t.assignedResourceID, t.completedByResourceID].filter(Boolean);
  const wasEscalated = techIds.length > 1 &&
    techIds.some(id => TECH_TIERS[id]?.tier === 1) &&
    techIds.some(id => TECH_TIERS[id]?.tier >= 2);
  const resolutionDays = t.createDate && t.completedDate
    ? Math.round((new Date(t.completedDate) - new Date(t.createDate)) / (1000 * 60 * 60 * 24))
    : null;
  return {
    reviewedAt: now,
    companyID: t.companyID,
    issueType: t.issueType || null,
    techId: t.assignedResourceID || null,
    wasEscalated,
    resolutionDays
  };
}

// ── One-time cleanup: bulk-resolve ticketNumber -> internal ticket ID ────────
// Existing flags in data.flags only store ticketNumber (e.g. "T20260727.0017"),
// not the internal numeric ID that TicketNotes queries need. Confirmed via
// diagnostic testing that AutoTask's 'in' operator works on the ticketNumber
// field (a string field) — same chunk/pagination pattern as elsewhere in this file.
async function fetchTicketIdsByNumbers(ticketNumbers) {
  const map = {};
  const cleanNumbers = ticketNumbers.filter(Boolean); // strip null/undefined — a single bad value in AutoTask's 'in' filter fails the ENTIRE chunk, not just that entry
  const CHUNK = 500;
  for (let i = 0; i < cleanNumbers.length; i += CHUNK) {
    const chunk = cleanNumbers.slice(i, i + CHUNK);
    const filter = [{ field: 'ticketNumber', op: 'in', value: chunk }];
    try {
      let nextPageUrl = null;
      const firstResponse = await autotaskClient.post('/Tickets/query', { filter, maxRecords: 500 });
      (firstResponse.data.items || []).forEach(t => { map[t.ticketNumber] = t.id; });
      nextPageUrl = firstResponse.data.pageDetails?.nextPageUrl || null;

      while (nextPageUrl) {
        await new Promise(r => setTimeout(r, 300));
        const response = await axios.post(nextPageUrl, { filter, maxRecords: 500 }, { headers: getHeaders() });
        (response.data.items || []).forEach(t => { map[t.ticketNumber] = t.id; });
        nextPageUrl = response.data.pageDetails?.nextPageUrl || null;
      }
    } catch (err) {
      console.warn('[AIReview] Could not resolve a chunk of ticket numbers to IDs:', err.message);
    }
    if (i + CHUNK < cleanNumbers.length) await new Promise(r => setTimeout(r, 300));
  }
  return map;
}

// ── One-time cleanup: find which existing flags match the auto-close pattern ──
// Shared by the preview and apply routes so they can never disagree with
// each other about which flags match.
async function computeAutoCloseFlagMatches(data) {
  const flags = data.flags || [];
  const flagsMissingTicketNumber = flags.filter(f => !f.id).length; // pre-existing bad data — a flag with no traceable ticket number at all, separate from a lookup failure
  const ticketNumbers = flags.map(f => f.id).filter(Boolean);
  const numberToId = await fetchTicketIdsByNumbers(ticketNumbers);

  const idToNumber = {};
  Object.entries(numberToId).forEach(([num, id]) => { idToNumber[id] = num; });

  const autoClosedIds = await fetchAutoClosedTicketIds(Object.values(numberToId));
  const matchedTicketNumbers = new Set();
  autoClosedIds.forEach(id => {
    if (idToNumber[id]) matchedTicketNumbers.add(idToNumber[id]);
  });

  const matchedFlags = flags.filter(f => matchedTicketNumbers.has(f.id));
  const unresolvedTicketNumbers = ticketNumbers.filter(tn => !(tn in numberToId));

  return { matchedFlags, unresolvedTicketNumbers, flagsMissingTicketNumber };
}

// ── Analyze a batch of tickets with Claude ────────────────────────────────────
async function analyzeBatch(batch, companyMap, customPrompt) {
  const ticketSummaries = batch.map(t => {
    const techIds = [t.assignedResourceID, t.completedByResourceID].filter(Boolean);
    const techInfo = techIds.map(id => {
      const tech = TECH_TIERS[id];
      return tech ? `${tech.name} (Tier ${tech.tier})` : `Tech ID: ${id}`;
    }).join(', ');

    const isEscalation = techIds.length > 1 &&
      techIds.some(id => TECH_TIERS[id]?.tier === 1) &&
      techIds.some(id => TECH_TIERS[id]?.tier >= 2);

    const openDays = t.createDate && t.completedDate
      ? Math.round((new Date(t.completedDate) - new Date(t.createDate)) / (1000 * 60 * 60 * 24))
      : t.createDate
        ? Math.round((new Date() - new Date(t.createDate)) / (1000 * 60 * 60 * 24))
        : null;

    return {
      ticketNumber: t.ticketNumber,
      companyId: t.companyID,
      title: t.title || '',
      status: t.status,
      issueType: t.issueType,
      openDays,
      techInvolved: techInfo,
      isEscalation,
      description: scrubPII((t.description || '').substring(0, 400))
    };
  });

  const byCompany = {};
  ticketSummaries.forEach(t => {
    if (!byCompany[t.companyId]) byCompany[t.companyId] = [];
    byCompany[t.companyId].push(t);
  });

  const basePrompt = (customPrompt && customPrompt.trim()) ? customPrompt : DEFAULT_TICKET_REVIEW_PROMPT;
  const prompt = basePrompt
    .replace('{{TICKETS}}', JSON.stringify(ticketSummaries, null, 2))
    .replace('{{COMPANY_GROUPINGS}}', JSON.stringify(Object.entries(byCompany).map(([id, tickets]) => ({
      companyId: id,
      ticketCount: tickets.length,
      issueTypes: [...new Set(tickets.map(t => t.issueType))]
    })), null, 2));

  let response;
  try {
    response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: CLAUDE_MODEL,
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }]
    }, {
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': process.env.ANTHROPIC_API_KEY
      }
    });
  } catch (err) {
    if (err.response) {
      console.error('[AIReview] Claude API error:', err.response.status, JSON.stringify(err.response.data));
      console.error('[AIReview] Prompt length (chars):', prompt.length);
      console.error('[AIReview] First 500 chars of prompt:', prompt.substring(0, 500));
    }
    throw err; // re-throw so retry logic handles it
  }

  try {
    const content = response.data.content[0]?.text || '[]';
    const clean = content.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (err) {
    if (err.response) {
      console.error('[AIReview] Claude API error:', err.response.status, JSON.stringify(err.response.data));
    } else {
      console.error('[AIReview] Failed to parse Claude response:', err.message);
    }
    return [];
  }
}

// ── Analyze trends across accumulated reviewed ticket metadata ─────────────────
async function analyzeTrends(reviewedMetadata, companyMap, customPrompt) {
  console.log(`[AIReview] Running trend analysis on ${Object.keys(reviewedMetadata).length} reviewed tickets...`);

  // Build company-level summaries from metadata
  const byCompany = {};
  const byTech = {};

  Object.entries(reviewedMetadata).forEach(([ticketNum, meta]) => {
    if (!meta || !meta.companyID) return;

    const companyId = String(meta.companyID);
    const companyName = companyMap[companyId] || `Company ${companyId}`;

    if (!byCompany[companyId]) {
      byCompany[companyId] = {
        companyName,
        ticketCount: 0,
        flaggedCount: 0,
        flagTypes: {},
        issueTypes: {},
        avgResolutionDays: [],
        escalationCount: 0,
        monthlyActivity: {},
        ticketNumbers: []   // for drill-down
      };
    }

    const co = byCompany[companyId];
    co.ticketCount++;
    co.ticketNumbers.push(ticketNum);
    if (meta.hasIssues) co.flaggedCount++;
    if (meta.wasEscalated) co.escalationCount++;
    if (meta.resolutionDays != null) co.avgResolutionDays.push(meta.resolutionDays);
    if (meta.flagType) co.flagTypes[meta.flagType] = (co.flagTypes[meta.flagType] || 0) + 1;
    if (meta.issueType) co.issueTypes[String(meta.issueType)] = (co.issueTypes[String(meta.issueType)] || 0) + 1;

    // Track by month
    const month = (meta.reviewedAt || '').substring(0, 7);
    if (month) co.monthlyActivity[month] = (co.monthlyActivity[month] || 0) + 1;

    // By tech
    if (meta.techId) {
      const techId = String(meta.techId);
      const techInfo = TECH_TIERS[meta.techId];
      const techName = techInfo?.name || `Tech ${techId}`;
      if (!byTech[techId]) {
        byTech[techId] = {
          techName,
          tier: techInfo?.tier || null,
          ticketCount: 0,
          flaggedCount: 0,
          escalationCount: 0,
          flagTypes: {},
          issueTypes: {},
          avgResolutionDays: [],
          ticketNumbers: []   // for drill-down
        };
      }
      const te = byTech[techId];
      te.ticketCount++;
      te.ticketNumbers.push(ticketNum);
      if (meta.hasIssues) te.flaggedCount++;
      if (meta.wasEscalated) te.escalationCount++;
      if (meta.resolutionDays != null) te.avgResolutionDays.push(meta.resolutionDays);
      if (meta.flagType) te.flagTypes[meta.flagType] = (te.flagTypes[meta.flagType] || 0) + 1;
      if (meta.issueType) te.issueTypes[String(meta.issueType)] = (te.issueTypes[String(meta.issueType)] || 0) + 1;
    }
  });

  // Compute averages
  Object.values(byCompany).forEach(co => {
    co.avgResolutionDays = co.avgResolutionDays.length
      ? Math.round(co.avgResolutionDays.reduce((a, b) => a + b, 0) / co.avgResolutionDays.length)
      : null;
    co.flagRate = co.ticketCount > 0 ? Math.round((co.flaggedCount / co.ticketCount) * 100) : 0;
  });

  Object.values(byTech).forEach(te => {
    te.avgResolutionDays = te.avgResolutionDays.length
      ? Math.round(te.avgResolutionDays.reduce((a, b) => a + b, 0) / te.avgResolutionDays.length)
      : null;
    te.escalationRate = te.ticketCount > 0 ? Math.round((te.escalationCount / te.ticketCount) * 100) : 0;
    te.flagRate = te.ticketCount > 0 ? Math.round((te.flaggedCount / te.ticketCount) * 100) : 0;
  });

  // Only send companies with meaningful volume to Claude
  const significantCompanies = Object.values(byCompany)
    .filter(co => co.ticketCount >= 3)
    .sort((a, b) => b.flagRate - a.flagRate)
    .slice(0, 40);

  const significantTechs = Object.values(byTech)
    .filter(te => te.ticketCount >= 5)
    .sort((a, b) => b.flagRate - a.flagRate);

  const baseTrendPrompt = (customPrompt && customPrompt.trim()) ? customPrompt : DEFAULT_TREND_ANALYSIS_PROMPT;
  const prompt = baseTrendPrompt
    .replace('{{COMPANY_COUNT}}', significantCompanies.length)
    .replace('{{COMPANY_DATA}}', JSON.stringify(significantCompanies, null, 2))
    .replace('{{TECH_COUNT}}', significantTechs.length)
    .replace('{{TECH_DATA}}', JSON.stringify(significantTechs, null, 2));

  let response;
  try {
    response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: CLAUDE_MODEL,
      max_tokens: 3000,
      messages: [{ role: 'user', content: prompt }]
    }, {
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': process.env.ANTHROPIC_API_KEY
      }
    });
  } catch (err) {
    if (err.response) {
      console.error('[AIReview Trends] Claude API error:', err.response.status, JSON.stringify(err.response.data));
      console.error('[AIReview Trends] Prompt length (chars):', prompt.length);
    }
    throw err;
  }

  try {
    const content = response.data.content[0]?.text || '{}';
    const clean = content.replace(/```json|```/g, '').trim();
    const result = JSON.parse(clean);

    // Build lookup maps: companyName -> ticketNumbers, techName -> ticketNumbers
    const companyTicketMap = {};
    Object.values(byCompany).forEach(co => {
      companyTicketMap[co.companyName] = co.ticketNumbers || [];
    });
    const techTicketMap = {};
    Object.values(byTech).forEach(te => {
      techTicketMap[te.techName] = te.ticketNumbers || [];
    });

    // Attach ticket numbers to each trend item
    if (result.companyTrends) {
      result.companyTrends = result.companyTrends.map(item => ({
        ...item,
        ticketNumbers: companyTicketMap[item.companyName] || []
      }));
    }
    if (result.techPatterns) {
      result.techPatterns = result.techPatterns.map(item => ({
        ...item,
        ticketNumbers: techTicketMap[item.techName] || []
      }));
    }
    if (result.sentimentSignals) {
      result.sentimentSignals = result.sentimentSignals.map(item => ({
        ...item,
        ticketNumbers: companyTicketMap[item.companyName] || []
      }));
    }

    return result;
  } catch (err) {
    console.error('[AIReview] Failed to parse trend response:', err.message);
    return { companyTrends: [], techPatterns: [], sentimentSignals: [] };
  }
}

// ── Background review job ─────────────────────────────────────────────────────
async function runReviewJob() {
  const startTime = Date.now();
  runState = { running: true, progress: 2, phase: 'Fetching tickets', startedAt: new Date().toISOString(), error: null };

  try {
    const data = loadData();
    const excludedCompanyIds = new Set((data.exclusions || []).map(e => e.companyId));
    const reviewed = data.reviewed || {};

    console.log('[AIReview] Fetching all tickets from approved queues...');
    const allTickets = await fetchAllTicketsForReview();

    const toReview = allTickets.filter(t =>
      !reviewed[t.ticketNumber] &&
      !excludedCompanyIds.has(t.companyID)
    );

    console.log(`[AIReview] ${toReview.length} unreviewed tickets to process`);
    runState.progress = 8;

    if (toReview.length === 0) {
      const now = new Date().toISOString();
      data.lastReviewRun = now;
      data.reviewStats = {
        ...data.reviewStats,
        lastRunAt: now,
        lastRunReviewed: 0,
        lastRunFlagged: 0,
        totalReviewed: Object.keys(reviewed).length,
        totalFlagged: (data.flags || []).length
      };
      saveData(data);
      runState = { running: false, progress: 100, phase: 'Complete', startedAt: runState.startedAt, error: null };
      return;
    }

    // Find tickets that auto-closed with no customer response (never a real
    // signal per Matt — see AUTO_CLOSE_NOTE_TITLE_MATCH) and pull them out
    // before any Claude calls happen at all.
    runState = { ...runState, phase: 'Checking for auto-closed tickets', progress: 9 };
    const autoClosedTicketIds = await fetchAutoClosedTicketIds(toReview.map(t => t.id));
    const autoClosedTickets = toReview.filter(t => autoClosedTicketIds.has(t.id));
    const ticketsToAnalyze = toReview.filter(t => !autoClosedTicketIds.has(t.id));
    console.log(`[AIReview] ${autoClosedTickets.length} tickets auto-closed with no customer response — excluded from AI analysis, ${ticketsToAnalyze.length} remaining to analyze`);

    // Mark auto-closed tickets as reviewed immediately — no Claude call needed
    const preNow = new Date().toISOString();
    autoClosedTickets.forEach(t => {
      reviewed[t.ticketNumber] = {
        ...baseReviewMetadata(t, preNow),
        hasIssues: false,
        flagType: null,
        autoClosedNoResponse: true
      };
    });
    data.reviewed = reviewed;
    saveData(data);

    // Find RMM-auto-resolved tickets with no human/customer involvement at
    // all (see fetchTicketNoteCheckResults) and pull them out too. Only
    // tickets we could POSITIVELY confirm have zero non-system notes get
    // excluded — a chunk lookup failure leaves those tickets in scope rather
    // than risking a wrong exclusion.
    runState = { ...runState, phase: 'Checking RMM-resolved tickets for human involvement', progress: 9.5 };
    const rmmCandidates = ticketsToAnalyze.filter(t => t.status === RMM_RESOLVED_STATUS);
    const { idsWithNonSystemNotes, failedIds } = await fetchTicketNoteCheckResults(rmmCandidates.map(t => t.id));
    const rmmExcludedTickets = rmmCandidates.filter(t => !idsWithNonSystemNotes.has(t.id) && !failedIds.has(t.id));
    const rmmExcludedIds = new Set(rmmExcludedTickets.map(t => t.id));
    const ticketsForClaude = ticketsToAnalyze.filter(t => !rmmExcludedIds.has(t.id));
    console.log(`[AIReview] ${rmmExcludedTickets.length} RMM-resolved tickets with no human involvement — excluded from AI analysis, ${ticketsForClaude.length} remaining to analyze`);

    rmmExcludedTickets.forEach(t => {
      reviewed[t.ticketNumber] = {
        ...baseReviewMetadata(t, preNow),
        hasIssues: false,
        flagType: null,
        rmmResolvedNoHumanNotes: true
      };
    });
    data.reviewed = reviewed;
    saveData(data);

    // Fetch company names (only needed for tickets actually going to Claude)
    runState = { ...runState, phase: 'Fetching company names', progress: 10 };
    const companyIds = [...new Set(ticketsForClaude.map(t => t.companyID).filter(Boolean))];
    const companyMap = await fetchCompanyNames(companyIds);

    // Process in batches of 25
    const BATCH_SIZE = 25;
    const batches = [];
    for (let i = 0; i < ticketsForClaude.length; i += BATCH_SIZE) {
      batches.push(ticketsForClaude.slice(i, i + BATCH_SIZE));
    }

    console.log(`[AIReview] Processing ${batches.length} batches of up to ${BATCH_SIZE} tickets...`);

    const allNewFlags = [];
    const now = new Date().toISOString();
    let totalSkippedTickets = 0;

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const batchProgress = 10 + Math.round(((i + 1) / batches.length) * 70);
      runState = { ...runState, phase: `Analyzing batch ${i + 1} of ${batches.length}`, progress: batchProgress };
      console.log(`[AIReview] Batch ${i + 1}/${batches.length} — ${batch.length} tickets`);

      let aiFlags = [];
      let retries = 0;
      let batchSucceeded = false;
      while (retries < 3) {
        try {
          aiFlags = await analyzeBatch(batch, companyMap, data.prompts?.ticketReview || null);
          batchSucceeded = true;
          break;
        } catch (err) {
          if (err.response?.status === 429) {
            const waitSecs = [60, 90, 120][retries] || 120;
            console.log(`[AIReview] Rate limited on batch ${i + 1}, waiting ${waitSecs}s before retry ${retries + 1}...`);
            await new Promise(r => setTimeout(r, waitSecs * 1000));
            retries++;
          } else {
            console.error(`[AIReview] Batch ${i + 1} failed:`, err.message);
            break;
          }
        }
      }

      if (!batchSucceeded) {
        // IMPORTANT: do NOT mark these tickets as reviewed — leave them unreviewed
        // so they get retried on the next AI Review run instead of being silently lost.
        console.warn(`[AIReview] Batch ${i + 1} failed after ${retries} retries — leaving ${batch.length} tickets unreviewed for retry next run`);
        totalSkippedTickets += batch.length;

        if (i < batches.length - 1) {
          await new Promise(r => setTimeout(r, 8000));
        }
        continue; // skip marking-as-reviewed and flag-building for this batch entirely
      }

      // Mark batch as reviewed with richer metadata (only runs if batch succeeded)
      batch.forEach(t => {
        const aiFlag = aiFlags.find(f => f.ticketNumber === t.ticketNumber);
        reviewed[t.ticketNumber] = {
          ...baseReviewMetadata(t, now),
          hasIssues: !!aiFlag,
          flagType: aiFlag?.flagType || null
        };
      });

      // Build flag objects — only for tickets created within FLAG_WINDOW_DAYS
      const flagCutoff = new Date();
      flagCutoff.setDate(flagCutoff.getDate() - FLAG_WINDOW_DAYS);
      aiFlags.forEach(f => {
        const ticket = batch.find(t => t.ticketNumber === f.ticketNumber);
        // Skip adding to flags if ticket is older than the flag window
        if (ticket?.createDate && new Date(ticket.createDate) < flagCutoff) {
          console.log(`[AIReview] Ticket ${f.ticketNumber} flagged but outside ${FLAG_WINDOW_DAYS}-day window — stored in metadata only`);
          return;
        }
        const companyName = ticket ? (companyMap[String(ticket.companyID)] || 'Unknown Company') : 'Unknown Company';
        allNewFlags.push({
          id: f.ticketNumber,
          sev: f.severity,
          flagType: f.flagType,
          title: ticket?.title || f.ticketNumber,
          summary: f.summary,
          reasons: f.reasons || [],
          notesForExec: f.notesForExec || '',
          company: companyName,
          companyId: ticket?.companyID,
          issueType: ticket?.issueType,
          tech: ticket ? [ticket.assignedResourceID, ticket.completedByResourceID]
            .filter(Boolean)
            .map(id => TECH_TIERS[id]?.name || `Tech ${id}`)
            .join(', ') : '',
          openedDays: ticket ? (
            ticket.createDate && ticket.completedDate
              ? Math.round((new Date(ticket.completedDate) - new Date(ticket.createDate)) / (1000 * 60 * 60 * 24))
              : ticket.createDate
                ? Math.round((new Date() - new Date(ticket.createDate)) / (1000 * 60 * 60 * 24))
                : null
          ) : null,
          ticketUrl: ticketUrl(f.ticketNumber),
          dateFlagged: now,
          action: 'unactioned',
          timeline: []
        });
      });

      // Save progress after each batch
      data.reviewed = reviewed;
      const existingFlagMap = {};
      (data.flags || []).forEach(f => { existingFlagMap[f.id] = f; });
      allNewFlags.forEach(f => { existingFlagMap[f.id] = f; });
      const allFlags = Object.values(existingFlagMap);
      const sevRank = { critical: 0, high: 1, medium: 2, low: 3 };
      allFlags.sort((a, b) => (sevRank[a.sev] || 3) - (sevRank[b.sev] || 3));
      data.flags = allFlags;
      saveData(data);

      if (i < batches.length - 1) {
        await new Promise(r => setTimeout(r, 8000)); // 8s between batches to respect rate limit
      }
    }

    if (totalSkippedTickets > 0) {
      console.warn(`[AIReview] ${totalSkippedTickets} tickets left unreviewed due to batch failures — will retry on next run`);
    }

    // Run trend analysis on all accumulated metadata
    runState = { ...runState, phase: 'Analyzing long-term trends', progress: 85 };
    const allCompanyIds = [...new Set(Object.values(reviewed).map(m => m?.companyID).filter(Boolean))];
    const allCompanyMap = await fetchCompanyNames(allCompanyIds);
    const trends = await analyzeTrends(reviewed, allCompanyMap, data.prompts?.trendAnalysis || null);

    const duration = Math.round((Date.now() - startTime) / 1000);
    const finalData = loadData();

    finalData.lastReviewRun = now;
    finalData.reviewStats = {
      lastRunAt: now,
      lastRunReviewed: toReview.length - totalSkippedTickets,
      lastRunAutoClosedExcluded: autoClosedTickets.length,
      lastRunRmmResolvedExcluded: rmmExcludedTickets.length,
      lastRunSkipped: totalSkippedTickets,
      lastRunFlagged: allNewFlags.length,
      totalReviewed: Object.keys(finalData.reviewed).length,
      totalFlagged: (finalData.flags || []).length,
      lastRunDuration: `${Math.floor(duration / 60)}m ${duration % 60}s`
    };
    finalData.trends = {
      ...trends,
      generatedAt: now,
      ticketsAnalyzed: Object.keys(finalData.reviewed).length
    };
    saveData(finalData);

    console.log(`[AIReview] Complete — ${toReview.length - totalSkippedTickets} reviewed, ${totalSkippedTickets} skipped for retry, ${allNewFlags.length} flagged in ${duration}s`);
    runState = { running: false, progress: 100, phase: 'Complete', startedAt: runState.startedAt, error: null };

  } catch (err) {
    console.error('[AIReview] Run failed:', err.message);
    runState = { running: false, progress: 0, phase: 'Failed', startedAt: runState.startedAt, error: err.message };
  }
}


// ── Analyze individual tech performance holistically ──────────────────────────
async function analyzeTechPerformance(techId, techName, allTickets, timeEntries, reviewedMeta) {
  console.log(`[TechAnalysis] Analyzing ${techName} (${techId})...`);

  const TECH_TIERS_LOCAL = {
    29682924: 1, 29682927: 1,
    29682910: 2, 29682889: 2,
    29682904: 3, 29682899: 3
  };

  // Filter tickets assigned to this tech
  const techTickets = allTickets.filter(t => t.assignedResourceID === techId);
  if (techTickets.length < 10) {
    return { error: 'Insufficient ticket history for analysis (need 10+)' };
  }

  // Build time entry map
  const ticketHoursMap = {};
  timeEntries.forEach(te => {
    if (te.resourceID === techId && te.ticketID) {
      ticketHoursMap[te.ticketID] = (ticketHoursMap[te.ticketID] || 0) + (te.hoursWorked || 0);
    }
  });

  // Group tickets by quarter
  const quarterData = {};
  techTickets.forEach(t => {
    if (!t.createDate) return;
    const d = new Date(t.createDate);
    const q = Math.floor(d.getMonth() / 3) + 1;
    const key = `${d.getFullYear()}-Q${q}`;
    if (!quarterData[key]) quarterData[key] = {
      tickets: [], responseTimes: [], hoursLogged: [],
      escalations: 0, docFlags: 0, oneTouchYes: 0, oneTouchTotal: 0,
      slaBreaches: 0, slaEligible: 0
    };
    const qd = quarterData[key];
    qd.tickets.push(t);

    // Response time (excl low priority + internal)
    if (t.createDate && t.firstResponseDateTime && t.priority !== 4 && t.companyID !== 0) {
      const hrs = (new Date(t.firstResponseDateTime) - new Date(t.createDate)) / (1000 * 60 * 60);
      if (hrs >= 0 && hrs < 720) qd.responseTimes.push(hrs);
    }

    // Hours logged on completed tickets
    if (t.completedDate && ticketHoursMap[t.id] != null) {
      qd.hoursLogged.push(ticketHoursMap[t.id]);
    }

    // Escalation
    const assignedTier = TECH_TIERS_LOCAL[techId] || null;
    if (t.completedByResourceID && t.completedByResourceID !== techId) {
      const completedTier = TECH_TIERS_LOCAL[t.completedByResourceID];
      if (assignedTier && completedTier && completedTier > assignedTier) {
        qd.escalations++;
      }
    }

    // SLA
    if (t.firstResponseDueDateTime) {
      qd.slaEligible++;
      if (!t.firstResponseDateTime || new Date(t.firstResponseDateTime) > new Date(t.firstResponseDueDateTime)) {
        qd.slaBreaches++;
      }
    }

    // FCR
    const oneTouchField = t.userDefinedFields?.find(f => f.name === 'Is One Touch Close');
    if (oneTouchField) {
      qd.oneTouchTotal++;
      if (oneTouchField.value === 'Yes') qd.oneTouchYes++;
    }

    // Doc flags from reviewed metadata
    if (reviewedMeta[t.ticketNumber]?.flagType === 'documentation') {
      qd.docFlags++;
    }
  });

  // Compute per-quarter summaries
  const quarters = Object.keys(quarterData).sort();
  const quarterSummaries = quarters.map(key => {
    const qd = quarterData[key];
    const avgResponseMins = qd.responseTimes.length
      ? Math.round((qd.responseTimes.reduce((a, b) => a + b, 0) / qd.responseTimes.length) * 60) : null;
    const avgResolutionMins = qd.hoursLogged.length
      ? Math.round((qd.hoursLogged.reduce((a, b) => a + b, 0) / qd.hoursLogged.length) * 60) : null;
    const fcrRate = qd.oneTouchTotal > 0
      ? Math.round((qd.oneTouchYes / qd.oneTouchTotal) * 100) : null;
    const slaBreachRate = qd.slaEligible > 0
      ? Math.round((qd.slaBreaches / qd.slaEligible) * 100) : null;
    const notesIssueRate = qd.tickets.length > 0
      ? Math.round((qd.docFlags / qd.tickets.length) * 100) : null;
    return {
      quarter: key,
      ticketCount: qd.tickets.length,
      avgResponseMins,
      avgResolutionMins,
      escalations: qd.escalations,
      slaBreachRate,
      fcrRate,
      notesIssueRate
    };
  });

  // QoQ comparison — current vs prior quarter
  const now = new Date();
  const currentQ = Math.floor(now.getMonth() / 3) + 1;
  const currentQKey = `${now.getFullYear()}-Q${currentQ}`;
  const priorQNum = currentQ === 1 ? 4 : currentQ - 1;
  const priorQYear = currentQ === 1 ? now.getFullYear() - 1 : now.getFullYear();
  const priorQKey = `${priorQYear}-Q${priorQNum}`;

  const currentQData = quarterSummaries.find(q => q.quarter === currentQKey);
  const priorQData = quarterSummaries.find(q => q.quarter === priorQKey);

  // Send to Claude for narrative
  const prompt = `You are writing a performance summary for an IT support technician at an MSP, for executive review.

TECHNICIAN: ${techName}
TIER: ${TECH_TIERS_LOCAL[techId] ? `Tier ${TECH_TIERS_LOCAL[techId]}` : 'Unknown'}

QUARTERLY PERFORMANCE DATA (last ${quarters.length} quarters):
${JSON.stringify(quarterSummaries, null, 2)}

CURRENT QUARTER (${currentQKey}):
${JSON.stringify(currentQData || 'No data yet', null, 2)}

PRIOR QUARTER (${priorQKey}):
${JSON.stringify(priorQData || 'No data yet', null, 2)}

METRIC DEFINITIONS:
- avgResponseMins: Average minutes from ticket creation to first response (lower = better, exclude low priority)
- avgResolutionMins: Average minutes of logged work on completed tickets (lower = better)
- escalations: Number of tickets escalated to a higher tier tech (context dependent)
- slaBreachRate: % of tickets where first response exceeded SLA deadline (lower = better)
- fcrRate: % of tickets closed as one-touch (higher = better, target 90%+)
- notesIssueRate: % of tickets flagged by AI for documentation issues (lower = better)

Write a concise executive performance summary with:
1. STRENGTHS: 2-3 specific things this tech does well based on the data
2. CONCERNS: 2-3 specific areas needing attention (if any)
3. TRENDS: What direction are their key metrics heading quarter over quarter?
4. RECOMMENDATION: One clear action item for management

Keep each section to 2-3 sentences. Be specific and data-driven. If data is insufficient for a section, say so briefly.

Return ONLY a JSON object:
{
  "strengths": "paragraph text",
  "concerns": "paragraph text or 'No significant concerns identified.'",
  "trends": "paragraph text",
  "recommendation": "one clear sentence"
}`;

  const response = await axios.post('https://api.anthropic.com/v1/messages', {
    model: CLAUDE_MODEL,
    max_tokens: 1000,
    messages: [{ role: 'user', content: prompt }]
  }, {
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': process.env.ANTHROPIC_API_KEY
    }
  });

  let narrative = { strengths: '', concerns: '', trends: '', recommendation: '' };
  try {
    const text = response.data.content[0]?.text || '{}';
    const clean = text.replace(/```json|```/g, '').trim();
    narrative = JSON.parse(clean);
  } catch (err) {
    console.error('[TechAnalysis] Failed to parse narrative:', err.message);
  }

  return {
    techId,
    techName,
    generatedAt: new Date().toISOString(),
    narrative,
    quarterSummaries,
    currentQKey,
    priorQKey,
    currentQ: currentQData || null,
    priorQ: priorQData || null
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.get('/status', (req, res) => {
  const data = loadData();
  res.json({
    lastReviewRun: data.lastReviewRun,
    reviewStats: data.reviewStats || {},
    flags: data.flags || [],
    exclusions: data.exclusions || [],
    trends: data.trends || null,
    prompts: data.prompts || {},
    ignoredTrends: data.ignoredTrends || [],
    // Live run state for polling
    running: runState.running,
    runProgress: runState.progress,
    runPhase: runState.phase,
    runError: runState.error
  });
});

router.get('/companies', async (req, res, next) => {
  try {
    const response = await autotaskClient.post('/Companies/query', {
      filter: [
        { field: 'isActive', op: 'eq', value: true },
        { field: 'companyType', op: 'eq', value: 1 }
      ]
    });
    const companies = (response.data.items || [])
      .map(c => ({ id: c.id, name: c.companyName }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ companies });
  } catch (err) {
    next(err);
  }
});

router.post('/exclusions', (req, res) => {
  const { companyId, companyName, reason } = req.body;
  const data = loadData();
  if (!data.exclusions) data.exclusions = [];
  if (!data.exclusions.find(e => e.companyId === companyId)) {
    data.exclusions.push({
      companyId, companyName,
      reason: reason || 'Excluded by exec',
      addedAt: new Date().toISOString().slice(0, 10)
    });
    saveData(data);
  }
  res.json({ ok: true, exclusions: data.exclusions });
});

router.delete('/exclusions/:companyId', (req, res) => {
  const data = loadData();
  data.exclusions = (data.exclusions || []).filter(
    e => String(e.companyId) !== String(req.params.companyId)
  );
  saveData(data);
  res.json({ ok: true, exclusions: data.exclusions });
});

router.post('/action', (req, res) => {
  const { ticketId, action } = req.body;
  const data = loadData();
  const flag = (data.flags || []).find(f => f.id === ticketId);
  if (flag) {
    flag.action = action;
    flag.actionAt = new Date().toISOString();
    if (data.reviewed[ticketId]) data.reviewed[ticketId].action = action;
    saveData(data);
  }
  res.json({ ok: true });
});

// Fire-and-forget: returns immediately, job runs in background
router.post('/run', (req, res) => {
  if (runState.running) {
    return res.json({ started: false, alreadyRunning: true, progress: runState.progress, phase: runState.phase });
  }
  // Kick off background job — do NOT await
  runReviewJob();
  res.json({ started: true });
});

router.post('/trends/ignore', (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).json({ error: 'key required' });
  const data = loadData();
  if (!data.ignoredTrends) data.ignoredTrends = [];
  if (!data.ignoredTrends.includes(key)) {
    data.ignoredTrends.push(key);
    saveData(data);
  }
  res.json({ ok: true, ignoredTrends: data.ignoredTrends });
});

router.delete('/trends/ignore/:key', (req, res) => {
  const key = decodeURIComponent(req.params.key);
  const data = loadData();
  data.ignoredTrends = (data.ignoredTrends || []).filter(k => k !== key);
  saveData(data);
  res.json({ ok: true, ignoredTrends: data.ignoredTrends });
});

// Admin route — clear all flags (keep reviewed metadata for trend analysis)
router.get('/tech-analysis', (req, res) => {
  const data = loadData();
  res.json({ techAnalysis: data.techAnalysis || {} });
});

router.post('/analyze-tech', async (req, res, next) => {
  const { techId } = req.body;
  if (!techId) return res.status(400).json({ error: 'techId required' });

  try {
    // Load ticket caches
    const fs = require('fs');
    const historicalCache = fs.existsSync('/app/data/tickets-historical.json')
      ? JSON.parse(fs.readFileSync('/app/data/tickets-historical.json', 'utf8')) : {};
    const recentCache = fs.existsSync('/app/data/tickets-recent.json')
      ? JSON.parse(fs.readFileSync('/app/data/tickets-recent.json', 'utf8')) : {};

    // Merge tickets
    const ticketMap = {};
    [...(historicalCache.allTickets || []), ...(recentCache.allTickets || [])].forEach(t => {
      ticketMap[t.id] = t;
    });
    const allTickets = Object.values(ticketMap);

    const { autotaskClient } = require('../utils/autotask');
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    // Fetch time entries for this tech
    const teResponse = await autotaskClient.post('/TimeEntries/query', {
      filter: [
        { field: 'resourceID', op: 'eq', value: techId },
        { field: 'dateWorked', op: 'gte', value: sixMonthsAgo.toISOString() },
        { field: 'ticketID', op: 'exist' }
      ],
      maxRecords: 500
    });
    const timeEntries = teResponse.data.items || [];

    // Load reviewed metadata
    const data = loadData();
    const reviewedMeta = data.reviewed || {};

    // Find tech name from TECH_TIERS
    const techInfo = Object.entries({
      29682924: 'Carlos Agundez', 29682927: 'Ben Holliday',
      29682910: 'Brandon Emby', 29682889: 'Matt Cartrett',
      29682904: 'Rob Coleman', 29682899: 'Chris McDaniel'
    }).find(([id]) => parseInt(id) === parseInt(techId));
    const techName = techInfo?.[1] || `Tech ${techId}`;

    const result = await analyzeTechPerformance(parseInt(techId), techName, allTickets, timeEntries, reviewedMeta);

    // Store result
    if (!data.techAnalysis) data.techAnalysis = {};
    data.techAnalysis[techId] = result;
    saveData(data);

    res.json({ ok: true, analysis: result });
  } catch (err) {
    console.error('[TechAnalysis] Failed:', err.message);
    next(err);
  }
});

router.post('/admin/clear-flags', requireOwner, (req, res) => {
  const data = loadData();
  const count = (data.flags || []).length;
  data.flags = [];
  saveData(data);
  res.json({ ok: true, clearedFlags: count });
});

// One-time cleanup for flags generated before the auto-close-exclusion fix.
// PREVIEW makes no changes — read this response before ever calling apply.
router.get('/admin/auto-close-flag-cleanup-preview', requireOwner, async (req, res, next) => {
  try {
    const data = loadData();
    const { matchedFlags, unresolvedTicketNumbers, flagsMissingTicketNumber } = await computeAutoCloseFlagMatches(data);
    res.json({
      totalFlags: (data.flags || []).length,
      matchCount: matchedFlags.length,
      matches: matchedFlags.map(f => ({
        ticketNumber: f.id,
        company: f.company,
        severity: f.sev,
        flagType: f.flagType,
        summary: f.summary,
        ticketUrl: f.ticketUrl
      })),
      // Flags with no ticketNumber at all — pre-existing bad data, not
      // something this cleanup can resolve. Worth a separate manual look.
      flagsMissingTicketNumber,
      // Ticket numbers that couldn't be resolved to an internal AutoTask ID at
      // all (e.g. a deleted ticket) — not touched by apply, worth a manual look.
      unresolvedTicketNumbers
    });
  } catch (err) {
    next(err);
  }
});

// APPLY — actually removes the matched flags and updates their reviewed
// metadata. Requires { "confirm": true } in the body so this can't be
// triggered by an accidental request. Run the preview route first.
router.post('/admin/auto-close-flag-cleanup-apply', requireOwner, async (req, res, next) => {
  if (req.body?.confirm !== true) {
    return res.status(400).json({ error: 'Pass { "confirm": true } in the request body to apply this cleanup. Run the preview route first.' });
  }
  try {
    const data = loadData();
    const { matchedFlags } = await computeAutoCloseFlagMatches(data);
    const matchedNumbers = new Set(matchedFlags.map(f => f.id));

    data.flags = (data.flags || []).filter(f => !matchedNumbers.has(f.id));

    matchedNumbers.forEach(ticketNumber => {
      if (data.reviewed[ticketNumber]) {
        data.reviewed[ticketNumber] = {
          ...data.reviewed[ticketNumber],
          hasIssues: false,
          flagType: null,
          autoClosedNoResponse: true
        };
      }
    });

    saveData(data);
    res.json({
      ok: true,
      removedCount: matchedFlags.length,
      removedTicketNumbers: [...matchedNumbers],
      remainingFlags: data.flags.length
    });
  } catch (err) {
    next(err);
  }
});

// Admin route — clear reviewed entries from a specific date forward (to fix
// tickets that were incorrectly marked "reviewed" during the model outage)
router.post('/admin/reset-reviewed-since', (req, res) => {
  const { since } = req.body; // ISO date string
  if (!since) return res.status(400).json({ error: 'since (ISO date) required' });
  const cutoff = new Date(since);
  const data = loadData();
  let cleared = 0;
  let kept = 0;
  const newReviewed = {};
  Object.entries(data.reviewed || {}).forEach(([ticketNum, meta]) => {
    const reviewedAt = meta?.reviewedAt ? new Date(meta.reviewedAt) : null;
    if (reviewedAt && reviewedAt >= cutoff) {
      cleared++;
    } else {
      newReviewed[ticketNum] = meta;
      kept++;
    }
  });
  data.reviewed = newReviewed;
  saveData(data);
  res.json({ ok: true, clearedReviewed: cleared, kept, cutoff: cutoff.toISOString() });
});

router.get('/prompts', (req, res) => {
  const data = loadData();
  res.json({
    ticketReview: data.prompts?.ticketReview || DEFAULT_TICKET_REVIEW_PROMPT,
    trendAnalysis: data.prompts?.trendAnalysis || DEFAULT_TREND_ANALYSIS_PROMPT
  });
});

router.post('/prompts', (req, res) => {
  const { ticketReview, trendAnalysis } = req.body;
  const data = loadData();
  data.prompts = {
    ticketReview: ticketReview || null,
    trendAnalysis: trendAnalysis || null
  };
  saveData(data);
  res.json({ ok: true, prompts: data.prompts });
});

router.post('/prompts/reset', (req, res) => {
  const data = loadData();
  data.prompts = {};
  saveData(data);
  res.json({
    ok: true,
    ticketReview: DEFAULT_TICKET_REVIEW_PROMPT,
    trendAnalysis: DEFAULT_TREND_ANALYSIS_PROMPT
  });
});

module.exports = router;