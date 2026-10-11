// Colour terminal output for the `scorly` CLI. Used only when stdout is a
// terminal: piped or redirected output stays plain Markdown, so scripts and
// agents keep something they can parse. NO_COLOR / --markdown force plain
// output; FORCE_COLOR forces colour.
//
// Score colours follow the popup (and Lighthouse): 90+ good, 50–89 needs
// work, under 50 poor.

const ESC = '\x1b[';
const wrap = (open, close) => (s) => `${ESC}${open}m${s}${ESC}${close}m`;
const c = {
  bold: wrap(1, 22), dim: wrap(2, 22), italic: wrap(3, 23), underline: wrap(4, 24),
  red: wrap(31, 39), green: wrap(32, 39), yellow: wrap(33, 39), blue: wrap(34, 39),
  magenta: wrap(35, 39), cyan: wrap(36, 39), gray: wrap(90, 39),
  bgRed: (s) => `${ESC}41;97m${s}${ESC}0m`,
  bgYellow: (s) => `${ESC}43;30m${s}${ESC}0m`,
  bgGreen: (s) => `${ESC}42;30m${s}${ESC}0m`,
  bgGray: (s) => `${ESC}100;97m${s}${ESC}0m`,
  bgBlue: (s) => `${ESC}44;97m${s}${ESC}0m`,
};

function useColor(stream = process.stdout) {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  return !!stream.isTTY;
}

const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
const visibleLength = (s) => [...stripAnsi(s)].length;
const padEnd = (s, n) => s + ' '.repeat(Math.max(0, n - visibleLength(s)));
const padStart = (s, n) => ' '.repeat(Math.max(0, n - visibleLength(s))) + s;

function termWidth() {
  return Math.max(60, Math.min(process.stdout.columns || 100, 110));
}

// Word-wraps text that may already contain colour codes; every line after
// the first is indented by `indent` spaces.
function wrapText(text, width, indent = 0) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  const room = (first) => width - (first ? 0 : indent);
  for (const w of words) {
    const candidate = line ? line + ' ' + w : w;
    if (line && visibleLength(candidate) > room(lines.length === 0)) {
      lines.push(line);
      line = w;
    } else line = candidate;
  }
  if (line) lines.push(line);
  return lines.map((l, i) => (i ? ' '.repeat(indent) + l : l)).join('\n');
}

const scoreTone = (n) => (n >= 90 ? 'green' : n >= 50 ? 'yellow' : 'red');
const toneText = (n, s) => c[scoreTone(n)](s);
const toneBadge = (n, s) => ({ green: c.bgGreen, yellow: c.bgYellow, red: c.bgRed })[scoreTone(n)](s);

function bar(score, width) {
  const filled = Math.round((score / 100) * width);
  return toneText(score, '█'.repeat(filled)) + c.gray('░'.repeat(width - filled));
}

const SEVERITY = {
  high: (s) => c.bgRed(s),
  med: (s) => c.bgYellow(s),
  low: (s) => c.bgGray(s),
};

function formatTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// ---- Summary report --------------------------------------------------------

function renderSummary(m, { engine } = {}) {
  const width = termWidth();
  const out = [''];
  out.push('  ' + c.bold(c.blue('◆ Scorly')) + '  ' + c.bold(m.url));
  out.push('  ' + c.dim([engine, formatTime(m.capturedAt), 'audit ' + m.id].filter(Boolean).join(' · ')));
  out.push('');

  const counts = [
    (m.counts.issues ? c.red : c.gray)(`✖ ${m.counts.issues} ${m.counts.issues === 1 ? 'issue' : 'issues'}`),
    (m.counts.warnings ? c.yellow : c.gray)(`▲ ${m.counts.warnings} ${m.counts.warnings === 1 ? 'warning' : 'warnings'}`),
    c.green(`✔ ${m.counts.passed} passed`),
  ].join('   ');
  out.push('  ' + toneBadge(m.overall, c.bold(`  ${m.overall}  `)) + c.dim(' /100') + '     ' + counts);
  out.push('');

  const labelW = Math.max(...m.categories.map((x) => x.label.length));
  const barW = Math.max(16, Math.min(32, width - labelW - 14));
  m.categories.forEach((x) => {
    out.push('  ' + padEnd(x.label, labelW) + '  ' + bar(x.score, barW) + '  ' + padStart(toneText(x.score, c.bold(String(x.score))), 3));
  });
  if (m.origin === 'background') {
    out.push('');
    out.push('  ' + c.dim(c.italic(wrapText('Captured in a background tab: the browser does not paint those, so LCP/CLS were not recorded.', width - 4, 2))));
  }

  const section = (title, rows, tone) => {
    if (!rows.length) return;
    out.push('');
    out.push('  ' + c.bold(tone(`${title.toUpperCase()} · ${rows.length}`)));
    out.push('  ' + c.gray('─'.repeat(Math.min(width - 4, 60))));
    rows.forEach((r) => {
      const badge = (SEVERITY[r.severity] || c.bgGray)(` ${String(r.severity || '').toUpperCase().padEnd(4)} `);
      out.push('  ' + badge + ' ' + c.bold(r.label) + c.gray('  ' + r.categoryLabel));
      if (r.detail) out.push('         ' + c.dim(wrapText(r.detail, width - 11, 9)));
    });
  };
  section('Issues', m.issues, c.red);
  section('Warnings', m.warnings, c.yellow);
  if (!m.issues.length && !m.warnings.length) {
    out.push('');
    out.push('  ' + c.green('✔ No issues or warnings.'));
  }
  out.push('');
  return out.join('\n');
}

