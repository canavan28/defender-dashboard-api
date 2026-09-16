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

// ---------------------------------------------------------------------
// Standup feature exploration (Projects / ProjectTasks) — added this
// session. We have NEVER queried Projects or project-task entities
// anywhere in this codebase before now, so nothing below assumes field
// names are what they sound like. Everything returns raw, undecorated
// AutoTask objects so real field names/shapes can be read directly from
// the response rather than guessed at.
// ---------------------------------------------------------------------

// GET /api/diagnostic/project-fields
// Pulls AutoTask's field metadata for the Projects entity. AutoTask's
// REST API convention (used elsewhere by other MSP integrations, NOT yet
// confirmed working on this zone) is a GET to {Entity}/entityInformation/
// fields, which — for picklist fields like status or department — should
// include the list of valid values and their integer IDs. If this 404s
// or comes back empty, that tells us department/status are NOT picklists
// on this instance (e.g. department might be a plain free-text or a
// lookup to a separate Departments entity instead), which is itself
// useful and something we'd need to handle differently.
router.get('/project-fields', async (req, res) => {
  try {
    const response = await autotaskClient.get('/Projects/entityInformation/fields');
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message, body: err.response?.data });
  }
});

// GET /api/diagnostic/projects-raw?name=Onboarding
// Searches Projects by name (contains match, since onboarding project
// names are confirmed NOT standardized — "Company X Onboarding",
// "Onboarding Company X", "Onboarding Template Company X" all seen in
// real use) and returns the FULL raw item for each match — no field
// picking, since we don't yet know what department/status actually look
// like on a real record. The 'contains' filter op is not yet confirmed
// to work on this AutoTask zone (only 'eq', 'gte', and 'exist' have been
// tested so far in this project) — if this 400s, that's the signal to
// fall back to pulling a broader set and filtering in JS instead.
router.get('/projects-raw', async (req, res) => {
  const name = req.query.name;
  if (!name) {
    return res.status(400).json({ error: 'Pass ?name=SearchTerm in the URL' });
  }
  try {
    const response = await autotaskClient.post('/Projects/query', {
      filter: [{ field: 'projectName', op: 'contains', value: name }]
    });
    res.json({
      searchTerm: name,
      items: response.data.items || [],
      pageDetails: response.data.pageDetails
    });
  } catch (err) {
    res.status(500).json({ error: err.message, body: err.response?.data });
  }
});

// GET /api/diagnostic/project-tasks-raw?projectId=XXXX
// Pulls raw task records for a given project ID. Field name for the
// project-task entity ('Tasks' vs 'ProjectTasks') and its filter field
// ('projectID' vs something else) are both unconfirmed guesses based on
// AutoTask's general naming pattern elsewhere (contractID, companyID,
// etc.) — if this 404s or the filter field is wrong, the error body will
// tell us so we can correct it rather than silently returning nothing.
router.get('/project-tasks-raw', async (req, res) => {
  const projectId = parseInt(req.query.projectId, 10);
  if (!projectId) {
    return res.status(400).json({ error: 'Pass ?projectId=XXXX in the URL' });
  }
  try {
    const response = await autotaskClient.post('/Tasks/query', {
      filter: [{ field: 'projectID', op: 'eq', value: projectId }]
    });
    res.json({
      projectId,
      items: response.data.items || [],
      pageDetails: response.data.pageDetails
    });
  } catch (err) {
    res.status(500).json({ error: err.message, body: err.response?.data });
  }
});

// GET /api/diagnostic/task-fields
// Same purpose as /project-fields but for the Tasks entity — decoding the
// status picklist (we saw values 1, 8, 10, 24 on SharePoint Project's
// tasks with no way yet to tell which of those mean "done" vs "not
// started" vs "in progress"). Also worth checking here whether there's
// any field resembling a REAL per-task due date distinct from
// startDateTime/endDateTime, since those two were identical across every
// task on the one project tested so far — a strong signal they're not
// being used as real per-task scheduling.
router.get('/task-fields', async (req, res) => {
  try {
    const response = await autotaskClient.get('/Tasks/entityInformation/fields');
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message, body: err.response?.data });
  }
});

