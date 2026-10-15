const express = require('express');
const router = require('express').Router();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { autotaskClient, getHeaders } = require('../utils/autotask');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ── Cache file paths ──────────────────────────────────────────────────────────
const CACHE_DIR = '/app/data';
const HISTORICAL_CACHE_FILE = path.join(CACHE_DIR, 'tickets-historical.json');
const RECENT_CACHE_FILE = path.join(CACHE_DIR, 'tickets-recent.json');
const HISTORICAL_TE_CACHE_FILE = path.join(CACHE_DIR, 'timeentries-historical.json');

// ── History windows ──────────────────────────────────────────────────────────
// Time entries now go back as far as tickets do (24 months) so the Time
// Analytics tab can compare a quarter against the same quarter last year.
// Previously time entries only went back 6 months.
const TICKET_HISTORY_MONTHS = 24;
const TIME_ENTRY_HISTORY_MONTHS = 24;
const RECENT_DAYS = 30;

// ── Constants ────────────────────────────────────────────────────────────────
const INCLUDE_QUEUES = [5, 29682833, 29683482, 29683496, 29683497];
const EXCLUDE_STATUSES = [5, 20];
const EXCLUDE_RESOURCES = [
  29682885, 29682893, 29682894, 29682895,
  29682902, 29682926, 29682928, 29682936
];
const EXCLUDE_RESOURCES_SET = new Set(EXCLUDE_RESOURCES);

const ISSUE_TYPE_MAP = {
  '6': 'InfoTank Services', '7': 'Server', '10': 'Computer', '11': 'Network',
  '13': 'Maintenance', '16': 'Other', '17': 'Quote', '18': 'RMM Monitoring',
  '19': 'Web Development', '20': 'Email', '21': 'User Management',
  '22': 'Net User Change', '23': 'New Device Setup', '24': 'Mobile Device Mgmt',
  '26': 'Leased Item Install', '27': 'HSCC Daily Onsite', '28': 'Microsoft',
  '29': 'Software', '30': 'Printing/Scanning'
};

