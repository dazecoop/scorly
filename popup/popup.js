const browserApi = (typeof browser !== 'undefined') ? browser : chrome;

let lastData = null;
let lastScoreResult = null;
let currentPlatform = 'facebook';
let savedSnapshotId = null;

const el = (id) => document.getElementById(id);

async function analyzeActiveTab() {
  showLoading();
  try {
    const [tab] = await browserApi.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || scorlyIsRestrictedUrl(tab.url)) {
      showError("This page can't be analyzed (browser-internal or store page).");
      return;
    }

    lastData = await scorlyAnalyzeTab(tab.id);
    savedSnapshotId = null;
    lastScoreResult = scorlyComputeScore(lastData);

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


// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

// The diff is far too wide for a 460px popup, so the popup's job is only to
// capture a snapshot and hand off to compare.html in a full tab.
async function refreshSnapCount() {
  const list = await scorlyLoadSnapshots();
  el('snapCount').textContent = list.length
    ? `${list.length} saved`
    : '';
}

async function saveCurrentSnapshot() {
  if (!lastData) return null;
  if (savedSnapshotId) return savedSnapshotId;
  const snap = await scorlySaveSnapshot(lastData, { origin: 'tab' });
  savedSnapshotId = snap.id;
  await refreshSnapCount();
  return snap.id;
}

function flashCmpButton(btn, text) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = text;
  setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 1400);
}

function initCompare() {
  el('saveSnapBtn').addEventListener('click', async () => {
    const id = await saveCurrentSnapshot();
    if (id) flashCmpButton(el('saveSnapBtn'), 'Saved \u2713');
  });

  el('compareBtn').addEventListener('click', async () => {
    // Snapshot this page as side A on the way out, so the compare view opens
    // with one side already filled.
    const id = await saveCurrentSnapshot();
    const url = browserApi.runtime.getURL('compare/compare.html') + (id ? '?a=' + encodeURIComponent(id) : '');
    await browserApi.tabs.create({ url });
    window.close();
  });

  refreshSnapCount();
}

document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initPlatformSwitch();
  initCountTiles();
  initExportButtons();
  initTheme();
  initCompare();
  el('refreshBtn').addEventListener('click', analyzeActiveTab);
  analyzeActiveTab();
});
