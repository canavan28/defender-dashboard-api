const fs = require('fs');
const path = require('path');
const { brightlocalClient } = require('./brightlocal');

// Saved BrightLocal snapshot for the SEO agent. The agent NEVER calls
// BrightLocal directly: the API key is a trial key with 1,000 lifetime
// requests, and BrightLocal only re-measures rankings on its own weekly
// schedule anyway. Instead, a sync (about 10 requests) runs automatically
// once a week (or manually by an owner) and saves everything here. Every
// sync also appends to a history, so week-over-week comparisons build up
// on our side even though BrightLocal's API only returns the latest run.
//
// File: /app/data/seo-brightlocal.json

const DATA_DIR = process.env.DATA_DIR || '/app/data';
const FILE = path.join(DATA_DIR, 'seo-brightlocal.json');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MAX_HISTORY = 52;

let cache = null;
let syncing = false;

function emptyStore() {
  return {
    lastSyncAt: null,
    lastAttemptAt: null,
    lastError: null,
    requestsUsed: 0,
    location: null,
    rankTracker: null,
    rankTrackerHistory: [],
    grid: null,
    gridHistory: {},
    reviews: null
  };
}

function load() {
  if (cache) return cache;
  try {
    cache = { ...emptyStore(), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  } catch {
    cache = emptyStore();
  }
  return cache;
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache));
  fs.renameSync(tmp, FILE);
}

