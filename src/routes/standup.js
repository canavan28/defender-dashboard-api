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

// Dragging-ticket rules — revised with Matt after the first version showed
// 34 tickets, too long for a daily standup. A ticket is "dragging" if it is
// NOT Waiting Customer / On Hold (those are expected to sit) AND any of:
//   A) no update in 48+ hours
//   B) open more than 7 days AND no update in 24+ hours
//   C) more than 5 time entries logged (regardless of how recent the activity)
const DRAGGING_EXCLUDED_STATUSES = new Set([7, 17]); // 7 = Waiting Customer, 17 = On Hold
const DRAGGING_STALLED_HOURS = 48;
const DRAGGING_AGED_DAYS = 7;
const DRAGGING_AGED_STALLED_HOURS = 24;
const DRAGGING_TIME_ENTRY_THRESHOLD = 5; // "more than 5" => 6+

// AI escalations shown on the standup: only these severities (Matt: "High
// and Critical"). Lower severities are counted but not listed.
const AI_ESCALATION_SEVERITIES = new Set(['critical', 'high']);
const AI_SEV_RANK = { critical: 0, high: 1 };

// Full ticket status picklist — decoded from /api/diagnostic/ticket-fields.
// Replaces the earlier scheduled-only label map so dragging tickets show a
// readable status instead of a raw number.
const TICKET_STATUS_LABELS = {
  1: 'New', 5: 'Complete', 7: 'Waiting Customer', 8: 'In Progress', 9: 'Waiting Materials',
  10: 'Assigned', 11: 'Escalate', 12: 'Waiting Vendor', 16: 'Work Complete', 17: 'On Hold',
  19: 'Customer Note Added', 20: 'RMM Resolved', 21: 'Co-Managed', 22: 'Scheduled - Phone Call',
  23: 'Re-Opened', 24: 'Waiting on Engineer', 25: 'Acknowledged', 26: '1st Attempt',
  27: '2nd Attempt', 29: 'Needs Review', 30: 'Escalated', 31: 'Scheduled for Remote',
  32: 'Scheduled for Onsite', 33: 'Scheduled for Flex', 34: 'Auto Dispatch', 35: 'Procurement',
  36: 'Approval Pending', 37: 'Not Approved', 39: 'Hot Swap', 40: 'In Transit', 41: 'Scheduled - Onsite'
};

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
  // Same pagination caveat as fetchOpenProjects: a single project's task
  // list has been well under 500 in every sample pulled (largest seen: 40),
  // but if this ever warns, the task counts below would be undercounted.
  if (response.data.pageDetails?.nextPageUrl) {
    console.warn(`[Standup] Tasks query for project ${projectId} has more pages than fetched — pagination needed!`);
  }
  return response.data.items || [];
}

// A task counts as done if it has a completedDateTime OR its status is
// Complete (5). Used for BOTH the progress count and the overdue-task
// check so the two can never disagree about whether a task is finished.
function isTaskDone(t) {
  return !!t.completedDateTime || t.status === 5;
}

// "% Complete - Tasks" — what AutoTask's own project page shows as
// "0 of 3 (0%)". Deliberately NOT the project's completedPercentage
// field, which is the HOURS-based percentage ("% Complete - Hours") and
// reads 100% whenever logged hours meet the estimate, even with tasks
// still open. Returns null when the project has no tasks (or the task
// fetch failed), so the UI can show a dash instead of a fake 0%.
function summarizeTaskProgress(tasks) {
  if (!tasks || tasks.length === 0) return null;
  const done = tasks.filter(isTaskDone).length;
  return { done, total: tasks.length, percent: Math.round((done / tasks.length) * 100) };
}

