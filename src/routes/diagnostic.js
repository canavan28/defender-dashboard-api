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

module.exports = router;