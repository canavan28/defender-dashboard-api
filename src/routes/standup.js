const express = require('express');
const router = express.Router();
const axios = require('axios');
const { autotaskClient, getHeaders } = require('../utils/autotask');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ── Live data, not the shared ticket cache ──────────────────────────────────
// This route used to read open tickets from tickets-recent.json on disk. That
// file only gets rebuilt when someone loads the main dashboard (which calls
// /api/tickets/all), so the standup's "Refresh now" button and its hourly
// auto-refresh just re-read the same stale file — only a full page reload
// produced new data. Open tickets are now queried straight from AutoTask on
// every request, using the exact same queue + status rules tickets.js uses
// for its own "open" list (kept in sync by hand — see INCLUDE_QUEUES and
// EXCLUDE_OPEN_STATUSES below).

// ── Constants confirmed via diagnostic testing this session ──────────────────

// Ticket status IDs — AutoTask has no plain "Scheduled" status, only these two
// (confirmed by Matt directly, not decoded from a picklist call — Tickets'
// status picklist was never pulled since Tasks' picklist, which shares most of
// the same labels, already showed both "Scheduled - Phone Call" (22) and
// "Scheduled - Onsite" (41) and Matt confirmed both count as "Scheduled" here).
const SCHEDULED_STATUS_IDS = [22, 41];
const SCHEDULED_STATUS_LABELS = { 22: 'Scheduled - Phone Call', 41: 'Scheduled - Onsite' };

// "Open" ticket definition — copied from tickets.js (INCLUDE_QUEUES and
// EXCLUDE_STATUSES there). If either list changes in tickets.js, change it
// here too, or the standup and the Operations tabs will disagree.
const INCLUDE_QUEUES = [5, 29682833, 29683482, 29683496, 29683497];
const EXCLUDE_OPEN_STATUSES = [5, 20]; // Complete, RMM Resolved

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

// ── Paginated AutoTask query ─────────────────────────────────────────────────
// Same confirmed pattern as customerSuccess.js / tickets.js on this zone:
// continuation pages need POST (not GET) and the original filter body resent.
async function queryAll(entity, body) {
  const first = await autotaskClient.post(`/${entity}/query`, body);
  let items = first.data.items || [];
  let nextUrl = first.data.pageDetails?.nextPageUrl;
  while (nextUrl) {
    await sleep(300);
    const page = await axios.post(nextUrl, body, { headers: getHeaders() });
    items = items.concat(page.data.items || []);
    nextUrl = page.data.pageDetails?.nextPageUrl;
  }
  return items;
}

async function fetchOpenTickets() {
  return queryAll('Tickets', {
    filter: [
      { op: 'or', items: INCLUDE_QUEUES.map(id => ({ field: 'queueID', op: 'eq', value: id })) },
      { op: 'and', items: EXCLUDE_OPEN_STATUSES.map(id => ({ field: 'status', op: 'noteq', value: id })) }
    ],
    maxRecords: 500
  });
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
async function fetchTimeEntryCounts(ticketIds) {
  const counts = {};
  if (!ticketIds.length) return counts;
  const CHUNK = 500;
  for (let i = 0; i < ticketIds.length; i += CHUNK) {
    const chunk = ticketIds.slice(i, i + CHUNK);
    // Paginated: 500 open tickets can easily have more than 500 time
    // entries between them. The old single-page query silently undercounted,
    // which meant the "more than 5 time entries" dragging rule could miss
    // tickets.
    const items = await queryAll('TimeEntries', {
      filter: [{ field: 'ticketID', op: 'in', value: chunk }],
      maxRecords: 500
    });
    items.forEach(te => {
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

// ── Route ──────────────────────────────────────────────────────────────────
router.get('/data', async (req, res, next) => {
  try {
    const now = new Date();
    const nowMs = now.getTime();

    // ── Tickets: live from AutoTask on every request (see top of file) ────
    const openTickets = await fetchOpenTickets();
    await sleep(300);

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