const SUB_ISSUE_MAP = {
  '104': { label: 'Application', parent: '10' },
  '105': { label: 'New Setup', parent: '10' },
  '108': { label: 'Spyware/Malware', parent: '10' },
  '109': { label: 'System Performance', parent: '10' },
  '110': { label: 'Virus', parent: '10' },
  '111': { label: 'DNS', parent: '11' },
  '112': { label: 'Firewall/Router', parent: '11' },
  '116': { label: 'WAP', parent: '11' },
  '117': { label: 'Backup', parent: '7' },
  '118': { label: 'DHCP', parent: '7' },
  '119': { label: 'DNS', parent: '7' },
  '120': { label: 'File System', parent: '7' },
  '124': { label: 'Performance', parent: '7' },
  '125': { label: 'SQL', parent: '7' },
  '129': { label: 'S1', parent: '6' },
  '130': { label: 'Hexnode', parent: '6' },
  '131': { label: 'Cloud Radial', parent: '6' },
  '152': { label: 'Hardware', parent: '10' },
  '153': { label: 'Operating System', parent: '10' },
  '155': { label: 'Anti-Virus', parent: '13' },
  '156': { label: 'Backup', parent: '13' },
  '157': { label: 'E-mail', parent: '13' },
  '158': { label: 'Firewall', parent: '13' },
  '159': { label: 'Internet', parent: '13' },
  '160': { label: 'Intranet/LAN', parent: '13' },
  '161': { label: 'Network', parent: '13' },
  '162': { label: 'Phone', parent: '13' },
  '163': { label: 'Point of Sale', parent: '13' },
  '164': { label: 'Router', parent: '13' },
  '165': { label: 'Server', parent: '13' },
  '166': { label: 'Software', parent: '13' },
  '167': { label: 'Website', parent: '13' },
  '168': { label: 'Workstation', parent: '13' },
  '184': { label: 'Cabling', parent: '11' },
  '185': { label: 'Configuration', parent: '11' },
  '186': { label: 'Connectivity', parent: '11' },
  '187': { label: 'Hub', parent: '11' },
  '188': { label: 'Internet', parent: '11' },
  '189': { label: 'ISP', parent: '11' },
  '190': { label: 'Logon Failure', parent: '11' },
  '191': { label: 'Network Printer', parent: '11' },
  '192': { label: 'Performance', parent: '11' },
  '193': { label: 'Remote Access', parent: '11' },
  '194': { label: 'Security', parent: '11' },
  '195': { label: 'Server', parent: '11' },
  '196': { label: 'Settings Change', parent: '11' },
  '198': { label: 'VPN', parent: '11' },
  '199': { label: 'Switch', parent: '11' },
  '213': { label: 'Active Directory', parent: '7' },
  '214': { label: 'Anti Virus', parent: '7' },
  '215': { label: 'Application', parent: '7' },
  '217': { label: 'Hardware', parent: '7' },
  '218': { label: 'Software', parent: '7' },
  '220': { label: 'TBD', parent: '16' },
  '221': { label: 'SE Request', parent: '17' },
  '222': { label: 'Antivirus Status Monitor', parent: '18' },
  '223': { label: 'Backup Monitor', parent: '18' },
  '224': { label: 'Component Monitor', parent: '18' },
  '225': { label: 'CPU Monitor', parent: '18' },
  '226': { label: 'Disk Usage Monitor', parent: '18' },
  '227': { label: 'End Client Agent', parent: '18' },
  '228': { label: 'Event Log Monitor', parent: '18' },
  '229': { label: 'File/Folder Size Monitor', parent: '18' },
  '230': { label: 'Hardware Monitor', parent: '18' },
  '231': { label: 'Online Status Monitor', parent: '18' },
  '232': { label: 'Patch Monitor', parent: '18' },
  '233': { label: 'Ping Monitor', parent: '18' },
  '234': { label: 'Process Monitor', parent: '18' },
  '235': { label: 'Security Management Monitor', parent: '18' },
  '236': { label: 'Service Monitor', parent: '18' },
  '237': { label: 'SNMP Monitor', parent: '18' },
  '238': { label: 'Software Monitor', parent: '18' },
  '239': { label: 'Temperature Sensor Monitor', parent: '18' },
  '240': { label: 'Windows Performance Monitor', parent: '18' },
  '241': { label: 'WMI Monitor', parent: '18' },
  '242': { label: 'Printer Monitor', parent: '18' },
  '243': { label: 'Memory Monitor', parent: '18' },
  '247': { label: 'Mail Flow', parent: '20' },
  '248': { label: 'Password', parent: '20' },
  '249': { label: 'Password Reset', parent: '21' },
  '251': { label: 'Net Remove User', parent: '22' },
  '252': { label: 'Net New User', parent: '22' },
  '253': { label: 'Configuration Change', parent: '20' },
  '254': { label: 'New Desktop/Laptop', parent: '23' },
  '255': { label: 'New iPad', parent: '23' },
  '256': { label: 'New Firewall', parent: '23' },
  '257': { label: 'New Switch', parent: '23' },
  '258': { label: 'New Wireless Access Point', parent: '23' },
  '259': { label: 'Other', parent: '23' },
  '260': { label: 'SSL Renewal', parent: '19' },
  '262': { label: 'iPad Order', parent: '24' },
  '263': { label: 'Replace iPad', parent: '24' },
  '264': { label: 'Policy Updates', parent: '24' },
  '265': { label: 'Mobile Device Management', parent: '24' },
  '266': { label: 'Spam / Phishing', parent: '20' },
  '267': { label: 'Access Change', parent: '21' },
  '268': { label: 'New Accessories', parent: '23' },
  '269': { label: 'Quarantine Requests', parent: '20' },
  '270': { label: 'Maintenance', parent: '7' },
  '271': { label: 'Auditing', parent: '6' },
  '272': { label: 'KnowBe4', parent: '6' },
  '273': { label: 'Spam Filter', parent: '6' },
  '274': { label: 'SonicWall', parent: '26' },
  '275': { label: 'NAS Backup Appliance', parent: '26' },
  '276': { label: 'Hot Swap', parent: '24' },
  '277': { label: 'Intune', parent: '28' },
  '278': { label: 'Azure/Entra', parent: '28' },
  '279': { label: 'Teams', parent: '28' },
  '280': { label: 'OneDrive', parent: '28' },
  '281': { label: 'Exchange', parent: '28' },
  '282': { label: 'SharePoint', parent: '28' },
  '283': { label: 'Net Email Only User', parent: '22' },
  '284': { label: 'Net Remove Email Only User', parent: '22' },
  '285': { label: 'Permission Change', parent: '21' },
  '286': { label: 'Account Locked', parent: '21' },
  '287': { label: 'Teams / Calendar', parent: '20' },
  '288': { label: 'Application Error', parent: '29' },
  '289': { label: 'Licensing', parent: '29' },
  '290': { label: 'Application Install', parent: '29' },
  '291': { label: 'Configuration', parent: '29' },
  '292': { label: 'Application Performance', parent: '29' },
  '293': { label: 'Cannot Print/Scan', parent: '30' },
  '294': { label: 'Printer Install', parent: '30' },
  '295': { label: 'Printer Offline', parent: '30' }
};

