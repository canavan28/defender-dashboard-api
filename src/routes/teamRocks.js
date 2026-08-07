const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();

const DATA_DIR = '/app/data';
const ROCKS_FILE = path.join(DATA_DIR, 'teamrocks.json');
const VTO_FILE = path.join(DATA_DIR, 'vtos.json');

// No requireOwner here — this tab is open to anyone who can log into the
// dashboard at all (verifyApiKey, mounted globally in index.js, is the only gate).

// ---- Storage helpers ----

function loadStore() {
  try {
    const raw = fs.readFileSync(ROCKS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return { records: {} };
    throw err;
  }
}

function saveStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ROCKS_FILE, JSON.stringify(store, null, 2));
}

// Deep-set helper, identical to vto.js's setPath, used for PATCH.
function setPath(obj, pathParts, value) {
  if (pathParts.length === 0) return value;
  const [head, ...rest] = pathParts;
  const clone = Array.isArray(obj) ? obj.slice() : { ...obj };
  clone[head] = setPath(obj ? obj[head] : undefined, rest, value);
  return clone;
}

function currentQuarter() {
  const now = new Date();
  const q = Math.floor(now.getMonth() / 3) + 1;
  return `${now.getFullYear()}-Q${q}`;
}

function makeId(quarter) {
  return `rocks-${quarter}`;
}

// Most recent record strictly before the given quarter — "YYYY-Qn" sorts
// correctly as a plain string, so no date parsing needed.
function mostRecentBefore(store, quarter) {
  const matches = Object.values(store.records || {})
    .filter(r => r.quarter < quarter)
    .sort((a, b) => (a.quarter < b.quarter ? 1 : -1));
  return matches[0] || null;
}

// Read the most recent VTO's coreValues + coreFocus for read-only meeting
// reference at the top of the page. Reads vtos.json directly rather than
// importing vto.js, since this route has no other dependency on that
// module. Picks the latest by year regardless of draft/final status,
// mirroring vto.js's own mostRecentVto logic used for next-year pre-fill.
// Returns null if no VTO exists yet or the file can't be read — the
// frontend just omits the reference sections in that case.
function latestVisionRef() {
  try {
    const raw = fs.readFileSync(VTO_FILE, 'utf8');
    const vtoStore = JSON.parse(raw);
    const all = Object.values(vtoStore.vtos || {});
    if (all.length === 0) return null;
    const latest = all.sort((a, b) => Number(b.year) - Number(a.year))[0];
    return {
      sourceYear: latest.year,
      coreValues: latest.vision?.coreValues || [],
      coreFocus: latest.vision?.coreFocus || { purpose: '', niche: '' },
    };
  } catch (err) {
    return null;
  }
}

// ---- Routes ----
// Every route is keyed by :quarter (e.g. "2026-Q3") rather than an opaque
// id — the id is deterministic (rocks-<quarter>) so the frontend never
// needs to track one separately from the quarter it's already displaying.

// GET /api/team-rocks/:quarter — full record, with the prior quarter's
// rocks/issues and the latest VTO's coreValues/coreFocus embedded read-only.
// 404 if this quarter's meeting hasn't been started yet.
router.get('/:quarter', (req, res) => {
  try {
    const store = loadStore();
    const id = makeId(req.params.quarter);
    const record = store.records[id];
    if (!record) return res.status(404).json({ error: 'No meeting started for this quarter yet' });

    const prevQuarter = record.prevQuarterId
      ? store.records[record.prevQuarterId] || null
      : null;

    res.json({
      ...record,
      prevQuarter: prevQuarter
        ? { id: prevQuarter.id, quarter: prevQuarter.quarter, rocks: prevQuarter.rocks, issues: prevQuarter.issues }
        : null,
      visionRef: latestVisionRef(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/team-rocks — start a quarter's meeting.
// Body: { quarter?: string } (defaults to current quarter)
// Auto-links prevQuarterId to the most recent earlier quarter's record, if any.
router.post('/', (req, res) => {
  try {
    const quarter = req.body?.quarter || currentQuarter();
    const store = loadStore();
    const id = makeId(quarter);
    if (store.records[id]) {
      return res.status(409).json({ error: `A meeting for ${quarter} already exists` });
    }

    const prev = mostRecentBefore(store, quarter);
    const now = new Date().toISOString();
    const record = {
      id,
      quarter,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
      finalizedAt: null,
      issues: [],
      rocks: [], // { desc, owner }
      prevQuarterId: prev ? prev.id : null,
    };
    store.records[id] = record;
    saveStore(store);

    res.status(201).json(record);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/team-rocks/:quarter — update one field path (autosave-friendly)
// Body: { path: string[], value: any }
// Finalized records reject edits unless unlocked first.
router.patch('/:quarter', (req, res) => {
  try {
    const { path: fieldPath, value } = req.body;
    if (!Array.isArray(fieldPath) || fieldPath.length === 0) {
      return res.status(400).json({ error: 'path (non-empty array) is required' });
    }

    const store = loadStore();
    const id = makeId(req.params.quarter);
    const existing = store.records[id];
    if (!existing) return res.status(404).json({ error: 'No meeting started for this quarter yet' });

    if (existing.status === 'final') {
      return res.status(423).json({ error: 'Meeting is finalized and locked. Unlock before editing.' });
    }

    const updated = setPath(existing, fieldPath, value);
    updated.updatedAt = new Date().toISOString();
    store.records[id] = updated;
    saveStore(store);

    res.json({ ok: true, updatedAt: updated.updatedAt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/team-rocks/:quarter/finalize — lock once the meeting is done.
router.post('/:quarter/finalize', (req, res) => {
  try {
    const store = loadStore();
    const id = makeId(req.params.quarter);
    const existing = store.records[id];
    if (!existing) return res.status(404).json({ error: 'No meeting started for this quarter yet' });

    existing.status = 'final';
    existing.finalizedAt = new Date().toISOString();
    existing.updatedAt = existing.finalizedAt;

    store.records[id] = existing;
    saveStore(store);

    res.json(existing);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/team-rocks/:quarter/unlock — reopen a finalized meeting for correction.
// No owner gate — loose by design, since this tab has no role tier at all.
router.post('/:quarter/unlock', (req, res) => {
  try {
    const store = loadStore();
    const id = makeId(req.params.quarter);
    const existing = store.records[id];
    if (!existing) return res.status(404).json({ error: 'No meeting started for this quarter yet' });

    existing.status = 'draft';
    existing.finalizedAt = null;
    existing.updatedAt = new Date().toISOString();
    console.warn(`[TeamRocks] ${req.user?.name || req.user?.oid} unlocked ${id}`);

    store.records[id] = existing;
    saveStore(store);

    res.json(existing);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/team-rocks/:quarter — finalized records require ?force=true.
router.delete('/:quarter', (req, res) => {
  try {
    const store = loadStore();
    const id = makeId(req.params.quarter);
    const existing = store.records[id];
    if (!existing) return res.status(404).json({ error: 'No meeting started for this quarter yet' });

    if (existing.status === 'final' && req.query.force !== 'true') {
      return res.status(409).json({
        error: `${id} is finalized. Add ?force=true to delete a finalized meeting.`
      });
    }

    delete store.records[id];
    saveStore(store);

    console.warn(`[TeamRocks] ${req.user?.name || req.user?.oid} deleted ${id} (was status: ${existing.status})`);

    res.json({ ok: true, deleted: id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;