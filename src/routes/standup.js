const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { autotaskClient } = require('../utils/autotask');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ── File paths — reading existing caches/data files directly, same pattern
// aireview.js's /analyze-tech route already uses to read tickets-historical.json
// and tickets-recent.json off disk rather than re-fetching from AutoTask.
const CACHE_DIR = '/app/data';
const TICKETS_HISTORICAL_FILE = path.join(CACHE_DIR, 'tickets-historical.json');
const TICKETS_RECENT_FILE = path.join(CACHE_DIR, 'tickets-recent.json');
const REVIEWED_FILE = path.join(CACHE_DIR, 'reviewed.json');

// ── Constants confirmed via diagnostic testing this session ──────────────────

// Ticket status IDs — AutoTask has no plain "Scheduled" status, only these two
// (confirmed by Matt directly, not decoded from a picklist call — Tickets'
// status picklist was never pulled since Tasks' picklist, which shares most of
// the same labels, already showed both "Scheduled - Phone Call" (22) and
// "Scheduled - Onsite" (41) and Matt confirmed both count as "Scheduled" here).
const SCHEDULED_STATUS_IDS = [22, 41];
const SCHEDULED_STATUS_LABELS = { 22: 'Scheduled - Phone Call', 41: 'Scheduled - Onsite' };

// "Open" ticket definition — reused EXACTLY from tickets.js's EXCLUDE_STATUSES
// ([5, 20] = Complete, RMM Resolved) rather than redefining "open" a second
// time. We read recentCache.openTickets directly below, which tickets.js
// already builds using this exact status exclusion, so we don't even need to
// re-apply the filter ourselves here.

// Web Dev exclusion for dragging tickets — confirmed via /api/diagnostic/
// ticket-fields this session. Tickets have NO department field at all
// (unlike Projects/Tasks), so this uses queueID (29683481 = "Web
// Development") and issueType (19 = "Web Development") instead. The
// queueID check is likely already redundant with tickets.js's own
// INCLUDE_QUEUES list (which omits 29683481), but is kept here as an
// explicit, self-contained safeguard rather than relying on that
// upstream list never changing. issueType is the one doing real work,
// since Web Dev tickets can still land in a shared/general queue.
const WEB_DEV_QUEUE_ID = 29683481;
const WEB_DEV_ISSUE_TYPE = 19;

// Web Dev team members — confirmed via /api/diagnostic/resource-search
// this session. Notably, these exact three IDs already appear in
// tickets.js's own EXCLUDE_RESOURCES list (used there for time-entry/
// response-time exclusions) — a strong independent confirmation these
// are the right people. Mark Lamson shows isActive:true in AutoTask
// despite no longer being an employee per Matt — that's a stale AutoTask
// record, not a bug here; his ID is still valid for excluding his past
// tickets regardless of his current active status.
const WEB_DEV_RESOURCE_IDS = new Set([29682893, 29682894, 29682895]); // Joe Lozier, Carissa Malone, Mark Lamson

// Dragging-ticket thresholds — confirmed with Matt, all three are OR'd, not AND'd
const DRAGGING_DAYS_OPEN_THRESHOLD = 3;
const DRAGGING_HOURS_NO_ACTIVITY_THRESHOLD = 48;
const DRAGGING_TIME_ENTRY_THRESHOLD = 4;

// Project constants — confirmed via /api/diagnostic/project-fields this session
const ENGINEERING_DEPARTMENT_ID = 29683471;
const OPEN_PROJECT_STATUSES = [1, 2, 3, 6, 7]; // New, In Progress, On Hold, Waiting Parts, Waiting Customer
const PROJECT_STATUS_LABELS = {
  1: 'New', 2: 'In Progress', 3: 'On Hold', 6: 'Waiting Parts', 7: 'Waiting Customer',
  5: 'Complete', 0: 'Inactive', 4: 'Change Order'
};
const CLIENT_PROJECT_TYPE = 5; // excludes Template(3)/Proposal(2)/Internal(4)/Baseline(8)

// ── File helpers ──────────────────────────────────────────────────────────────
function loadJsonFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (err) {
    console.error(`[Standup] Failed to load ${filePath}:`, err.message);
  }
  return null;
}

// ── Company name resolution — same pattern used in tickets.js/aireview.js ────
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
      if (i + CHUNK < companyIds.length) await sleep(300);
    }
  } catch (err) {
    console.warn('[Standup] Could not fetch company names:', err.message);
  }
  companyMap['0'] = 'InfoTank (Internal)';
  return companyMap;
}

// ── Resource (tech) name resolution ───────────────────────────────────────────
async function fetchResourceNames() {
  const map = {};
  try {
    const response = await autotaskClient.post('/Resources/query', {
      filter: [{ field: 'isActive', op: 'eq', value: true }]
    });
    (response.data.items || []).forEach(r => {
      map[r.id] = `${r.firstName} ${r.lastName}`;
    });
  } catch (err) {
    console.warn('[Standup] Could not fetch resource names:', err.message);
  }
  return map;
}

