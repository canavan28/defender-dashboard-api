const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { autotaskClient } = require('../utils/autotask');

const DATA_FILE = '/app/data/reviewed.json';
const AUTOTASK_ZONE = process.env.AUTOTASK_ZONE_URL?.replace('/ATServicesRest', '') || 'https://ww14.autotask.net';

// ── Severity and flag type definitions ────────────────────────────────────────
const TECH_TIERS = {
  29682924: { name: 'Carlos Agundez', tier: 1 },
  29682927: { name: 'Ben Holliday',   tier: 1 },
  29682910: { name: 'Brandon Emby',   tier: 2 },
  29682889: { name: 'Matt Cartrett',  tier: 2 },
  29682904: { name: 'Rob Coleman',    tier: 3 },
  29682899: { name: 'Chris McDaniel', tier: 3 }
};

// ── PII scrubbing ──────────────────────────────────────────────────────────────
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

// ── Load/save reviewed data ────────────────────────────────────────────────────
function loadReviewed() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('[AIReview] Error loading data file:', err.message);
  }
  return { reviewed: {}, lastReviewRun: null, reviewStats: {}, exclusions: [], flags: [] };
}

function saveReviewed(data) {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('[AIReview] Error saving data file:', err.message);
  }
}

// ── Build AutoTask ticket URL ─────────────────────────────────────────────────
function ticketUrl(ticketNumber) {
  return `${AUTOTASK_ZONE}/Autotask/AutotaskExtend/ExecuteCommand.aspx?Code=OpenTicketDetail&TicketNumber=${ticketNumber}`;
}

// ── GET /api/aireview/status ──────────────────────────────────────────────────
router.get('/status', (req, res) => {
  const data = loadReviewed();
  res.json({
    lastReviewRun: data.lastReviewRun,
    reviewStats: data.reviewStats || {},
    flags: data.flags || [],
    exclusions: data.exclusions || []
  });
});

