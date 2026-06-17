require('dotenv').config();
const express = require('express');
const cors = require('cors');
const ticketsRouter = require('./routes/tickets');
const aiReviewRouter = require('./routes/aireview');
const vtoRouter = require('./routes/vto');
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

// Emergency lever, kept from the original TEMP routes — useful if a future
// model deprecation or outage causes tickets to be incorrectly marked
// reviewed again. Gated by requireOwner now that we have real authz instead
// of being an unauthenticated TEMP route. Older entries are left untouched
// so trend analysis history isn't lost.
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