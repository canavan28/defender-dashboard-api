const express = require('express');
const router = express.Router();
const axios = require('axios');
const { autotaskClient, getHeaders } = require('../utils/autotask');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

async function queryAllTickets(filter) {
  let allItems = [];
  let nextPageUrl = null;

  do {
    let response;
    if (nextPageUrl) {
      response = await axios.post(nextPageUrl, {}, { headers: getHeaders() });
    } else {
      response = await autotaskClient.post('/Tickets/query', { filter, maxRecords: 500 });
    }

    const items = response.data.items || [];
    allItems = [...allItems, ...items];
    nextPageUrl = response.data.pageDetails?.nextPageUrl || null;

    if (nextPageUrl) await sleep(300);
  } while (nextPageUrl);

  return allItems;
}

router.get('/all', async (req, res, next) => {
  try {
    const queueFilter = {
      op: 'or',
      items: INCLUDE_QUEUES.map(id => ({
        field: 'queueID',
        op: 'eq',
        value: id
      }))
    };

    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);

    console.log('[Tickets] Fetching summary...');
    const summaryItems = await queryAllTickets([
      queueFilter,
      { field: 'createDate', op: 'gte', value: twelveMonthsAgo.toISOString() }
    ]);
    console.log('[Tickets] Summary done, count:', summaryItems.length);
    await sleep(500);

    console.log('[Tickets] Fetching open...');
    const openItems = await queryAllTickets([
      queueFilter,
      {
        op: 'and',
        items: EXCLUDE_STATUSES.map(id => ({
          field: 'status',
          op: 'noteq',
          value: id
        }))
      }
    ]);
    console.log('[Tickets] Open done, count:', openItems.length);
    await sleep(500);

    console.log('[Tickets] Fetching completed...');
    let completedItems = [];
    try {
      completedItems = await queryAllTickets([
        queueFilter,
        { field: 'status', op: 'eq', value: 5 },
        { field: 'completedDate', op: 'exist' },
        { field: 'createDate', op: 'gte', value: twelveMonthsAgo.toISOString() }
      ]);
      console.log('[Tickets] Completed done, count:', completedItems.length);
    } catch (completedErr) {
      console.log('[Tickets] Completed query failed:', completedErr.message);
    }

    res.json({
      summary: { items: summaryItems },
      open: { items: openItems },
      completed: { items: completedItems },
      excludeResources: EXCLUDE_RESOURCES,
      issueTypeMap: ISSUE_TYPE_MAP
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;