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

// ── Disk cache helpers ────────────────────────────────────────────────────────
function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function saveCacheToDisk(filePath, data) {
  try {
    ensureCacheDir();
    fs.writeFileSync(filePath, JSON.stringify(data));
    console.log(`[Cache] Saved to disk: ${path.basename(filePath)} (${Math.round(JSON.stringify(data).length / 1024)}KB)`);
  } catch (err) {
    console.error(`[Cache] Failed to save ${filePath}:`, err.message);
  }
}

function loadCacheFromDisk(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      console.log(`[Cache] Loaded from disk: ${path.basename(filePath)} (${Math.round(JSON.stringify(data).length / 1024)}KB)`);
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

  if (historical) {
    historicalCache = historical;
    console.log(`[Cache] Historical loaded: ${historical.allTickets?.length} tickets, built ${historical.builtAt}`);
  }
  if (recent) {
    recentCache = recent;
    console.log(`[Cache] Recent loaded: ${recent.allTickets?.length} tickets, built ${recent.builtAt}`);
  }
}

// Initialize on module load
initializeCaches();

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
        companyMap[c.id] = c.companyName;
      });
      if (i + CHUNK < companyIds.length) await sleep(300);
    }
    console.log(`[Companies] Resolved ${Object.keys(companyMap).length} company names`);
  } catch (err) {
    console.warn('[Companies] Could not fetch company names:', err.message);
  }
  return companyMap;
}

// ── Build response payload ────────────────────────────────────────────────────
async function buildPayload(resources) {
  const allTickets = mergeTickets(historicalCache?.allTickets, recentCache?.allTickets);
  const completedTickets = mergeTickets(historicalCache?.completedTickets, recentCache?.completedTickets);
  const openTickets = recentCache?.openTickets || [];

  const timeEntryMap = {};
  [...(historicalTimeEntryCache?.items || []), ...(recentTimeEntryCache?.items || [])].forEach(t => {
    timeEntryMap[t.id] = t;
  });
  const timeEntries = Object.values(timeEntryMap);

  // Resolve company names for all tickets
  const companyIds = [...new Set(allTickets.map(t => t.companyID).filter(Boolean))];
  const companyMap = await fetchCompanyNames(companyIds);

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
    cacheInfo: {
      historicalBuiltAt: historicalCache?.builtAt,
      recentBuiltAt: recentCache?.builtAt,
      timeEntriesBuiltAt: recentTimeEntryCache?.builtAt,
      totalTickets: allTickets.length,
      totalTimeEntries: timeEntries.length,
      loadedFromDisk: historicalCache?.loadedFromDisk || false
    }
  };
}
const companyIds = [...new Set(allTickets.map(t => t.companyID).filter(Boolean))];
const companyMap = await fetchCompanyNames(companyIds);

// TEMP DEBUG — remove after confirming
console.log('[Debug] Sample companyIds from tickets:', companyIds.slice(0, 3), typeof companyIds[0]);
console.log('[Debug] Sample companyMap keys:', Object.keys(companyMap).slice(0, 3), typeof Object.keys(companyMap)[0]);
console.log('[Debug] Sample lookup test:', companyIds[0], companyMap[companyIds[0]]);
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
  const twentyFourMonthsAgo = new Date();
  twentyFourMonthsAgo.setMonth(twentyFourMonthsAgo.getMonth() - 24);
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const allTickets = await queryAllTickets([
    queueFilter,
    { field: 'createDate', op: 'gte', value: twentyFourMonthsAgo.toISOString() },
    { field: 'createDate', op: 'lt', value: thirtyDaysAgo.toISOString() },
    { field: 'status', op: 'noteq', value: 20 }
  ]);
  await sleep(500);

  const completedTickets = await queryAllTickets([
    queueFilter,
    { field: 'status', op: 'eq', value: 5 },
    { field: 'completedDate', op: 'exist' },
    { field: 'createDate', op: 'gte', value: twentyFourMonthsAgo.toISOString() },
    { field: 'createDate', op: 'lt', value: thirtyDaysAgo.toISOString() }
  ]);

  console.log(`[Cache] Historical tickets: ${allTickets.length} all, ${completedTickets.length} completed`);
  const cache = { allTickets, completedTickets, builtAt: new Date().toISOString() };
  saveCacheToDisk(HISTORICAL_CACHE_FILE, cache);
  return cache;
}

async function fetchRecent() {
  console.log('[Cache] Refreshing recent ticket cache...');
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const allTickets = await queryAllTickets([
    queueFilter,
    { field: 'createDate', op: 'gte', value: thirtyDaysAgo.toISOString() },
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
    { field: 'createDate', op: 'gte', value: thirtyDaysAgo.toISOString() }
  ]);

  console.log(`[Cache] Recent tickets: ${allTickets.length} all, ${openTickets.length} open, ${completedTickets.length} completed`);
  const cache = { allTickets, openTickets, completedTickets, builtAt: new Date().toISOString() };
  saveCacheToDisk(RECENT_CACHE_FILE, cache);
  return cache;
}

// ── Time entry fetchers ───────────────────────────────────────────────────────
async function fetchHistoricalTimeEntries(ticketIDSet) {
  console.log('[TimeEntries] Building historical cache...');
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const items = await queryAllEntries('/TimeEntries/query', [
    { field: 'dateWorked', op: 'gte', value: sixMonthsAgo.toISOString() },
    { field: 'dateWorked', op: 'lt', value: thirtyDaysAgo.toISOString() },
    { field: 'ticketID', op: 'exist' }
  ]);

  const filtered = items.filter(t =>
    !EXCLUDE_RESOURCES_SET.has(t.resourceID) && ticketIDSet.has(t.ticketID)
  );

  console.log(`[TimeEntries] Historical: ${items.length} total, ${filtered.length} after filter`);
  return { items: filtered, builtAt: new Date().toISOString() };
}

async function fetchRecentTimeEntries(ticketIDSet) {
  console.log('[TimeEntries] Refreshing recent cache...');
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const items = await queryAllEntries('/TimeEntries/query', [
    { field: 'dateWorked', op: 'gte', value: thirtyDaysAgo.toISOString() },
    { field: 'ticketID', op: 'exist' }
  ]);

  const filtered = items.filter(t =>
    !EXCLUDE_RESOURCES_SET.has(t.resourceID) && ticketIDSet.has(t.ticketID)
  );

  console.log(`[TimeEntries] Recent: ${items.length} total, ${filtered.length} after filter`);
  return { items: filtered, builtAt: new Date().toISOString() };
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
      historicalTimeEntryCache = await fetchHistoricalTimeEntries(ticketIDSet);
    }

    recentTimeEntryCache = await fetchRecentTimeEntries(ticketIDSet);

    const resources = await fetchResources();
    res.json(await buildPayload(resources));
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
    historicalTimeEntryCache = null;
    recentTimeEntryCache = null;

    const allTickets = mergeTickets(historicalCache.allTickets, recentCache.allTickets);
    const ticketIDSet = new Set(allTickets.map(t => t.id));

    historicalTimeEntryCache = await fetchHistoricalTimeEntries(ticketIDSet);
    recentTimeEntryCache = await fetchRecentTimeEntries(ticketIDSet);

    const timeEntryMap = {};
    [...(historicalTimeEntryCache.items || []), ...(recentTimeEntryCache.items || [])].forEach(t => {
      timeEntryMap[t.id] = t;
    });

    res.json({
      ok: true,
      totalTimeEntries: Object.keys(timeEntryMap).length,
      historicalBuiltAt: historicalTimeEntryCache.builtAt,
      recentBuiltAt: recentTimeEntryCache.builtAt
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
