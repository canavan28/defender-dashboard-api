const express = require('express');
const router = express.Router();
const { autotaskClient } = require('../utils/autotask');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

router.get('/compliance', async (req, res, next) => {
  try {
    const now = new Date();
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(now.getMonth() - 6);
    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setMonth(now.getMonth() - 12);

    const currentRes = await autotaskClient.post('/Tickets/query', {
      filter: [
        { field: 'id', op: 'gt', value: 0 }
      ]
    });
    await sleep(500);

    const priorRes = await autotaskClient.post('/Tickets/query', {
      filter: [
        { field: 'id', op: 'gt', value: 0 }
      ]
    });

    const calcBreachRate = (tickets) => {
      if (!tickets.length) return 0;
      const breached = tickets.filter(t => t.serviceLevelAgreementHasBeenMet === false).length;
      return parseFloat(((breached / tickets.length) * 100).toFixed(1));
    };

    const currentTickets = currentRes.data.items || [];
    const priorTickets = priorRes.data.items || [];

    res.json({
      current: { total: currentTickets.length, breachRate: calcBreachRate(currentTickets) },
      prior: { total: priorTickets.length, breachRate: calcBreachRate(priorTickets) }
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;