// ── AI flag de-duplication ───────────────────────────────────────────────────
// Many flags are the same alert firing repeatedly (e.g. the same Datto backup
// error raised as 5 separate tickets). Two flags are treated as duplicates
// when their normalized titles match: lowercased, parenthetical bits (device
// IDs like "(405b7f640de0)") and long hex strings removed, leading Fw:/Re:
// stripped, punctuation collapsed. Titles that are merely reworded versions
// of the same alert will NOT match — that's a deliberate limit, since a
// looser rule (e.g. same company + same flag type) would merge genuinely
// different problems at a busy client.
function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/^\s*((fw|fwd|re)\s*:\s*)+/g, '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b[0-9a-f]{8,}\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Keeps one flag per duplicate group — the most severe, then most recently
// flagged — and records how many others it stands in for. Nothing is
// silently dropped: the UI shows "+N similar" on the survivor.
function groupDuplicateFlags(flags) {
  const groups = new Map();
  for (const f of flags) {
    const key = normalizeTitle(f.title) || `__untitled__${f.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  const best = (a, b) => {
    const sevDiff = (AI_SEV_RANK[a.sev] ?? 9) - (AI_SEV_RANK[b.sev] ?? 9);
    if (sevDiff !== 0) return sevDiff;
    return new Date(b.dateFlagged).getTime() - new Date(a.dateFlagged).getTime();
  };
  return [...groups.values()].map(group => {
    const sorted = [...group].sort(best);
    return { ...sorted[0], similarCount: group.length - 1 };
  });
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
        !WEB_DEV_RESOURCE_IDS.has(t.assignedResourceID) &&
        !DRAGGING_EXCLUDED_STATUSES.has(t.status) // Waiting Customer / On Hold are expected to sit
      )
      .map(t => {
        const created = t.createDate ? new Date(t.createDate).getTime() : null;
        const daysOpen = created ? (nowMs - created) / (1000 * 60 * 60 * 24) : null;
        const lastActivity = t.lastActivityDate ? new Date(t.lastActivityDate).getTime() : null;
        const hoursSinceActivity = lastActivity ? (nowMs - lastActivity) / (1000 * 60 * 60) : null;
        const timeEntryCount = timeEntryCounts[t.id] || 0;

        // A) no update in 48+ hours
        const stalled = hoursSinceActivity != null && hoursSinceActivity > DRAGGING_STALLED_HOURS;
        // B) open > 7 days AND no update in 24+ hours
        const agedAndQuiet =
          daysOpen != null && daysOpen > DRAGGING_AGED_DAYS &&
          hoursSinceActivity != null && hoursSinceActivity > DRAGGING_AGED_STALLED_HOURS;
        // C) more than 5 time entries, regardless of how recent the activity is
        const heavyTime = timeEntryCount > DRAGGING_TIME_ENTRY_THRESHOLD;

        const reasons = [];
        if (stalled || agedAndQuiet) {
          reasons.push(`No update in ${Math.round(hoursSinceActivity)}h`);
          if (daysOpen != null && daysOpen > DRAGGING_AGED_DAYS) {
            reasons.push(`Open ${Math.round(daysOpen)} days`);
          }
        }
        if (heavyTime) {
          reasons.push(`${timeEntryCount} time entries logged`);
        }

        return { ticket: t, daysOpen, hoursSinceActivity, timeEntryCount, reasons };
      })
      .filter(d => d.reasons.length > 0)
      // Worst first = longest since last update. Tickets caught only by the
      // time-entry rule have recent activity, so they sort toward the end.
      .sort((a, b) => (b.hoursSinceActivity ?? -1) - (a.hoursSinceActivity ?? -1));

    // ── AI Review escalations — direct read of reviewed.json's flags array ─
    // Restricted to the last 7 days (by dateFlagged, not the underlying
    // ticket's age — a ticket can be old but only just got flagged, or
    // vice versa) since this is a DAILY standup, not a running backlog of
    // every unactioned flag going back months.
    const sevenDaysAgoMs = nowMs - 7 * 24 * 60 * 60 * 1000;
    const reviewedData = loadJsonFile(REVIEWED_FILE);
    // id is the ticket number; a few old flags lack it (past AI Review glitch)
    // and would render with a broken link, so they're skipped entirely.
    const recentUnactioned = (reviewedData?.flags || []).filter(f =>
      f.id &&
      f.action === 'unactioned' &&
      f.dateFlagged &&
      new Date(f.dateFlagged).getTime() >= sevenDaysAgoMs
    );
    // Standup shows high + critical only, with repeats grouped (see
    // groupDuplicateFlags). Anything lower is counted so the UI can point
    // at the AI Review tab instead of hiding it without a trace.
    const importantFlags = recentUnactioned.filter(f => AI_ESCALATION_SEVERITIES.has(f.sev));
    const aiEscalationsOtherCount = recentUnactioned.length - importantFlags.length;
    const aiEscalations = groupDuplicateFlags(importantFlags).sort((a, b) => {
      const sevDiff = (AI_SEV_RANK[a.sev] ?? 9) - (AI_SEV_RANK[b.sev] ?? 9);
      if (sevDiff !== 0) return sevDiff;
      return new Date(b.dateFlagged).getTime() - new Date(a.dateFlagged).getTime();
    });

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

    // ── Project tasks — fetched ONCE per project and shared ───────────────
    // Needed for the engineering list's task-based progress AND the
    // onboarding overdue check. Several onboarding projects also appear in
    // the engineering list (blank department), so this cache avoids
    // querying the same project twice. A failed fetch stores null, so one
    // bad project shows "—" for progress instead of blanking a section.
    const taskCache = new Map();
    const getProjectTasks = async (proj) => {
      if (taskCache.has(proj.id)) return taskCache.get(proj.id);
      await sleep(200);
      let tasks = null;
      try {
        tasks = await fetchProjectTasks(proj.id);
      } catch (err) {
        console.warn(`[Standup] Failed to fetch tasks for project ${proj.id} (${proj.projectName}):`, err.message);
      }
      taskCache.set(proj.id, tasks);
      return tasks;
    };

    for (const p of engineeringProjects) {
      await getProjectTasks(p);
    }

    // ── Onboarding projects + their overdue tasks ──────────────────────────
    const onboardingProjectsRaw = await fetchOpenProjects([
      { field: 'projectName', op: 'contains', value: 'Onboarding' },
      { field: 'projectType', op: 'eq', value: CLIENT_PROJECT_TYPE }
    ]);

    const onboardingOverdue = [];
    for (const proj of onboardingProjectsRaw) {
      const tasks = await getProjectTasks(proj);
      if (!tasks) continue; // one bad project shouldn't blank the whole onboarding section
      const overdueTasks = tasks.filter(t =>
        !isTaskDone(t) && t.endDateTime && new Date(t.endDateTime).getTime() < nowMs
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

    // ── Task formatting for the expandable project rows ────────────────────
    // Open tasks first (soonest due date first, undated last), completed
    // tasks after. daysOverdue is only non-zero for tasks that are not done
    // and past their due date; the page decides whether to flag it (it does
    // for onboarding, but not for engineering projects, where some projects
    // have every task stamped with the project's creation date, which would
    // make every task look weeks overdue).
    const formatTask = (t) => {
      const done = isTaskDone(t);
      const dueMs = t.endDateTime ? new Date(t.endDateTime).getTime() : null;
      const overdue = !done && dueMs != null && dueMs < nowMs;
      return {
        taskNumber: t.taskNumber,
        title: t.title || '',
        assignedTech: resourceMap[t.assignedResourceID] || 'Unassigned',
        statusLabel: TICKET_STATUS_LABELS[t.status] || String(t.status),
        endDateTime: t.endDateTime || null,
        done,
        daysOverdue: overdue ? Math.floor((nowMs - dueMs) / (1000 * 60 * 60 * 24)) : 0
      };
    };
    const formatTasks = (tasks) => (tasks || []).map(formatTask).sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1;
      const ad = a.endDateTime ? new Date(a.endDateTime).getTime() : Infinity;
      const bd = b.endDateTime ? new Date(b.endDateTime).getTime() : Infinity;
      return ad - bd;
    });

    // ── Shape response ───────────────────────────────────────────────────────
    const formatTicket = (t) => ({
      id: t.id,
      ticketNumber: t.ticketNumber,
      title: t.title || '',
      companyName: companyMap[String(t.companyID)] || 'Unknown',
      assignedTech: resourceMap[t.assignedResourceID] || 'Unassigned',
      status: t.status,
      statusLabel: TICKET_STATUS_LABELS[t.status] || SCHEDULED_STATUS_LABELS[t.status] || String(t.status)
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
      aiEscalationsOtherCount,

      engineeringProjects: engineeringProjects.map(p => ({
        id: p.id,
        projectName: p.projectName,
        companyName: companyMap[String(p.companyID)] || 'Unknown',
        status: p.status,
        statusLabel: PROJECT_STATUS_LABELS[p.status] || String(p.status),
        taskProgress: summarizeTaskProgress(taskCache.get(p.id)),
        tasks: formatTasks(taskCache.get(p.id)),
        endDateTime: p.endDateTime,
        isOverdue: !!(p.endDateTime && new Date(p.endDateTime).getTime() < nowMs),
        projectLead: resourceMap[p.projectLeadResourceID] || null
      })),

      // Still only onboarding projects that HAVE overdue tasks (that's what
      // this section is for), but each now carries its full task list so
      // the row can expand; overdueCount drives the badge and section total.
      onboardingOverdue: onboardingOverdue.map(o => ({
        projectId: o.project.id,
        projectName: o.project.projectName,
        companyName: companyMap[String(o.project.companyID)] || 'Unknown',
        taskProgress: summarizeTaskProgress(taskCache.get(o.project.id)),
        overdueCount: o.overdueTasks.length,
        tasks: formatTasks(taskCache.get(o.project.id))
      }))
    });

  } catch (err) {
    next(err);
  }
});

module.exports = router;