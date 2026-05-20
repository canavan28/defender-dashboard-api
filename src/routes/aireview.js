const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { autotaskClient, getHeaders } = require('../utils/autotask');

const DATA_FILE = '/app/data/reviewed.json';
const AUTOTASK_ZONE = (process.env.AUTOTASK_ZONE_URL || '').replace('/ATServicesRest', '') || 'https://ww14.autotask.net';

// ── Constants ─────────────────────────────────────────────────────────────────
const INCLUDE_QUEUES = [5, 29682833, 29683482, 29683496, 29683497];

const TECH_TIERS = {
  29682924: { name: 'Carlos Agundez', tier: 1 },
  29682927: { name: 'Ben Holliday', tier: 1 },
  29682910: { name: 'Brandon Emby', tier: 2 },
  29682889: { name: 'Matt Cartrett', tier: 2 },
  29682904: { name: 'Rob Coleman', tier: 3 },
  29682899: { name: 'Chris McDaniel', tier: 3 }
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
  return { reviewed: {}, lastReviewRun: null, reviewStats: {}, exclusions: [], flags: [] };
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
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

  const queueFilter = {
    op: 'or',
    items: INCLUDE_QUEUES.map(id => ({ field: 'queueID', op: 'eq', value: id }))
  };

  const filter = [
    queueFilter,
    { field: 'createDate', op: 'gte', value: sixMonthsAgo.toISOString() }
  ];

  let allTickets = [];
  let nextPageUrl = null;

  const firstResponse = await autotaskClient.post('/Tickets/query', {
    filter, maxRecords: 500
  });
  allTickets = [...(firstResponse.data.items || [])];
  nextPageUrl = firstResponse.data.pageDetails?.nextPageUrl || null;

  while (nextPageUrl) {
    await new Promise(r => setTimeout(r, 300));
    const response = await axios.post(nextPageUrl, { filter, maxRecords: 500 }, { headers: getHeaders() });
    allTickets = [...allTickets, ...(response.data.items || [])];
    nextPageUrl = response.data.pageDetails?.nextPageUrl || null;
  }

  console.log(`[AIReview] Fetched ${allTickets.length} tickets from approved queues`);
  return allTickets;
}

// ── Fetch company names ────────────────────────────────────────────────────────
async function fetchCompanyNames(companyIds) {
  if (!companyIds.length) return {};
  const companyMap = {};
  try {
    const response = await autotaskClient.post('/Companies/query', {
      filter: [{ field: 'id', op: 'in', value: companyIds }]
    });
    (response.data.items || []).forEach(c => {
      companyMap[c.id] = c.companyName;
    });
  } catch (err) {
    console.warn('[AIReview] Could not fetch company names:', err.message);
  }
  return companyMap;
}

