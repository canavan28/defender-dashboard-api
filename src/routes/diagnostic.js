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

// GET /api/diagnostic/service-catalog
// Pulls the full Services and ServiceBundles catalog directly from
// AutoTask, for the license-audit feature: finding exact IDs/names for
// the 4 plan bundles, Partial User, Extra Devices, Server Remote
// Support/Monitoring, etc. — rather than matching against what these are
// casually called, which has already burned us once on this project
// (e.g. "S1 Vigilance and vPenTest" turned out to actually be named
// "Sentinel One Vigilance and vPenTest combined" in AutoTask).
// NOTE: no pagination handling here (unlike customerSuccess.js's queryAll)
// — if either list looks suspiciously short or the raw response includes
// a truthy pageDetails.nextPageUrl, the catalog is larger than one page
// and this needs pagination added before trusting it's complete.
router.get('/service-catalog', async (req, res) => {
  try {
    const [servicesRes, bundlesRes] = await Promise.all([
      autotaskClient.post('/Services/query', {
        filter: [{ field: 'id', op: 'gte', value: 0 }]
      }),
      autotaskClient.post('/ServiceBundles/query', {
        filter: [{ field: 'id', op: 'gte', value: 0 }]
      })
    ]);
    res.json({
      services: (servicesRes.data.items || [])
        .map(s => ({ id: s.id, name: s.name, isActive: s.isActive }))
        .sort((a, b) => a.name?.localeCompare(b.name)),
      servicesPageDetails: servicesRes.data.pageDetails,
      serviceBundles: (bundlesRes.data.items || [])
        .map(b => ({ id: b.id, name: b.name, isActive: b.isActive }))
        .sort((a, b) => a.name?.localeCompare(b.name)),
      serviceBundlesPageDetails: bundlesRes.data.pageDetails
    });
  } catch (err) {
    res.status(500).json({ error: err.message, body: err.response?.data });
  }
});

module.exports = router;