const express = require('express');
const router = express.Router();
const { autotaskClient } = require('../utils/autotask');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

router.get('/all', async (req, res, next) => {
  try {
    const summaryRes = await autotaskClient.post('/Tickets/query', {
      filter: [{ field: 'id', op: 'gt', value: 0 }]
    });

    // Temporary - log first ticket to see field names
    if (summaryRes.data.items?.length > 0) {
      console.log('[Ticket Fields]', JSON.stringify(summaryRes.data.items[0]));
    }

    await sleep(500);

    const openRes = await autotaskClient.post('/Tickets/query', {
      filter: [{ field: 'status', op: 'noteq', value: 5 }]
    });
    await sleep(500);

    const categoriesRes = await autotaskClient.post('/Tickets/query', {
      filter: [{ field: 'id', op: 'gt', value: 0 }]
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
router.get('/queues', async (req, res, next) => {
  try {
    const response = await autotaskClient.get('/Tickets/entityInformation/fields');
    const fields = response.data.fields || [];
    const queueField = fields.find(f => f.name === 'queueID');
    res.json({ queues: queueField?.picklistValues || [] });
  } catch (err) {
    next(err);
  }
});
module.exports = router;