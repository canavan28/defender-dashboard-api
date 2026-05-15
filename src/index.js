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
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));
app.options('*', cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Temporary lookup routes
app.get('/queues', async (req, res) => {
  try {
    const { autotaskClient } = require('./utils/autotask');
    const response = await autotaskClient.get('/Tickets/entityInformation/fields');
    const fields = response.data.fields || [];
    const queueField = fields.find(f => f.name === 'queueID');
    res.json({ queues: queueField?.picklistValues || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/timeentrycount', async (req, res) => {
  try {
    const { autotaskClient } = require('./utils/autotask');
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const response = await autotaskClient.post('/TimeEntries/query', {
      filter: [
        { field: 'dateWorked', op: 'gte', value: sixMonthsAgo.toISOString() },
        { field: 'ticketID', op: 'exist' }
      ],
      maxRecords: 3
    });
    res.json({ 
      pageDetails: response.data.pageDetails,
      samples: response.data.items?.map(t => ({
        timeEntryType: t.timeEntryType,
        ticketID: t.ticketID,
        hoursWorked: t.hoursWorked,
        dateWorked: t.dateWorked,
        resourceID: t.resourceID,
        summaryNotes: t.summaryNotes?.substring(0, 100)
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/statuses', async (req, res) => {
  try {
    const { autotaskClient } = require('./utils/autotask');
    const response = await autotaskClient.get('/Tickets/entityInformation/fields');
    const fields = response.data.fields || [];
    const statusField = fields.find(f => f.name === 'status');
    res.json({ statuses: statusField?.picklistValues || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/techlist', async (req, res) => {
  try {
    const { autotaskClient } = require('./utils/autotask');
    const response = await autotaskClient.post('/Resources/query', {
      filter: [{ field: 'isActive', op: 'eq', value: true }]
    });
    res.json({ resources: response.data.items || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.use('/api', verifyApiKey);
app.use('/api/tickets', ticketsRouter);

app.use((err, req, res, next) => {
  console.error('[Error]', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Defender Dashboard API running on port ${PORT}`);

});