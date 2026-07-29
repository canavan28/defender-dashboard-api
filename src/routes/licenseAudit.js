// src/routes/licenseAudit.js
//
// Resolves the CONTRACTED side of the license audit: how many users/devices
// a client is actually billed for, per AutoTask's own contract data. The
// CONSUMED side (Datto RMM, SentinelOne, KnowBe4, etc.) is a separate,
// not-yet-built piece — this route only answers "what does the contract say."
//
// Formula confirmed against two real clients with known answers:
//   - COE: 18 Professional Plan (bundle 2) full users — MATCHED
//   - Morton Construction: 19 Professional Plan (bundle 2) full users +
//     14 Partial Users (bundle 7) — BOTH MATCHED
//
// Contracted email/user count = Full Users (from whichever plan bundle) +
//   Partial Users (email-only, no device)
// Contracted device count = Full Users (1 device each) + Extra Devices +
//   Servers
// Add-ons (Vigilance, vPenTest, ACP) tracked separately, each compared
// against its own consumption source later — not part of the base
// user/device pool.

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const { autotaskClient, getHeaders } = require('../utils/autotask');

const router = express.Router();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PAGE_SLEEP_MS = 400;
const DATA_FILE = '/app/data/licenseAudit-cache.json';

let cache = null;

function loadCache() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    console.log(`[LicenseAuditCache] Loaded from disk, built ${cache.builtAt}, ${Object.keys(cache.clients || {}).length} clients`);
  } catch (err) {
    cache = { builtAt: null, clients: {}, errors: [] };
    console.log('[LicenseAuditCache] No cache on disk yet');
  }
  return cache;
}

