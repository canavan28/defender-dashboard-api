const axios = require('axios');
const cheerio = require('cheerio');

// Reads a page from OUR OWN website and extracts the SEO-relevant parts.
// Restricted to the domain in GSC_SITE_URL (and its subdomains) on
// purpose: the SEO agent will feed this text to Claude, and pages from
// the open web can contain hidden text written to manipulate AI.
//
// User-Agent: SiteGround's bot protection on infotank.com drops
// connections from clients that claim to be a browser but don't behave
// like one (confirmed: a Chrome User-Agent from curl was blocked, plain
// curl was not). So we identify honestly as a non-browser tool.

const DEFAULT_USER_AGENT = 'InfoTank-Dashboard/1.0 (+https://infotank.com)';
const MAX_TEXT_CHARS = 8000;
const MAX_LIST = 30;

function getSiteHost() {
  const site = (process.env.GSC_SITE_URL || '').trim();
  if (!site) return null;
  if (site.startsWith('sc-domain:')) return site.slice('sc-domain:'.length).toLowerCase();
  try {
    return new URL(site).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

function isAllowedHost(hostname) {
  const base = getSiteHost();
  if (!base || !hostname) return false;
  const h = hostname.toLowerCase();
  return h === base || h.endsWith('.' + base);
}

function getHomepageUrl() {
  const site = (process.env.GSC_SITE_URL || '').trim();
  const host = getSiteHost();
  if (!host) return null;
  if (site.startsWith('sc-domain:')) return `https://${host}/`;
  return site;
}

function collectSchemaTypes(node, set) {
  if (!node) return;
  if (Array.isArray(node)) { node.forEach(n => collectSchemaTypes(n, set)); return; }
  if (typeof node !== 'object') return;
  const t = node['@type'];
  if (Array.isArray(t)) t.forEach(x => set.add(String(x)));
  else if (t) set.add(String(t));
  if (node['@graph']) collectSchemaTypes(node['@graph'], set);
}

// options.userAgent overrides the default (used by the diagnostic route
// to test what SiteGround lets through).
async function readPage(url, options = {}) {
  const userAgent = options.userAgent || DEFAULT_USER_AGENT;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Not a valid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http and https URLs can be read');
  }
  if (!isAllowedHost(parsed.hostname)) {
    throw new Error(`Only pages on ${getSiteHost() || '(no site configured)'} can be read`);
  }

  const started = Date.now();
  const res = await axios.get(parsed.toString(), {
    timeout: 20000,
    maxRedirects: 5,
    maxContentLength: 5 * 1024 * 1024,
    responseType: 'text',
    transformResponse: x => x,
    validateStatus: () => true,
    headers: {
      'User-Agent': userAgent,
      'Accept': 'text/html,application/xhtml+xml'
    }
  });
  const responseTimeMs = Date.now() - started;
  const finalUrl = res.request?.res?.responseUrl || parsed.toString();

  const base = {
    requestedUrl: parsed.toString(),
    finalUrl,
    redirected: finalUrl !== parsed.toString(),
    status: res.status,
    responseTimeMs,
    userAgentUsed: userAgent,
    contentType: res.headers['content-type'] || null,
    xRobotsTag: res.headers['x-robots-tag'] || null
  };

  if (!isAllowedHost(new URL(finalUrl).hostname)) {
    return { ...base, error: 'Page redirected off-site; content not read' };
  }
  if (res.status >= 400) return { ...base, error: `Page returned HTTP ${res.status}` };
  if (!String(base.contentType || '').includes('text/html')) {
    return { ...base, error: 'Not an HTML page' };
  }

  const $ = cheerio.load(res.data);
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  const metaName = n => clean($(`meta[name="${n}"]`).attr('content')) || null;
  const metaProp = p => clean($(`meta[property="${p}"]`).attr('content')) || null;
  const listText = sel => $(sel).map((_, el) => clean($(el).text())).get().filter(Boolean).slice(0, MAX_LIST);

  // Headings
  const headingCounts = {};
  ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].forEach(h => { headingCounts[h] = $(h).length; });

  // Images
  let imageCount = 0;
  let missingAltCount = 0;
  let emptyAltCount = 0;
  const missingAltSamples = [];
  $('img').each((_, el) => {
    imageCount++;
    const alt = $(el).attr('alt');
    const src = $(el).attr('src') || $(el).attr('data-src') || null;
    if (alt === undefined) {
      missingAltCount++;
      if (missingAltSamples.length < MAX_LIST) missingAltSamples.push(src);
    } else if (!alt.trim()) {
      emptyAltCount++; // empty alt is valid for decorative images, so counted separately
    }
  });

  // Links
  const internalLinks = new Set();
  let internalLinkCount = 0;
  let externalLinkCount = 0;
  let nofollowCount = 0;
  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') || '').trim();
    if (!href || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) return;
    let u;
    try { u = new URL(href, finalUrl); } catch { return; }
    if (/nofollow/i.test($(el).attr('rel') || '')) nofollowCount++;
    if (isAllowedHost(u.hostname)) {
      internalLinkCount++;
      if (internalLinks.size < 100) internalLinks.add(u.origin + u.pathname);
    } else {
      externalLinkCount++;
    }
  });

  // Structured data (schema.org JSON-LD)
  const schemaTypes = new Set();
  let schemaParseErrors = 0;
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      collectSchemaTypes(JSON.parse($(el).contents().text()), schemaTypes);
    } catch {
      schemaParseErrors++;
    }
  });

  // Visible text (done last, since it removes script tags)
  $('script, style, noscript, svg, template, iframe').remove();
  const bodyText = clean($('body').text());

  return {
    ...base,
    lang: $('html').attr('lang') || null,
    title: clean($('head > title').first().text()) || null,
    titleLength: clean($('head > title').first().text()).length,
    metaDescription: metaName('description'),
    metaDescriptionLength: (metaName('description') || '').length,
    canonical: $('link[rel="canonical"]').attr('href') || null,
    robotsMeta: metaName('robots'),
    hasViewport: $('meta[name="viewport"]').length > 0,
    hreflangCount: $('link[rel="alternate"][hreflang]').length,
    openGraph: {
      title: metaProp('og:title'),
      description: metaProp('og:description'),
      image: metaProp('og:image')
    },
    headingCounts,
    h1: listText('h1'),
    h2: listText('h2'),
    h3: listText('h3'),
    images: { total: imageCount, missingAltCount, emptyAltCount, missingAltSamples },
    links: {
      internalCount: internalLinkCount,
      externalCount: externalLinkCount,
      nofollowCount,
      internalSample: [...internalLinks]
    },
    schemaTypes: [...schemaTypes],
    schemaParseErrors,
    wordCount: bodyText ? bodyText.split(' ').length : 0,
    mainText: bodyText.slice(0, MAX_TEXT_CHARS),
    mainTextTruncated: bodyText.length > MAX_TEXT_CHARS
  };
}

module.exports = { readPage, getSiteHost, isAllowedHost, getHomepageUrl, DEFAULT_USER_AGENT };