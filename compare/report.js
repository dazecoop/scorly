// Full-report view controller.
//
// Opened as a full tab (report.html?snap=<snapshotId>) from the popup's
// "Full report" button. The page is the popup laid out wide: every tab is
// rendered by the popup's own builders (scorlyPagePanels in render.js, styled
// by panels.css), then "All captured fields" lists every raw value the
// compare view knows about (scorlyBuildReport in diff.js). Exports are the
// popup's single-page exporters (export.js).

const el = (id) => document.getElementById(id);

const state = {
  snap: null,
  score: null,
  report: null,
  shot: null,
  filter: '',
};

// Long raw lists (page text, requests, links) start trimmed; a button reveals the rest.
const LIST_PREVIEW = 40;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  scorlyInitTheme();
  scorlyInitExportMenu((format) => { if (state.snap) EXPORTERS[format](); });
  scorlyInitPanelInteractions(() => (state.snap ? { data: state.snap.data, score: state.score } : null));
  el('filterInput').addEventListener('input', (e) => {
    state.filter = e.target.value.trim().toLowerCase();
    if (state.report) applyFilter();
  });

  const id = new URLSearchParams(location.search).get('snap');
  const [snap, shot] = id ? await Promise.all([scorlyGetSnapshot(id), scorlyGetShot(id)]) : [null, null];
  el('busyPane').classList.add('hidden');

  if (!snap) {
    el('missingPane').classList.remove('hidden');
    ['filterInput', 'compareBtn', 'exportWrap'].forEach((x) => el(x).classList.add('hidden'));
    return;
  }

  state.snap = snap;
  state.shot = shot;
  state.score = scorlyComputeScore(snap.data);
  state.report = scorlyBuildReport(snap, state.score);

  el('compareBtn').addEventListener('click', () => {
    location.href = 'compare.html?a=' + encodeURIComponent(snap.id);
  });

  document.title = 'Scorly · ' + snap.label;
  renderHero();
  renderHeader();
  renderPanels();
  renderFields();
  el('reportPane').classList.remove('hidden');
});

// ---------------------------------------------------------------------------
// Header: screenshot, score ring, category bars, issue counts
// ---------------------------------------------------------------------------

function renderHero() {
  if (!state.shot) return;
  const img = el('heroImg');
  img.onload = () => {
    el('hero').dataset.state = 'ready';
    document.body.classList.add('has-hero');
  };
  img.src = state.shot;
}