function saveCache(data) {
  cache = data;
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Confirmed bundle/service IDs — see project notes for how each was
// resolved (service-catalog pull + real-data validation against COE/Morton).
const FULL_USER_BUNDLE_IDS = new Set([2, 3, 6, 8]); // Professional Plan / Essentials Plan / Professional + Plan / Software Essentials
const PARTIAL_USER_BUNDLE_ID = 7;                    // "InfoTank Professional Plan Partial User" bundle
const PARTIAL_USER_SERVICE_ID = 72;                  // "Partial User" service — interchangeable with the bundle above, per Matt
const EXTRA_DEVICES_SERVICE_ID = 19;                 // "Cyber Security Protection - Extra Devices"
const SERVER_SERVICE_IDS = new Set([7, 11]);         // "Server Monitoring", "Server Remote Support"

// Add-ons tracked separately from the base user/device pool — same service
// IDs already confirmed via Inside Sales' upsell tracking.
const ADDON_SERVICE_IDS = {
  vigilance: 74,
  vPenTest: 83,
  acp: 98,
  longTermArchive: 91, // "Long Term Account Archive" — compared against SaaS Protect's Archived Seats
};
const COMBINED_ADDON_BUNDLE_ID = 9; // "S1 Vigilance and vPenTest"

// Finds the ContractServiceUnits/ContractServiceBundleUnits period whose
// [startDate, endDate] window contains right now — same "current billing
// period" pattern already used elsewhere in this project (Inside Sales MRR,
// CS scoring survey/breach sync).
function findCurrentPeriod(periods) {
  if (!periods || periods.length === 0) return null;
  const now = new Date();
  return periods.find((p) => new Date(p.startDate) <= now && new Date(p.endDate) >= now) || null;
}

// Pulls all contract/service/bundle/unit data for one company. No
// pagination handling here — a single company's contract data is very
// unlikely to exceed one page (500 items) on any of these entities, unlike
// the org-wide pulls in customerSuccess.js that genuinely need it.
async function fetchContractRawData(companyId) {
  const contractsRes = await autotaskClient.post('/Contracts/query', {
    filter: [
      { field: 'companyID', op: 'eq', value: companyId },
      { field: 'status', op: 'eq', value: 1 }, // active contracts only
    ],
  });
  const contracts = contractsRes.data.items || [];

  const allServices = [];
  const allBundles = [];
  const serviceUnitsMap = {};
  const bundleUnitsMap = {};

  for (const contract of contracts) {
    const [servicesRes, bundlesRes] = await Promise.all([
      autotaskClient.post('/ContractServices/query', {
        filter: [{ field: 'contractID', op: 'eq', value: contract.id }],
      }),
      autotaskClient.post('/ContractServiceBundles/query', {
        filter: [{ field: 'contractID', op: 'eq', value: contract.id }],
      }),
    ]);
    const services = servicesRes.data.items || [];
    const bundles = bundlesRes.data.items || [];
    allServices.push(...services);
    allBundles.push(...bundles);

    for (const cs of services) {
      const unitsRes = await autotaskClient.post('/ContractServiceUnits/query', {
        filter: [{ field: 'contractServiceID', op: 'eq', value: cs.id }],
      });
      serviceUnitsMap[cs.id] = unitsRes.data.items || [];
      await sleep(PAGE_SLEEP_MS);
    }
    for (const csb of bundles) {
      const unitsRes = await autotaskClient.post('/ContractServiceBundleUnits/query', {
        filter: [{ field: 'contractServiceBundleID', op: 'eq', value: csb.id }],
      });
      bundleUnitsMap[csb.id] = unitsRes.data.items || [];
      await sleep(PAGE_SLEEP_MS);
    }
  }

  return { allServices, allBundles, serviceUnitsMap, bundleUnitsMap };
}

// Follows AutoTask's pageDetails.nextPageUrl pagination (POST, with the
// original filter body resent — confirmed required in customerSuccess.js;
// this instance's zone rejects GET and rejects an empty continuation body).
async function queryAll(entity, body) {
  let items = [];
  const first = await autotaskClient.post(`/${entity}/query`, body);
  items = items.concat(first.data.items || []);
  let nextUrl = first.data.pageDetails?.nextPageUrl;
  while (nextUrl) {
    await sleep(PAGE_SLEEP_MS);
    const pageRes = await axios.post(nextUrl, body, { headers: getHeaders() });
    items = items.concat(pageRes.data.items || []);
    nextUrl = pageRes.data.pageDetails?.nextPageUrl;
  }
  return items;
}

// Same "not a real billed client" exclusions as Customer Success scoring,
// for the same underlying reason — these companies (InfoTank internal, NJC,
// Web Dev accounts) aren't on the standard plan bundles this audit measures.
const EXCLUDE_LICENSE_AUDIT_COMPANIES = new Set([0, 344]);
const WEB_DEV_CLASSIFICATION = 19;

// companyType: 1 = active customer companies — same filter already proven
// in upsells.js's fetchActiveCompanies.
async function fetchActiveCompanies() {
  const companies = await queryAll('Companies', {
    filter: [
      { field: 'isActive', op: 'eq', value: true },
      { field: 'companyType', op: 'eq', value: 1 },
    ],
  });
  return companies.filter(
    (c) => !EXCLUDE_LICENSE_AUDIT_COMPANIES.has(c.id) && Number(c.classification) !== WEB_DEV_CLASSIFICATION
  );
}


// Resolves the confirmed contracted-count breakdown for one company.
async function resolveContractedCounts(companyId) {
  const { allServices, allBundles, serviceUnitsMap, bundleUnitsMap } = await fetchContractRawData(companyId);

  let fullUsers = 0;
  let fullUsersSourceBundle = null;
  for (const bundle of allBundles) {
    if (FULL_USER_BUNDLE_IDS.has(bundle.serviceBundleID)) {
      const period = findCurrentPeriod(bundleUnitsMap[bundle.id]);
      if (period) {
        fullUsers += period.units;
        fullUsersSourceBundle = bundle.serviceBundleID;
      }
    }
  }

  let partialUsers = 0;
  for (const bundle of allBundles) {
    if (bundle.serviceBundleID === PARTIAL_USER_BUNDLE_ID) {
      const period = findCurrentPeriod(bundleUnitsMap[bundle.id]);
      if (period) partialUsers += period.units;
    }
  }
  for (const service of allServices) {
    if (service.serviceID === PARTIAL_USER_SERVICE_ID) {
      const period = findCurrentPeriod(serviceUnitsMap[service.id]);
      if (period) partialUsers += period.units;
    }
  }

  // Extra Devices — flags "lapsed" (had periods historically, but none
  // covering today) separately from genuinely zero, mirroring the same
  // lapsed-detection concept Inside Sales already uses for COE's Backup-NAS.
  let extraDevices = 0;
  let extraDevicesLapsed = false;
  for (const service of allServices) {
    if (service.serviceID === EXTRA_DEVICES_SERVICE_ID) {
      const periods = serviceUnitsMap[service.id];
      const period = findCurrentPeriod(periods);
      if (period) extraDevices += period.units;
      else if (periods && periods.length > 0) extraDevicesLapsed = true;
    }
  }

  // Servers — NOT YET CONFIRMED whether a single server can have both
  // Server Monitoring AND Server Remote Support attached at once, which
  // would double-count it here. serverServiceHitsBothPresent surfaces this
  // directly in the output so real data testing will show us immediately
  // rather than guessing further.
  let servers = 0;
  const serverServiceHits = [];
  for (const service of allServices) {
    if (SERVER_SERVICE_IDS.has(service.serviceID)) {
      const period = findCurrentPeriod(serviceUnitsMap[service.id]);
      if (period) {
        servers += period.units;
        serverServiceHits.push(service.serviceID);
      }
    }
  }

  const addons = {};
  for (const [key, serviceId] of Object.entries(ADDON_SERVICE_IDS)) {
    let units = 0;
    let status = 'not_present';
    for (const service of allServices) {
      if (service.serviceID === serviceId) {
        const period = findCurrentPeriod(serviceUnitsMap[service.id]);
        if (period) {
          units = period.units;
          status = 'active_service';
        }
      }
    }
    // Vigilance/vPenTest can also be covered via the combined bundle rather
    // than an individual service line.
    for (const bundle of allBundles) {
      if (bundle.serviceBundleID === COMBINED_ADDON_BUNDLE_ID && (key === 'vigilance' || key === 'vPenTest')) {
        const period = findCurrentPeriod(bundleUnitsMap[bundle.id]);
        if (period && status === 'not_present') {
          units = period.units;
          status = 'included_in_combined_bundle';
        }
      }
    }
    addons[key] = { units, status };
  }

  return {
    companyId,
    fullUsers,
    fullUsersSourceBundle,
    partialUsers,
    totalContractedUsers: fullUsers + partialUsers,
    extraDevices,
    extraDevicesLapsed,
    servers,
    serverServiceHitsBothPresent: serverServiceHits.length > 1,
    totalContractedDevices: fullUsers + extraDevices + servers,
    addons,
  };
}

// GET /api/license-audit/status — safe to poll repeatedly. Only reads
// whatever's on disk right now; never triggers a build (unlike /all, which
// builds automatically if the cache is empty — that's the risky one to
// poll with, since it could kick off another long run and time out again).
router.get('/status', (req, res) => {
  const data = loadCache();
  res.json({
    builtAt: data.builtAt,
    clientCount: Object.keys(data.clients || {}).length,
    excludedNoFullUsers: data.excludedNoFullUsers || 0,
    errorCount: (data.errors || []).length,
  });
});

// GET /api/license-audit/contracted/:companyId
router.get('/contracted/:companyId', async (req, res) => {
  const companyId = parseInt(req.params.companyId, 10);
  if (!companyId) {
    return res.status(400).json({ error: 'companyId must be a number' });
  }
  try {
    const result = await resolveContractedCounts(companyId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message, body: err.response?.data });
  }
});