// ---- Change since a saved audit ----------------------------------------------

function arrow(delta) {
  if (delta > 0) return c.green(`▲ +${delta}`);
  if (delta < 0) return c.red(`▼ ${delta}`);
  return c.gray('= 0');
}

function renderDelta(d, { beforeLabel } = {}) {
  const out = [];
  out.push('  ' + c.bold(c.blue(`CHANGE SINCE ${beforeLabel || d.beforeId}`)));
  out.push('  ' + c.gray('─'.repeat(40)));
  const rows = [{ label: 'Overall', a: d.overall.a, b: d.overall.b, delta: d.overall.delta, bold: true }]
    .concat(d.categories.map((x) => ({ label: x.label, a: x.a, b: x.b, delta: x.delta })));
  const labelW = Math.max(...rows.map((r) => r.label.length));
  rows.forEach((r) => {
    const label = padEnd(r.bold ? c.bold(r.label) : r.label, labelW);
    out.push(`  ${label}  ${padStart(toneText(r.a, String(r.a)), 3)} ${c.gray('→')} ${padStart(toneText(r.b, c.bold(String(r.b))), 3)}   ${arrow(r.delta)}`);
  });
  if (d.overall.unreliable) out.push('  ' + c.dim(c.italic('Performance not like-for-like (one side captured in a background tab).')));
  if (!d.categories.length && d.overall.delta === 0) out.push('  ' + c.gray('No category scores moved.'));
  if (d.flips.length) {
    out.push('');
    out.push('  ' + c.bold('Checks that changed'));
    const rank = { fail: 0, warn: 1, pass: 2 };
    d.flips.forEach((f) => {
      const better = rank[f.to] > rank[f.from];
      const mark = better ? c.green('✔') : c.red('✘');
      const tone = (st) => (st === 'pass' ? c.green : st === 'warn' ? c.yellow : c.red)(st);
      out.push(`  ${mark} ${f.label}  ${tone(f.from)} ${c.gray('→')} ${tone(f.to)}`);
    });
  }
  out.push('');
  return out.join('\n');
}

// ---- Comparison of two audits ------------------------------------------------

// Header from the diff model (who's A and B, scores side by side), then the
// changed sections from the shared Markdown, which starts at its first "## ".
function renderCompare(diff, md) {
  const out = [''];
  out.push('  ' + c.bold(c.blue('◆ Scorly comparison')));
  out.push('  ' + c.bgBlue(c.bold(' A ')) + ' ' + diff.a.url + c.dim('  ' + formatTime(diff.a.capturedAt)));
  out.push('  ' + c.bgGray(c.bold(' B ')) + ' ' + diff.b.url + c.dim('  ' + formatTime(diff.b.capturedAt)));
  out.push('');
  const rows = [{ label: 'Overall', a: diff.scores.overall.a, b: diff.scores.overall.b, delta: diff.scores.overall.delta, bold: true }]
    .concat(diff.scores.categories.map((x) => ({ label: x.label + (x.unreliable ? ' *' : ''), a: x.a, b: x.b, delta: x.delta })));
  const labelW = Math.max(...rows.map((r) => r.label.length));
  out.push('  ' + c.dim(padEnd('', labelW) + '    A     B'));
  rows.forEach((r) => {
    const label = padEnd(r.bold ? c.bold(r.label) : r.label, labelW);
    out.push(`  ${label}  ${padStart(toneText(r.a, String(r.a)), 4)}  ${padStart(toneText(r.b, c.bold(String(r.b))), 4)}   ${arrow(r.delta)}`);
  });
  if (!diff.scores.perfComparable) {
    out.push('  ' + c.dim(c.italic('* One side was captured in a background tab, so performance is not like-for-like.')));
  }
  const rest = String(md).indexOf('\n## ');
  out.push(rest >= 0 ? renderMarkdown(md.slice(rest + 1)) : '\n  ' + c.green('✔ No other differences.') + '\n');
  return out.join('\n');
}

