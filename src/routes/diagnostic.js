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

  // 1. Resolve Service IDs by name (needed to match ContractServices.serviceID)
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

  // 2. Company record + UDFs (to see the "Services" multiselect raw format)
  results.company = await safeStep('Company + UDFs', async () => {
    const response = await autotaskClient.post('/Companies/query', {
      filter: [{ field: 'id', op: 'eq', value: companyId }]
    });
    return response.data.items;
  });
  await sleep(300);

  // 3. Contracts for this company (no status filter yet — want to see real status values first)
  const contractsResult = await safeStep('Contracts for company', async () => {
    const response = await autotaskClient.post('/Contracts/query', {
      filter: [{ field: 'companyID', op: 'eq', value: companyId }]
    });
    return response.data.items;
  });
  results.contracts = contractsResult;
  await sleep(300);

  // 4. ContractServices — try BOTH a flat query and the nested child path, to see which actually works
  results.contractServicesAttempts = [];
  if (contractsResult.ok && contractsResult.data.length) {
    for (const contract of contractsResult.data) {
      const flatAttempt = await safeStep(`ContractServices FLAT query (contract ${contract.id})`, async () => {
        const response = await autotaskClient.post('/ContractServices/query', {
          filter: [{ field: 'contractID', op: 'eq', value: contract.id }]
        });
        return response.data.items;
      });
      await sleep(300);

      const nestedAttempt = await safeStep(`ContractServices NESTED query (contract ${contract.id})`, async () => {
        const response = await autotaskClient.post(`/Contracts/${contract.id}/ContractServices/query`, {
          filter: [{ field: 'id', op: 'gte', value: 0 }]
        });
        return response.data.items;
      });
      await sleep(300);

      results.contractServicesAttempts.push({ contractId: contract.id, flatAttempt, nestedAttempt });
    }
  }

  // 5. Opportunities for this company (Quotes must attach to one)
  const opportunitiesResult = await safeStep('Opportunities for company', async () => {
    const response = await autotaskClient.post('/Opportunities/query', {
      filter: [{ field: 'companyID', op: 'eq', value: companyId }]
    });
    return response.data.items;
  });
  results.opportunities = opportunitiesResult;
  await sleep(300);

  // 6. Quotes — nested under each Opportunity
  results.quoteAttempts = [];
  if (opportunitiesResult.ok && opportunitiesResult.data.length) {
    for (const opp of opportunitiesResult.data) {
      const quotesAttempt = await safeStep(`Quotes NESTED query (opportunity ${opp.id})`, async () => {
        const response = await autotaskClient.post(`/Opportunities/${opp.id}/Quotes/query`, {
          filter: [{ field: 'id', op: 'gte', value: 0 }]
        });
        return response.data.items;
      });
      results.quoteAttempts.push({ opportunityId: opp.id, quotesAttempt });
      await sleep(300);
    }
  }

  res.json(results);
});

module.exports = router;