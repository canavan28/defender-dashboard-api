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
app.get('/categories', async (req, res) => {
  try {
    const { autotaskClient } = require('./utils/autotask');
    const response = await autotaskClient.get('/Tickets/entityInformation/fields');
    const fields = response.data.fields || [];
    const catField = fields.find(f => f.name === 'ticketCategory');
    res.json({ categories: catField?.picklistValues || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/flagsreport', (req, res) => {
  try {
    const fs = require('fs');
    const raw = fs.readFileSync('/app/data/reviewed.json', 'utf8');
    const data = JSON.parse(raw);
    const flags = (data.flags || []).sort((a, b) => {
      const rank = { critical: 0, high: 1, medium: 2, low: 3 };
      return (rank[a.sev] || 3) - (rank[b.sev] || 3);
    });

    const page = parseInt(req.query.page || '1');
    const perPage = 50;
    const total = flags.length;
    const totalPages = Math.ceil(total / perPage);
    const paginated = flags.slice((page - 1) * perPage, page * perPage);

    const html = `
      <html><head><title>AI Review Flags</title>
      <style>
        body { font-family: sans-serif; padding: 20px; max-width: 1200px; margin: 0 auto; }
        table { width: 100%; border-collapse: collapse; font-size: 13px; }
        th { background: #f1f5f9; padding: 8px 12px; text-align: left; border-bottom: 2px solid #e2e8f0; }
        td { padding: 8px 12px; border-bottom: 1px solid #e2e8f0; vertical-align: top; max-width: 300px; }
        tr:hover { background: #fafafa; }
        .critical { color: #991b1b; font-weight: 600; }
        .high { color: #9a3412; font-weight: 600; }
        .medium { color: #854d0e; }
        .low { color: #334155; }
        a { color: #2563eb; }
        h1 { font-size: 18px; margin-bottom: 4px; }
        .meta { color: #64748b; font-size: 12px; margin-bottom: 20px; }
        .pages { margin-top: 20px; display: flex; gap: 8px; }
        .pages a { padding: 4px 10px; border: 1px solid #e2e8f0; border-radius: 4px; text-decoration: none; }
        .pages a.active { background: #2563eb; color: white; border-color: #2563eb; }
      </style></head>
      <body>
        <h1>AI Review — Flagged Tickets</h1>
        <div class="meta">
          ${total} total flags · Page ${page} of ${totalPages} · 
          Generated ${new Date().toLocaleString()}
        </div>
        <table>
          <tr>
            <th>Severity</th><th>Ticket</th><th>Company</th>
            <th>Flag Type</th><th>Summary</th><th>Action</th><th>Flagged</th>
          </tr>
          ${paginated.map(f => `
            <tr>
              <td class="${f.sev}">${(f.sev || '').toUpperCase()}</td>
              <td><a href="${f.ticketUrl}" target="_blank">${f.id}</a></td>
              <td>${f.company || ''}</td>
              <td>${f.flagType || ''}</td>
              <td>${f.summary || ''}</td>
              <td>${f.action || 'unactioned'}</td>
              <td>${f.dateFlagged ? new Date(f.dateFlagged).toLocaleDateString() : ''}</td>
            </tr>
          `).join('')}
        </table>
        <div class="pages">
          ${Array.from({ length: totalPages }, (_, i) => i + 1).map(p =>
      `<a href="/flagsreport?page=${p}" class="${p === page ? 'active' : ''}">${p}</a>`
    ).join('')}
        </div>
      </body></html>
    `;
    res.send(html);
  } catch (err) {
    res.status(500).send(`Error: ${err.message}`);
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
const aiReviewRouter = require('./routes/aireview');
app.use('/api/aireview', aiReviewRouter);

app.use((err, req, res, next) => {
  console.error('[Error]', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Defender Dashboard API running on port ${PORT}`);

});