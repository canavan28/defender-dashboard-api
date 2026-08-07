const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();

const DATA_DIR = '/app/data';
const ROCKS_FILE = path.join(DATA_DIR, 'teamrocks.json');

// No requireOwner here — this tab is open to anyone who can log into the
// dashboard at all (verifyApiKey, mounted in index.js, is the only gate).

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

function slugify(str) {
  return String(str)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function makeId(manager, quarter) {
  return `rocks-${slugify(manager)}-${quarter}`;
}

// Current quarter as "YYYY-Qn", e.g. "2026-Q3".
function currentQuarter() {
  const now = new Date();
  const q = Math.floor(now.getMonth() / 3) + 1;
  return `${now.getFullYear()}-Q${q}`;
}

// Find this manager's most recent record strictly before the given quarter
// (string-sortable since "YYYY-Qn" sorts correctly lexicographically).
function mostRecentForManager(store, manager, beforeQuarter) {
  const slug = slugify(manager);
  const matches = Object.values(store.records || {})
    .filter(r => slugify(r.manager) === slug && r.quarter < beforeQuarter)
    .sort((a, b) => (a.quarter < b.quarter ? 1 : -1));
  return matches[0] || null;
}

function newMeetingRecord(manager, quarter, prev) {
  const now = new Date().toISOString();
  return {
    id: makeId(manager, quarter),
    manager,
    quarter,
    status: 'draft',
    createdAt: now,
    updatedAt: now,
    finalizedAt: null,
    issues: [],
    rocks: [], // { desc, owner }
    prevQuarterId: prev ? prev.id : null,
  };
}

// ---- Routes ----

// GET /api/team-rocks?quarter=2026-Q3 — rollup summary, optionally filtered
// to one quarter. Defaults to the current quarter if not specified.
router.get('/', (req, res) => {
  try {
    const store = loadStore();
    const quarter = req.query.quarter || currentQuarter();
    const list = Object.values(store.records)
      .filter(r => r.quarter === quarter)
      .map(r => ({
        id: r.id,
        manager: r.manager,
        quarter: r.quarter,
        status: r.status,
        rocksCount: r.rocks?.length || 0,
        issuesCount: r.issues?.length || 0,
        updatedAt: r.updatedAt,
      }))
      .sort((a, b) => a.manager.localeCompare(b.manager));
    res.json({ quarter, records: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/team-rocks/managers — distinct manager names seen so far, for
// populating a "pick existing or type new" control when starting a meeting.
router.get('/managers', (req, res) => {
  try {
    const store = loadStore();
    const names = [...new Set(Object.values(store.records).map(r => r.manager))].sort();
    res.json({ managers: names });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/team-rocks/:id — full record, with the prior quarter's rocks/
// issues embedded read-only (if one exists) so the frontend doesn't need a
// second round trip to show carry-forward context at the start of a meeting.
router.get('/:id', (req, res) => {
  try {
    const store = loadStore();
    const record = store.records[req.params.id];
    if (!record) return res.status(404).json({ error: 'Record not found' });

    const prevQuarter = record.prevQuarterId
      ? store.records[record.prevQuarterId] || null
      : null;

    res.json({
      ...record,
      prevQuarter: prevQuarter
        ? { id: prevQuarter.id, quarter: prevQuarter.quarter, rocks: prevQuarter.rocks, issues: prevQuarter.issues }
        : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/team-rocks — start a new quarter's meeting for a manager.
// Body: { manager: string, quarter?: string }  (quarter defaults to current)
// Auto-links prevQuarterId to that manager's most recent earlier record, if any.
router.post('/', (req, res) => {
  try {
    const manager = (req.body?.manager || '').trim();
    if (!manager) return res.status(400).json({ error: 'manager is required' });
    const quarter = req.body?.quarter || currentQuarter();

    const store = loadStore();
    const id = makeId(manager, quarter);
    if (store.records[id]) {
      return res.status(409).json({ error: `A record for ${manager} in ${quarter} already exists` });
    }

    const prev = mostRecentForManager(store, manager, quarter);
    const record = newMeetingRecord(manager, quarter, prev);
    store.records[id] = record;
    saveStore(store);

    res.status(201).json(record);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/team-rocks/:id — update one field path (autosave-friendly)
// Body: { path: string[], value: any }
// Finalized records reject edits unless unlocked first.
router.patch('/:id', (req, res) => {
  try {
    const { path: fieldPath, value } = req.body;
    if (!Array.isArray(fieldPath) || fieldPath.length === 0) {
      return res.status(400).json({ error: 'path (non-empty array) is required' });
    }

    const store = loadStore();
    const existing = store.records[req.params.id];
    if (!existing) return res.status(404).json({ error: 'Record not found' });

    if (existing.status === 'final') {
      return res.status(423).json({ error: 'Record is finalized and locked. Unlock before editing.' });
    }

    const updated = setPath(existing, fieldPath, value);
    updated.updatedAt = new Date().toISOString();
    store.records[req.params.id] = updated;
    saveStore(store);

    res.json({ ok: true, updatedAt: updated.updatedAt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/team-rocks/:id/finalize — lock the record once the meeting is done.
router.post('/:id/finalize', (req, res) => {
  try {
    const store = loadStore();
    const existing = store.records[req.params.id];
    if (!existing) return res.status(404).json({ error: 'Record not found' });

    existing.status = 'final';
    existing.finalizedAt = new Date().toISOString();
    existing.updatedAt = existing.finalizedAt;

    store.records[req.params.id] = existing;
    saveStore(store);

    res.json(existing);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/team-rocks/:id/unlock — reopen a finalized record for correction.
// No owner gate — loose by design, since this tab has no role tier at all.
router.post('/:id/unlock', (req, res) => {
  try {
    const store = loadStore();
    const existing = store.records[req.params.id];
    if (!existing) return res.status(404).json({ error: 'Record not found' });

    existing.status = 'draft';
    existing.finalizedAt = null;
    existing.updatedAt = new Date().toISOString();
    console.warn(`[TeamRocks] ${req.user?.name || req.user?.oid} unlocked ${req.params.id}`);

    store.records[req.params.id] = existing;
    saveStore(store);

    res.json(existing);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/team-rocks/:id — finalized records require ?force=true.
router.delete('/:id', (req, res) => {
  try {
    const store = loadStore();
    const existing = store.records[req.params.id];
    if (!existing) return res.status(404).json({ error: 'Record not found' });

    if (existing.status === 'final' && req.query.force !== 'true') {
      return res.status(409).json({
        error: `${req.params.id} is finalized. Add ?force=true to delete a finalized record.`
      });
    }

    delete store.records[req.params.id];
    saveStore(store);

    console.warn(`[TeamRocks] ${req.user?.name || req.user?.oid} deleted ${req.params.id} (was status: ${existing.status})`);

    res.json({ ok: true, deleted: req.params.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;