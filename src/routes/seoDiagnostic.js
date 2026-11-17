const express = require('express');
const axios = require('axios');
const router = express.Router();
const {
  getCredentials, getAccessToken, isoDaysAgo,
  ga4RunReport, flattenGa4Report,
  getGscSiteUrl, gscListSites, gscQuery,
  runPagespeed, summarizePagespeed
} = require('../utils/google');
const { readPage, getSiteHost, getHomepageUrl } = require('../utils/siteReader');
const { brightlocalClient } = require('../utils/brightlocal');

// Owner-only test routes for the SEO agent's data connections. Mounted at
// /api/diagnostic/seo with requireOwner in index.js. Same purpose as
// diagnostic.js: see REAL responses from each source before building the
// agent on top of them. Each check is independently try/caught so one
// failing source doesn't hide the others.

function errInfo(err) {
  return { error: err.message, status: err.response?.status, body: err.response?.data };
}

// GET /api/diagnostic/seo/config
// Confirms the Railway variables are present and parse correctly.
// Never returns secrets.
router.get('/config', (req, res) => {
  let serviceAccountEmail = null;
  let credentialsError = null;
  try {
    serviceAccountEmail = getCredentials().clientEmail;
  } catch (err) {
    credentialsError = err.message;
  }
  res.json({
    googleServiceAccount: { ok: !credentialsError, serviceAccountEmail, error: credentialsError },
    ga4PropertyId: process.env.GA4_PROPERTY_ID || null,
    gscSiteUrl: process.env.GSC_SITE_URL || null,
    siteHost: getSiteHost(),
    homepageUrl: getHomepageUrl(),
    brightlocalKeySet: !!process.env.BRIGHTLOCAL_API_KEY,
    anthropicKeySet: !!process.env.ANTHROPIC_API_KEY,
    pagespeedKeySet: !!process.env.PAGESPEED_API_KEY
  });
});

// GET /api/diagnostic/seo/google
// Token, Search Console site list (confirms GSC_SITE_URL matches exactly),
// a small GA4 report, and a small Search Console report.
router.get('/google', async (req, res) => {
  const out = {};

  try {
    await getAccessToken();
    out.token = { ok: true };
  } catch (err) {
    out.token = { ok: false, ...errInfo(err) };
    return res.json(out);
  }

  try {
    const sites = await gscListSites();
    out.searchConsoleSites = sites.siteEntry || [];
    let configured = null;
    try { configured = getGscSiteUrl(); } catch { /* reported in /config */ }
    out.configuredSiteUrl = configured;
    out.configuredSiteFound = out.searchConsoleSites.some(s => s.siteUrl === configured);
  } catch (err) {
    out.searchConsoleSites = errInfo(err);
  }

  try {
    const report = await ga4RunReport({
      dateRanges: [{ startDate: '28daysAgo', endDate: 'yesterday' }],
      dimensions: [{ name: 'sessionDefaultChannelGroup' }],
      metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'keyEvents' }],
      limit: 20
    });
    out.ga4Last28DaysByChannel = flattenGa4Report(report);
  } catch (err) {
    out.ga4Last28DaysByChannel = errInfo(err);
  }

  try {
    const report = await gscQuery({
      startDate: isoDaysAgo(31),
      endDate: isoDaysAgo(3),
      dimensions: ['query'],
      rowLimit: 10
    });
    out.searchConsoleTopQueries = report.rows || [];
  } catch (err) {
    out.searchConsoleTopQueries = errInfo(err);
  }

  res.json(out);
});

// GET /api/diagnostic/seo/page?url=https://...
// Reads one page of our own site. With no url, reads the homepage.
router.get('/page', async (req, res) => {
  const url = req.query.url || getHomepageUrl();
  if (!url) return res.status(400).json({ error: 'No url passed and GSC_SITE_URL is not set' });
  try {
    res.json(await readPage(url));
  } catch (err) {
    res.status(500).json(errInfo(err));
  }
});

// GET /api/diagnostic/seo/pagespeed?url=https://...&strategy=mobile
// Google PageSpeed (speed + SEO audit). Takes 30-60 seconds.
// With no url, tests the homepage.
router.get('/pagespeed', async (req, res) => {
  const url = req.query.url || getHomepageUrl();
  const strategy = req.query.strategy === 'desktop' ? 'desktop' : 'mobile';
  if (!url) return res.status(400).json({ error: 'No url passed and GSC_SITE_URL is not set' });
  try {
    const data = await runPagespeed(url, strategy);
    res.json({ strategy, ...summarizePagespeed(data) });
  } catch (err) {
    res.status(500).json(errInfo(err));
  }
});

// GET /api/diagnostic/seo/brightlocal?path=/manage/v1/locations
// Pass-through for exploring BrightLocal's API. Only reaches
// api.brightlocal.com; any other query parameters are forwarded.
router.get('/brightlocal', async (req, res) => {
  const path = req.query.path;
  if (!path || !path.startsWith('/') || path.startsWith('//') || path.includes('..') || path.includes('://')) {
    return res.status(400).json({ error: 'Pass ?path=/some/path (must start with a single /)' });
  }
  const params = { ...req.query };
  delete params.path;
  try {
    const response = await brightlocalClient.get(path, params);
    res.json({ path, status: response.status, data: response.data });
  } catch (err) {
    res.status(500).json({ path, ...errInfo(err) });
  }
});

// GET /api/diagnostic/seo/anthropic
// Confirms the API key works and lists the models it can use. No cost.
router.get('/anthropic', async (req, res) => {
  try {
    const response = await axios.get('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      params: { limit: 50 },
      timeout: 15000
    });
    res.json({
      ok: true,
      models: (response.data.data || []).map(m => ({ id: m.id, displayName: m.display_name }))
    });
  } catch (err) {
    res.status(500).json(errInfo(err));
  }
});

module.exports = router;