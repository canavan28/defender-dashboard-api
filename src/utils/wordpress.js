const axios = require('axios');
const cheerio = require('cheerio');
const { getHomepageUrl, DEFAULT_USER_AGENT } = require('./siteReader');

// Reads published posts and pages from infotank.com through WordPress's
// PUBLIC REST API (wp-json). No login or credentials: this is the same
// data any visitor can see. Used for posting-cadence reminders ("no blog
// post in N days") and for giving the agent a list of pages to review.

function getApiBase() {
  const home = getHomepageUrl();
  if (!home) throw new Error('GSC_SITE_URL is not set, so the website address is unknown');
  return `${new URL(home).origin}/wp-json/wp/v2`;
}

// WordPress returns titles with HTML entities (&#038; etc.); this turns
// them back into plain text.
function decode(html) {
  return cheerio.load(`<div>${html || ''}</div>`)('div').text().replace(/\s+/g, ' ').trim();
}

async function wpGet(path, params) {
  return axios.get(`${getApiBase()}${path}`, {
    params,
    timeout: 20000,
    headers: { 'User-Agent': DEFAULT_USER_AGENT, 'Accept': 'application/json' }
  });
}

async function listRecentPosts(count = 20) {
  const res = await wpGet('/posts', {
    per_page: Math.min(count, 100),
    orderby: 'date',
    order: 'desc',
    _fields: 'id,date,modified,title,link,excerpt'
  });
  return {
    total: Number(res.headers['x-wp-total']) || null,
    posts: (res.data || []).map(p => ({
      id: p.id,
      title: decode(p.title?.rendered),
      link: p.link,
      published: p.date,
      modified: p.modified,
      excerpt: decode(p.excerpt?.rendered).slice(0, 300)
    }))
  };
}

// Pages are paged 100 at a time; most business sites have well under
// that, but this follows every page so nothing is silently dropped.
async function listAllPages() {
  const pages = [];
  for (let page = 1; page <= 20; page++) {
    const res = await wpGet('/pages', {
      per_page: 100,
      page,
      _fields: 'id,date,modified,title,link'
    });
    (res.data || []).forEach(p => pages.push({
      id: p.id,
      title: decode(p.title?.rendered),
      link: p.link,
      published: p.date,
      modified: p.modified
    }));
    const totalPages = Number(res.headers['x-wp-totalpages']) || 1;
    if (page >= totalPages) break;
  }
  return pages;
}

function daysSince(isoDate) {
  if (!isoDate) return null;
  return Math.floor((Date.now() - new Date(isoDate).getTime()) / 86400000);
}

module.exports = { listRecentPosts, listAllPages, daysSince };