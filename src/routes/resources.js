const express = require('express');
const router = express.Router();
const { autotaskClient } = require('../utils/autotask');

router.get('/', async (req, res, next) => {
  try {
    const response = await autotaskClient.post('/Resources/query', {
      filter: [
        { field: 'isActive', op: 'eq', value: true }
      ]
    });

    const resources = (response.data.items || []).map(r => ({
      id: r.id,
      name: `${r.firstName} ${r.lastName}`,
      email: r.email,
      title: r.title
    }));

    res.json({ resources });
  } catch (err) {
    next(err);
  }
});

module.exports = router;