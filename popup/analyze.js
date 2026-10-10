// Shared page-analysis step, used by both the popup (active tab) and the
// compare view (a URL loaded in a background tab) so the two capture paths
// cannot drift apart and produce falsely different results.

const scorlyBrowser = (typeof browser !== 'undefined') ? browser : chrome;

function scorlyIsRestrictedUrl(url) {
  return /^(chrome|chrome-extension|edge|about|moz-extension|view-source|devtools):/i.test(url) ||
    /^https:\/\/chrome\.google\.com\/webstore/.test(url) ||
    /^https:\/\/addons\.mozilla\.org/.test(url);
}

async function scorlyFetchOk(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    return res.ok;
  } catch (e) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Fetches a small text file and returns its body (or null). Used for
// robots.txt so the AI-crawler rules can be parsed from the same request
// that already proves the file exists.
async function scorlyFetchText(url, ms, maxBytes = 100000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) return null;
    const text = await res.text();
    return text.slice(0, maxBytes);
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// The AI assistant/training crawlers worth knowing about. A site that blocks
// them in robots.txt is (deliberately or not) invisible to the AI answer
// engines that increasingly send traffic.
const SCORLY_AI_BOTS = [
  { bot: 'GPTBot', engine: 'ChatGPT (training)' },
  { bot: 'OAI-SearchBot', engine: 'ChatGPT Search' },
  { bot: 'ChatGPT-User', engine: 'ChatGPT (browsing)' },
  { bot: 'ClaudeBot', engine: 'Claude' },
  { bot: 'anthropic-ai', engine: 'Claude (training)' },
  { bot: 'PerplexityBot', engine: 'Perplexity' },
  { bot: 'Google-Extended', engine: 'Gemini (training)' },
  { bot: 'CCBot', engine: 'Common Crawl' },
];

// Minimal robots.txt group parser: for each AI bot, is "/" disallowed under
// its own user-agent group or under *? (Longest-match rules and wildcards
// beyond a bare "Disallow: /" are out of scope — the blanket block is the
// pattern that actually occurs in the wild.)
function scorlyParseAiBotAccess(robotsText) {
  if (!robotsText) return SCORLY_AI_BOTS.map((b) => ({ ...b, allowed: true, explicit: false }));
  const groups = []; // { agents: [..], disallowAll, allowAll }
  let current = null;
  robotsText.split(/\r?\n/).forEach((line) => {
    const clean = line.replace(/#.*$/, '').trim();
    const m = clean.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) return;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'user-agent') {
      // Consecutive user-agent lines share one group; any other directive closes it.
      if (!current || current.closed) { current = { agents: [], disallowAll: false, allowAll: false, closed: false }; groups.push(current); }
      current.agents.push(val.toLowerCase());
    } else if (current) {
      if (key === 'disallow' && (val === '/' || val === '/*')) current.disallowAll = true;
      if (key === 'allow' && val === '/') current.allowAll = true;
      current.closed = true;
    }
  });
  return SCORLY_AI_BOTS.map((b) => {
    const name = b.bot.toLowerCase();
    const own = groups.filter((g) => g.agents.includes(name));
    const star = groups.filter((g) => g.agents.includes('*'));
    const pick = own.length ? own : star;
    const blocked = pick.some((g) => g.disallowAll) && !pick.some((g) => g.allowAll);
    return { ...b, allowed: !blocked, explicit: own.length > 0 };
  });
}

function scorlyCheckFavicon(url) {
  if (!url) return Promise.resolve(false);
  return new Promise((resolve) => {
    const img = new Image();
    const timer = setTimeout(() => resolve(false), 2500);
    img.onload = () => { clearTimeout(timer); resolve(true); };
    img.onerror = () => { clearTimeout(timer); resolve(false); };
    img.src = url;
  });
}

// Fetches one URL and reports its final status, following redirects. HEAD
// first to avoid downloading bodies; GET fallback for servers that reject
// HEAD (405/501). Requests go only to the site being analyzed.
async function scorlyFetchStatus(url, ms) {
  const attempt = async (method) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(url, { method, signal: ctrl.signal, cache: 'no-store' });
      // Only the status matters — stop the body download a GET would start.
      try { if (res.body) await res.body.cancel(); } catch (e) { /* ignore */ }
      return {
        url,
        status: res.status,
        ok: res.ok,
        // fetch follows redirects silently; `redirected` + the final URL is
        // all it exposes (the 301-vs-302 code would need webRequest).
        redirectedTo: res.redirected ? res.url : null,
      };
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const result = await attempt('HEAD');
    // Redirect/tracking endpoints (e.g. affiliate "via=lander" links) often
    // only implement GET and return a non-2xx to HEAD even though a real
    // browser's GET navigation succeeds — don't trust a failing HEAD alone.
    if (!result.ok) return await attempt('GET');
    return result;
  } catch (e) {
    try { return await attempt('GET'); } catch (e2) {
      return { url, status: null, ok: false, redirectedTo: null, error: true };
    }
  }
}