function decodeEntities(s) {
  return (s || '')
    .replace(/&#0?39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Local Rank Tracker result -> compact per-keyword ranks.
// Engines: google = desktop organic, google-mobile = mobile organic,
// google-places = Google Maps listings. rank 0 from BrightLocal means
// "not found in the top 100", stored here as null.
function summarizeRankTracker(d) {
  const volume = {};
  (d.rankings?.volume || []).forEach(v => { volume[v.keyword] = v.volume; });
  let runAt = null;
  const keywords = (d.rankings?.by_keyword || []).map(k => {
    const results = {};
    Object.entries(k.results || {}).forEach(([engine, arr]) => {
      const r = Array.isArray(arr) ? arr[0] : null;
      if (r?.date && !runAt) runAt = r.date;
      results[engine] = r && r.rank
        ? { rank: r.rank, page: r.page, type: r.type, url: r.url || null, title: r.title || null }
        : { rank: null, note: 'not in top 100' };
    });
    return { keyword: k.keyword, monthlySearchVolume: volume[k.keyword] ?? null, results };
  });
  return {
    runAt: runAt || d.details?.last_processed_at || null,
    schedule: d.details?.schedule || null,
    searchLocation: d.details?.search_location || null,
    engines: d.details?.search_engines || [],
    competitorsTracked: (d.competitors || []).length,
    reportUrl: d.urls?.interactive_url || null,
    keywords
  };
}

async function syncBrightLocal() {
  if (syncing) return { started: false, reason: 'A sync is already running' };
  if (!process.env.BRIGHTLOCAL_API_KEY) return { started: false, reason: 'BRIGHTLOCAL_API_KEY is not set' };
  syncing = true;

  const s = load();
  const now = new Date().toISOString();
  s.lastAttemptAt = now;
  const errors = [];
  let used = 0;

  const get = async (p, params) => {
    used++;
    s.requestsUsed = (s.requestsUsed || 0) + 1;
    const r = await brightlocalClient.get(p, params);
    return r.data;
  };

  try {
    // 1. Location -> report IDs (looked up each time, not hardcoded)
    const locs = await get('/manage/v1/locations');
    const loc = locs.items?.[0]?.location;
    if (!loc) throw new Error('No BrightLocal location found');
    const reports = loc.reports || {};
    s.location = {
      locationId: loc.location_id,
      name: loc.name,
      website: loc.urls?.website_url || null,
      officeLatLng: loc.geo_location ? [loc.geo_location.latitude, loc.geo_location.longitude] : null,
      reportIds: { lrt: reports.lrt?.id || null, lsg: reports.lsg?.id || null, rm: reports.rm?.id || null },
      dashboardUrl: loc.dashboard_urls?.location_url || null
    };

    // 2. Local Rank Tracker
    if (s.location.reportIds.lrt) {
      try {
        const d = await get(`/manage/v1/lrt/reports/${s.location.reportIds.lrt}/result`);
        s.rankTracker = summarizeRankTracker(d);
        const runAt = s.rankTracker.runAt;
        if (runAt && !s.rankTrackerHistory.some(h => h.runAt === runAt)) {
          s.rankTrackerHistory.push({
            runAt,
            keywords: s.rankTracker.keywords.map(k => ({
              keyword: k.keyword,
              ranks: Object.fromEntries(Object.entries(k.results).map(([eng, r]) => [eng, r.rank]))
            }))
          });
          s.rankTrackerHistory = s.rankTrackerHistory.slice(-MAX_HISTORY);
        }
      } catch (err) {
        errors.push(`rank tracker: ${err.message}`);
      }
    }

    // 3. Local Search Grid (skips the per-keyword calls if no new run since last sync)
    if (s.location.reportIds.lsg) {
      try {
        const lsgId = s.location.reportIds.lsg;
        const report = await get(`/manage/v1/lsg/reports/${lsgId}`);
        const reportKeywords = report.keywords || [];
        const unchanged = report.last_run_id
          && s.grid?.lastRunId === report.last_run_id
          && (s.grid?.keywords || []).length === reportKeywords.length;

        if (unchanged) {
          s.grid.checkedAt = now;
        } else {
          const kws = [];
          for (const kw of reportKeywords) {
            try {
              const d = await get(`/manage/v1/lsg/reports/${lsgId}/runs/latest/keywords/${kw.id}`);
              const runDate = d.end_date || d.start_date || null;
              kws.push({
                keyword: kw.keyword,
                keywordId: kw.id,
                runId: d.run_id,
                runDate,
                status: d.status,
                summary: d.summary || null,
                gridUrl: d.grid_url || null,
                points: (d.grid_points || []).map(p => [p.latitude, p.longitude, p.rank])
              });
              const hist = s.gridHistory[kw.keyword] || [];
              if (!hist.some(h => h.runId === d.run_id)) {
                hist.push({
                  runId: d.run_id,
                  runDate,
                  avgRank: d.summary?.avg_rank ?? null,
                  highPoints: d.summary?.num_high_ranking_points ?? null,
                  medPoints: d.summary?.num_med_ranking_points ?? null,
                  lowPoints: d.summary?.num_low_ranking_points ?? null,
                  totalPoints: d.summary?.num_points ?? null
                });
              }
              s.gridHistory[kw.keyword] = hist.slice(-MAX_HISTORY);
            } catch (err) {
              errors.push(`grid "${kw.keyword}": ${err.message}`);
            }
          }
          s.grid = {
            schedule: report.schedule || null,
            dayOfWeek: report.day_of_week || null,
            gridSize: report.grid_size || null,
            pointSpacing: report.grid_point_spacing || null,
            lastRunId: report.last_run_id || null,
            reportUrl: report.report_urls?.report_url || null,
            checkedAt: now,
            keywords: kws
          };
        }
      } catch (err) {
        errors.push(`grid report: ${err.message}`);
      }
    }

    // 4. Reviews (newest 100)
    if (s.location.reportIds.rm) {
      try {
        const d = await get(`/manage/v1/rm/reports/${s.location.reportIds.rm}/reviews`, {
          sort_date: 'desc',
          num_per_page: 100
        });
        s.reviews = {
          total: d.total_count ?? null,
          fetchedAt: now,
          recent: (d.items || []).map(r => ({
            rating: r.rating,
            author: r.author,
            text: decodeEntities(r.text),
            directory: r.directory,
            published: r.publish_time
          }))
          // Sorted here too, rather than trusting the API's sort order.
          .sort((a, b) => String(b.published || '').localeCompare(String(a.published || '')))
        };
      } catch (err) {
        errors.push(`reviews: ${err.message}`);
      }
    }

    s.lastSyncAt = now;
    s.lastError = errors.length ? errors.join(' | ') : null;
  } catch (err) {
    s.lastError = err.message;
    errors.push(err.message);
  } finally {
    syncing = false;
    try { save(); } catch (err) { console.error('[BrightLocal] Save failed:', err.message); }
  }

  console.log(`[BrightLocal] Sync finished: ${used} requests, ${errors.length} errors`);
  return { started: true, requestsThisSync: used, errors };
}

// Weekly automatic sync. Checks hourly; syncs when the last good sync is
// over 7 days old, and never retries a failed attempt within 6 hours, so
// a broken key can't burn through the trial allowance.
function startScheduler() {
  if (!process.env.BRIGHTLOCAL_API_KEY) return;
  const check = () => {
    const s = load();
    const nowMs = Date.now();
    const lastSync = s.lastSyncAt ? Date.parse(s.lastSyncAt) : 0;
    const lastAttempt = s.lastAttemptAt ? Date.parse(s.lastAttemptAt) : 0;
    if (nowMs - lastSync > 7 * DAY && nowMs - lastAttempt > 6 * HOUR) {
      syncBrightLocal().catch(err => console.error('[BrightLocal] Scheduled sync failed:', err.message));
    }
  };
  setTimeout(check, 2 * 60 * 1000);
  setInterval(check, HOUR);
}

function getStatus() {
  const s = load();
  return {
    syncing,
    lastSyncAt: s.lastSyncAt,
    lastAttemptAt: s.lastAttemptAt,
    lastError: s.lastError,
    requestsUsed: s.requestsUsed,
    trialAllowance: 1000,
    hasRankTracker: !!s.rankTracker,
    gridKeywords: (s.grid?.keywords || []).length,
    reviewsSaved: (s.reviews?.recent || []).length
  };
}

// What the agent's brightlocal_rankings tool returns.
function getRankingsForAgent({ includeGridPointsFor } = {}) {
  const s = load();
  if (!s.lastSyncAt) return { error: 'No BrightLocal data has been synced yet.' };
  return {
    syncedAt: s.lastSyncAt,
    location: s.location,
    rankTracker: s.rankTracker,
    rankTrackerHistory: s.rankTrackerHistory,
    localSearchGrid: s.grid ? {
      ...s.grid,
      keywords: (s.grid.keywords || []).map(k => {
        const { points, ...rest } = k;
        const wantPoints = includeGridPointsFor
          && k.keyword.toLowerCase() === String(includeGridPointsFor).toLowerCase();
        return wantPoints ? { ...rest, points_lat_lng_rank: points } : rest;
      })
    } : null,
    localSearchGridHistory: s.gridHistory
  };
}

// What the agent's brightlocal_reviews tool returns.
function getReviewsForAgent({ limit = 20, rating } = {}) {
  const s = load();
  if (!s.reviews) return { error: 'No review data has been synced yet.' };
  const recent = s.reviews.recent || [];
  const ratingCounts = {};
  recent.forEach(r => { ratingCounts[r.rating] = (ratingCounts[r.rating] || 0) + 1; });
  const avg = recent.length
    ? Math.round((recent.reduce((sum, r) => sum + (r.rating || 0), 0) / recent.length) * 100) / 100
    : null;
  const newest = recent[0]?.published || null;
  const filtered = rating != null ? recent.filter(r => r.rating === rating) : recent;
  return {
    syncedAt: s.reviews.fetchedAt,
    totalReviews: s.reviews.total,
    savedRecentReviews: recent.length,
    averageRatingOfSaved: avg,
    ratingCountsOfSaved: ratingCounts,
    newestReviewDate: newest,
    daysSinceNewestReview: newest ? Math.floor((Date.now() - Date.parse(newest.replace(' ', 'T') + 'Z')) / DAY) : null,
    reviews: filtered.slice(0, Math.min(limit || 20, 100))
  };
}

module.exports = { syncBrightLocal, startScheduler, getStatus, getRankingsForAgent, getReviewsForAgent };