// ── In-memory caches ──────────────────────────────────────────────────────────
let historicalCache = null;
let recentCache = null;
let historicalTimeEntryCache = null;
let recentTimeEntryCache = null;

// Guards against two overlapping historical time-entry builds (e.g. the
// dashboard auto-syncing while a manual refresh is already running).
let historicalTEBuild = null;

// ── Date helpers ──────────────────────────────────────────────────────────────
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function monthsAgo(n) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d;
}

// ── Disk cache helpers ────────────────────────────────────────────────────────
function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function saveCacheToDisk(filePath, data) {
  try {
    ensureCacheDir();
    const json = JSON.stringify(data);
    fs.writeFileSync(filePath, json);
    console.log(`[Cache] Saved to disk: ${path.basename(filePath)} (${Math.round(json.length / 1024)}KB)`);
  } catch (err) {
    console.error(`[Cache] Failed to save ${filePath}:`, err.message);
  }
}

function loadCacheFromDisk(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      const data = JSON.parse(raw);
      console.log(`[Cache] Loaded from disk: ${path.basename(filePath)} (${Math.round(raw.length / 1024)}KB)`);
      return data;
    }
  } catch (err) {
    console.error(`[Cache] Failed to load ${filePath}:`, err.message);
  }
  return null;
}

// ── Load caches from disk on startup ─────────────────────────────────────────
function initializeCaches() {
  console.log('[Cache] Initializing from disk...');
  const historical = loadCacheFromDisk(HISTORICAL_CACHE_FILE);
  const recent = loadCacheFromDisk(RECENT_CACHE_FILE);
  const historicalTE = loadCacheFromDisk(HISTORICAL_TE_CACHE_FILE);

  if (historical) {
    historicalCache = historical;
    console.log(`[Cache] Historical loaded: ${historical.allTickets?.length} tickets, built ${historical.builtAt}`);
  }
  if (recent) {
    recentCache = recent;
    console.log(`[Cache] Recent loaded: ${recent.allTickets?.length} tickets, built ${recent.builtAt}`);
  }
  if (historicalTE) {
    historicalTimeEntryCache = historicalTE;
    console.log(`[Cache] Historical time entries loaded: ${historicalTE.items?.length} entries since ${historicalTE.since}, built ${historicalTE.builtAt}`);
  }
}

// Initialize on module load
initializeCaches();

// ── Coverage boundaries ───────────────────────────────────────────────────────
// FIX: the historical ticket cache is only rebuilt on a manual full refresh,
// but the "recent" fetch always used a fixed 30-day window. If the historical
// cache was built, say, 3 months ago, it stopped at (3 months ago - 30 days)
// while recent started at (today - 30 days) — leaving a silent gap of tickets
// that neither cache contained. Recent now starts wherever historical stops.
function historicalTicketsCoverUntil() {
  if (!historicalCache) return null;
  if (historicalCache.coversUntil) return new Date(historicalCache.coversUntil);
  // Older caches didn't record this; it was always builtAt minus 30 days.
  if (historicalCache.builtAt) {
    const d = new Date(historicalCache.builtAt);
    d.setDate(d.getDate() - RECENT_DAYS);
    return d;
  }
  return null;
}

