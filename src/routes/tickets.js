const express = require('express');
const router = express.Router();
const axios = require('axios');
const { autotaskClient, getHeaders } = require('../utils/autotask');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ── Constants ────────────────────────────────────────────────────────────────
const INCLUDE_QUEUES = [5, 29682833, 29683482, 29683496, 29683497];
const EXCLUDE_STATUSES = [5, 20];
const EXCLUDE_RESOURCES = [
  29682885, 29682893, 29682894, 29682895,
  29682902, 29682926, 29682928, 29682936
];
const ISSUE_TYPE_MAP = {
  '6': 'InfoTank Services', '7': 'Server', '10': 'Computer', '11': 'Network',
  '13': 'Maintenance', '16': 'Other', '17': 'Quote', '18': 'RMM Monitoring',
  '19': 'Web Development', '20': 'Email', '21': 'User Management',
  '22': 'Net User Change', '23': 'New Device Setup', '24': 'Mobile Device Mgmt',
  '26': 'Leased Item Install', '27': 'HSCC Daily Onsite', '28': 'Microsoft',
  '29': 'Software', '30': 'Printing/Scanning'
};

// ── Cache ────────────────────────────────────────────────────────────────────
let historicalCache = null; // tickets older than 30 days
let recentCache = null;     // tickets last 30 days

// ── Pagination helper ────────────────────────────────────────────────────────
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

// ── Merge helper (recent wins on duplicate IDs) ───────────────────────────────
function mergeTickets(historical, recent) {
  const map = {};
  (historical || []).forEach(t => { map[t.id] = t; });
  (recent || []).forEach(t => { map[t.id] = t; }); // recent overwrites
  return Object.values(map);
}

// ── Fetch resources ───────────────────────────────────────────────────────────
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

// ── Build queue filter ────────────────────────────────────────────────────────
const queueFilter = {
  op: 'or',
  items: INCLUDE_QUEUES.map(id => ({ field: 'queueID', op: 'eq', value: id }))
};

// ── Fetch historical data (24mo to 30 days ago) ───────────────────────────────
async function fetchHistorical() {
  console.log('[Cache] Building historical cache...');
  const twentyFourMonthsAgo = new Date();
  twentyFourMonthsAgo.setMonth(twentyFourMonthsAgo.getMonth() - 24);
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const allTickets = await queryAllTickets([
    queueFilter,
    { field: 'createDate', op: 'gte', value: twentyFourMonthsAgo.toISOString() },
    { field: 'createDate', op: 'lt', value: thirtyDaysAgo.toISOString() }
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

  console.log(`[Cache] Historical built: ${allTickets.length} all, ${completedTickets.length} completed`);
  return { allTickets, completedTickets, builtAt: new Date() };
}

// ── Fetch recent data (last 30 days) ─────────────────────────────────────────
async function fetchRecent() {
  console.log('[Cache] Refreshing recent cache...');
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

  console.log(`[Cache] Recent built: ${allTickets.length} all, ${openTickets.length} open, ${completedTickets.length} completed`);
  return { allTickets, openTickets, completedTickets, builtAt: new Date() };
}

// ── Regular Sync endpoint ─────────────────────────────────────────────────────
router.get('/all', async (req, res, next) => {
  try {
    // Build historical cache if missing
    if (!historicalCache) {
      historicalCache = await fetchHistorical();
    }

    // Always refresh recent on sync
    recentCache = await fetchRecent();

    // Merge
    const allTickets = mergeTickets(historicalCache.allTickets, recentCache.allTickets);
    const completedTickets = mergeTickets(historicalCache.completedTickets, recentCache.completedTickets);
    const openTickets = recentCache.openTickets;

    const resources = await fetchResources();

    res.json({
      allTickets,
      completedTickets,
      openTickets,
      resources,
      excludeResources: EXCLUDE_RESOURCES,
      issueTypeMap: ISSUE_TYPE_MAP,
      cacheInfo: {
        historicalBuiltAt: historicalCache.builtAt,
        recentBuiltAt: recentCache.builtAt,
        totalTickets: allTickets.length
      }
    });
  } catch (err) {
    next(err);
  }
});

// ── Full refresh endpoint ─────────────────────────────────────────────────────
router.get('/fullrefresh', async (req, res, next) => {
  try {
    console.log('[Cache] Full refresh requested — clearing caches...');
    historicalCache = null;
    recentCache = null;

    historicalCache = await fetchHistorical();
    recentCache = await fetchRecent();

    const allTickets = mergeTickets(historicalCache.allTickets, recentCache.allTickets);
    const completedTickets = mergeTickets(historicalCache.completedTickets, recentCache.completedTickets);
    const openTickets = recentCache.openTickets;
    const resources = await fetchResources();

    res.json({
      allTickets,
      completedTickets,
      openTickets,
      resources,
      excludeResources: EXCLUDE_RESOURCES,
      issueTypeMap: ISSUE_TYPE_MAP,
      cacheInfo: {
        historicalBuiltAt: historicalCache.builtAt,
        recentBuiltAt: recentCache.builtAt,
        totalTickets: allTickets.length
      }
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;