// Checks whether the alternate www/non-www host for this domain redirects to
// the canonical host — the classic setup where both subdomains serve
// identical content with no redirect, which search engines treat as
// duplicate content. Returns null when there's no www/bare-domain pair to
// check (localhost, bare IPs, or a subdomain other than www).
async function scorlyCheckWwwRedirect(url, ms) {
  let u;
  try { u = new URL(url); } catch (e) { return null; }
  const host = u.hostname;
  const isWww = host.startsWith('www.');
  if (!isWww && host.split('.').length > 2) return null;
  if (!isWww && !/\./.test(host)) return null; // localhost, bare hostnames
  const altHost = isWww ? host.slice(4) : 'www.' + host;
  const altUrl = u.protocol + '//' + altHost + '/';

  let result;
  try {
    result = await scorlyFetchStatus(altUrl, ms);
  } catch (e) {
    return null;
  }
  if (!result.ok) return { checked: true, altHost, duplicate: false, unreachable: true };

  let redirectsToCanonical = false;
  if (result.redirectedTo) {
    try { redirectsToCanonical = new URL(result.redirectedTo).hostname === host; } catch (e) { /* ignore */ }
  }
  return { checked: true, altHost, duplicate: !redirectsToCanonical, unreachable: false };
}

// Reads a few security-relevant response headers that page-context JS can
// never see (document/location expose no header API), plus the HTML as it
// was actually served. A second request to the same URL — cheap, and the
// only way to get at this data from an extension.
//
// The served markup matters on its own: the in-page analyzer reads the DOM
// *after* JavaScript has run, so a client-rendered app looks fully populated
// to it while a crawler that does not execute scripts sees whatever is in
// this response. Comparing the two is the only way to tell the difference,
// and it is the single most consequential trait of a generated SPA.
async function scorlyFetchServedDocument(url, ms, maxBytes = 600000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    let html = '';
    try { html = (await res.text()).slice(0, maxBytes); } catch (e) { /* ignore */ }
    return {
      headers: {
        hsts: res.headers.get('strict-transport-security'),
        csp: res.headers.get('content-security-policy'),
        xContentTypeOptions: res.headers.get('x-content-type-options'),
        xFrameOptions: res.headers.get('x-frame-options'),
      },
      served: scorlyDescribeServedHtml(html, res),
    };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Strips the served HTML down to the text and metadata a non-executing
// crawler would come away with. Tag-stripping with regexes is crude, but it
// only has to produce a word count that is right to within a few percent —
// the question being asked is "nearly nothing, or a real page?".
function scorlyDescribeServedHtml(html, res) {
  if (!html) return null;
  const head = html.slice(0, 200000);
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<template[\s\S]*?<\/template>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:nbsp|amp|lt|gt|quot|#\d+);/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const generatorMatch = head.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i) ||
    head.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']generator["']/i);
  // Deployment platform, from the headers only a server can set.
  const platform = (() => {
    const h = (n) => { try { return res.headers.get(n); } catch (e) { return null; } };
    if (h('x-vercel-id') || h('x-vercel-cache')) return 'Vercel';
    if (h('x-nf-request-id')) return 'Netlify';
    if (h('x-railway-request-id')) return 'Railway';
    if (/cloudflare/i.test(h('server') || '')) return 'Cloudflare';
    if (/^Fly/i.test(h('server') || '')) return 'Fly.io';
    if (h('x-render-origin-server')) return 'Render';
    return h('server') || null;
  })();
  return {
    bytes: html.length,
    words: stripped ? stripped.split(/\s+/).filter(Boolean).length : 0,
    generator: generatorMatch ? generatorMatch[1].slice(0, 120) : null,
    platform,
    poweredBy: (() => { try { return res.headers.get('x-powered-by'); } catch (e) { return null; } })(),
    hasH1: /<h1[\s>]/i.test(html),
    titleLength: (() => { const m = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i); return m ? m[1].trim().length : 0; })(),
    rootOnly: /<(?:div|main)[^>]+id=["'](?:root|app|__next|__nuxt)["'][^>]*>\s*<\/(?:div|main)>/i.test(html),
  };
}