function recentTicketsSince() {
  const thirty = daysAgo(RECENT_DAYS);
  const covers = historicalTicketsCoverUntil();
  return covers && covers < thirty ? covers : thirty;
}

function recentTimeEntriesSince() {
  const thirty = daysAgo(RECENT_DAYS);
  const covers = historicalTimeEntryCache?.coversUntil
    ? new Date(historicalTimeEntryCache.coversUntil)
    : null;
  return covers && covers < thirty ? covers : thirty;
}

// ── Pagination helpers ────────────────────────────────────────────────────────
async function queryAllTickets(filter) {
  let allItems = [];
  let nextPageUrl = null;
  let pageCount = 0;

  const firstResponse = await autotaskClient.post('/Tickets/query', { filter, maxRecords: 500 });
  allItems = [...(firstResponse.data.items || [])];
  nextPageUrl = firstResponse.data.pageDetails?.nextPageUrl || null;
  pageCount++;
  console.log(`[Pagination] Page ${pageCount}, items: ${allItems.length}, hasNext: ${!!nextPageUrl}`);

  while (nextPageUrl) {
    await sleep(300);
    const response = await axios.post(nextPageUrl, { filter, maxRecords: 500 }, { headers: getHeaders() });
    allItems = [...allItems, ...(response.data.items || [])];
    nextPageUrl = response.data.pageDetails?.nextPageUrl || null;
    pageCount++;
    console.log(`[Pagination] Page ${pageCount}, items: ${allItems.length}, hasNext: ${!!nextPageUrl}`);
  }

  return allItems;
}

async function queryAllEntries(path2, filter) {
  let allItems = [];
  let nextPageUrl = null;
  let pageCount = 0;

  const firstResponse = await autotaskClient.post(path2, { filter, maxRecords: 500 });
  allItems = [...(firstResponse.data.items || [])];
  nextPageUrl = firstResponse.data.pageDetails?.nextPageUrl || null;
  pageCount++;

  while (nextPageUrl) {
    await sleep(300);
    const response = await axios.post(nextPageUrl, { filter, maxRecords: 500 }, { headers: getHeaders() });
    allItems = [...allItems, ...(response.data.items || [])];
    nextPageUrl = response.data.pageDetails?.nextPageUrl || null;
    pageCount++;
  }

  console.log(`[Pagination] ${path2} complete: ${pageCount} pages, ${allItems.length} items`);
  return allItems;
}

// ── Merge helpers ─────────────────────────────────────────────────────────────
function mergeTickets(historical, recent) {
  const map = {};
  (historical || []).forEach(t => { map[t.id] = t; });
  (recent || []).forEach(t => { map[t.id] = t; });
  return Object.values(map);
}

// ── Slim time entries ─────────────────────────────────────────────────────────
// Only the fields the dashboard actually uses are kept. Note text is replaced
// with a hasNotes yes/no flag — the frontend only ever checked whether notes
// existed (notes coverage + tech grading), never displayed the text. This keeps
// the browser payload small even with 24 months of entries.
// Project time entries (logged on a project task, not a ticket) also carry
// the project's name and company, resolved at fetch time.
function slimTimeEntry(t, projectInfo) {
  const hasSummary = typeof t.summaryNotes === 'string' && t.summaryNotes.trim().length > 0;
  const hasInternal = typeof t.internalNotes === 'string' && t.internalNotes.trim().length > 0;
  return {
    id: t.id,
    ticketID: t.ticketID ?? null,
    taskID: t.taskID ?? null,
    resourceID: t.resourceID,
    dateWorked: t.dateWorked,
    hoursWorked: t.hoursWorked,
    isNonBillable: !!t.isNonBillable,
    billingCodeID: t.billingCodeID ?? null,
    hasNotes: hasSummary || hasInternal,
    projectID: projectInfo?.projectID ?? null,
    projectName: projectInfo?.projectName ?? null,
    projectCompanyID: projectInfo?.companyID ?? null
  };
}

