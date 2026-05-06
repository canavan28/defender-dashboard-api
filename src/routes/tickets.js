const express = require('express');
const router = express.Router();
const { autotaskClient } = require('../utils/autotask');

/**
 * GET /api/tickets/summary
 * Returns ticket counts grouped by month for the last 12 months.
 * Used by: Ticket Overview module (volume trend chart)
 */
router.get('/summary', async (req, res, next) => {
  try {
    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);

    const response = await autotaskClient.post('/Tickets/query', {
      filter: [
        {
          field: 'CreateDate',
          op: 'gte',
          value: twelveMonthsAgo.toISOString()
        }
      ],
      includeFields: ['id', 'CreateDate', 'Status', 'AssignedResourceID', 'TicketCategory']
    });

    const tickets = response.data.items || [];

    // Group by month
    const byMonth = {};
    tickets.forEach(ticket => {
      const month = ticket.CreateDate.substring(0, 7); // "YYYY-MM"
      byMonth[month] = (byMonth[month] || 0) + 1;
    });

    res.json({
      total: tickets.length,
      byMonth,
      raw: tickets
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/tickets/open
 * Returns all currently open tickets with age calculation.
 * Used by: Avg open age metric, technician workload bars
 */
router.get('/open', async (req, res, next) => {
  try {
    const response = await autotaskClient.post('/Tickets/query', {
      filter: [
        { field: 'Status', op: 'noteq', value: 5 }  // 5 = Complete in AutoTask
      ],
      includeFields: ['id', 'CreateDate', 'Status', 'AssignedResourceID', 'Title', 'TicketCategory', 'ServiceLevelAgreementID']
    });

    const tickets = response.data.items || [];
    const now = new Date();

    const withAge = tickets.map(ticket => ({
      ...ticket,
      ageInDays: Math.floor((now - new Date(ticket.CreateDate)) / (1000 * 60 * 60 * 24))
    }));

    const avgAge = withAge.length
      ? (withAge.reduce((sum, t) => sum + t.ageInDays, 0) / withAge.length).toFixed(1)
      : 0;

    // Group by technician
    const byTech = {};
    withAge.forEach(t => {
      const id = t.AssignedResourceID || 'unassigned';
      byTech[id] = (byTech[id] || 0) + 1;
    });

    res.json({
      total: tickets.length,
      avgAgeInDays: parseFloat(avgAge),
      byTech,
      tickets: withAge
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/tickets/categories
 * Returns ticket counts grouped by category.
 * Used by: Ticket type donut chart
 */
router.get('/categories', async (req, res, next) => {
  try {
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    const response = await autotaskClient.post('/Tickets/query', {
      filter: [
        { field: 'CreateDate', op: 'gte', value: sixMonthsAgo.toISOString() }
      ],
      includeFields: ['id', 'TicketCategory']
    });

    const tickets = response.data.items || [];
    const byCategory = {};
    tickets.forEach(t => {
      const cat = t.TicketCategory || 'Uncategorized';
      byCategory[cat] = (byCategory[cat] || 0) + 1;
    });

    res.json({ byCategory, total: tickets.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