// ---- Generic Markdown (full report, comparisons) ---------------------------

function inline(s) {
  return s
    .replace(/`([^`]+)`/g, (_, x) => c.cyan(x))
    .replace(/\*\*([^*]+)\*\*/g, (_, x) => c.bold(x))
    .replace(/(^|[\s(])_([^_]+)_(?=[\s).,]|$)/g, (_, p, x) => p + c.italic(c.dim(x)))
    .replace(/\[(FAIL|HIGH)\b/g, (m) => c.red(m))
    .replace(/\[(WARN|MED)\b/g, (m) => c.yellow(m))
    .replace(/\[(PASS|LOW)\b/g, (m) => c.gray(m))
    .replace(/(^|\s)([+-]\d+)(?=\s|\)|$)/g, (_, p, n) => p + (n.startsWith('+') && n !== '+0' ? c.green(n) : n === '+0' || n === '-0' ? c.gray(n) : c.red(n)));
}

function renderTable(rows, width) {
  const cells = rows.map((r) => r.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((x) => x.trim().replace(/\\\|/g, '|')));
  const header = cells[0];
  const body = cells.slice(2);
  const cols = header.length;
  const widths = Array.from({ length: cols }, (_, i) => Math.max(...[header].concat(body).map((r) => visibleLength(r[i] || ''))));
  // Keep wide tables inside the terminal by capping the widest column.
  const total = widths.reduce((a, b) => a + b, 0) + (cols - 1) * 3 + 2;
  if (total > width) {
    const widest = widths.indexOf(Math.max(...widths));
    widths[widest] = Math.max(10, widths[widest] - (total - width));
  }
  const fit = (s, w) => (visibleLength(s) > w ? [...stripAnsi(s)].slice(0, w - 1).join('') + '…' : s);
  const line = (r, style) => '  ' + r.map((x, i) => padEnd(style(inline(fit(x || '', widths[i]))), widths[i])).join(c.gray(' │ '));
  const out = [line(header, c.bold), '  ' + c.gray(widths.map((w) => '─'.repeat(w)).join('─┼─'))];
  body.forEach((r) => out.push(line(r, (x) => x)));
  return out.join('\n');
}

function renderMarkdown(md) {
  const width = termWidth();
  const lines = String(md).split('\n');
  const out = [];
  let inCode = false;
  let lang = '';
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const fence = l.match(/^\s*```(\w*)/);
    if (fence) { inCode = !inCode; lang = fence[1]; continue; }
    if (inCode) {
      const t = l.replace(/^\s+/, '');
      out.push('    ' + (lang === 'diff' && t.startsWith('+') ? c.green(t) : lang === 'diff' && t.startsWith('-') ? c.red(t) : c.dim(t)));
      continue;
    }
    if (/^\s*\|/.test(l) && lines[i + 1] && /^\s*\|\s*:?-{3}/.test(lines[i + 1])) {
      const block = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) block.push(lines[i++].trim());
      i--;
      out.push(renderTable(block, width));
      continue;
    }
    let m;
    if ((m = l.match(/^# (.*)/))) { out.push('', '  ' + c.bold(c.blue('◆ ' + stripAnsi(inline(m[1])))), ''); continue; }
    if ((m = l.match(/^## (.*)/))) { out.push('', '  ' + c.bold(stripAnsi(inline(m[1])).toUpperCase()), '  ' + c.gray('─'.repeat(Math.min(width - 4, 60)))); continue; }
    if ((m = l.match(/^#{3,} (.*)/))) { out.push('', '  ' + c.bold(inline(m[1]))); continue; }
    if ((m = l.match(/^(\s*)[-*] (.*)/))) {
      const depth = Math.floor(m[1].length / 2);
      const pad = 2 + depth * 3;
      out.push(' '.repeat(pad) + c.gray('•') + ' ' + wrapText(inline(m[2]), width - pad - 4, pad + 2));
      continue;
    }
    if (!l.trim()) { if (out[out.length - 1] !== '') out.push(''); continue; }
    out.push('  ' + wrapText(inline(l), width - 4, 2));
  }
  return out.join('\n') + '\n';
}

module.exports = { useColor, renderSummary, renderDelta, renderCompare, renderMarkdown };
