const express = require('express');
const fs = require('fs');
const path = require('path');
const { requireOwner } = require('../middleware/auth');

const router = express.Router();

const DATA_DIR = '/app/data';
const VTO_FILE = path.join(DATA_DIR, 'vtos.json');

// ---- Storage helpers ----

function loadStore() {
  try {
    const raw = fs.readFileSync(VTO_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return { vtos: {} };
    throw err;
  }
}

function saveStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(VTO_FILE, JSON.stringify(store, null, 2));
}

// Deep-set helper mirroring the prototype's setPath, used for PATCH.
function setPath(obj, pathParts, value) {
  if (pathParts.length === 0) return value;
  const [head, ...rest] = pathParts;
  const clone = Array.isArray(obj) ? obj.slice() : { ...obj };
  clone[head] = setPath(obj ? obj[head] : undefined, rest, value);
  return clone;
}

function blankSnapshot() {
  return { date: '', money1: '', money2: '', measurables: '', looksLike: [] };
}

// Server-side equivalent of the prototype's newDraftFrom(prev, year).
// Carries over evergreen vision content + rocks/issues as a starting point;
// resets the four time-horizon snapshots to blank.
function newDraftFrom(prev, year) {
  const now = new Date().toISOString();
  return {
    id: `vto-${year}`,
    year: String(year),
    label: `FY${year} Vision/Traction`,
    savedDate: null,
    status: 'draft',
    authoredBy: '',
    createdAt: now,
    updatedAt: now,
    vision: {
      coreValues: (prev?.vision?.coreValues || []).map(v => ({ ...v })),
      coreFocus: { ...(prev?.vision?.coreFocus || { purpose: '', niche: '' }) },
      tenYear: prev?.vision?.tenYear || '',
      fiveYear: prev?.vision?.fiveYear || '',
      current: blankSnapshot(),
      twoYear: blankSnapshot(),
      threeYear: blankSnapshot(),
      marketing: {
        targetMarket: prev?.vision?.marketing?.targetMarket || '',
        uniques: [...(prev?.vision?.marketing?.uniques || [])],
        provenProcess: prev?.vision?.marketing?.provenProcess || '',
        guarantee: prev?.vision?.marketing?.guarantee || '',
      },
    },
    traction: {
      oneYear: { ...blankSnapshot(), goals: [] },
      rocks: {
        date: '', money1: '', money2: '', measurables: '',
        items: (prev?.traction?.rocks?.items || []).map(r => ({ ...r })),
      },
      issues: [...(prev?.traction?.issues || [])],
    },
  };
}

function mostRecentVto(store) {
  const all = Object.values(store.vtos || {});
  if (all.length === 0) return null;
  return all.sort((a, b) => Number(b.year) - Number(a.year))[0];
}

// All routes below require an authenticated owner.
router.use(requireOwner);

// GET /api/vto — history list (lightweight summary, not full bodies)
router.get('/', (req, res) => {
  try {
    const store = loadStore();
    const list = Object.values(store.vtos)
      .map(v => ({
        id: v.id,
        year: v.year,
        label: v.label,
        savedDate: v.savedDate,
        status: v.status,
        authoredBy: v.authoredBy,
        updatedAt: v.updatedAt,
        coreValuesCount: v.vision?.coreValues?.length || 0,
        rocksCount: v.traction?.rocks?.items?.length || 0,
        issuesCount: v.traction?.issues?.length || 0,
      }))
      .sort((a, b) => Number(b.year) - Number(a.year));
    res.json({ history: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/vto/:id — full record
router.get('/:id', (req, res) => {
  try {
    const store = loadStore();
    const vto = store.vtos[req.params.id];
    if (!vto) return res.status(404).json({ error: 'VTO not found' });
    res.json(vto);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/vto — create a new year's draft, pre-filled from the latest record
// Body: { year: number }
router.post('/', (req, res) => {
  try {
    const { year } = req.body;
    if (!year) return res.status(400).json({ error: 'year is required' });

    const store = loadStore();
    const id = `vto-${year}`;
    if (store.vtos[id]) {
      return res.status(409).json({ error: `VTO for ${year} already exists` });
    }

    const prev = mostRecentVto(store);
    const draft = newDraftFrom(prev, year);
    store.vtos[id] = draft;
    saveStore(store);

    res.status(201).json(draft);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/vto/:id — update one field path (autosave-friendly)
// Body: { path: string[], value: any }
// Locked (finalized) VTOs reject edits unless explicitly unlocked first.
router.patch('/:id', (req, res) => {
  try {
    const { path: fieldPath, value } = req.body;
    if (!Array.isArray(fieldPath) || fieldPath.length === 0) {
      return res.status(400).json({ error: 'path (non-empty array) is required' });
    }

    const store = loadStore();
    const existing = store.vtos[req.params.id];
    if (!existing) return res.status(404).json({ error: 'VTO not found' });

    if (existing.status === 'final') {
      return res.status(423).json({ error: 'VTO is finalized and locked. Unlock before editing.' });
    }

    const updated = setPath(existing, fieldPath, value);
    updated.updatedAt = new Date().toISOString();
    store.vtos[req.params.id] = updated;
    saveStore(store);

    res.json({ ok: true, updatedAt: updated.updatedAt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/vto/:id/finalize — lock the VTO, stamp savedDate/authoredBy
// Body: { authoredBy: string }
router.post('/:id/finalize', (req, res) => {
  try {
    const store = loadStore();
    const existing = store.vtos[req.params.id];
    if (!existing) return res.status(404).json({ error: 'VTO not found' });

    existing.status = 'final';
    existing.savedDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    existing.authoredBy = req.body?.authoredBy || existing.authoredBy || req.user.name || '';
    existing.updatedAt = new Date().toISOString();

    store.vtos[req.params.id] = existing;
    saveStore(store);

    res.json(existing);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/vto/:id/unlock — return a finalized VTO to draft so it can be edited again
router.post('/:id/unlock', (req, res) => {
  try {
    const store = loadStore();
    const existing = store.vtos[req.params.id];
    if (!existing) return res.status(404).json({ error: 'VTO not found' });

    existing.status = 'draft';
    existing.updatedAt = new Date().toISOString();
    console.warn(`[VTO] ${req.user.name || req.user.oid} unlocked ${req.params.id} for re-editing`);

    store.vtos[req.params.id] = existing;
    saveStore(store);

    res.json(existing);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;