// Builds the full cache: every active client's contracted-count breakdown.
// Mirrors upsells.js's processCompany resilience pattern — one company's
// failure gets appended to a shared errors array rather than dropping the
// whole batch (the exact bug class that once made COE vanish from the
// dashboard after a single transient AutoTask error).
async function buildCache() {
  const companies = await fetchActiveCompanies();
  const clients = {};
  const errors = [];
  let excludedNoFullUsers = 0;

  for (const company of companies) {
    try {
      const counts = await resolveContractedCounts(company.id);
      // Exclude any client with no full users — either they don't have one
      // of the four plan bundles (2/3/6/8) attached at all, or the bundle
      // exists but has no current-period units. These clients showed zero
      // across every other field too when spot-checked, consistent with
      // them not being active managed-service clients for this feature's
      // purposes (pure T&M clients, offboarded companies, etc.).
      if (counts.fullUsers === 0) {
        excludedNoFullUsers++;
      } else {
        clients[String(company.id)] = { companyName: company.companyName, ...counts };
      }
    } catch (err) {
      errors.push({ companyId: company.id, companyName: company.companyName, message: err.message });
    }
    await sleep(PAGE_SLEEP_MS);
  }

  const data = { builtAt: new Date().toISOString(), clients, errors, excludedNoFullUsers };
  saveCache(data);
  return data;
}

