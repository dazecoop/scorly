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
// never see (document/location expose no header API). A second request to
// the same URL — cheap, and the only way to get at this data from an extension.
async function scorlyFetchSecurityHeaders(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    try { if (res.body) await res.body.cancel(); } catch (e) { /* ignore */ }
    return {
      hsts: res.headers.get('strict-transport-security'),
      csp: res.headers.get('content-security-policy'),
      xContentTypeOptions: res.headers.get('x-content-type-options'),
      xFrameOptions: res.headers.get('x-frame-options'),
    };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
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

  const [robotsTxt, sitemapXml, faviconOk, linkCheck, wwwRedirect, securityHeaders] = await Promise.all([
    origin ? scorlyFetchOk(origin + '/robots.txt', 4000) : Promise.resolve(false),
    origin ? scorlyFetchOk(origin + '/sitemap.xml', 4000) : Promise.resolve(false),
    scorlyCheckFavicon(data.favicon),
    scorlyCheckInternalLinks(data),
    origin ? scorlyCheckWwwRedirect(data.url, 4000) : Promise.resolve(null),
    (origin && !data.isLocalhost) ? scorlyFetchSecurityHeaders(data.url, 4000) : Promise.resolve(null),
  ]);

  data.robotsTxt = robotsTxt;
  data.sitemapXml = sitemapXml;
  data.faviconOk = faviconOk;
  data.linkCheck = linkCheck;
  data.wwwRedirect = wwwRedirect;
  data.securityHeaders = securityHeaders;
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
