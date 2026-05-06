const express = require('express');
const router = express.Router();
const { autotaskClient } = require('../utils/autotask');

/**
 * GET /api/sla/compliance
 * Returns SLA breach rate for the last 6 months vs prior 6 months.
 * Used by: SLA Health module and Staffing Signals card
 */
router.get('/compliance', async (req, res, next) => {
  try {
    const now = new Date();
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(now.getMonth() - 6);
    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setMonth(now.getMonth() - 12);

    // Current period
    const currentRes = await autotaskClient.post('/Tickets/query', {
      filter: [
        { field: 'CreateDate', op: 'gte', value: sixMonthsAgo.toISOString() },
        { field: 'Status', op: 'eq', value: 5 } // completed tickets only for SLA calc
      ],
      includeFields: ['id', 'ServiceLevelAgreementHasBeenMet']
    });

    // Prior period
    const priorRes = await autotaskClient.post('/Tickets/query', {
      filter: [
        { field: 'CreateDate', op: 'gte', value: twelveMonthsAgo.toISOString() },
        { field: 'CreateDate', op: 'lt', value: sixMonthsAgo.toISOString() },
        { field: 'Status', op: 'eq', value: 5 }
      ],
      includeFields: ['id', 'ServiceLevelAgreementHasBeenMet']
    });

    const calcBreachRate = (tickets) => {
      if (!tickets.length) return 0;
      const breached = tickets.filter(t => t.ServiceLevelAgreementHasBeenMet === false).length;
      return parseFloat(((breached / tickets.length) * 100).toFixed(1));
    };

    const currentTickets = currentRes.data.items || [];
    const priorTickets = priorRes.data.items || [];

    res.json({
      current: {
        total: currentTickets.length,
        breachRate: calcBreachRate(currentTickets)
      },
      prior: {
        total: priorTickets.length,
        breachRate: calcBreachRate(priorTickets)
      }
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
