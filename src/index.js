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

// TEMP — remove after checking
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

app.listen(PORT, () => {
  console.log(`Defender Dashboard API running on port ${PORT}`);
});