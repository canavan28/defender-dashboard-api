require('dotenv').config();
const express = require('express');
const cors = require('cors');
const ticketsRouter = require('./routes/tickets');
const { verifyApiKey } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3001;

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim());

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));
app.options('*', cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api', verifyApiKey);
app.use('/api/tickets', ticketsRouter);
const aiReviewRouter = require('./routes/aireview');
app.use('/api/aireview', aiReviewRouter);

app.use((err, req, res, next) => {
  console.error('[Error]', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// TEMP — remove after use
app.post('/admin/clear-flags', async (req, res) => {
  try {
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync('/app/data/reviewed.json', 'utf8'));
    const count = (data.flags || []).length;
    data.flags = [];
    fs.writeFileSync('/app/data/reviewed.json', JSON.stringify(data, null, 2));
    res.json({ ok: true, clearedFlags: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// TEMP — remove after use
// Clears reviewed entries for tickets reviewed in last 60 days using reviewedAt timestamp
// Older entries kept intact for trend analysis
app.post('/admin/reset-recent-reviewed', async (req, res) => {
  try {
    const fs = require('fs');
    const reviewedFile = '/app/data/reviewed.json';
    const data = JSON.parse(fs.readFileSync(reviewedFile, 'utf8'));

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 60);

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
    data.flags = [];
    fs.writeFileSync(reviewedFile, JSON.stringify(data, null, 2));

    res.json({
      ok: true,
      clearedReviewed: cleared,
      keptForTrends: kept,
      flagsCleared: true,
      cutoffDate: cutoff.toISOString().slice(0, 10)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Defender Dashboard API running on port ${PORT}`);
});