// GET /api/license-audit/all — serves the cache, building it first if empty
router.get('/all', async (req, res) => {
  try {
    let data = loadCache();
    if (!data.builtAt) {
      data = await buildCache();
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message, body: err.response?.data });
  }
});

// GET /api/license-audit/refresh — forces a full rebuild (slow — many
// sequential AutoTask calls per company, paced with sleeps, same tradeoff
// as upsells.js's /refresh).
router.get('/refresh', async (req, res) => {
  try {
    const data = await buildCache();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message, body: err.response?.data });
  }
});

// ---- Consumed-side upload & matching (Phase 2: Datto RMM first) ----
//
// Design: the frontend parses whatever CSV the user uploads client-side
// (each vendor's export format differs, but this keeps the backend generic
// — it just receives { name, devices } rows regardless of source) and
// POSTs the parsed rows here. Matching order: previously-confirmed manual
// mapping > exact company name match > unmatched (needs reconciliation).
// Manual mappings and ignored names persist forever once resolved, so a
// re-upload of the same source never re-asks about the same row twice.

const CONSUMED_DATA_FILE = '/app/data/licenseAudit-consumed.json';
let consumedCache = null;

function loadConsumedData() {
  if (consumedCache) return consumedCache;
  try {
    consumedCache = JSON.parse(fs.readFileSync(CONSUMED_DATA_FILE, 'utf8'));
  } catch (err) {
    consumedCache = { sources: {}, nameMappings: {}, ignoredNames: {} };
  }
  return consumedCache;
}

function saveConsumedData(data) {
  consumedCache = data;
  fs.writeFileSync(CONSUMED_DATA_FILE, JSON.stringify(data, null, 2));
}

// Broader than fetchActiveCompanies() above — no Web Dev/NJC/internal
// exclusion here, since an upload might legitimately reference one of
// those (e.g. "InfoTank Inventory" mapping to InfoTank itself). Exclusion
// from the final audit view still happens downstream, same as the
// contracted side.
async function fetchAllCompanyNames() {
  const companies = await queryAll('Companies', {
    filter: [
      { field: 'isActive', op: 'eq', value: true },
      { field: 'companyType', op: 'eq', value: 1 },
    ],
  });
  const map = {};
  for (const c of companies) {
    if (c.companyName) map[c.companyName.trim()] = c.id;
  }
  return map;
}

