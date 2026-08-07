require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const ticketsRouter = require('./routes/tickets');
const aiReviewRouter = require('./routes/aireview');
const vtoRouter = require('./routes/vto');
const upsellsRouter = require('./routes/upsells');
const salesMetricsRouter = require('./routes/salesMetrics');
const customerSuccessRouter = require('./routes/customerSuccess');
const licenseAuditRouter = require('./routes/licenseAudit');
const diagnosticRouter = require('./routes/diagnostic');
const teamRocksRouter = require('./routes/teamRocks');
const { verifyApiKey, requireOwner } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3001;

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim());

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));
app.options('*', cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api', verifyApiKey);

// Per-person category access + default landing tab. Ships as part of the
// backend code (not a runtime-editable disk file like vtos.json/reviewed.json
// — updating who has access to what requires a commit + redeploy, same
// friction as OWNER_OBJECT_IDS today, just structured data instead of a
// flat env var list). Owners (Matt, Chris) are NOT in this file — they get
// full access via the existing isOwner flag, computed separately below.
const USER_ACCESS_PATH = path.join(__dirname, 'config', 'userAccess.json');
let userAccessConfig = {};
try {
  userAccessConfig = JSON.parse(fs.readFileSync(USER_ACCESS_PATH, 'utf8'));
} catch (err) {
  console.error('[UserAccess] Failed to load config:', err.message);
}

const ALL_CATEGORIES = ['operations', 'sales', 'customer-success', 'finance'];

app.get('/api/me', (req, res) => {
  const { oid, name, email, isOwner } = req.user;
  let categories, defaultCategory, defaultTab;

  if (isOwner) {
    categories = [...ALL_CATEGORIES, 'executive'];
    defaultCategory = 'executive';
    defaultTab = null; // lands on the Executive category's default sub-view (VTO for now, Tier 1 summary later)
  } else {
    const access = userAccessConfig[oid];
    if (access) {
      categories = access.categories;
      defaultCategory = access.defaultCategory;
      defaultTab = access.defaultTab;
    } else {
      // Fail closed for anyone not explicitly configured — matches the
      // isOwner check's own fail-closed pattern (never show access
      // optimistically). Logged so a missing config entry is visible.
      categories = ['operations'];
      defaultCategory = 'operations';
      defaultTab = null;
      console.warn('[UserAccess] No access config found for oid:', oid);
    }
  }

  res.json({ oid, name, email, isOwner, categories, defaultCategory, defaultTab });
});

// GET /api/me/preview-list — owner-only. Names/oids of everyone in the
// access config, for the "preview as" dropdown. Requires requireOwner (see
// below), mounted after the global verifyApiKey so req.user is populated.
app.get('/api/me/preview-list', requireOwner, (req, res) => {
  const list = Object.entries(userAccessConfig).map(([oid, access]) => ({
    oid, name: access.name
  }));
  res.json(list);
});

// GET /api/me/preview/:oid — owner-only. Returns exactly what /api/me would
// return FOR that person, without needing their actual credentials — lets
// an owner test category access/default-tab behavior for every configured
// person before deploying, using only their own login. Does not change who
// is actually authenticated; this is a read-only lookup against the same
// config /api/me itself reads.
app.get('/api/me/preview/:oid', requireOwner, (req, res) => {
  const targetOid = req.params.oid;
  const access = userAccessConfig[targetOid];
  if (!access) {
    return res.status(404).json({ error: 'No access config found for that oid' });
  }
  res.json({
    oid: targetOid,
    name: access.name,
    email: null,
    isOwner: false, // owners are never in this config file, so previewing one is never possible here
    categories: access.categories,
    defaultCategory: access.defaultCategory,
    defaultTab: access.defaultTab,
    isPreview: true
  });
});

app.use('/api/tickets', ticketsRouter);
app.use('/api/aireview', aiReviewRouter);
app.use('/api/vto', vtoRouter);
app.use('/api/upsells', upsellsRouter);
app.use('/api/sales', salesMetricsRouter);
app.use('/api/customer-success', customerSuccessRouter);
app.use('/api/license-audit', licenseAuditRouter);
app.use('/api/team-rocks', teamRocksRouter);
app.use('/api/diagnostic', requireOwner, diagnosticRouter);

app.post('/api/admin/reset-reviewed-since', requireOwner, async (req, res) => {
  try {
    const { since } = req.body;
    if (!since) return res.status(400).json({ error: 'since (ISO date string) required' });

    const fs = require('fs');
    const reviewedFile = '/app/data/reviewed.json';
    const data = JSON.parse(fs.readFileSync(reviewedFile, 'utf8'));

    const cutoff = new Date(since);
    if (isNaN(cutoff.getTime())) {
      return res.status(400).json({ error: 'since must be a valid ISO date string' });
    }

    let cleared = 0;
    let kept = 0;
    const newReviewed = {};

    Object.entries(data.reviewed || {}).forEach(([ticketNum, meta]) => {
      const reviewedAt = meta?.reviewedAt ? new Date(meta.reviewedAt) : null;
      if (reviewedAt && reviewedAt >= cutoff) {
        cleared++;
      } else {
        newReviewed[ticketNum] = meta;
        kept++;
      }
    });

    data.reviewed = newReviewed;
    fs.writeFileSync(reviewedFile, JSON.stringify(data, null, 2));

    console.warn(`[Admin] ${req.user.name || req.user.oid} reset reviewed entries since ${cutoff.toISOString()}`);

    res.json({
      ok: true,
      clearedReviewed: cleared,
      kept,
      cutoff: cutoff.toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Moved under /api (so the global verifyApiKey gate applies) and now
// requireOwner-gated, since this exposes raw per-tech ticket data and isn't
// something the other three execs need — same treatment as /api/diagnostic.
app.get('/api/admin/response-debug/:techId', requireOwner, async (req, res) => {
  try {
    const techId = parseInt(req.params.techId);
    const allTickets = [
      ...(JSON.parse(require('fs').readFileSync('/app/data/tickets-historical.json', 'utf8')).allTickets || []),
      ...(JSON.parse(require('fs').readFileSync('/app/data/tickets-recent.json', 'utf8')).allTickets || [])
    ];
    const EXCLUDE_COMPANIES = new Set([0, 344]);
    const EXCLUDE_QUEUES = new Set([29683479, 29683378, 29683480]);

    const results = allTickets
      .filter(t => t.assignedResourceID === techId
        && t.createDate
        && t.firstResponseDateTime
        && t.priority !== 4
        && !EXCLUDE_COMPANIES.has(t.companyID)
        && !EXCLUDE_QUEUES.has(t.queueID))
      .map(t => {
        const mins = Math.round((new Date(t.firstResponseDateTime) - new Date(t.createDate)) / (1000 * 60));
        return {
          ticket: t.ticketNumber,
          created: t.createDate,
          firstResponse: t.firstResponseDateTime,
          mins,
          priority: t.priority,
          companyID: t.companyID,
          queueID: t.queueID
        };
      })
      .sort((a, b) => b.mins - a.mins);

    const avg = results.length
      ? Math.round(results.reduce((s, r) => s + r.mins, 0) / results.length)
      : null;

    res.json({
      techId,
      totalTickets: results.length,
      avgMins: avg,
      tickets: results.slice(0, 50)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use((err, req, res, next) => {
  console.error('[Error]', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Defender Dashboard API running on port ${PORT}`);
});