// ── Fetch company names (same pattern as aireview.js) ────────────────────────
async function fetchCompanyNames(companyIds) {
  if (!companyIds.length) return {};
  const companyMap = {};
  try {
    // AutoTask /Companies/query supports up to 500 IDs per request
    // Chunk in case there are more than 500 unique companies
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
    console.log(`[Companies] Resolved ${Object.keys(companyMap).length} company names`);
  } catch (err) {
    console.warn('[Companies] Could not fetch company names:', err.message);
  }
  // companyID 0 is InfoTank's own internal tickets — not a real AutoTask company record
  companyMap['0'] = 'InfoTank (Internal)';
  return companyMap;
}

// ── Work type names (AutoTask BillingCodes) ──────────────────────────────────
// A time entry's billingCodeID is its Work Type (Remote Support, Onsite, etc.).
// Resolved dynamically every sync — nothing hardcoded. If this lookup fails,
// the dashboard still works and shows "Work type <id>" instead of names.
async function fetchBillingCodeMap() {
  const map = {};
  try {
    const items = await queryAllEntries('/BillingCodes/query', [{ op: 'exist', field: 'id' }]);
    items.forEach(b => {
      map[String(b.id)] = b.name;
    });
    console.log(`[BillingCodes] Resolved ${Object.keys(map).length} work type names`);
  } catch (err) {
    console.warn('[BillingCodes] Could not fetch work type names:', err.response?.status, err.message);
  }
  return map;
}

// ── Build response payload ────────────────────────────────────────────────────
function buildPayload(resources, companyMap, billingCodeMap) {
  const allTickets = mergeTickets(historicalCache?.allTickets, recentCache?.allTickets);
  const completedTickets = mergeTickets(historicalCache?.completedTickets, recentCache?.completedTickets);
  const openTickets = recentCache?.openTickets || [];

  const timeEntryMap = {};
  [...(historicalTimeEntryCache?.items || []), ...(recentTimeEntryCache?.items || [])].forEach(t => {
    timeEntryMap[t.id] = t;
  });
  const timeEntries = Object.values(timeEntryMap);

  return {
    allTickets,
    completedTickets,
    openTickets,
    timeEntries,
    resources,
    excludeResources: EXCLUDE_RESOURCES,
    issueTypeMap: ISSUE_TYPE_MAP,
    subIssueMap: SUB_ISSUE_MAP,
    companyMap,
    billingCodeMap: billingCodeMap || {},
    cacheInfo: {
      historicalBuiltAt: historicalCache?.builtAt,
      recentBuiltAt: recentCache?.builtAt,
      recentTicketsSince: recentCache?.since || null,
      timeEntriesBuiltAt: recentTimeEntryCache?.builtAt,
      timeEntriesHistoricalBuiltAt: historicalTimeEntryCache?.builtAt || null,
      // Earliest date time entries are guaranteed complete from. The frontend
      // uses this to decide whether a prior-year comparison is trustworthy.
      timeEntriesSince: historicalTimeEntryCache?.since || recentTimeEntryCache?.since || null,
      totalTickets: allTickets.length,
      totalTimeEntries: timeEntries.length,
      projectTimeEntries: timeEntries.filter(t => !t.ticketID && t.taskID).length,
      // Non-null means project time is missing or incomplete — the Time
      // Analytics tab shows a warning. Fix with /api/tickets/refreshtimeentries.
      projectTimeError: historicalTimeEntryCache?.projectTimeError || recentTimeEntryCache?.projectTimeError || null,
      loadedFromDisk: historicalCache?.loadedFromDisk || false
    }
  };
}

