const express = require('express');
const router = express.Router();
const { autotaskClient } = require('../utils/autotask');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const TRACKED_SERVICE_NAMES = [
  'Account Compromise Protection',
  'Onsite and Cloud Backups and Disaster Recovery',
  'Onsite and Cloud Backups',
  'Managed Firewall',
  'Mobile Device Management',
  'LastPass',
  'Vigilance - 24/7 SOC',
  'vPenTest'
];

async function safeStep(label, fn) {
  try {
    const result = await fn();
    console.log(`[Diagnostic] ${label}: OK (${Array.isArray(result) ? result.length : 'n/a'} items)`);
    return { ok: true, data: result };
  } catch (err) {
    console.log(`[Diagnostic] ${label}: FAILED - ${err.message}`);
    return {
      ok: false,
      error: err.message,
      status: err.response?.status,
      body: err.response?.data
    };
  }
}

// GET /api/diagnostic/upsells?companyId=XXXX
router.get('/upsells', async (req, res) => {
  const companyId = parseInt(req.query.companyId, 10);
  if (!companyId) {
    return res.status(400).json({ error: 'Pass ?companyId=XXXX in the URL' });
  }

  const results = {};

  // 1. Resolve Service IDs by name (CONFIRMED WORKING)
  results.services = await safeStep('Services lookup', async () => {
    const response = await autotaskClient.post('/Services/query', {
      filter: [
        {
          op: 'or',
          items: TRACKED_SERVICE_NAMES.map(name => ({ field: 'name', op: 'eq', value: name }))
        }
      ]
    });
    return response.data.items;
  });
  await sleep(300);

  // 2. Company record + UDFs (CONFIRMED WORKING)
  results.company = await safeStep('Company + UDFs', async () => {
    const response = await autotaskClient.post('/Companies/query', {
      filter: [{ field: 'id', op: 'eq', value: companyId }]
    });
    return response.data.items;
  });
  await sleep(300);

  // 3. Contracts for this company (CONFIRMED WORKING)
  const contractsResult = await safeStep('Contracts for company', async () => {
    const response = await autotaskClient.post('/Contracts/query', {
      filter: [{ field: 'companyID', op: 'eq', value: companyId }]
    });
    return response.data.items;
  });
  results.contracts = contractsResult;
  await sleep(300);

  // 4. ContractServices — CONFIRMED: flat query works, nested 404s. Only doing flat now.
  results.contractServices = [];
  if (contractsResult.ok && contractsResult.data.length) {
    for (const contract of contractsResult.data) {
      const attempt = await safeStep(`ContractServices (contract ${contract.id})`, async () => {
        const response = await autotaskClient.post('/ContractServices/query', {
          filter: [{ field: 'contractID', op: 'eq', value: contract.id }]
        });
        return response.data.items;
      });
      results.contractServices.push({ contractId: contract.id, attempt });
      await sleep(300);
    }
  }

  // 5. Quotes — NEW APPROACH: flat query filtered directly by companyID (no Opportunity nesting needed)
  const quotesResult = await safeStep('Quotes FLAT query by companyID', async () => {
    const response = await autotaskClient.post('/Quotes/query', {
      filter: [{ field: 'companyID', op: 'eq', value: companyId }]
    });
    return response.data.items;
  });
  results.quotes = quotesResult;
  await sleep(300);

  // 6. QuoteItems — try BOTH flat and nested, same approach that resolved ContractServices
  results.quoteItemsAttempts = [];
  if (quotesResult.ok && quotesResult.data.length) {
    for (const quote of quotesResult.data) {
      const flatAttempt = await safeStep(`QuoteItems FLAT query (quote ${quote.id})`, async () => {
        const response = await autotaskClient.post('/QuoteItems/query', {
          filter: [{ field: 'quoteID', op: 'eq', value: quote.id }]
        });
        return response.data.items;
      });
      await sleep(300);

      const nestedAttempt = await safeStep(`QuoteItems NESTED query (quote ${quote.id})`, async () => {
        const response = await autotaskClient.post(`/Quotes/${quote.id}/QuoteItems/query`, {
          filter: [{ field: 'id', op: 'gte', value: 0 }]
        });
        return response.data.items;
      });
      await sleep(300);

      results.quoteItemsAttempts.push({ quoteId: quote.id, flatAttempt, nestedAttempt });
    }
  }

  res.json(results);
});
// GET /api/diagnostic/contractserviceunits?contractServiceIds=189,192,379
router.get('/contractserviceunits', async (req, res) => {
  const ids = (req.query.contractServiceIds || '').split(',').map(id => parseInt(id.trim(), 10)).filter(Boolean);
  if (!ids.length) {
    return res.status(400).json({ error: 'Pass ?contractServiceIds=189,192,379 in the URL' });
  }

  const results = {};
  for (const id of ids) {
    results[id] = await safeStep(`ContractServiceUnits for ContractService ${id}`, async () => {
      const response = await autotaskClient.post('/ContractServiceUnits/query', {
        filter: [{ field: 'contractServiceID', op: 'eq', value: id }]
      });
      return response.data.items;
    });
    await sleep(300);
  }

  res.json(results);
});

const BUNDLE_NAMES = [
  'InfoTank Professional + Plan',
  'InfoTank Professional Plan Services',
  'InfoTank Essentials Plan Services',
  'Software Essentials'
];

// GET /api/diagnostic/bundles?companyId=563
router.get('/bundles', async (req, res) => {
  const companyId = parseInt(req.query.companyId, 10);
  const results = {};

  // 1. Resolve bundle IDs by name
  const bundlesResult = await safeStep('ServiceBundles lookup', async () => {
    const response = await autotaskClient.post('/ServiceBundles/query', {
      filter: [
        {
          op: 'or',
          items: BUNDLE_NAMES.map(name => ({ field: 'name', op: 'eq', value: name }))
        }
      ]
    });
    return response.data.items;
  });
  results.bundles = bundlesResult;
  await sleep(300);

  // 2. For each bundle found, see what services it includes
  results.bundleServices = [];
  if (bundlesResult.ok && bundlesResult.data.length) {
    for (const bundle of bundlesResult.data) {
      const attempt = await safeStep(`ServiceBundleServices for bundle "${bundle.name}" (${bundle.id})`, async () => {
        const response = await autotaskClient.post('/ServiceBundleServices/query', {
          filter: [{ field: 'serviceBundleID', op: 'eq', value: bundle.id }]
        });
        return response.data.items;
      });
      results.bundleServices.push({ bundleId: bundle.id, bundleName: bundle.name, attempt });
      await sleep(300);
    }
  }

  // 3. If a companyId was passed, check which bundle (if any) that company's contract is on
  if (companyId) {
    const contractsResult = await safeStep('Contracts for company', async () => {
      const response = await autotaskClient.post('/Contracts/query', {
        filter: [{ field: 'companyID', op: 'eq', value: companyId }]
      });
      return response.data.items;
    });
    results.contracts = contractsResult;
    await sleep(300);

    results.contractServiceBundles = [];
    if (contractsResult.ok && contractsResult.data.length) {
      for (const contract of contractsResult.data) {
        const attempt = await safeStep(`ContractServiceBundles for contract ${contract.id}`, async () => {
          const response = await autotaskClient.post('/ContractServiceBundles/query', {
            filter: [{ field: 'contractID', op: 'eq', value: contract.id }]
          });
          return response.data.items;
        });
        results.contractServiceBundles.push({ contractId: contract.id, attempt });
        await sleep(300);
      }
    }
  }

  res.json(results);
});

module.exports = router;