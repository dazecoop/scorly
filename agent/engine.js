// Scorly's analysis engine, outside the browser extension.
//
// Nothing here re-implements a check. The extension's own scripts
// (popup/analyze.js, scoring.js, export.js, compare/diff.js, …) are loaded
// into a Node vm context, so an audit run by an AI agent scores exactly like
// the popup does, and a fix to a check lands in both at once.
//
// A page can be read two ways:
//   - through the Scorly extension in the user's own browser (bridge.js),
//     which returns the same raw data the popup captures, or
//   - in a headless Chrome launched here (captureHeadless), which injects the
//     same in-page analyzer the extension injects with executeScript.
// Either way the raw data is scored here.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

// Load order matters: later files use helpers from earlier ones.
const SCRIPTS = [
  'popup/inpage-analyzer.js',
  'popup/analyze.js',
  'popup/scoring.js',
  'popup/render.js', // export.js formats with its helpers; no load-time DOM use
  'popup/export.js',
  'compare/diff.js',
  'compare/export-diff.js',
];

function loadScorly() {
  const context = vm.createContext({
    // analyze.js resolves `browser`/`chrome` at load time; the tab APIs it
    // wraps are never called from Node.
    chrome: {},
    fetch, AbortController, URL, URLSearchParams, Headers, TextDecoder, TextEncoder,
    setTimeout, clearTimeout, setInterval, clearInterval, console,
  });
  for (const file of SCRIPTS) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    vm.runInContext(src, context, { filename: file });
  }
  // Top-level const/function declarations live in the context's global
  // scope; pull out the ones the agent tools need.
  const pick = (name) => vm.runInContext(name, context);
  return {
    inPageAnalyzeSource: pick('scorlyInPageAnalyze').toString(),
    completeAnalysis: pick('scorlyCompleteAnalysis'),
    computeScore: pick('scorlyComputeScore'),
    toMarkdown: pick('toMarkdown'),
    buildExportPayload: pick('buildExportPayload'),
    buildDiff: pick('scorlyBuildDiff'),
    diffToMarkdown: pick('diffToMarkdown'),
    categoryLabels: pick('SCORLY_CATEGORY_LABELS'),
  };
}

const scorly = loadScorly();

// ---- Headless capture ------------------------------------------------------

let headlessBrowser = null;

// The full `puppeteer` package (a dev dependency of this repo) brings its own
// Chrome. An `npx` install only gets puppeteer-core, which drives the Chrome
// the user already has — or any Chromium named in SCORLY_CHROME.
async function launchHeadless() {
  if (headlessBrowser && headlessBrowser.connected) return headlessBrowser;
  const base = { headless: true, args: ['--no-first-run', '--no-default-browser-check'] };
  let bundled = null;
  try { bundled = require('puppeteer'); } catch (e) { /* npx install: core only */ }
  const core = require('puppeteer-core');

  const attempts = [];
  if (process.env.SCORLY_CHROME) attempts.push([core, { executablePath: process.env.SCORLY_CHROME }]);
  if (bundled) attempts.push([bundled, {}]);
  attempts.push([core, { channel: 'chrome' }]);

  let lastErr = null;
  for (const [lib, extra] of attempts) {
    try {
      headlessBrowser = await lib.launch({ ...base, ...extra });
      return headlessBrowser;
    } catch (err) { lastErr = err; }
  }
  throw new Error(
    'Could not start headless Chrome (' + lastErr.message.split('\n')[0] + '). ' +
    'Install Google Chrome, set SCORLY_CHROME to a Chrome/Chromium binary, or turn on ' +
    '"Let AI agents use Scorly" in the extension so audits run in your browser instead.');
}

async function closeHeadless() {
  if (headlessBrowser) {
    const b = headlessBrowser;
    headlessBrowser = null;
    try { await b.close(); } catch (e) { /* already gone */ }
  }
}

async function captureHeadless(url, { settleMs = 1200, timeoutMs = 30000 } = {}) {
  const browser = await launchHeadless();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1366, height: 900 });
    await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
    await new Promise((r) => setTimeout(r, settleMs));
    const data = await page.evaluate(`(${scorly.inPageAnalyzeSource})()`);
    if (!data) throw new Error('Could not read page content.');
    return await scorly.completeAnalysis(data);
  } finally {
    try { await page.close(); } catch (e) { /* ignore */ }
  }
}

// ---- Reports ---------------------------------------------------------------

// An audit is a snapshot in the extension's own shape, so the compare
// engine can diff two of them unchanged.
function makeAudit(data, origin) {
  return {
    id: 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    label: data.url,
    url: data.url,
    isLocalhost: !!data.isLocalhost,
    origin,
    capturedAt: new Date().toISOString(),
    data,
  };
}

function scoreAudit(audit) {
  if (!audit.score) {
    Object.defineProperty(audit, 'score', { value: scorly.computeScore(audit.data), enumerable: false });
  }
  return audit.score;
}

const SEV_RANK = { high: 0, med: 1, low: 2 };

