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
const EXCLUDE_CATEGORIES = new Set([104]); // 104 = LUV Credit Card Requests

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
  console.log(`[AIReview] Fetched ${before} tickets, ${allTickets.length} after category filter`);
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
      model: 'claude-sonnet-4-20250514',
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

    // Fetch company names
    runState = { ...runState, phase: 'Fetching company names', progress: 10 };
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
        console.warn(`[AIReview] Batch ${i + 1} skipped after ${retries} retries — marking tickets as reviewed without flags`);
      }

      // Mark batch as reviewed with richer metadata
      batch.forEach(t => {
        const techIds = [t.assignedResourceID, t.completedByResourceID].filter(Boolean);
        const wasEscalated = techIds.length > 1 &&
          techIds.some(id => TECH_TIERS[id]?.tier === 1) &&
          techIds.some(id => TECH_TIERS[id]?.tier >= 2);
        const resolutionDays = t.createDate && t.completedDate
          ? Math.round((new Date(t.completedDate) - new Date(t.createDate)) / (1000 * 60 * 60 * 24))
          : null;
        const aiFlag = aiFlags.find(f => f.ticketNumber === t.ticketNumber);

        reviewed[t.ticketNumber] = {
          reviewedAt: now,
          hasIssues: !!aiFlag,
          // Richer metadata for trend analysis
          companyID: t.companyID,
          issueType: t.issueType || null,
          techId: t.assignedResourceID || null,
          wasEscalated,
          resolutionDays,
          flagType: aiFlag?.flagType || null
        };
      });

      // Build flag objects
      aiFlags.forEach(f => {
        const ticket = batch.find(t => t.ticketNumber === f.ticketNumber);
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
      lastRunReviewed: toReview.length,
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

    console.log(`[AIReview] Complete — ${toReview.length} reviewed, ${allNewFlags.length} flagged in ${duration}s`);
    runState = { running: false, progress: 100, phase: 'Complete', startedAt: runState.startedAt, error: null };

  } catch (err) {
    console.error('[AIReview] Run failed:', err.message);
    runState = { running: false, progress: 0, phase: 'Failed', startedAt: runState.startedAt, error: err.message };
  }
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