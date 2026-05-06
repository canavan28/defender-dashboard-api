const express = require('express');
const router = express.Router();
const { autotaskClient } = require('../utils/autotask');

/**
 * GET /api/resources
 * Returns active technician resources.
 * Used to map AssignedResourceID → real names in the frontend.
 */
router.get('/', async (req, res, next) => {
  try {
    const response = await autotaskClient.post('/Resources/query', {
      filter: [
        { field: 'IsActive', op: 'eq', value: true },
        { field: 'ResourceType', op: 'eq', value: 1 } // 1 = Employee
      ],
      includeFields: ['id', 'FirstName', 'LastName', 'Email', 'Title']
    });

    const resources = (response.data.items || []).map(r => ({
      id: r.id,
      name: `${r.FirstName} ${r.LastName}`,
      email: r.Email,
      title: r.Title
    }));

    res.json({ resources });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
