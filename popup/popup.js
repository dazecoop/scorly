const browserApi = (typeof browser !== 'undefined') ? browser : chrome;

let lastData = null;
let lastScoreResult = null;
let currentPlatform = 'facebook';

const el = (id) => document.getElementById(id);

function isRestrictedUrl(url) {
  return /^(chrome|chrome-extension|edge|about|moz-extension|view-source|devtools):/i.test(url) ||
    /^https:\/\/chrome\.google\.com\/webstore/.test(url) ||
    /^https:\/\/addons\.mozilla\.org/.test(url);
}

async function fetchWithTimeout(url, ms) {
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

async function checkFavicon(url) {
  if (!url) return false;
  return new Promise((resolve) => {
    const img = new Image();
    const timer = setTimeout(() => resolve(false), 2500);
    img.onload = () => { clearTimeout(timer); resolve(true); };
    img.onerror = () => { clearTimeout(timer); resolve(false); };
    img.src = url;
  });
}

async function analyzeActiveTab() {
  showLoading();
  try {
    const [tab] = await browserApi.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || isRestrictedUrl(tab.url)) {
      showError("This page can't be analyzed (browser-internal or store page).");
      return;
    }

    const results = await browserApi.scripting.executeScript({
      target: { tabId: tab.id },
      func: scorlyInPageAnalyze,
    });

    const data = results && results[0] && results[0].result;
    if (!data) {
      showError('Could not read page content.');
      return;
    }

    let origin;
    try { origin = new URL(data.url).origin; } catch (e) { origin = null; }

    const [robotsTxt, sitemapXml, faviconOk] = await Promise.all([
      origin ? fetchWithTimeout(origin + '/robots.txt', 4000) : Promise.resolve(false),
      origin ? fetchWithTimeout(origin + '/sitemap.xml', 4000) : Promise.resolve(false),
      checkFavicon(data.favicon),
    ]);

    data.robotsTxt = robotsTxt;
    data.sitemapXml = sitemapXml;
    data.faviconOk = faviconOk;

    lastData = data;
    lastScoreResult = scorlyComputeScore(data);

    renderAll();
  } catch (err) {
    showError('Error analyzing page: ' + (err && err.message ? err.message : String(err)));
  }
}

function showLoading() {
  el('loadingState').classList.remove('hidden');
  el('errorState').classList.add('hidden');
  el('mainContent').classList.add('hidden');
}

function showError(msg) {
  el('loadingState').classList.add('hidden');
  el('mainContent').classList.add('hidden');
  el('errorState').classList.remove('hidden');
  el('errorText').textContent = msg;
}

function showMain() {
  el('loadingState').classList.add('hidden');
  el('errorState').classList.add('hidden');
  el('mainContent').classList.remove('hidden');
}

function renderAll() {
  showMain();
  el('pageUrl').textContent = lastData.url;
  el('localhostBadge').classList.toggle('hidden', !lastData.isLocalhost);

  renderOverview(lastData, lastScoreResult);
  renderMetaTab(lastData);
  renderContentTab(lastData, lastScoreResult);
  renderHeadingsTab(lastData, lastScoreResult);
  renderLinksTab(lastData);
  renderLinkListTab('internalContent', lastData.links.internalList, 'No internal links found.');
  renderLinkListTab('externalContent', lastData.links.externalList, 'No external links found.');
  renderImagesTab(lastData);
  renderSchemaTab(lastData, lastScoreResult);
  renderTechTab(lastData, lastScoreResult);
  renderPerfTab(lastData, lastScoreResult);
  renderSecurityTab(lastData, lastScoreResult);

  const ogData = renderOgTab(lastData);
  renderOgCard(currentPlatform, ogData);
}

function initTabs() {
  const strip = el('tabStrip');
  strip.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;
    strip.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    el('tab-' + btn.dataset.tab).classList.add('active');
    btn.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  });
}

function initPlatformSwitch() {
  el('platformSwitch').addEventListener('click', (e) => {
    const btn = e.target.closest('.plat-btn');
    if (!btn) return;
    document.querySelectorAll('.plat-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentPlatform = btn.dataset.plat;
    if (lastData) renderOgCard(currentPlatform, getOgPreviewData(lastData));
  });
}

function initCountTiles() {
  el('countRow').addEventListener('click', (e) => {
    const tile = e.target.closest('.count-tile');
    if (!tile) return;
    const target = el('overview-' + tile.dataset.target);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function initExportButtons() {
  el('exportJson').addEventListener('click', () => { if (lastData) exportJson(lastData, lastScoreResult); });
  el('exportCsv').addEventListener('click', () => { if (lastData) exportCsv(lastData, lastScoreResult); });
  el('exportPdf').addEventListener('click', () => { if (lastData) exportPdf(lastData, lastScoreResult); });
}

function initTheme() {
  const saved = localStorage.getItem('scorly-theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);
  el('themeBtn').addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') ||
      (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('scorly-theme', next);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initPlatformSwitch();
  initCountTiles();
  initExportButtons();
  initTheme();
  el('refreshBtn').addEventListener('click', analyzeActiveTab);
  analyzeActiveTab();
});