// What a summary report shows, as data: rendered as Markdown for agents
// (summaryMarkdown) and with colour for people at a terminal (terminal.js).
// Failing and warning checks are listed most severe first; passed checks are
// only counted, since listing 80 of them would bury the work.
function summaryModel(audit) {
  const s = scoreAudit(audit);
  const checks = (status) => s.allChecks
    .filter((c) => c.status === status)
    .sort((a, b) => (SEV_RANK[a.severity] ?? 3) - (SEV_RANK[b.severity] ?? 3))
    .map((c) => ({ ...c, categoryLabel: scorly.categoryLabels[c.category] || c.category }));
  return {
    id: audit.id,
    url: audit.url,
    capturedAt: audit.capturedAt,
    origin: audit.origin,
    overall: s.overallScore,
    counts: s.counts,
    categories: Object.keys(scorly.categoryLabels)
      .filter((key) => s.categoryScores[key] != null)
      .map((key) => ({ key, label: scorly.categoryLabels[key], score: s.categoryScores[key] })),
    issues: checks('fail'),
    warnings: checks('warn'),
  };
}

function summaryMarkdown(audit, { engine } = {}) {
  const m = summaryModel(audit);
  const lines = [];
  lines.push(`# Scorly audit — ${m.url}`);
  lines.push('');
  lines.push(`Audit id: \`${m.id}\` · captured ${m.capturedAt}` + (engine ? ` · via ${engine}` : ''));
  lines.push('');
  lines.push(`**Overall score: ${m.overall}/100** — ${m.counts.issues} issues, ${m.counts.warnings} warnings, ${m.counts.passed} passed`);
  lines.push('');
  lines.push('| Category | Score |');
  lines.push('| --- | --- |');
  m.categories.forEach((c) => lines.push(`| ${c.label} | ${c.score} |`));
  lines.push('');
  if (m.origin === 'background') {
    lines.push('_Captured in a background tab: the browser does not paint those, so LCP/CLS were not recorded._');
    lines.push('');
  }
  [['Issues', m.issues], ['Warnings', m.warnings]].forEach(([heading, rows]) => {
    if (!rows.length) return;
    lines.push(`## ${heading} (${rows.length})`);
    lines.push('');
    rows.forEach((c) => {
      lines.push(`- **[${c.severity}] ${c.label}** (${c.categoryLabel} · \`${c.category}/${c.id}\`)${c.detail ? ' — ' + c.detail : ''}`);
    });
    lines.push('');
  });
  return lines.join('\n');
}

function fullMarkdown(audit) {
  return scorly.toMarkdown(audit.data, scoreAudit(audit));
}

function jsonReport(audit) {
  return { auditId: audit.id, origin: audit.origin, ...scorly.buildExportPayload(audit.data, scoreAudit(audit)) };
}

function diffAudits(before, after) {
  return scorly.buildDiff(before, after, scoreAudit(before), scoreAudit(after));
}

function diffMarkdown(before, after) {
  return scorly.diffToMarkdown(diffAudits(before, after));
}

// What changed between two audits of the same page, as data: the overall
// and category scores that moved, and checks whose verdict flipped.
function deltaModel(before, after) {
  const diff = diffAudits(before, after);
  const key = (c) => c.category + '/' + c.id;
  const prev = new Map(scoreAudit(before).allChecks.map((c) => [key(c), c]));
  return {
    beforeId: before.id,
    afterId: after.id,
    overall: diff.scores.overall,
    categories: diff.scores.categories.filter((c) => c.delta !== 0),
    flips: scoreAudit(after).allChecks
      .filter((c) => prev.has(key(c)) && prev.get(key(c)).status !== c.status)
      .map((c) => ({ label: c.label, from: prev.get(key(c)).status, to: c.status })),
  };
}

// Short "what changed" block appended to a re-audit of the same URL.
function deltaMarkdown(before, after) {
  const d = deltaModel(before, after);
  const sign = (n) => (n > 0 ? '+' + n : String(n));
  const lines = [];
  lines.push(`## Change since previous audit \`${d.beforeId}\``);
  lines.push('');
  lines.push(`Overall: ${d.overall.a} → ${d.overall.b} (${sign(d.overall.delta)})` +
    (d.overall.unreliable ? ' — performance not like-for-like (background capture)' : ''));
  d.categories.forEach((c) => lines.push(`- ${c.label}: ${c.a} → ${c.b} (${sign(c.delta)})`));
  if (d.flips.length) {
    lines.push('');
    lines.push('Checks that changed verdict:');
    d.flips.forEach((c) => lines.push(`- ${c.label}: ${c.from} → ${c.to}`));
  }
  lines.push('');
  lines.push(`Full comparison: call scorly_compare with before \`${d.beforeId}\` and after \`${d.afterId}\`.`);
  return lines.join('\n');
}

module.exports = {
  captureHeadless, closeHeadless, makeAudit, scoreAudit,
  summaryModel, summaryMarkdown, fullMarkdown, jsonReport,
  diffAudits, diffMarkdown, deltaModel, deltaMarkdown,
};
