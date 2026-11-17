const axios = require('axios');
const jwt = require('jsonwebtoken');

// Google service-account auth for GA4 (Analytics Data API) and Search
// Console. Signs its own JWT with the already-installed jsonwebtoken
// package and exchanges it for an access token, so no Google SDK is
// needed. The token is cached in memory and reused until ~1 minute
// before it expires.

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPES = [
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/webmasters.readonly'
];
const GA4_BASE = 'https://analyticsdata.googleapis.com/v1beta';
const GSC_BASE = 'https://www.googleapis.com/webmasters/v3';
const PAGESPEED_URL = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

let cachedCreds = null;
let cachedToken = null; // { accessToken, expiresAt }

function getCredentials() {
  if (cachedCreds) return cachedCreds;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON: ' + err.message);
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email or private_key');
  }
  // If the key's line breaks got stored as literal "\n" text, convert them.
  const privateKey = parsed.private_key.includes('\\n')
    ? parsed.private_key.replace(/\\n/g, '\n')
    : parsed.private_key;
  cachedCreds = { clientEmail: parsed.client_email, privateKey };
  return cachedCreds;
}

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60000) {
    return cachedToken.accessToken;
  }
  const { clientEmail, privateKey } = getCredentials();
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    { iss: clientEmail, scope: SCOPES.join(' '), aud: TOKEN_URL, iat: now, exp: now + 3600 },
    privateKey,
    { algorithm: 'RS256' }
  );
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion
  });
  const res = await axios.post(TOKEN_URL, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15000
  });
  cachedToken = {
    accessToken: res.data.access_token,
    expiresAt: Date.now() + (res.data.expires_in || 3600) * 1000
  };
  return cachedToken.accessToken;
}

async function authHeaders() {
  const token = await getAccessToken();
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

function isoDaysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

// ---------- GA4 ----------

async function ga4RunReport(body) {
  const propertyId = process.env.GA4_PROPERTY_ID;
  if (!propertyId) throw new Error('GA4_PROPERTY_ID is not set');
  const res = await axios.post(
    `${GA4_BASE}/properties/${propertyId}:runReport`,
    body,
    { headers: await authHeaders(), timeout: 30000 }
  );
  return res.data;
}

// Turns GA4's parallel header/value arrays into plain row objects:
// [{ sessionDefaultChannelGroup: 'Organic Search', sessions: 412 }, ...]
function flattenGa4Report(data) {
  const dims = (data.dimensionHeaders || []).map(h => h.name);
  const mets = (data.metricHeaders || []).map(h => h.name);
  return (data.rows || []).map(row => {
    const out = {};
    dims.forEach((d, i) => { out[d] = row.dimensionValues?.[i]?.value ?? null; });
    mets.forEach((m, i) => {
      const v = row.metricValues?.[i]?.value;
      out[m] = v == null ? null : Number(v);
    });
    return out;
  });
}

// ---------- Search Console ----------

function getGscSiteUrl() {
  const site = (process.env.GSC_SITE_URL || '').trim();
  if (!site) throw new Error('GSC_SITE_URL is not set');
  return site;
}

async function gscListSites() {
  const res = await axios.get(`${GSC_BASE}/sites`, {
    headers: await authHeaders(),
    timeout: 30000
  });
  return res.data;
}

async function gscQuery(body) {
  const site = encodeURIComponent(getGscSiteUrl());
  const res = await axios.post(
    `${GSC_BASE}/sites/${site}/searchAnalytics/query`,
    body,
    { headers: await authHeaders(), timeout: 30000 }
  );
  return res.data;
}

// ---------- PageSpeed Insights ----------
// Public Google API. Works without a key at low volume; if it starts
// returning 429 (quota), add a PAGESPEED_API_KEY variable in Railway.

async function runPagespeed(url, strategy = 'mobile') {
  const params = new URLSearchParams({ url, strategy: strategy.toUpperCase() });
  ['PERFORMANCE', 'SEO', 'ACCESSIBILITY', 'BEST_PRACTICES'].forEach(c => params.append('category', c));
  if (process.env.PAGESPEED_API_KEY) params.append('key', process.env.PAGESPEED_API_KEY);
  const res = await axios.get(`${PAGESPEED_URL}?${params.toString()}`, { timeout: 120000 });
  return res.data;
}

// The raw PageSpeed response is huge; this keeps only what matters for SEO.
function summarizePagespeed(data) {
  const lh = data.lighthouseResult || {};
  const cats = lh.categories || {};
  const audits = lh.audits || {};
  const score = c => (cats[c] && typeof cats[c].score === 'number') ? Math.round(cats[c].score * 100) : null;
  const metric = id => audits[id]
    ? { value: audits[id].displayValue || null, score: audits[id].score }
    : null;
  const failing = catId => ((cats[catId]?.auditRefs) || [])
    .map(r => audits[r.id])
    .filter(a => a && typeof a.score === 'number' && a.score < 0.9)
    .map(a => ({ id: a.id, title: a.title, displayValue: a.displayValue || null, score: a.score }));
  const fieldMetrics = data.loadingExperience?.metrics
    ? Object.fromEntries(Object.entries(data.loadingExperience.metrics)
        .map(([k, v]) => [k, { percentile: v.percentile, category: v.category }]))
    : null;

  return {
    url: lh.finalDisplayedUrl || lh.finalUrl || data.id || null,
    fetchTime: lh.fetchTime || null,
    scores: {
      performance: score('performance'),
      seo: score('seo'),
      accessibility: score('accessibility'),
      bestPractices: score('best-practices')
    },
    labMetrics: {
      largestContentfulPaint: metric('largest-contentful-paint'),
      cumulativeLayoutShift: metric('cumulative-layout-shift'),
      totalBlockingTime: metric('total-blocking-time'),
      firstContentfulPaint: metric('first-contentful-paint'),
      speedIndex: metric('speed-index')
    },
    realUserData: {
      overall: data.loadingExperience?.overall_category || null,
      metrics: fieldMetrics
    },
    failingSeoAudits: failing('seo'),
    failingPerformanceAudits: failing('performance').slice(0, 15)
  };
}

module.exports = {
  getCredentials,
  getAccessToken,
  isoDaysAgo,
  ga4RunReport,
  flattenGa4Report,
  getGscSiteUrl,
  gscListSites,
  gscQuery,
  runPagespeed,
  summarizePagespeed
};