// Does the site serve a real 404 for a URL that cannot exist? A 200 here
// (soft 404) means search engines may index junk URLs; a tiny default body
// means users hitting a dead link get a bare server error page.
async function scorlyCheck404Page(origin, ms) {
  const probe = origin + '/scorly-404-probe-' + Math.random().toString(36).slice(2, 10);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(probe, { signal: ctrl.signal, cache: 'no-store' });
    let bodyLength = 0;
    try { bodyLength = (await res.text()).length; } catch (e) { /* ignore */ }
    return { status: res.status, soft404: res.ok, custom: bodyLength > 1500, bodyLength };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Samples the page's heaviest same-origin static assets and re-requests
// them to read caching headers and spot unminified JS/CSS — the only way to
// see response headers/bodies from an extension. Bounded like the link
// checker: a handful of requests, all to the site being analyzed.
async function scorlyCheckAssets(data, { maxAssets = 8, perRequestMs = 4000 } = {}) {
  const sameOrigin = (data.resources || []).filter((r) => {
    try { return new URL(r.url).hostname === data.hostname && r.type !== 'document'; } catch (e) { return false; }
  });
  const isStatic = (u) => /\.(js|mjs|css|png|jpe?g|webp|avif|gif|svg|woff2?)(\?|$)/i.test(u);
  const targets = sameOrigin
    .filter((r) => isStatic(r.url))
    .sort((a, b) => (b.transferSize || 0) - (a.transferSize || 0))
    .slice(0, maxAssets);
  if (!targets.length) return null;

  const results = [];
  for (const r of targets) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), perRequestMs);
    try {
      const isCode = /\.(js|mjs|css)(\?|$)/i.test(r.url);
      const res = await fetch(r.url, { signal: ctrl.signal, cache: 'force-cache' });
      const cacheControl = res.headers.get('cache-control');
      const expires = res.headers.get('expires');
      // "Cacheable" = any positive caching signal; no-store/no-cache/max-age=0
      // or no header at all means every repeat visitor re-downloads it.
      const cacheable = cacheControl
        ? !/no-store|no-cache|max-age=0(?!\d)/i.test(cacheControl) && /max-age=[1-9]|immutable|public/i.test(cacheControl)
        : !!expires;
      let minified = null;
      if (isCode) {
        const text = (await res.text()).slice(0, 200000);
        if (text.length > 2500) {
          const lines = text.split('\n');
          const avgLine = text.length / lines.length;
          // Minified code has very long lines; hand-written code averages <200 chars.
          minified = avgLine > 250;
        }
      } else {
        try { if (res.body) await res.body.cancel(); } catch (e) { /* ignore */ }
      }
      results.push({ url: r.url, kind: isCode ? (/\.css/i.test(r.url) ? 'css' : 'js') : 'asset', cacheControl, cacheable, minified });
    } catch (e) {
      /* unreachable asset — skip rather than guess */
    } finally {
      clearTimeout(timer);
    }
  }
  if (!results.length) return null;
  const code = results.filter((x) => x.minified !== null);
  return {
    checked: results.length,
    uncached: results.filter((x) => !x.cacheable).length,
    uncachedList: results.filter((x) => !x.cacheable).map((x) => x.url),
    codeChecked: code.length,
    unminified: code.filter((x) => !x.minified).length,
    unminifiedList: code.filter((x) => !x.minified).map((x) => x.url),
  };
}

