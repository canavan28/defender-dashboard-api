const express = require('express');
const router = express.Router();
const { autotaskClient } = require('../utils/autotask');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const INCLUDE_QUEUES = [5, 29682833, 29683482, 29683496, 29683497];
const EXCLUDE_STATUSES = [5, 20]; // Complete, RMM Resolved
const EXCLUDE_RESOURCES = [
  29682885, // Matt Canavan
  29682893, // Joe Lozier
  29682894, // Carissa Malone
  29682895, // Mark Lamson
  29682902, // Matt Woodring
  29682926, // Avery Sellers
  29682928, // Ali Sellers
  29682936  // Brian Robinson
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

    // All tickets in valid queues for volume trend
    const summaryRes = await autotaskClient.post('/Tickets/query', {
      filter: [queueFilter]
    });
    await sleep(500);

    // Open tickets excluding RMM Resolved and Complete
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
    await sleep(500);

    // Completed tickets with a completedDate for avg resolution time
    // Exclude tickets with no hours (hoursToBeScheduled is null and status is complete)
    const completedRes = await autotaskClient.post('/Tickets/query', {
      filter: [
        queueFilter,
        { field: 'status', op: 'eq', value: 5 },
        { field: 'completedDate', op: 'exist' }
      ]
    });

    // Filter out tickets with no work done (hoursToBeScheduled null)
    const completedWithWork = (completedRes.data.items || []).filter(
      t => t.hoursToBeScheduled !== null && t.hoursToBeScheduled > 0
    );

    res.json({
      summary: { items: summaryRes.data.items || [] },
      open: { items: openRes.data.items || [] },
      completed: { items: completedWithWork },
      excludeResources: EXCLUDE_RESOURCES
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;