// ── Resources ─────────────────────────────────────────────────────────────────
async function fetchResources() {
  const response = await autotaskClient.post('/Resources/query', {
    filter: [{ field: 'isActive', op: 'eq', value: true }]
  });
  return (response.data.items || []).map(r => ({
    id: r.id,
    name: `${r.firstName} ${r.lastName}`,
    licenseType: r.licenseType
  }));
}

// ── Queue filter ──────────────────────────────────────────────────────────────
const queueFilter = {
  op: 'or',
  items: INCLUDE_QUEUES.map(id => ({ field: 'queueID', op: 'eq', value: id }))
};

// ── Ticket fetchers ───────────────────────────────────────────────────────────
async function fetchHistorical() {
  console.log('[Cache] Building historical ticket cache...');
  const since = monthsAgo(TICKET_HISTORY_MONTHS);
  const until = daysAgo(RECENT_DAYS);

  const allTickets = await queryAllTickets([
    queueFilter,
    { field: 'createDate', op: 'gte', value: since.toISOString() },
    { field: 'createDate', op: 'lt', value: until.toISOString() },
    { field: 'status', op: 'noteq', value: 20 }
  ]);
  await sleep(500);

  const completedTickets = await queryAllTickets([
    queueFilter,
    { field: 'status', op: 'eq', value: 5 },
    { field: 'completedDate', op: 'exist' },
    { field: 'createDate', op: 'gte', value: since.toISOString() },
    { field: 'createDate', op: 'lt', value: until.toISOString() }
  ]);

  console.log(`[Cache] Historical tickets: ${allTickets.length} all, ${completedTickets.length} completed`);
  const cache = {
    allTickets,
    completedTickets,
    since: since.toISOString(),
    coversUntil: until.toISOString(),
    builtAt: new Date().toISOString()
  };
  saveCacheToDisk(HISTORICAL_CACHE_FILE, cache);
  return cache;
}

async function fetchRecent() {
  const since = recentTicketsSince();
  console.log(`[Cache] Refreshing recent ticket cache (since ${since.toISOString()})...`);

  const allTickets = await queryAllTickets([
    queueFilter,
    { field: 'createDate', op: 'gte', value: since.toISOString() },
    { field: 'status', op: 'noteq', value: 20 }
  ]);
  await sleep(500);

  const openTickets = await queryAllTickets([
    queueFilter,
    {
      op: 'and',
      items: EXCLUDE_STATUSES.map(id => ({ field: 'status', op: 'noteq', value: id }))
    }
  ]);
  await sleep(500);

  const completedTickets = await queryAllTickets([
    queueFilter,
    { field: 'status', op: 'eq', value: 5 },
    { field: 'completedDate', op: 'exist' },
    { field: 'createDate', op: 'gte', value: since.toISOString() }
  ]);

  console.log(`[Cache] Recent tickets: ${allTickets.length} all, ${openTickets.length} open, ${completedTickets.length} completed`);
  const cache = {
    allTickets,
    openTickets,
    completedTickets,
    since: since.toISOString(),
    builtAt: new Date().toISOString()
  };
  saveCacheToDisk(RECENT_CACHE_FILE, cache);
  return cache;
}

// ── Time entry fetchers ───────────────────────────────────────────────────────
// Two kinds of time are pulled:
//   1. Ticket time — ticketID exists, ticket must be in the included queues
//      (same rule as before).
//   2. Project time — logged against a project task (taskID exists, no
//      ticket). New: previously project time never reached the dashboard.
// If the project-time fetch fails, ticket time still loads and the error is
// recorded (projectTimeError) so the Time Analytics tab can warn about it
// instead of silently showing lower totals.