// POST /api/license-audit/consumed/:source
// body: { rows: [{ name, devices }] }
router.post('/consumed/:source', async (req, res) => {
  const source = req.params.source;
  const rows = req.body?.rows;
  if (!Array.isArray(rows)) {
    return res.status(400).json({ error: 'Body must include a rows array of { name, devices }' });
  }

  try {
    const companyNameMap = await fetchAllCompanyNames();
    const data = loadConsumedData();
    if (!data.nameMappings[source]) data.nameMappings[source] = {};
    if (!data.ignoredNames[source]) data.ignoredNames[source] = {};

    const byCompany = {};
    const unmatched = [];

    for (const row of rows) {
      const rawName = (row.name || '').trim();
      const devices = Number(row.devices) || 0;
      if (!rawName) continue;
      if (data.ignoredNames[source][rawName]) continue;

      const companyId = data.nameMappings[source][rawName] || companyNameMap[rawName] || null;

      if (companyId) {
        const key = String(companyId);
        if (!byCompany[key]) byCompany[key] = { devices: 0, rawNames: [] };
        byCompany[key].devices += devices;
        byCompany[key].rawNames.push(rawName);
        // Generic passthrough for any source-specific extra signal beyond
        // name/devices (e.g. SentinelOne's Vigilance MDR add-on flag).
        // Booleans OR together across multiple matched rows for the same
        // company; anything else just takes the latest value.
        for (const [k, v] of Object.entries(row)) {
          if (k === 'name' || k === 'devices') continue;
          if (typeof v === 'boolean') {
            byCompany[key][k] = byCompany[key][k] || v;
          } else if (typeof v === 'number') {
            byCompany[key][k] = (byCompany[key][k] || 0) + v;
          } else {
            byCompany[key][k] = v;
          }
        }
      } else {
        const extra = {};
        for (const [k, v] of Object.entries(row)) {
          if (k !== 'name' && k !== 'devices') extra[k] = v;
        }
        unmatched.push({ rawName, devices, extra });
      }
    }

    data.sources[source] = { byCompany, unmatched, uploadedAt: new Date().toISOString() };
    saveConsumedData(data);

    res.json({
      source,
      matchedCount: Object.keys(byCompany).length,
      unmatchedCount: unmatched.length,
      unmatched,
    });
  } catch (err) {
    res.status(500).json({ error: err.message, body: err.response?.data });
  }
});

// GET /api/license-audit/consumed/:source
router.get('/consumed/:source', (req, res) => {
  const data = loadConsumedData();
  res.json(data.sources[req.params.source] || { byCompany: {}, unmatched: [], uploadedAt: null });
});

// POST /api/license-audit/consumed/:source/map
// body: { rawName, companyId } — records a permanent mapping and resolves
// this row immediately, without needing to re-upload the CSV.
router.post('/consumed/:source/map', (req, res) => {
  const source = req.params.source;
  const { rawName, companyId } = req.body || {};
  if (!rawName || !companyId) {
    return res.status(400).json({ error: 'rawName and companyId are required' });
  }
  const data = loadConsumedData();
  if (!data.nameMappings[source]) data.nameMappings[source] = {};
  data.nameMappings[source][rawName] = Number(companyId);

  const src = data.sources[source];
  if (src) {
    const idx = src.unmatched.findIndex((u) => u.rawName === rawName);
    if (idx !== -1) {
      const [row] = src.unmatched.splice(idx, 1);
      const key = String(companyId);
      if (!src.byCompany[key]) src.byCompany[key] = { devices: 0, rawNames: [] };
      src.byCompany[key].devices += row.devices;
      src.byCompany[key].rawNames.push(row.rawName);
      for (const [k, v] of Object.entries(row.extra || {})) {
        if (typeof v === 'boolean') {
          src.byCompany[key][k] = src.byCompany[key][k] || v;
        } else if (typeof v === 'number') {
          src.byCompany[key][k] = (src.byCompany[key][k] || 0) + v;
        } else {
          src.byCompany[key][k] = v;
        }
      }
    }
  }

  saveConsumedData(data);
  res.json({ ok: true });
});

// POST /api/license-audit/consumed/:source/ignore
// body: { rawName } — permanently marks a raw name as "not a real client"
// (e.g. placeholder site names like "Managed" or "OnDemand"), so it never
// shows up as unmatched again.
router.post('/consumed/:source/ignore', (req, res) => {
  const source = req.params.source;
  const { rawName } = req.body || {};
  if (!rawName) return res.status(400).json({ error: 'rawName is required' });
  const data = loadConsumedData();
  if (!data.ignoredNames[source]) data.ignoredNames[source] = {};
  data.ignoredNames[source][rawName] = true;

  const src = data.sources[source];
  if (src) {
    src.unmatched = src.unmatched.filter((u) => u.rawName !== rawName);
  }
  saveConsumedData(data);
  res.json({ ok: true });
});

// GET /api/license-audit/companies-list — for the manual-mapping dropdown
// in the upload reconciliation UI.
router.get('/companies-list', async (req, res) => {
  try {
    const map = await fetchAllCompanyNames();
    const list = Object.entries(map)
      .map(([companyName, id]) => ({ id, companyName }))
      .sort((a, b) => a.companyName.localeCompare(b.companyName));
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message, body: err.response?.data });
  }
});

module.exports = router;