// GET /api/diagnostic/ticket-fields
// Same purpose as /project-fields and /task-fields, but for the Ticket
// entity — needed to confirm whether Tickets even HAVE a department field
// at all, and if so, whether it reuses the same picklist values we've
// already decoded on Projects/Tasks (29683471 = Engineering, 29683484 =
// Web Development). Tasks turned out to reuse Ticket's status picklist,
// but that does NOT prove the reverse is true for department — nothing
// here is assumed until this comes back.
router.get('/ticket-fields', async (req, res) => {
  try {
    const response = await autotaskClient.get('/Tickets/entityInformation/fields');
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message, body: err.response?.data });
  }
});

// GET /api/diagnostic/resource-search?name=Lozier
// Looks up Resources by last or first name, INCLUDING inactive ones —
// needed specifically because Mark Lamson is no longer an employee and
// would be silently excluded by any isActive:true filter (like the one
// standup.js's fetchResourceNames() uses for display purposes). We still
// need his real numeric ID to exclude his historical tickets from the
// dragging list, even though he's inactive. 'contains' is confirmed
// working on Projects/query this session but not yet tested on
// Resources/query — if this 400s, that's the signal to fall back to
// 'eq' with an exact name instead.
router.get('/resource-search', async (req, res) => {
  const name = req.query.name;
  if (!name) {
    return res.status(400).json({ error: 'Pass ?name=SearchTerm in the URL' });
  }
  try {
    const response = await autotaskClient.post('/Resources/query', {
      filter: [{
        op: 'or',
        items: [
          { field: 'lastName', op: 'contains', value: name },
          { field: 'firstName', op: 'contains', value: name }
        ]
      }]
    });
    res.json({
      searchTerm: name,
      items: (response.data.items || []).map(r => ({
        id: r.id,
        firstName: r.firstName,
        lastName: r.lastName,
        isActive: r.isActive,
        licenseType: r.licenseType
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message, body: err.response?.data });
  }
});

// ---------------------------------------------------------------------
// Auto-close-on-no-response investigation (AI Review false positives) —
// added this session. AI Review is flagging tickets like T20260727.0017
// as "customer-health" issues (frustration, unresolved) when the real
// story is: workflow rule "Waiting on Customer - Day 5" auto-closed the
// ticket after 5 business days of no customer response, following 3
// manual outreach attempts + 2 automatic ones. There is no clean status
// or UDF for this — confirmed by Matt directly, not guessed — the only
// signal is an internal note titled "Auto Closing ticket. No response
// after 5 business days." This route pulls the raw ticket plus its raw
// notes so we can see the REAL entity/field names (note entity name,
// which field holds the note title vs body, which field marks
// "Internal Only") before writing any matching logic against them.
// ---------------------------------------------------------------------

// GET /api/diagnostic/ticket-notes-raw?ticketNumber=T20260727.0017
router.get('/ticket-notes-raw', async (req, res) => {
  const ticketNumber = req.query.ticketNumber;
  if (!ticketNumber) {
    return res.status(400).json({ error: 'Pass ?ticketNumber=TXXXXXXXX.XXXX in the URL' });
  }
  try {
    const ticketRes = await autotaskClient.post('/Tickets/query', {
      filter: [{ field: 'ticketNumber', op: 'eq', value: ticketNumber }]
    });
    const ticket = ticketRes.data.items?.[0];
    if (!ticket) {
      return res.status(404).json({ error: `No ticket found with ticketNumber ${ticketNumber}` });
    }

    let notes = null;
    let notesError = null;
    try {
      const notesRes = await autotaskClient.post('/TicketNotes/query', {
        filter: [{ field: 'ticketID', op: 'eq', value: ticket.id }]
      });
      notes = notesRes.data.items || [];
    } catch (err) {
      notesError = { error: err.message, body: err.response?.data };
    }

    res.json({
      ticketNumber,
      ticket,
      notes,
      notesError
    });
  } catch (err) {
    res.status(500).json({ error: err.message, body: err.response?.data });
  }
});

module.exports = router;