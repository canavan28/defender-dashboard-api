const express = require('express');
const router = express.Router();
const { autotaskClient } = require('../utils/autotask');

router.get('/summary', async (req, res, next) => {
  try {
    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);

    const response = await autotaskClient.post('/Tickets/query', {
      filter: [
        {
          field: 'id',
          op: 'gt',
          value: 0
        }
      ]
    });

    const tickets = response.data.items || [];
    const byMonth = {};
    tickets.forEach(ticket => {
      const month = ticket.createDate?.substring(0, 7);
      if (month) byMonth[month] = (byMonth[month] || 0) + 1;
    });

    res.json({ total: tickets.length, byMonth });
  } catch (err) {
    next(err);
  }
});

router.get('/open', async (req, res, next) => {
  try {
    const response = await autotaskClient.post('/Tickets/query', {
      filter: [
        { field: 'status', op: 'noteq', value: 5 }
      ]
    });

    const tickets = response.data.items || [];
    const now = new Date();
    const withAge = tickets.map(ticket => ({
      ...ticket,
      ageInDays: Math.floor((now - new Date(ticket.createDate)) / (1000 * 60 * 60 * 24))
    }));

    const avgAge = withAge.length
      ? (withAge.reduce((sum, t) => sum + t.ageInDays, 0) / withAge.length).toFixed(1)
      : 0;

    const byTech = {};
    withAge.forEach(t => {
      const id = t.assignedResourceID || 'unassigned';
      byTech[id] = (byTech[id] || 0) + 1;
    });

    res.json({ total: tickets.length, avgAgeInDays: parseFloat(avgAge), byTech });
  } catch (err) {
    next(err);
  }
});

router.get('/categories', async (req, res, next) => {
  try {
    const response = await autotaskClient.post('/Tickets/query', {
      filter: [
        { field: 'id', op: 'gt', value: 0 }
      ]
    });

    const tickets = response.data.items || [];
    const byCategory = {};
    tickets.forEach(t => {
      const cat = t.ticketCategory || 'Uncategorized';
      byCategory[cat] = (byCategory[cat] || 0) + 1;
    });

    res.json({ byCategory, total: tickets.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;