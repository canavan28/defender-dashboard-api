const express = require('express');
const router = express.Router();
const { autotaskClient } = require('../utils/autotask');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const INCLUDE_QUEUES = [5, 29682833, 29683482, 29683496, 29683497];
const EXCLUDE_STATUSES = [5, 20];
const EXCLUDE_RESOURCES = [
  29682885, 29682893, 29682894, 29682895,
  29682902, 29682926, 29682928, 29682936
];

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

    console.log('[Tickets] Fetching summary...');
    const summaryRes = await autotaskClient.post('/Tickets/query', {
      filter: [queueFilter]
    });
    console.log('[Tickets] Summary done, count:', summaryRes.data.items?.length);
    await sleep(500);

    console.log('[Tickets] Fetching open...');
    const openRes = await autotaskClient.post('/Tickets/query', {
      filter: [
        queueFilter,
        {
          op: 'and',
          items: EXCLUDE_STATUSES.map(id => ({
            field: 'status',
            op: 'noteq',
            value: id
          }))
        }
      ]
    });
    console.log('[Tickets] Open done, count:', openRes.data.items?.length);
    await sleep(500);

    console.log('[Tickets] Fetching completed...');
    let completedItems = [];
    try {
      const completedRes = await autotaskClient.post('/Tickets/query', {
        filter: [
          queueFilter,
          { field: 'status', op: 'eq', value: 5 },
          { field: 'completedDate', op: 'exist' }
        ]
      });
      completedItems = (completedRes.data.items || []).filter(
        t => t.hoursToBeScheduled !== null && t.hoursToBeScheduled > 0
      );
      console.log('[Tickets] Completed done, count:', completedItems.length);
    } catch (completedErr) {
      console.log('[Tickets] Completed query failed:', completedErr.message);
    }

    res.json({
      summary: { items: summaryRes.data.items || [] },
      open: { items: openRes.data.items || [] },
      completed: { items: completedItems },
      excludeResources: EXCLUDE_RESOURCES
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;