// ── Analyze a batch of tickets with Claude ────────────────────────────────────
async function analyzeBatch(batch, companyMap) {
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

  const prompt = `You are reviewing IT support tickets for an MSP looking for issues needing executive attention.

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
${JSON.stringify(ticketSummaries, null, 2)}

COMPANY GROUPINGS:
${JSON.stringify(Object.entries(byCompany).map(([id, tickets]) => ({
    companyId: id,
    ticketCount: tickets.length,
    issueTypes: [...new Set(tickets.map(t => t.issueType))]
  })), null, 2)}

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

  const response = await axios.post('https://api.anthropic.com/v1/messages', {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }]
  }, {
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': process.env.ANTHROPIC_API_KEY
    }
  });

  try {
    const content = response.data.content[0]?.text || '[]';
    const clean = content.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (err) {
    console.error('[AIReview] Failed to parse Claude response:', err.message);
    return [];
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.get('/status', (req, res) => {
  const data = loadData();
  res.json({
    lastReviewRun: data.lastReviewRun,
    reviewStats: data.reviewStats || {},
    flags: data.flags || [],
    exclusions: data.exclusions || []
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

router.post('/run', async (req, res, next) => {
  const startTime = Date.now();
  try {
    const data = loadData();
    const excludedCompanyIds = new Set((data.exclusions || []).map(e => e.companyId));
    const reviewed = data.reviewed || {};

    // Fetch all tickets from approved queues
    console.log('[AIReview] Fetching all tickets from approved queues...');
    const allTickets = await fetchAllTicketsForReview();

    // Filter to unreviewed tickets not in excluded companies
    const toReview = allTickets.filter(t =>
      !reviewed[t.ticketNumber] &&
      !excludedCompanyIds.has(t.companyID)
    );

    console.log(`[AIReview] ${toReview.length} unreviewed tickets to process`);

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
      return res.json({
        ok: true, reviewed: 0, flagged: 0,
        flags: data.flags || [],
        message: 'All tickets already reviewed'
      });
    }

    // Fetch company names for all tickets
    const companyIds = [...new Set(toReview.map(t => t.companyID).filter(Boolean))];
    const companyMap = await fetchCompanyNames(companyIds);

    // Process in batches of 50
    const BATCH_SIZE = 50;
    const batches = [];
    for (let i = 0; i < toReview.length; i += BATCH_SIZE) {
      batches.push(toReview.slice(i, i + BATCH_SIZE));
    }

    console.log(`[AIReview] Processing ${batches.length} batches of up to ${BATCH_SIZE} tickets...`);

    const allNewFlags = [];
    const now = new Date().toISOString();

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      console.log(`[AIReview] Batch ${i + 1}/${batches.length} — ${batch.length} tickets`);

      // Analyze with Claude
      let aiFlags = [];
      let retries = 0;
      while (retries < 3) {
        try {
          aiFlags = await analyzeBatch(batch, companyMap);
          break;
        } catch (err) {
          if (err.response?.status === 429 && retries < 2) {
            console.log(`[AIReview] Rate limited, waiting 30s before retry ${retries + 1}...`);
            await new Promise(r => setTimeout(r, 30000));
            retries++;
          } else {
            console.error(`[AIReview] Batch ${i + 1} failed:`, err.message);
            break;
          }
        }
      }

      // Mark batch as reviewed
      batch.forEach(t => {
        reviewed[t.ticketNumber] = {
          reviewedAt: now,
          hasIssues: aiFlags.some(f => f.ticketNumber === t.ticketNumber)
        };
      });

      // Build flag objects
      aiFlags.forEach(f => {
        const ticket = batch.find(t => t.ticketNumber === f.ticketNumber);
        const companyName = ticket ? (companyMap[ticket.companyID] || 'Unknown Company') : 'Unknown Company';
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
          tech: ticket?.techInvolved || '',
          openedDays: ticket?.openDays,
          ticketUrl: ticketUrl(f.ticketNumber),
          dateFlagged: now,
          action: 'unactioned',
          timeline: []
        });
      });

      // Save progress after each batch
      data.reviewed = reviewed;
      const existingActioned = (data.flags || []).filter(f => f.action !== 'unactioned');
      const allFlags = [...existingActioned, ...allNewFlags];
      const sevRank = { critical: 0, high: 1, medium: 2, low: 3 };
      allFlags.sort((a, b) => (sevRank[a.sev] || 3) - (sevRank[b.sev] || 3));
      data.flags = allFlags;
      saveData(data);

      // Small delay between batches to avoid rate limits
      if (i < batches.length - 1) {
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    const duration = Math.round((Date.now() - startTime) / 1000);
    const finalData = loadData();

    finalData.lastReviewRun = now;
    finalData.reviewStats = {
      lastRunAt: now,
      lastRunReviewed: toReview.length,
      lastRunFlagged: allNewFlags.length,
      totalReviewed: Object.keys(finalData.reviewed).length,
      totalFlagged: (finalData.flags || []).length,
      lastRunDuration: `${Math.floor(duration / 60)}m ${duration % 60}s`
    };
    saveData(finalData);

    console.log(`[AIReview] Complete — ${toReview.length} reviewed, ${allNewFlags.length} flagged in ${duration}s`);

    res.json({
      ok: true,
      reviewed: toReview.length,
      flagged: allNewFlags.length,
      flags: finalData.flags || []
    });
  } catch (err) {
    console.error('[AIReview] Run failed:', err.message);
    next(err);
  }
});

module.exports = router;