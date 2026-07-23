const express = require('express');
const router = express.Router();
const { autotaskClient } = require('../utils/autotask');
const { ghlClient } = require('../utils/ghl');

// GET /api/diagnostic/company-udfs?companyId=563
router.get('/company-udfs', async (req, res) => {
  const companyId = parseInt(req.query.companyId, 10);
  if (!companyId) {
    return res.status(400).json({ error: 'Pass ?companyId=XXXX in the URL' });
  }
  try {
    const response = await autotaskClient.post('/Companies/query', {
      filter: [{ field: 'id', op: 'eq', value: companyId }]
    });
    const company = response.data.items?.[0];
    res.json({
      companyName: company?.companyName,
      userDefinedFields: company?.userDefinedFields
    });
  } catch (err) {
    res.status(500).json({ error: err.message, body: err.response?.data });
  }
});

// GET /api/diagnostic/ghl-pipelines
router.get('/ghl-pipelines', async (req, res) => {
  try {
    const response = await ghlClient.get('/opportunities/pipelines', {
      locationId: process.env.GHL_LOCATION_ID
    });
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message, body: err.response?.data });
  }
});

// GET /api/diagnostic/ghl-opportunities?pipelineId=XXXX
router.get('/ghl-opportunities', async (req, res) => {
  try {
    const response = await ghlClient.get('/opportunities/search', {
      location_id: process.env.GHL_LOCATION_ID,
      pipeline_id: req.query.pipelineId,
      limit: 10
    });
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message, body: err.response?.data });
  }
});

module.exports = router;