// ── Time entry counts per ticket — bulk query using the 'in' operator ────────
// NOTE: 'in' is confirmed working on /Companies/query elsewhere in this
// codebase but has NOT been tested on /TimeEntries/query before now. If this
// throws/400s, that's useful diagnostic signal — the error will surface in
// the route's response via the catch-all below, and we'll need to either
// fall back to per-ticket queries or find the right op for this entity.
async function fetchTimeEntryCounts(ticketIds) {
  const counts = {};
  if (!ticketIds.length) return counts;
  const CHUNK = 500;
  for (let i = 0; i < ticketIds.length; i += CHUNK) {
    const chunk = ticketIds.slice(i, i + CHUNK);
    const response = await autotaskClient.post('/TimeEntries/query', {
      filter: [{ field: 'ticketID', op: 'in', value: chunk }],
      maxRecords: 500
    });
    (response.data.items || []).forEach(te => {
      counts[te.ticketID] = (counts[te.ticketID] || 0) + 1;
    });
    if (i + CHUNK < ticketIds.length) await sleep(300);
  }
  return counts;
}

// ── Projects — open-status filter shared by both the Engineering and
// Onboarding project queries ───────────────────────────────────────────────
async function fetchOpenProjects(extraFilters) {
  const statusFilter = {
    op: 'or',
    items: OPEN_PROJECT_STATUSES.map(s => ({ field: 'status', op: 'eq', value: s }))
  };
  const response = await autotaskClient.post('/Projects/query', {
    filter: [...extraFilters, statusFilter],
    maxRecords: 500
  });
  // NOTE: no pagination handling. Diagnostic testing this session showed only
  // a handful of currently-open projects in either category, so a single page
  // should always cover it — but if pageDetails.nextPageUrl ever comes back
  // truthy, that's the signal this needs pagination added (same POST-based
  // pattern used elsewhere in this project for Tickets pagination).
  if (response.data.pageDetails?.nextPageUrl) {
    console.warn('[Standup] Projects query has more pages than fetched — pagination needed!');
  }
  return response.data.items || [];
}

async function fetchProjectTasks(projectId) {
  const response = await autotaskClient.post('/Tasks/query', {
    filter: [{ field: 'projectID', op: 'eq', value: projectId }],
    maxRecords: 500
  });
  return response.data.items || [];
}