// Checks that every internal link on the page actually resolves. Bounded so a
// link-heavy page can't stall the analysis: 60 unique targets, 6 at a time,
// and anything still unchecked when the time budget runs out is skipped
// rather than reported as broken.
async function scorlyCheckInternalLinks(data, { max = 60, concurrency = 6, perRequestMs = 4000, budgetMs = 10000 } = {}) {
  const seen = new Set();
  const targets = [];
  ((data.links && data.links.internalList) || []).forEach((l) => {
    if (!l.href || seen.has(l.href) || targets.length >= max) return;
    seen.add(l.href);
    targets.push(l.href);
  });
  if (!targets.length) return null;

  const started = Date.now();
  const results = [];
  let next = 0;
  async function worker() {
    while (next < targets.length) {
      const url = targets[next++];
      if (Date.now() - started > budgetMs) {
        results.push({ url, status: null, ok: null, redirectedTo: null, skipped: true });
        continue;
      }
      results.push(await scorlyFetchStatus(url, perRequestMs));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  const checked = results.filter((r) => !r.skipped);
  return {
    total: targets.length,
    checked: checked.length,
    broken: checked.filter((r) => !r.ok).length,
    redirected: checked.filter((r) => r.ok && r.redirectedTo).length,
    list: results,
  };
}

// Runs the in-page analyzer in `tabId` and adds the few facts that can only be
// checked from outside the page (origin-level files, favicon reachability,
// internal link targets).
//
// `onPartial` (optional) fires as soon as the in-page read is done — before
// the network checks, which on a slow site dominate the wait. The popup uses
// it to paint everything it already knows; robotsTxt / sitemapXml /
// faviconOk / linkCheck are still undefined at that point and fill in on the
// final return (same object, mutated).
async function scorlyAnalyzeTab(tabId, { onPartial } = {}) {
  const results = await scorlyBrowser.scripting.executeScript({
    target: { tabId },
    func: scorlyInPageAnalyze,
  });
  const data = results && results[0] && results[0].result;
  if (!data) throw new Error('Could not read page content.');
  if (onPartial) {
    try { onPartial(data); } catch (e) { /* rendering must not kill analysis */ }
  }

  let origin;
  try { origin = new URL(data.url).origin; } catch (e) { origin = null; }

  const [robotsTxtBody, sitemapXml, faviconOk, linkCheck, wwwRedirect, servedDoc, llmsTxt, notFoundPage, assetCheck] = await Promise.all([
    origin ? scorlyFetchText(origin + '/robots.txt', 4000) : Promise.resolve(null),
    origin ? scorlyFetchOk(origin + '/sitemap.xml', 4000) : Promise.resolve(false),
    scorlyCheckFavicon(data.favicon),
    scorlyCheckInternalLinks(data),
    origin ? scorlyCheckWwwRedirect(data.url, 4000) : Promise.resolve(null),
    origin ? scorlyFetchServedDocument(data.url, 6000) : Promise.resolve(null),
    origin ? scorlyFetchOk(origin + '/llms.txt', 4000) : Promise.resolve(false),
    origin ? scorlyCheck404Page(origin, 5000) : Promise.resolve(null),
    scorlyCheckAssets(data),
  ]);

  data.robotsTxt = robotsTxtBody !== null;
  data.aiBotAccess = scorlyParseAiBotAccess(robotsTxtBody);
  data.llmsTxt = llmsTxt;
  data.notFoundPage = notFoundPage;
  data.assetCheck = assetCheck;
  data.sitemapXml = sitemapXml;
  data.faviconOk = faviconOk;
  data.linkCheck = linkCheck;
  data.wwwRedirect = wwwRedirect;
  // The security headers are meaningless on localhost (no TLS, no CDN), but
  // the served-HTML read is just as useful there as anywhere.
  data.securityHeaders = (servedDoc && !data.isLocalhost) ? servedDoc.headers : null;
  data.servedHtml = servedDoc ? servedDoc.served : null;
  return data;
}

// Loads a URL in an inactive tab, analyzes it, then closes the tab again.
// The tab is never brought to the foreground, so the browser does not paint
// it and no LCP/CLS entries are recorded — snapshots taken this way are
// marked `origin: 'background'` and their paint timings are not compared.
async function scorlyAnalyzeUrlInBackgroundTab(url, { settleMs = 1200, timeoutMs = 25000 } = {}) {
  const tab = await scorlyBrowser.tabs.create({ url, active: false });
  try {
    await scorlyWaitForTabLoad(tab.id, timeoutMs);
    await new Promise((r) => setTimeout(r, settleMs));
    return await scorlyAnalyzeTab(tab.id);
  } finally {
    try { await scorlyBrowser.tabs.remove(tab.id); } catch (e) { /* already gone */ }
  }
}

function scorlyWaitForTabLoad(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    (function poll() {
      scorlyBrowser.tabs.get(tabId).then((tab) => {
        if (tab && tab.status === 'complete') resolve(tab);
        else if (Date.now() > deadline) reject(new Error('Timed out loading the page.'));
        else setTimeout(poll, 200);
      }, reject);
    }());
  });
}
