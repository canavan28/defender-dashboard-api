const express = require('express');
const router = express.Router();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { autotaskClient, getHeaders } = require('../utils/autotask');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ── Cache ──────────────────────────────────────────────────────────────────
const CACHE_DIR = '/app/data';
const CACHE_FILE = path.join(CACHE_DIR, 'upsells-cache.json');
let cache = null;

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function saveCacheToDisk(data) {
  try {
    ensureCacheDir();
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data));
    console.log(`[UpsellsCache] Saved to disk (${Math.round(JSON.stringify(data).length / 1024)}KB)`);
  } catch (err) {
    console.error('[UpsellsCache] Failed to save:', err.message);
  }
}

function loadCacheFromDisk() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      console.log(`[UpsellsCache] Loaded from disk, built ${data.builtAt}`);
      return data;
    }
  } catch (err) {
    console.error('[UpsellsCache] Failed to load:', err.message);
  }
  return null;
}

cache = loadCacheFromDisk();

// ── Tracked upsells ───────────────────────────────────────────────────────
const TRACKED_UPSELLS = [
  { key: 'accountCompromiseProtection', label: 'Account Compromise Protection', serviceID: 98 },
  { key: 'backupDatto', label: 'Backup - Datto', serviceID: 55 },
  { key: 'backupNas', label: 'Backup - NAS', serviceID: 60 },
  { key: 'managedFirewall', label: 'Managed Firewall', serviceID: 46 },
  { key: 'mdm', label: 'MDM', serviceID: 30 },
  { key: 'passwordManager', label: 'Password Manager', serviceID: 79 },
  { key: 'vigilance', label: 'Vigilance', serviceID: 74 },
  { key: 'vPenTest', label: 'vPenTest', serviceID: 83 }
];

// ── Generic paginated flat query helper ──────────────────────────────────
async function queryAllFlat(entityPath, filter) {
  let allItems = [];
  const body = { filter, maxRecords: 500 };
  const first = await autotaskClient.post(entityPath, body);
  allItems = [...(first.data.items || [])];
  let nextPageUrl = first.data.pageDetails?.nextPageUrl || null;

  while (nextPageUrl) {
    await sleep(250);
    const resp = await axios.post(nextPageUrl, body, { headers: getHeaders() });
    allItems = [...allItems, ...(resp.data.items || [])];
    nextPageUrl = resp.data.pageDetails?.nextPageUrl || null;
  }
  return allItems;
}

// ── Build a map of every ServiceBundle -> which service IDs it includes ──
// This is deliberately NOT hardcoded to the named tiers - it picks up any
// combo bundle (like the "Vigilance + vPenTest" bundle we found on COE)
// automatically, since we check every active bundle's actual contents.
async function buildServiceBundleMap() {
  const bundles = await queryAllFlat('/ServiceBundles/query', [
    { field: 'isActive', op: 'eq', value: true }
  ]);
  const map = {};
  for (const bundle of bundles) {
    await sleep(200);
    const services = await queryAllFlat('/ServiceBundleServices/query', [
      { field: 'serviceBundleID', op: 'eq', value: bundle.id }
    ]);
    map[bundle.id] = {
      name: bundle.name,
      serviceIds: new Set(services.map(s => s.serviceID))
    };
  }
  console.log(`[UpsellsCache] Resolved ${Object.keys(map).length} service bundles`);
  return map;
}

// ── Fetch active customer companies ──────────────────────────────────────
async function fetchActiveCompanies() {
  return queryAllFlat('/Companies/query', [
    { field: 'isActive', op: 'eq', value: true },
    { field: 'companyType', op: 'eq', value: 1 }
  ]);
}

// ── Determine if a ContractService's billing is currently active ────────
// Returns { active: bool, mrr: number } based on the most relevant
// ContractServiceUnits period (catches the "cancelled but line item still
// on contract" case we found with COE's Backup-NAS).
async function resolveBillingStatus(contractServiceId) {
  const units = await queryAllFlat('/ContractServiceUnits/query', [
    { field: 'contractServiceID', op: 'eq', value: contractServiceId }
  ]);
  const now = new Date();
  const pastOrCurrent = units
    .filter(u => new Date(u.startDate) <= now)
    .sort((a, b) => new Date(b.startDate) - new Date(a.startDate));
  const current = pastOrCurrent[0];

  if (current && new Date(current.endDate) >= now && current.price > 0) {
    return { active: true, mrr: current.price };
  }
  return { active: false, mrr: 0 };
}

