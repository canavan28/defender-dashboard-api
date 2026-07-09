const express = require('express');
const router = express.Router();
const { autotaskClient } = require('../utils/autotask');

// GET /api/diagnostic/classification-picklist
router.get('/classification-picklist', async (req, res) => {
  try {
    const response = await autotaskClient.get('/Companies/entityInformation/fields');
    const field = response.data.fields.find(f => f.name === 'classification');
    res.json({ field });
  } catch (err) {
    res.status(500).json({ error: err.message, body: err.response?.data });
  }
});

module.exports = router;