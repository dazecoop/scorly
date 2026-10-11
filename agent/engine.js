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

// The compact report an agent works from: scores, then every failing and
// warning check with the reason, most severe first. Passed checks are only
// counted — listing 80 of them would bury the work.
function summaryMarkdown(audit, { engine } = {}) {
  const s = scoreAudit(audit);
  const lines = [];
  lines.push(`# Scorly audit — ${audit.url}`);
  lines.push('');
  lines.push(`Audit id: \`${audit.id}\` · captured ${audit.capturedAt}` + (engine ? ` · via ${engine}` : ''));
  lines.push('');
  lines.push(`**Overall score: ${s.overallScore}/100** — ${s.counts.issues} issues, ${s.counts.warnings} warnings, ${s.counts.passed} passed`);
  lines.push('');
  lines.push('| Category | Score |');
  lines.push('| --- | --- |');
  Object.keys(scorly.categoryLabels).forEach((key) => {
    const v = s.categoryScores[key];
    if (v != null) lines.push(`| ${scorly.categoryLabels[key]} | ${v} |`);
  });
  lines.push('');
  if (audit.origin === 'background') {
    lines.push('_Captured in a background tab: the browser does not paint those, so LCP/CLS were not recorded._');
    lines.push('');
  }

  const listChecks = (status, heading) => {
    const rows = s.allChecks
      .filter((c) => c.status === status)
      .sort((a, b) => (SEV_RANK[a.severity] ?? 3) - (SEV_RANK[b.severity] ?? 3));
    if (!rows.length) return;
    lines.push(`## ${heading} (${rows.length})`);
    lines.push('');
    rows.forEach((c) => {
      const label = scorly.categoryLabels[c.category] || c.category;
      lines.push(`- **[${c.severity}] ${c.label}** (${label} · \`${c.category}/${c.id}\`)${c.detail ? ' — ' + c.detail : ''}`);
    });
    lines.push('');
  };
  listChecks('fail', 'Issues');
  listChecks('warn', 'Warnings');
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

// Short "what changed" block appended to a re-audit of the same URL.
function deltaMarkdown(before, after) {
  const diff = diffAudits(before, after);
  const sign = (n) => (n > 0 ? '+' + n : String(n));
  const lines = [];
  lines.push(`## Change since previous audit \`${before.id}\``);
  lines.push('');
  lines.push(`Overall: ${diff.scores.overall.a} → ${diff.scores.overall.b} (${sign(diff.scores.overall.delta)})` +
    (diff.scores.overall.unreliable ? ' — performance not like-for-like (background capture)' : ''));
  const moved = diff.scores.categories.filter((c) => c.delta !== 0);
  moved.forEach((c) => lines.push(`- ${c.label}: ${c.a} → ${c.b} (${sign(c.delta)})`));

  const s1 = scoreAudit(before);
  const s2 = scoreAudit(after);
  const key = (c) => c.category + '/' + c.id;
  const prev = new Map(s1.allChecks.map((c) => [key(c), c]));
  const flips = s2.allChecks.filter((c) => prev.has(key(c)) && prev.get(key(c)).status !== c.status);
  if (flips.length) {
    lines.push('');
    lines.push('Checks that changed verdict:');
    flips.forEach((c) => lines.push(`- ${c.label}: ${prev.get(key(c)).status} → ${c.status}`));
  }
  lines.push('');
  lines.push(`Full comparison: call scorly_compare with before \`${before.id}\` and after \`${after.id}\`.`);
  return lines.join('\n');
}

module.exports = {
  captureHeadless, closeHeadless, makeAudit, scoreAudit,
  summaryMarkdown, fullMarkdown, jsonReport, diffMarkdown, deltaMarkdown,
};