function renderHeader() {
  const { snap, score } = state;
  const data = snap.data;

  el('scoreRing').innerHTML = scoreRingHtml(score.overallScore, 'SCORE');
  el('scoreBars').innerHTML = categoryBarsHtml(score.categoryScores);

  el('pageTitle').textContent = (data.title && data.title.text) || snap.label;
  el('pageUrl').textContent = snap.url;
  el('pageUrl').href = snap.url;

  const meta = el('pageMeta');
  meta.innerHTML = '';
  meta.appendChild(document.createTextNode('Analyzed ' + new Date(snap.capturedAt).toLocaleString()));
  if (snap.isLocalhost) meta.appendChild(pill('localhost', 'pill-local'));
  if (snap.origin === 'background') meta.appendChild(pill('background capture', 'pill-bg'));

  el('issuesCount').textContent = score.counts.issues;
  el('warningsCount').textContent = score.counts.warnings;
  el('passedCount').textContent = score.counts.passed;

  // The count tiles jump to the matching group in the Overview's check list.
  el('countRow').addEventListener('click', (e) => {
    const tile = e.target.closest('.count-tile');
    if (!tile) return;
    el('sec-overview').open = true;
    const target = el('overview-' + tile.dataset.target);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function pill(text, cls) {
  const span = document.createElement('span');
  span.className = 'pill ' + (cls || '');
  span.textContent = text;
  return span;
}

// ---------------------------------------------------------------------------
// Popup tabs, laid out wide
// ---------------------------------------------------------------------------

function renderPanels() {
  const host = el('panelHost');
  const nav = el('jumpNav');
  host.innerHTML = '';
  nav.innerHTML = '';

  scorlyPagePanels(state.snap.data, state.score, { imageLimit: 500 }).forEach((tab) => {
    const { sec, body } = sectionShell('sec-' + tab.id, tab.label);
    body.classList.add('pp');
    body.innerHTML = tab.html;
    host.appendChild(sec);
    nav.appendChild(jumpLink(sec, tab.label));
  });

  const fields = el('fieldsWrap');
  nav.appendChild(jumpLink(fields, 'All captured fields', 'jump-raw'));
}

function jumpLink(target, label, cls) {
  const link = document.createElement('a');
  link.href = '#' + target.id;
  link.textContent = label;
  if (cls) link.className = cls;
  link.addEventListener('click', () => { target.open = true; });
  return link;
}

function sectionShell(id, label, hint, warnHint) {
  const sec = document.createElement('details');
  sec.className = 'sec';
  sec.id = id;
  sec.open = true;

  const summary = document.createElement('summary');
  const text = document.createElement('span');
  text.textContent = label;
  summary.appendChild(text);
  sec.appendChild(summary);

  if (hint) {
    const h = document.createElement('div');
    h.className = 'sec-hint' + (warnHint ? ' warn-hint' : '');
    h.textContent = hint;
    sec.appendChild(h);
  }

  const body = document.createElement('div');
  body.className = 'sec-body';
  sec.appendChild(body);
  return { sec, body };
}

// ---------------------------------------------------------------------------
// Filter: popup panels show or hide whole; raw fields filter row by row.
// ---------------------------------------------------------------------------

function applyFilter() {
  el('panelHost').querySelectorAll(':scope > .sec').forEach((sec) => {
    sec.classList.toggle('hidden', !!state.filter && !sec.textContent.toLowerCase().includes(state.filter));
  });
  el('jumpNav').querySelectorAll('a').forEach((a) => {
    const target = document.querySelector(a.getAttribute('href'));
    a.classList.toggle('hidden', !!target && target.classList.contains('hidden'));
  });
  renderFields();
  // A filter is a search: open the raw fields so matches there are visible.
  if (state.filter) el('fieldsWrap').open = true;
}

function matches(...parts) {
  if (!state.filter) return true;
  return parts.filter((p) => p !== null && p !== undefined).join(' ').toLowerCase().includes(state.filter);
}

// ---------------------------------------------------------------------------
// All captured fields (same section list the compare view uses)
// ---------------------------------------------------------------------------

function renderFields() {
  const host = el('fieldHost');
  host.innerHTML = '';
  state.report.sections.forEach((section) => {
    const node = fieldSection(section);
    if (node) host.appendChild(node);
  });
  if (!host.childNodes.length) {
    const note = document.createElement('p');
    note.className = 'empty-note';
    note.textContent = 'No captured field matches that filter.';
    host.appendChild(note);
  }
}

function fieldSection(section) {
  const sectionHit = matches(section.label);
  const rows = section.rows.map((row) => renderRow(row, sectionHit)).filter(Boolean);
  if (!rows.length && state.filter) return null;

  const { sec, body } = sectionShell('field-' + section.id, section.label, section.hint, section.unreliable);
  sec.open = !!state.filter;
  rows.forEach((r) => body.appendChild(r));
  if (!rows.length) {
    const note = document.createElement('p');
    note.className = 'empty-note';
    note.textContent = 'Nothing captured for this section.';
    body.appendChild(note);
  }
  return sec;
}

// Returns null when the filter hides the whole row.
function renderRow(row, sectionHit) {
  const labelHit = sectionHit || matches(row.label);
  switch (row.kind) {
    case 'num': return labelHit || matches(row.value) ? numRow(row) : null;
    case 'seq': return listRow(row, labelHit, seqItemText, seqLine);
    case 'set': return listRow(row, labelHit, (i) => i.key + ' ' + (i.value || ''), setLine);
    default: return labelHit || matches(row.value) ? valueRow(row) : null;
  }
}

function rowHead(label, note) {
  const head = document.createElement('div');
  head.className = 'row-head';
  const l = document.createElement('span');
  l.className = 'row-label';
  l.textContent = label;
  head.appendChild(l);
  if (note) {
    const n = document.createElement('span');
    n.className = 'row-note';
    n.textContent = note;
    head.appendChild(n);
  }
  return head;
}

function valueRow(row) {
  const wrap = document.createElement('div');
  wrap.className = 'row';
  const notes = [];
  if (row.kind === 'text' && row.value !== null) notes.push(row.len + ' chars');
  if (row.ideal) notes.push('ideal ' + row.ideal);
  if (row.note) notes.push(row.note);
  wrap.appendChild(rowHead(row.label, notes.join('  ·  ')));

  const cell = document.createElement('div');
  cell.className = 'rcell';
  if (row.value === null || row.value === undefined) {
    const miss = document.createElement('span');
    miss.className = 'missing';
    miss.textContent = '— not present';
    cell.appendChild(miss);
  } else {
    cell.textContent = displayImageSrc(row.value);
  }
  wrap.appendChild(cell);

  if (row.preview === 'image' && row.value) {
    const pair = document.createElement('div');
    pair.className = 'img-pair';
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = '';
    img.src = row.value;
    pair.appendChild(img);
    wrap.appendChild(pair);
  }
  return wrap;
}

function numRow(row) {
  const grid = document.createElement('div');
  grid.className = 'rnum';

  const l = document.createElement('span');
  l.className = 'nlabel';
  l.textContent = row.label;
  if (row.note) {
    const n = document.createElement('span');
    n.className = 'rnum-note';
    n.textContent = row.note;
    l.appendChild(n);
  }
  grid.appendChild(l);

  const v = document.createElement('span');
  v.className = 'nval';
  const val = row.value;
  if (val === null || val === undefined) {
    v.textContent = '—';
    v.classList.add('flat');
  } else {
    v.textContent = row.unit === ' bytes' ? formatByteSize(val) : formatNum(val) + (row.unit || '');
    const vital = row.vital && scorlyVitalStatus(row.vital, val);
    if (vital) v.style.color = `var(--${vital})`;
  }
  grid.appendChild(v);
  return grid;
}

function formatByteSize(n) {
  if (Math.abs(n) < 1024) return `${Math.round(n)} B`;
  if (Math.abs(n) < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function formatNum(n) {
  if (typeof n !== 'number') return String(n);
  if (Math.abs(n) >= 10000) return n.toLocaleString();
  return String(Math.round(n * 1000) / 1000);
}

// Sets and sequences share one renderer: a count, then the items, trimmed
// to LIST_PREVIEW until asked (a filter always shows every match).
function listRow(row, labelHit, textOf, lineOf) {
  const items = labelHit ? row.items : row.items.filter((i) => matches(textOf(i)));
  if (!items.length && !labelHit) return null;

  const wrap = document.createElement('div');
  wrap.className = 'row';
  const total = row.kind === 'set' ? row.count : row.items.length;
  wrap.appendChild(rowHead(row.label,
    [state.filter && items.length !== row.items.length ? `${items.length} of ${total} match` : `${total}`, row.note]
      .filter(Boolean).join('  ·  ')));

  if (!items.length) {
    const note = document.createElement('p');
    note.className = 'empty-note';
    note.textContent = 'None found.';
    wrap.appendChild(note);
    return wrap;
  }

  const box = document.createElement(row.kind === 'set' ? 'ul' : 'div');
  box.className = row.kind === 'set' ? 'set-list rlist' : 'seq rlist';
  const limit = state.filter ? items.length : LIST_PREVIEW;
  items.slice(0, limit).forEach((item) => box.appendChild(lineOf(item, row.render)));
  wrap.appendChild(box);

  if (items.length > limit) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'seq-gap';
    more.textContent = `Show all ${items.length} (${items.length - limit} more)`;
    more.addEventListener('click', () => {
      const frag = document.createDocumentFragment();
      items.slice(limit).forEach((item) => frag.appendChild(lineOf(item, row.render)));
      box.appendChild(frag);
      more.remove();
    });
    wrap.appendChild(more);
  }
  return wrap;
}

function seqItemText(item) {
  if (item && typeof item === 'object') return [item.level ? 'h' + item.level : item.tag, item.text, item.line].filter(Boolean).join(' ');
  return String(item);
}

function seqLine(item, render) {
  const line = document.createElement('div');
  line.className = 'seq-line';
  if (render === 'heading' || render === 'textblock') {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = render === 'heading' ? 'H' + item.level : '<' + item.tag + '>';
    line.appendChild(tag);
    // Indent the outline by level so the hierarchy reads at a glance.
    if (render === 'heading') line.style.paddingLeft = (8 + (item.level - 1) * 14) + 'px';
    line.appendChild(document.createTextNode(item.text));
  } else if (render === 'jsonline') {
    line.classList.add('pre');
    line.appendChild(document.createTextNode(item.line));
  } else {
    line.appendChild(document.createTextNode(String(item)));
  }
  return line;
}

function setLine(item) {
  const li = document.createElement('li');
  if (item.thumb) li.appendChild(thumbImg(item.thumb));
  const key = document.createElement('span');
  key.className = 'skey';
  key.textContent = item.key;
  li.appendChild(key);
  if (item.value) {
    const val = document.createElement('span');
    val.className = 'sval';
    val.textContent = item.value;
    li.appendChild(val);
  }
  return li;
}

// ---------------------------------------------------------------------------
// Export menu — the popup's single-page exporters, fed the stored snapshot
// ---------------------------------------------------------------------------

// The PDF gets the screenshot cropped to the top of the page, at the aspect
// exportPdf draws it at, flattened to JPEG so jsPDF needn't decode PNG.
function cropShotForPdf(src) {
  return new Promise((resolve) => {
    if (!src) { resolve(null); return; }
    const img = new Image();
    img.onload = () => {
      const w = Math.min(img.naturalWidth, 1400);
      const h = Math.round(w / PDF_SHOT_ASPECT);
      const srcH = Math.min(img.naturalHeight, Math.round(img.naturalWidth / PDF_SHOT_ASPECT));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, img.naturalWidth, srcH, 0, 0, w, Math.round(srcH * (w / img.naturalWidth)));
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

const EXPORTERS = {
  pdf: async () => exportPdf(state.snap.data, state.score, { screenshot: await cropShotForPdf(state.shot) }),
  csv: () => exportCsv(state.snap.data, state.score),
  json: () => exportJson(state.snap.data, state.score),
  md: () => exportMarkdown(state.snap.data, state.score),
};
