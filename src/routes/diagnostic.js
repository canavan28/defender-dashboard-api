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

// GET /api/diagnostic/license-audit-raw?companyId=XXXX
// Pulls raw Contract + ContractService + ContractServiceBundle data (plus
// whatever unit/quantity entities actually exist) for one company — for
// scoping the license-audit feature's user/device/partial-user quantity
// math against REAL AutoTask structure. Not guessing field names here:
// this project has already been burned twice by AutoTask's docs implying
// one structure while the real API behaves differently (ContractServices
// needing flat queries, not nested; same with Quotes). Each sub-step is
// independently try/caught (mirrors upsells.js's processCompany
// resilience pattern) so one entity that doesn't exist as expected
// (e.g. if ContractServiceBundleUnits isn't real) doesn't blank the
// whole response — we just see the error for that piece and the raw
// data for everything else, which is itself useful diagnostic signal.
router.get('/license-audit-raw', async (req, res) => {
  const companyId = parseInt(req.query.companyId, 10);
  if (!companyId) {
    return res.status(400).json({ error: 'Pass ?companyId=XXXX in the URL' });
  }
  try {
    const contractsRes = await autotaskClient.post('/Contracts/query', {
      filter: [{ field: 'companyID', op: 'eq', value: companyId }]
    });
    const contracts = contractsRes.data.items || [];
    const results = [];

    for (const contract of contracts) {
      const entry = {
        contract: { id: contract.id, contractName: contract.contractName, status: contract.status }
      };

      try {
        const servicesRes = await autotaskClient.post('/ContractServices/query', {
          filter: [{ field: 'contractID', op: 'eq', value: contract.id }]
        });
        entry.contractServices = servicesRes.data.items || [];
      } catch (err) {
        entry.contractServices = { error: err.message, body: err.response?.data };
      }

      try {
        const bundlesRes = await autotaskClient.post('/ContractServiceBundles/query', {
          filter: [{ field: 'contractID', op: 'eq', value: contract.id }]
        });
        entry.contractServiceBundles = bundlesRes.data.items || [];
      } catch (err) {
        entry.contractServiceBundles = { error: err.message, body: err.response?.data };
      }

      // Per-service billing quantity — confirmed real entity, already used
      // for Inside Sales MRR calculations.
      entry.contractServiceUnits = {};
      for (const cs of Array.isArray(entry.contractServices) ? entry.contractServices : []) {
        try {
          const unitsRes = await autotaskClient.post('/ContractServiceUnits/query', {
            filter: [{ field: 'contractServiceID', op: 'eq', value: cs.id }]
          });
          entry.contractServiceUnits[cs.id] = unitsRes.data.items || [];
        } catch (err) {
          entry.contractServiceUnits[cs.id] = { error: err.message, body: err.response?.data };
        }
      }

      // Per-bundle quantity — NOT confirmed to exist as a named entity;
      // this is a guess at the parallel naming convention. If this 404s,
      // that's useful: it tells us the bundle quantity must live as a
      // plain field directly on the ContractServiceBundle record instead
      // (already captured above in contractServiceBundles).
      entry.contractServiceBundleUnits = {};
      for (const csb of Array.isArray(entry.contractServiceBundles) ? entry.contractServiceBundles : []) {
        try {
          const unitsRes = await autotaskClient.post('/ContractServiceBundleUnits/query', {
            filter: [{ field: 'contractServiceBundleID', op: 'eq', value: csb.id }]
          });
          entry.contractServiceBundleUnits[csb.id] = unitsRes.data.items || [];
        } catch (err) {
          entry.contractServiceBundleUnits[csb.id] = { error: err.message, body: err.response?.data };
        }
      }

      results.push(entry);
    }

    res.json({ companyId, contracts: results });
  } catch (err) {
    res.status(500).json({ error: err.message, body: err.response?.data });
  }
});

module.exports = router;