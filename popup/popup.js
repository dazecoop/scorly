const browserApi = (typeof browser !== 'undefined') ? browser : chrome;

let lastData = null;
let lastScoreResult = null;
let currentPlatform = 'facebook';
let savedSnapshotId = null;

const el = (id) => document.getElementById(id);

// ---- Analysis progress bar ----
// "Realistic" = it trickles toward the cap of the current phase and only
// jumps when a phase actually completes, so it never sits full while the
// slow network checks are still running.
const progress = { value: 0, cap: 0, timer: null };

function progressStart() {
  const wrap = el('progressWrap');
  const fill = el('progressFill');
  wrap.classList.remove('hidden');
  fill.style.opacity = '1';
  progress.value = 4;
  progress.cap = 35; // phase 1: injecting + running the in-page analyzer
  fill.style.width = '4%';
  clearInterval(progress.timer);
  progress.timer = setInterval(() => {
    progress.value += (progress.cap - progress.value) * 0.08;
    fill.style.width = progress.value.toFixed(1) + '%';
    // The pending Technical bar on the overview tracks the same trickle.
    const techFill = document.getElementById('techPendingFill');
    if (techFill) techFill.style.width = progress.value.toFixed(1) + '%';
  }, 150);
}

function progressPhase(cap) {
  progress.value = Math.max(progress.value, progress.cap);
  progress.cap = cap;
}

function progressDone() {
  clearInterval(progress.timer);
  progress.timer = null;
  const fill = el('progressFill');
  fill.style.width = '100%';
  setTimeout(() => { fill.style.opacity = '0'; }, 350);
  setTimeout(() => {
    el('progressWrap').classList.add('hidden');
    fill.style.width = '0';
  }, 2000);
}

// ---- Pending score ticker ----
// While the network checks run, the score deliberately starts below the
// provisional value and climbs 1 at a time: it reads as "still being earned"
// instead of flashing a number that is about to change. Colors (number, ring,
// header chip) track whatever band the displayed value is in.
const scoreTicker = { timer: null };

// Milliseconds per +1 tick. (Not related to progressDone's timeout, which
// only controls how long the finished progress bar lingers on screen.)
const SCORE_TICK_MS = 2000;

function paintTickingScore(shown) {
  el('scoreNumber').textContent = shown;
  el('scoreNumber').style.color = scoreColor(shown);
  el('scoreArc').style.stroke = scoreColor(shown);
  el('scoreChip').textContent = shown;
  el('scoreChip').style.background = scoreColor(shown);
}

function startScoreTicker(target) {
  stopScoreTicker();
  let shown = Math.max(1, target - 10);
  paintTickingScore(shown);
  scoreTicker.timer = setInterval(() => {
    if (shown >= target) return; // hold just under lock-in until data lands
    shown++;
    paintTickingScore(shown);
  }, SCORE_TICK_MS);
}

function stopScoreTicker() {
  clearInterval(scoreTicker.timer);
  scoreTicker.timer = null;
}

// Final flourish: one quick full revolution of the ring while the arc fills
// to the real score underneath it.
function lockInScore() {
  stopScoreTicker();
  const svg = document.querySelector('#tab-overview .score-circle');
  svg.classList.add('score-fast-spin');
  setTimeout(() => svg.classList.remove('score-fast-spin'), 650);
}

async function analyzeActiveTab() {
  showLoading();
  progressStart();
  try {
    const [tab] = await browserApi.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || scorlyIsRestrictedUrl(tab.url)) {
      progressDone();
      showError("This page can't be analyzed (browser-internal or store page).");
      return;
    }

    // Two-phase render: paint everything the in-page analyzer returned the
    // moment it lands, while the origin checks (robots.txt, sitemap, favicon,
    // link targets) finish in the background and trigger a second render.
    lastData = await scorlyAnalyzeTab(tab.id, {
      onPartial: (data) => {
        lastData = data;
        savedSnapshotId = null;
        lastScoreResult = scorlyComputeScore(data);
        renderAll(true);
        startScoreTicker(lastScoreResult.overallScore);
        setAnalysisPending(true); // no partial snapshots: wait for full data
        progressPhase(92); // phase 2: network checks, the slow part
      },
    });
    savedSnapshotId = null;
    lastScoreResult = scorlyComputeScore(lastData);
    lockInScore();
    renderAll();
    setAnalysisPending(false);
    progressDone();
  } catch (err) {
    stopScoreTicker();
    progressDone();
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

// While origin/link checks are still in flight, a saved snapshot would be
// missing them — hold Save & Compare until the data is complete.
function setAnalysisPending(pending) {
  const save = el('saveSnapBtn');
  const compare = el('compareBtn');
  save.disabled = pending;
  compare.disabled = pending;
  save.title = pending
    ? 'Finishing link and origin checks…'
    : 'Store this page locally so you can diff it against another page later';
  compare.title = pending
    ? 'Finishing link and origin checks…'
    : 'Open the full comparison view in a new tab';
}

function showMain() {
  el('loadingState').classList.add('hidden');
  el('errorState').classList.add('hidden');
  el('mainContent').classList.remove('hidden');
}

function renderAll(pending) {
  showMain();
  el('pageUrl').textContent = lastData.url;
  el('localhostBadge').classList.toggle('hidden', !lastData.isLocalhost);

  renderOverview(lastData, lastScoreResult, { pending });
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

  // The strip's scrollbar is hidden (it ate ~15% of the strip on Windows), so
  // let a plain mouse wheel scroll it horizontally like a trackpad would.
  strip.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    strip.scrollLeft += e.deltaY;
    e.preventDefault();
  }, { passive: false });
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
  el('exportMd').addEventListener('click', () => { if (lastData) exportMarkdown(lastData, lastScoreResult); });
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

// The diff is far too wide for the popup, so the popup's job is only to
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
  // Version read from the manifest at runtime, so the About tab can't drift
  // from what is actually installed.
  try { el('aboutVersion').textContent = 'v' + browserApi.runtime.getManifest().version; } catch (e) { /* ignore */ }
  initTabs();
  initPlatformSwitch();
  initCountTiles();
  initExportButtons();
  initTheme();
  initCompare();
  el('refreshBtn').addEventListener('click', analyzeActiveTab);
  analyzeActiveTab();
});
