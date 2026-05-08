const express = require('express');
const router = express.Router();
const { autotaskClient } = require('../utils/autotask');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Queues to include
const INCLUDE_QUEUES = [5, 29682833, 29683482, 29683496, 29683497];

// Statuses to exclude
const EXCLUDE_STATUSES = [5, 20]; // Complete, RMM Resolved

router.get('/all', async (req, res, next) => {
  try {
    // All tickets in valid queues
    const summaryRes = await autotaskClient.post('/Tickets/query', {
      filter: [
        {
          op: 'or',
          items: INCLUDE_QUEUES.map(id => ({
            field: 'queueID',
            op: 'eq',
            value: id
          }))
        }
      ]
    });
    await sleep(500);

    // Open tickets in valid queues (excluding RMM Resolved and Complete)
    const openRes = await autotaskClient.post('/Tickets/query', {
      filter: [
        {
          op: 'or',
          items: INCLUDE_QUEUES.map(id => ({
            field: 'queueID',
            op: 'eq',
            value: id
          }))
        },
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

    // Categories in valid queues
    const categoriesRes = await autotaskClient.post('/Tickets/query', {
      filter: [
        {
          op: 'or',
          items: INCLUDE_QUEUES.map(id => ({
            field: 'queueID',
            op: 'eq',
            value: id
          }))
        }
      ]
    });

    res.json({
      summary: { items: summaryRes.data.items || [] },
      open: { items: openRes.data.items || [] },
      categories: { items: categoriesRes.data.items || [] }
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;