// taskID -> { projectID, projectName, companyID }
async function resolveTaskProjects(taskIds) {
  const info = {};
  if (!taskIds.length) return info;
  try {
    const CHUNK = 500;
    const taskToProject = {};
    for (let i = 0; i < taskIds.length; i += CHUNK) {
      const chunk = taskIds.slice(i, i + CHUNK);
      const tasks = await queryAllEntries('/Tasks/query', [{ field: 'id', op: 'in', value: chunk }]);
      tasks.forEach(t => { taskToProject[t.id] = t.projectID; });
      await sleep(300);
    }

    const projectIds = [...new Set(Object.values(taskToProject).filter(Boolean))];
    const projects = {};
    for (let i = 0; i < projectIds.length; i += CHUNK) {
      const chunk = projectIds.slice(i, i + CHUNK);
      const items = await queryAllEntries('/Projects/query', [{ field: 'id', op: 'in', value: chunk }]);
      items.forEach(p => { projects[p.id] = { projectName: p.projectName, companyID: p.companyID }; });
      await sleep(300);
    }

    taskIds.forEach(id => {
      const pid = taskToProject[id] ?? null;
      info[id] = {
        projectID: pid,
        projectName: pid != null ? (projects[pid]?.projectName || null) : null,
        companyID: pid != null ? (projects[pid]?.companyID ?? null) : null
      };
    });
    console.log(`[TimeEntries] Resolved ${Object.keys(taskToProject).length} tasks to ${projectIds.length} projects`);
  } catch (err) {
    // Hours still count — only the project name/company is missing.
    console.warn('[TimeEntries] Could not resolve tasks to projects:', err.response?.status, err.message);
  }
  return info;
}

async function fetchProjectTimeEntries(since, until) {
  const filter = [
    { field: 'dateWorked', op: 'gte', value: since.toISOString() },
    ...(until ? [{ field: 'dateWorked', op: 'lt', value: until.toISOString() }] : []),
    { field: 'taskID', op: 'exist' }
  ];
  const items = (await queryAllEntries('/TimeEntries/query', filter))
    .filter(t => !EXCLUDE_RESOURCES_SET.has(t.resourceID) && !t.ticketID);

  await sleep(300);
  const taskIds = [...new Set(items.map(t => t.taskID).filter(Boolean))];
  const taskInfo = await resolveTaskProjects(taskIds);
  return items.map(t => slimTimeEntry(t, taskInfo[t.taskID]));
}

async function fetchTimeEntriesRange(since, until, ticketIDSet, label) {
  const ticketFilter = [
    { field: 'dateWorked', op: 'gte', value: since.toISOString() },
    ...(until ? [{ field: 'dateWorked', op: 'lt', value: until.toISOString() }] : []),
    { field: 'ticketID', op: 'exist' }
  ];
  const ticketRaw = await queryAllEntries('/TimeEntries/query', ticketFilter);
  const ticketItems = ticketRaw
    .filter(t => !EXCLUDE_RESOURCES_SET.has(t.resourceID) && ticketIDSet.has(t.ticketID))
    .map(t => slimTimeEntry(t));

  let projectItems = [];
  let projectTimeError = null;
  try {
    await sleep(500);
    projectItems = await fetchProjectTimeEntries(since, until);
  } catch (err) {
    projectTimeError = `${err.response?.status || ''} ${err.message}`.trim();
    console.error(`[TimeEntries] ${label}: project time fetch FAILED:`, projectTimeError);
  }

  console.log(`[TimeEntries] ${label}: ${ticketRaw.length} ticket entries raw, ${ticketItems.length} after filter; ${projectItems.length} project entries`);
  return { items: [...ticketItems, ...projectItems], projectTimeError };
}

async function fetchHistoricalTimeEntries(ticketIDSet) {
  const since = monthsAgo(TIME_ENTRY_HISTORY_MONTHS);
  const until = daysAgo(RECENT_DAYS);
  console.log(`[TimeEntries] Building historical cache (${since.toISOString()} to ${until.toISOString()})...`);

  const { items, projectTimeError } = await fetchTimeEntriesRange(since, until, ticketIDSet, 'Historical');

  const cache = {
    items,
    projectTimeError,
    since: since.toISOString(),
    coversUntil: until.toISOString(),
    builtAt: new Date().toISOString()
  };
  saveCacheToDisk(HISTORICAL_TE_CACHE_FILE, cache);
  return cache;
}

