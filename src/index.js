require('dotenv').config();
const express = require('express');
const cors = require('cors');

const ticketsRouter = require('./routes/tickets');
const resourcesRouter = require('./routes/resources');
const slaRouter = require('./routes/sla');
const { verifyApiKey } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3001;

// ── CORS ──────────────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim());

app.use(cors({
  origin: (origin, callback) => {
    const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim());
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

// Handle preflight requests explicitly
app.options('*', cors());

app.use(express.json());

// ── Health check (no auth required) ──────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Temporary public route to fetch queue IDs
app.get('/queues', async (req, res) => {
  try {
    const { autotaskClient } = require('./utils/autotask');
    const response = await autotaskClient.get('/Tickets/entityInformation/fields');
    const fields = response.data.fields || [];
    const queueField = fields.find(f => f.name === 'queueID');
    res.json({ queues: queueField?.picklistValues || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Protected routes ──────────────────────────────────────────────────────────
app.use('/api', verifyApiKey);
app.use('/api/tickets', ticketsRouter);
app.use('/api/resources', resourcesRouter);
app.use('/api/sla', slaRouter);

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[Error]', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Defender Dashboard API running on port ${PORT}`);
});