// ── GET /api/aireview/companies ───────────────────────────────────────────────
// Returns list of company names from AutoTask for the exclusion search
router.get('/companies', async (req, res, next) => {
  try {
    const response = await autotaskClient.post('/Companies/query', {
      filter: [
        { field: 'isActive', op: 'eq', value: true },
        { field: 'companyType', op: 'eq', value: 1 } // 1 = Customer
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

// ── POST /api/aireview/exclusions ─────────────────────────────────────────────
router.post('/exclusions', (req, res) => {
  const { companyId, companyName, reason } = req.body;
  const data = loadReviewed();
  if (!data.exclusions) data.exclusions = [];
  if (!data.exclusions.find(e => e.companyId === companyId)) {
    data.exclusions.push({
      companyId,
      companyName,
      reason: reason || 'Excluded by exec',
      addedAt: new Date().toISOString().slice(0, 10)
    });
    saveReviewed(data);
  }
  res.json({ ok: true, exclusions: data.exclusions });
});

// ── DELETE /api/aireview/exclusions/:companyId ────────────────────────────────
router.delete('/exclusions/:companyId', (req, res) => {
  const data = loadReviewed();
  data.exclusions = (data.exclusions || []).filter(
    e => String(e.companyId) !== String(req.params.companyId)
  );
  saveReviewed(data);
  res.json({ ok: true, exclusions: data.exclusions });
});

// ── POST /api/aireview/action ─────────────────────────────────────────────────
router.post('/action', (req, res) => {
  const { ticketId, action } = req.body;
  const data = loadReviewed();
  const flag = (data.flags || []).find(f => f.id === ticketId);
  if (flag) {
    flag.action = action;
    flag.actionAt = new Date().toISOString();
    if (data.reviewed[ticketId]) {
      data.reviewed[ticketId].action = action;
    }
    saveReviewed(data);
  }
  res.json({ ok: true });
});

// ── POST /api/aireview/run ────────────────────────────────────────────────────
router.post('/run', async (req, res, next) => {
  try {
    const data = loadReviewed();
    const excludedCompanyIds = new Set(
      (data.exclusions || []).map(e => e.companyId)
    );
    const reviewed = data.reviewed || {};

    // Fetch recent tickets for review (last 6 months)
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    console.log('[AIReview] Fetching tickets for review...');
    const ticketResponse = await autotaskClient.post('/Tickets/query', {
      filter: [
        { field: 'createDate', op: 'gte', value: sixMonthsAgo.toISOString() }
      ],
      maxRecords: 500
    });

    const allTickets = ticketResponse.data.items || [];

    // Filter out already reviewed, excluded companies, and get unreviewed
    const toReview = allTickets.filter(t =>
      !reviewed[t.ticketNumber] &&
      !excludedCompanyIds.has(t.companyID)
    ).slice(0, 50); // Process 50 at a time

    console.log(`[AIReview] Reviewing ${toReview.length} new tickets...`);

    if (toReview.length === 0) {
      data.lastReviewRun = new Date().toISOString();
      data.reviewStats = {
        ...data.reviewStats,
        lastRunAt: new Date().toISOString(),
        lastRunReviewed: 0,
        lastRunFlagged: 0,
        totalReviewed: Object.keys(reviewed).length
      };
      saveReviewed(data);
      return res.json({
        ok: true,
        reviewed: 0,
        flagged: 0,
        flags: data.flags || []
      });
    }

    // Fetch company names for tickets
    const companyIds = [...new Set(toReview.map(t => t.companyID).filter(Boolean))];
    const companyMap = {};
    if (companyIds.length > 0) {
      try {
        const companyResponse = await autotaskClient.post('/Companies/query', {
          filter: [{ field: 'id', op: 'in', value: companyIds }]
        });
        (companyResponse.data.items || []).forEach(c => {
          companyMap[c.id] = c.companyName;
        });
      } catch (err) {
        console.warn('[AIReview] Could not fetch company names:', err.message);
      }
    }

    // Build batch prompt for Claude
    const ticketSummaries = toReview.map(t => {
      const techIds = [t.assignedResourceID, t.completedByResourceID].filter(Boolean);
      const techInfo = techIds.map(id => {
        const tech = TECH_TIERS[id];
        return tech ? `${tech.name} (Tier ${tech.tier})` : `Unknown (ID: ${id})`;
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
        description: scrubPII((t.description || '').substring(0, 500)),
      };
    });

    // Group by company for cross-customer trend detection
    const byCompany = {};
    ticketSummaries.forEach(t => {
      if (!byCompany[t.companyId]) byCompany[t.companyId] = [];
      byCompany[t.companyId].push(t);
    });

    // Call Claude API
    const prompt = `You are reviewing IT support tickets for an MSP (managed service provider) looking for issues that need executive attention.

Review the following tickets and identify any that warrant flagging. For each flagged ticket return a JSON object.

WHAT TO LOOK FOR:
1. customer-health: Customer frustration signals, repeat issues, long resolution times, multiple follow-ups
2. cross-customer: Same issue type appearing across multiple users at the same company (flag the company pattern)
3. escalation: Ticket started with Tier 1 tech but required Tier 2 or Tier 3 to resolve
4. tech-performance: Unusually long resolution for the issue type, confusing back-and-forth, misdiagnosis
5. documentation: Time entries with no notes, resolutions with no description
6. reopen: Ticket that appears to have been reopened after closure

SEVERITY LEVELS:
- critical: Requires immediate executive attention (major customer frustration, serious mishandling)
- high: Should be reviewed this week
- medium: Worth noting, review when time allows
- low: Informational, pattern to watch

TICKETS TO REVIEW:
${JSON.stringify(ticketSummaries, null, 2)}

COMPANY GROUPINGS (for cross-customer detection):
${JSON.stringify(Object.entries(byCompany).map(([id, tickets]) => ({
  companyId: id,
  ticketCount: tickets.length,
  issueTypes: [...new Set(tickets.map(t => t.issueType))]
})), null, 2)}

Return ONLY a JSON array of flagged tickets. If no tickets warrant flagging return an empty array [].
Each flagged ticket must have this exact shape:
{
  "ticketNumber": "T20260101.0001",
  "severity": "critical|high|medium|low",
  "flagType": "customer-health|cross-customer|escalation|tech-performance|documentation|reopen",
  "summary": "One sentence summary of the issue",
  "reasons": ["Reason 1", "Reason 2"],
  "notesForExec": "Brief actionable note for the executive"
}

Return only the JSON array, no other text.`;

    console.log('[AIReview] Calling Claude API...');
    const claudeResponse = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }]
    }, {
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': process.env.ANTHROPIC_API_KEY
      }
    });

    let aiFlags = [];
    try {
      const content = claudeResponse.data.content[0]?.text || '[]';
      const clean = content.replace(/```json|```/g, '').trim();
      aiFlags = JSON.parse(clean);
    } catch (parseErr) {
      console.error('[AIReview] Failed to parse Claude response:', parseErr.message);
    }

    console.log(`[AIReview] Claude flagged ${aiFlags.length} tickets`);

    // Mark all reviewed tickets
    const now = new Date().toISOString();
    toReview.forEach(t => {
      reviewed[t.ticketNumber] = {
        reviewedAt: now,
        hasIssues: aiFlags.some(f => f.ticketNumber === t.ticketNumber)
      };
    });

    // Build full flag objects
    const newFlags = aiFlags.map(f => {
      const ticket = toReview.find(t => t.ticketNumber === f.ticketNumber);
      const companyName = ticket ? (companyMap[ticket.companyID] || 'Unknown Company') : 'Unknown Company';
      return {
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
        tech: ticket?.techInvolved || '',
        openedDays: ticket?.openDays,
        ticketUrl: ticketUrl(f.ticketNumber),
        dateFlagged: now,
        action: 'unactioned',
        timeline: []
      };
    });

    // Merge with existing flags (keep actioned ones, add new ones)
    const existingFlags = (data.flags || []).filter(f => f.action !== 'unactioned');
    const allFlags = [...existingFlags, ...newFlags];

    // Sort by severity
    const sevRank = { critical: 0, high: 1, medium: 2, low: 3 };
    allFlags.sort((a, b) => (sevRank[a.sev] || 3) - (sevRank[b.sev] || 3));

    data.reviewed = reviewed;
    data.flags = allFlags;
    data.lastReviewRun = now;
    data.reviewStats = {
      lastRunAt: now,
      lastRunReviewed: toReview.length,
      lastRunFlagged: newFlags.length,
      totalReviewed: Object.keys(reviewed).length,
      totalFlagged: allFlags.length
    };

    saveReviewed(data);

    res.json({
      ok: true,
      reviewed: toReview.length,
      flagged: newFlags.length,
      flags: allFlags
    });
  } catch (err) {
    console.error('[AIReview] Run failed:', err.message);
    next(err);
  }
});

module.exports = router;