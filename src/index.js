require('dotenv').config();
const express = require('express');
const cors = require('cors');
const ticketsRouter = require('./routes/tickets');
const aiReviewRouter = require('./routes/aireview');
const vtoRouter = require('./routes/vto');
const upsellsRouter = require('./routes/upsells');
const diagnosticRouter = require('./routes/diagnostic');
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

app.get('/api/me', (req, res) => {
  res.json({ oid: req.user.oid, name: req.user.name, email: req.user.email, isOwner: req.user.isOwner });
});

app.use('/api/tickets', ticketsRouter);
app.use('/api/aireview', aiReviewRouter);
app.use('/api/vto', vtoRouter);
app.use('/api/upsells', upsellsRouter);
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

app.use((err, req, res, next) => {
  console.error('[Error]', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Defender Dashboard API running on port ${PORT}`);
});

app.get('/admin/response-debug/:techId', async (req, res) => {
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