// ── Route ──────────────────────────────────────────────────────────────────
router.get('/data', async (req, res, next) => {
  try {
    const now = new Date();
    const nowMs = now.getTime();

    // ── Tickets: read straight from tickets.js's existing disk caches ──────
    // recentCache.openTickets is EXACTLY tickets.js's own "open" definition
    // (status not in [5, 20]) — reused as-is, not redefined here.
    const recentCache = loadJsonFile(TICKETS_RECENT_FILE);
    const openTickets = recentCache?.openTickets || [];

    if (!recentCache) {
      console.warn('[Standup] tickets-recent.json not found on disk — has the main dashboard synced tickets at least once?');
    }

    // ── Scheduled tickets ───────────────────────────────────────────────────
    const scheduledTicketsRaw = openTickets.filter(t => SCHEDULED_STATUS_IDS.includes(t.status));

    // ── Dragging tickets — needs a live time-entry count per open ticket ───
    const timeEntryCounts = await fetchTimeEntryCounts(openTickets.map(t => t.id));

    const draggingTicketsRaw = openTickets
      .filter(t =>
        t.queueID !== WEB_DEV_QUEUE_ID &&
        t.issueType !== WEB_DEV_ISSUE_TYPE &&
        !WEB_DEV_RESOURCE_IDS.has(t.assignedResourceID)
      )
      .map(t => {
        const created = t.createDate ? new Date(t.createDate).getTime() : null;
        const daysOpen = created ? (nowMs - created) / (1000 * 60 * 60 * 24) : null;
        const lastActivity = t.lastActivityDate ? new Date(t.lastActivityDate).getTime() : null;
        const hoursSinceActivity = lastActivity ? (nowMs - lastActivity) / (1000 * 60 * 60) : null;
        const timeEntryCount = timeEntryCounts[t.id] || 0;

        const reasons = [];
        if (daysOpen != null && daysOpen > DRAGGING_DAYS_OPEN_THRESHOLD) {
          reasons.push(`Open ${daysOpen.toFixed(1)} days`);
        }
        if (hoursSinceActivity != null && hoursSinceActivity > DRAGGING_HOURS_NO_ACTIVITY_THRESHOLD) {
          reasons.push(`No update in ${Math.round(hoursSinceActivity)}h`);
        }
        if (timeEntryCount > DRAGGING_TIME_ENTRY_THRESHOLD) {
          reasons.push(`${timeEntryCount} time entries logged`);
        }

        return { ticket: t, daysOpen, hoursSinceActivity, timeEntryCount, reasons };
      })
      .filter(d => d.reasons.length > 0);

    // ── AI Review escalations — direct read of reviewed.json's flags array ─
    // Restricted to the last 7 days (by dateFlagged, not the underlying
    // ticket's age — a ticket can be old but only just got flagged, or
    // vice versa) since this is a DAILY standup, not a running backlog of
    // every unactioned flag going back months.
    const sevenDaysAgoMs = nowMs - 7 * 24 * 60 * 60 * 1000;
    const reviewedData = loadJsonFile(REVIEWED_FILE);
    const aiEscalations = (reviewedData?.flags || []).filter(f =>
      f.action === 'unactioned' &&
      f.dateFlagged &&
      new Date(f.dateFlagged).getTime() >= sevenDaysAgoMs
    );

    // ── Engineering projects ────────────────────────────────────────────────
    const engineeringProjectsRaw = await fetchOpenProjects([
      { field: 'projectType', op: 'eq', value: CLIENT_PROJECT_TYPE }
    ]);
    // department filter done in JS, not in the AutoTask query itself — we
    // don't have a confirmed "not exists" filter op on this zone, and the
    // result set here is small enough that filtering client-side is cheap
    // and avoids guessing at an unconfirmed filter operator.
    const engineeringProjects = engineeringProjectsRaw.filter(
      p => p.department == null || p.department === ENGINEERING_DEPARTMENT_ID
    );

    await sleep(300);

    // ── Onboarding projects + their overdue tasks ──────────────────────────
    const onboardingProjectsRaw = await fetchOpenProjects([
      { field: 'projectName', op: 'contains', value: 'Onboarding' },
      { field: 'projectType', op: 'eq', value: CLIENT_PROJECT_TYPE }
    ]);

    const onboardingOverdue = [];
    for (const proj of onboardingProjectsRaw) {
      await sleep(200);
      let tasks = [];
      try {
        tasks = await fetchProjectTasks(proj.id);
      } catch (err) {
        console.warn(`[Standup] Failed to fetch tasks for project ${proj.id} (${proj.projectName}):`, err.message);
        continue; // one bad project shouldn't blank the whole onboarding section
      }
      const overdueTasks = tasks.filter(t =>
        !t.completedDateTime && t.endDateTime && new Date(t.endDateTime).getTime() < nowMs
      );
      if (overdueTasks.length > 0) {
        onboardingOverdue.push({ project: proj, overdueTasks });
      }
    }

    // ── Resolve names for everything gathered above ────────────────────────
    const resourceMap = await fetchResourceNames();

    const companyIds = new Set();
    scheduledTicketsRaw.forEach(t => companyIds.add(t.companyID));
    draggingTicketsRaw.forEach(d => companyIds.add(d.ticket.companyID));
    engineeringProjects.forEach(p => companyIds.add(p.companyID));
    onboardingOverdue.forEach(o => companyIds.add(o.project.companyID));
    const companyMap = await fetchCompanyNames([...companyIds].filter(id => id != null));

    // ── Shape response ───────────────────────────────────────────────────────
    const formatTicket = (t) => ({
      id: t.id,
      ticketNumber: t.ticketNumber,
      title: t.title || '',
      companyName: companyMap[String(t.companyID)] || 'Unknown',
      assignedTech: resourceMap[t.assignedResourceID] || 'Unassigned',
      status: t.status,
      statusLabel: SCHEDULED_STATUS_LABELS[t.status] || String(t.status)
    });

    res.json({
      generatedAt: now.toISOString(),

      scheduledTickets: scheduledTicketsRaw.map(formatTicket),

      draggingTickets: draggingTicketsRaw.map(d => ({
        ...formatTicket(d.ticket),
        daysOpen: d.daysOpen != null ? parseFloat(d.daysOpen.toFixed(1)) : null,
        hoursSinceActivity: d.hoursSinceActivity != null ? Math.round(d.hoursSinceActivity) : null,
        timeEntryCount: d.timeEntryCount,
        reasons: d.reasons
      })),

      aiEscalations,

      engineeringProjects: engineeringProjects.map(p => ({
        id: p.id,
        projectName: p.projectName,
        companyName: companyMap[String(p.companyID)] || 'Unknown',
        status: p.status,
        statusLabel: PROJECT_STATUS_LABELS[p.status] || String(p.status),
        percentComplete: p.completedPercentage,
        endDateTime: p.endDateTime,
        isOverdue: !!(p.endDateTime && new Date(p.endDateTime).getTime() < nowMs),
        projectLead: resourceMap[p.projectLeadResourceID] || null
      })),

      onboardingOverdue: onboardingOverdue.map(o => ({
        projectId: o.project.id,
        projectName: o.project.projectName,
        companyName: companyMap[String(o.project.companyID)] || 'Unknown',
        percentComplete: o.project.completedPercentage,
        tasks: o.overdueTasks.map(t => ({
          taskNumber: t.taskNumber,
          title: t.title,
          assignedTech: resourceMap[t.assignedResourceID] || 'Unassigned',
          endDateTime: t.endDateTime,
          daysOverdue: Math.floor((nowMs - new Date(t.endDateTime).getTime()) / (1000 * 60 * 60 * 24))
        }))
      }))
    });

  } catch (err) {
    next(err);
  }
});

module.exports = router;