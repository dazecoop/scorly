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

// Runs the in-page analyzer in `tabId` and adds the few facts that can only be
// checked from outside the page (origin-level files, favicon reachability).
async function scorlyAnalyzeTab(tabId) {
  const results = await scorlyBrowser.scripting.executeScript({
    target: { tabId },
    func: scorlyInPageAnalyze,
  });
  const data = results && results[0] && results[0].result;
  if (!data) throw new Error('Could not read page content.');

  let origin;
  try { origin = new URL(data.url).origin; } catch (e) { origin = null; }

  const [robotsTxt, sitemapXml, faviconOk] = await Promise.all([
    origin ? scorlyFetchOk(origin + '/robots.txt', 4000) : Promise.resolve(false),
    origin ? scorlyFetchOk(origin + '/sitemap.xml', 4000) : Promise.resolve(false),
    scorlyCheckFavicon(data.favicon),
  ]);

  data.robotsTxt = robotsTxt;
  data.sitemapXml = sitemapXml;
  data.faviconOk = faviconOk;
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