// ── Process a single company against all tracked upsells ────────────────
async function processCompany(company, bundleMap) {
  const result = {
    companyId: company.id,
    companyName: company.companyName,
    upsells: {}
  };
  TRACKED_UPSELLS.forEach(u => {
    result.upsells[u.key] = { status: 'not_quoted', label: u.label };
  });

  // UDF cross-check values (secondary signal only - see notes below)
  const servicesUdf = (company.userDefinedFields || []).find(f => f.name === 'Services');
  const udfValues = servicesUdf?.value
    ? servicesUdf.value.split(',').map(v => v.trim())
    : [];

  // Contracts -> only Recurring Service type (contractType 7) matter here
  const contracts = await queryAllFlat('/Contracts/query', [
    { field: 'companyID', op: 'eq', value: company.id }
  ]);
  await sleep(200);
  const recurringContracts = contracts.filter(c => c.contractType === 7);

  for (const contract of recurringContracts) {
    // Individually billed ContractServices
    const services = await queryAllFlat('/ContractServices/query', [
      { field: 'contractID', op: 'eq', value: contract.id }
    ]);
    await sleep(200);

    for (const upsell of TRACKED_UPSELLS) {
      const match = services.find(s => s.serviceID === upsell.serviceID);
      if (match) {
        const billing = await resolveBillingStatus(match.id);
        await sleep(150);
        result.upsells[upsell.key] = billing.active
          ? { status: 'active', label: upsell.label, mrr: billing.mrr, contractServiceId: match.id }
          : { status: 'lapsed', label: upsell.label, contractServiceId: match.id };
      }
    }

    // Bundled inclusions (base tiers + combo bundles like Vigilance+vPenTest)
    const contractBundles = await queryAllFlat('/ContractServiceBundles/query', [
      { field: 'contractID', op: 'eq', value: contract.id }
    ]);
    await sleep(200);

    for (const cb of contractBundles) {
      const bundleInfo = bundleMap[cb.serviceBundleID];
      if (!bundleInfo) continue;
      for (const upsell of TRACKED_UPSELLS) {
        if (bundleInfo.serviceIds.has(upsell.serviceID) && result.upsells[upsell.key].status !== 'active') {
          result.upsells[upsell.key] = {
            status: 'included',
            label: upsell.label,
            bundleName: bundleInfo.name
          };
        }
      }
    }
  }

  // Quotes - only matters for upsells not already resolved via contract/bundle
  const stillUnresolved = TRACKED_UPSELLS.some(u => result.upsells[u.key].status === 'not_quoted');
  if (stillUnresolved) {
    const quotes = await queryAllFlat('/Quotes/query', [
      { field: 'companyID', op: 'eq', value: company.id }
    ]);
    await sleep(200);

    const bestQuoteByUpsell = {};
    for (const quote of quotes) {
      const items = await queryAllFlat('/QuoteItems/query', [
        { field: 'quoteID', op: 'eq', value: quote.id }
      ]);
      await sleep(150);

      for (const upsell of TRACKED_UPSELLS) {
        if (result.upsells[upsell.key].status !== 'not_quoted') continue;
        const match = items.find(i => i.serviceID === upsell.serviceID);
        if (match) {
          const existing = bestQuoteByUpsell[upsell.key];
          if (!existing || new Date(quote.createDate) > new Date(existing.createDate)) {
            bestQuoteByUpsell[upsell.key] = quote;
          }
        }
      }
    }

    for (const upsell of TRACKED_UPSELLS) {
      const quote = bestQuoteByUpsell[upsell.key];
      if (!quote) continue;
      if (quote.extApprovalContactResponse === 1) {
        result.upsells[upsell.key] = { status: 'sold_not_on_contract', label: upsell.label, quoteId: quote.id, quoteName: quote.name };
      } else if (quote.extApprovalContactResponse === 2) {
        result.upsells[upsell.key] = { status: 'declined', label: upsell.label, quoteId: quote.id, quoteName: quote.name };
      } else {
        result.upsells[upsell.key] = { status: 'awaiting', label: upsell.label, quoteId: quote.id, quoteName: quote.name };
      }
    }
  }

  // UDF flag - secondary signal for manual review. Only meaningful when the
  // UDF says "yes" but nothing else (contract/bundle) explains it - those
  // are the cases Matt wants to personally sort into real gaps vs freebies.
  for (const upsell of TRACKED_UPSELLS) {
    const udfSaysYes = udfValues.includes(upsell.label);
    if (udfSaysYes && !['active', 'included'].includes(result.upsells[upsell.key].status)) {
      result.upsells[upsell.key].udfFlaggedNoContractLine = true;
    }
  }

  return result;
}

// ── Full cache rebuild ────────────────────────────────────────────────────
async function buildCache() {
  console.log('[UpsellsCache] Starting full rebuild...');
  const bundleMap = await buildServiceBundleMap();
  await sleep(300);

  const companies = await fetchActiveCompanies();
  console.log(`[UpsellsCache] Processing ${companies.length} companies...`);

  const results = [];
  for (const company of companies) {
    try {
      const companyResult = await processCompany(company, bundleMap);
      results.push(companyResult);
    } catch (err) {
      console.error(`[UpsellsCache] Failed on company ${company.id} (${company.companyName}):`, err.message);
    }
    await sleep(300);
  }

  const newCache = { companies: results, builtAt: new Date().toISOString() };
  saveCacheToDisk(newCache);
  return newCache;
}

// ── Routes ────────────────────────────────────────────────────────────────
router.get('/all', async (req, res, next) => {
  try {
    if (!cache) {
      cache = await buildCache();
    }
    res.json(cache);
  } catch (err) {
    next(err);
  }
});

router.get('/refresh', async (req, res, next) => {
  try {
    cache = await buildCache();
    res.json({ ok: true, totalCompanies: cache.companies.length, builtAt: cache.builtAt });
  } catch (err) {
    next(err);
  }
});

module.exports = router;