function buildHistoricalTimeEntries(ticketIDSet) {
  if (!historicalTEBuild) {
    historicalTEBuild = fetchHistoricalTimeEntries(ticketIDSet)
      .then(cache => {
        historicalTimeEntryCache = cache;
        return cache;
      })
      .finally(() => {
        historicalTEBuild = null;
      });
  } else {
    console.log('[TimeEntries] Historical build already running — waiting on it instead of starting another');
  }
  return historicalTEBuild;
}

async function fetchRecentTimeEntries(ticketIDSet) {
  const since = recentTimeEntriesSince();
  console.log(`[TimeEntries] Refreshing recent cache (since ${since.toISOString()})...`);

  const { items, projectTimeError } = await fetchTimeEntriesRange(since, null, ticketIDSet, 'Recent');
  return { items, projectTimeError, since: since.toISOString(), builtAt: new Date().toISOString() };
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.get('/all', async (req, res, next) => {
  try {
    // Use disk cache if available, otherwise build
    if (!historicalCache) {
      historicalCache = await fetchHistorical();
    }

    // Always refresh recent on sync
    recentCache = await fetchRecent();

    const allTickets = mergeTickets(historicalCache.allTickets, recentCache.allTickets);
    const ticketIDSet = new Set(allTickets.map(t => t.id));

    if (!historicalTimeEntryCache) {
      await buildHistoricalTimeEntries(ticketIDSet);
    }

    recentTimeEntryCache = await fetchRecentTimeEntries(ticketIDSet);

    const resources = await fetchResources();
    const projectCompanyIds = [
      ...(historicalTimeEntryCache?.items || []),
      ...(recentTimeEntryCache?.items || [])
    ].map(t => t.projectCompanyID).filter(Boolean);
    const companyIds = [...new Set([
      ...allTickets.map(t => t.companyID).filter(Boolean),
      ...projectCompanyIds
    ])];
    const companyMap = await fetchCompanyNames(companyIds);
    const billingCodeMap = await fetchBillingCodeMap();
    res.json(buildPayload(resources, companyMap, billingCodeMap));
  } catch (err) {
    next(err);
  }
});

router.get('/refreshtickets', async (req, res, next) => {
  try {
    console.log('[FullRefresh] Step 1: Rebuilding ticket caches...');
    historicalCache = null;
    recentCache = null;

    historicalCache = await fetchHistorical();
    recentCache = await fetchRecent();

    const allTickets = mergeTickets(historicalCache.allTickets, recentCache.allTickets);

    res.json({
      ok: true,
      totalTickets: allTickets.length,
      historicalBuiltAt: historicalCache.builtAt,
      recentBuiltAt: recentCache.builtAt
    });
  } catch (err) {
    next(err);
  }
});

router.get('/refreshtimeentries', async (req, res, next) => {
  try {
    if (!historicalCache || !recentCache) {
      return res.status(400).json({ error: 'Ticket cache must be built first.' });
    }

    console.log('[FullRefresh] Step 2: Rebuilding time entry caches...');
    // The old caches keep serving the dashboard until the new ones are ready.

    const allTickets = mergeTickets(historicalCache.allTickets, recentCache.allTickets);
    const ticketIDSet = new Set(allTickets.map(t => t.id));

    await buildHistoricalTimeEntries(ticketIDSet);
    recentTimeEntryCache = await fetchRecentTimeEntries(ticketIDSet);

    const timeEntryMap = {};
    [...(historicalTimeEntryCache.items || []), ...(recentTimeEntryCache.items || [])].forEach(t => {
      timeEntryMap[t.id] = t;
    });

    res.json({
      ok: true,
      totalTimeEntries: Object.keys(timeEntryMap).length,
      timeEntriesSince: historicalTimeEntryCache.since,
      projectTimeEntries: Object.values(timeEntryMap).filter(t => !t.ticketID && t.taskID).length,
      projectTimeError: historicalTimeEntryCache.projectTimeError || recentTimeEntryCache.projectTimeError || null,
      historicalBuiltAt: historicalTimeEntryCache.builtAt,
      recentBuiltAt: recentTimeEntryCache.builtAt
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;