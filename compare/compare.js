// Compare view controller.
//
// Opened as a full tab (compare.html?a=<snapshotId>&b=<snapshotId>). Reads
// snapshots from local extension storage, scores them with the same
// scoring.js the popup uses, diffs them with diff.js, and renders the result.

const el = (id) => document.getElementById(id);

const state = {
  snapA: null,
  snapB: null,
  diff: null,
  diffOnly: true,
  filter: '',
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  initTheme();
  initChrome();

  const params = new URLSearchParams(location.search);
  const [a, b] = await Promise.all([
    params.get('a') ? scorlyGetSnapshot(params.get('a')) : null,
    params.get('b') ? scorlyGetSnapshot(params.get('b')) : null,
  ]);
  state.snapA = a;
  state.snapB = b;

  if (a && b) renderDiff();
  else await showSetup();
});

function initChrome() {
  el('themeBtn').addEventListener('click', toggleTheme);
  el('diffOnly').addEventListener('change', (e) => {
    state.diffOnly = e.target.checked;
    if (state.diff) renderSections();
  });
  el('filterInput').addEventListener('input', (e) => {
    state.filter = e.target.value.trim().toLowerCase();
    if (state.diff) renderSections();
  });
  el('swapBtn').addEventListener('click', () => {
    const t = state.snapA;
    state.snapA = state.snapB;
    state.snapB = t;
    if (state.snapA && state.snapB) renderDiff();
  });
  el('backBtn').addEventListener('click', showSetup);
  el('compareBtn').addEventListener('click', () => {
    if (state.snapA && state.snapB) renderDiff();
  });
  el('clearAllBtn').addEventListener('click', async () => {
    if (!confirm('Delete all saved snapshots? This cannot be undone.')) return;
    await scorlyClearSnapshots();
    state.snapA = null;
    state.snapB = null;
    await showSetup();
  });
  initExportMenu();

  document.querySelectorAll('.slot-form').forEach((form) => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const slot = form.dataset.capture;
      const input = form.querySelector('.slot-url');
      await captureIntoSlot(slot, input.value.trim());
      input.value = '';
    });
  });

  el('slotSelectA').addEventListener('change', (e) => selectSnapshot('a', e.target.value));
  el('slotSelectB').addEventListener('change', (e) => selectSnapshot('b', e.target.value));
}

function initTheme() {
  const saved = localStorage.getItem('scorly-theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') ||
    (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('scorly-theme', next);
}

function showPane(which) {
  ['setupPane', 'diffPane', 'busyPane'].forEach((id) => {
    el(id).classList.toggle('hidden', id !== which);
  });
  const isDiff = which === 'diffPane';
  el('diffOnlyWrap').classList.toggle('hidden', !isDiff);
  el('filterInput').classList.toggle('hidden', !isDiff);
  el('swapBtn').classList.toggle('hidden', !isDiff);
  el('exportWrap').classList.toggle('hidden', !isDiff);
  if (!isDiff) closeExportMenu();
}

function busy(text) {
  el('busyText').textContent = text;
  showPane('busyPane');
}

function setStatus(text, isError) {
  const node = el('setupStatus');
  node.textContent = text || '';
  node.classList.toggle('err', !!isError);
}

// ---------------------------------------------------------------------------
// Setup pane
// ---------------------------------------------------------------------------

async function showSetup() {
  showPane('setupPane');
  const list = await scorlyLoadSnapshots();

  ['a', 'b'].forEach((slot) => {
    const select = el('slotSelect' + slot.toUpperCase());
    const chosen = slot === 'a' ? state.snapA : state.snapB;
    select.innerHTML = '';
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = list.length ? 'Choose a saved snapshot…' : 'No saved snapshots yet';
    select.appendChild(blank);
    list.forEach((snap) => {
      const opt = document.createElement('option');
      opt.value = snap.id;
      opt.textContent = `${snap.label} — ${scorlyRelativeTime(snap.capturedAt)}`;
      if (chosen && chosen.id === snap.id) opt.selected = true;
      select.appendChild(opt);
    });

    const current = el('slotCurrent' + slot.toUpperCase());
    current.classList.toggle('filled', !!chosen);
    current.textContent = chosen
      ? `${chosen.url} · ${scorlyRelativeTime(chosen.capturedAt)}${chosen.origin === 'background' ? ' · background capture' : ''}`
      : 'Nothing selected';
  });

  el('compareBtn').disabled = !(state.snapA && state.snapB);
  renderSnapshotList(list);
}

function renderSnapshotList(list) {
  const host = el('snapList');
  host.innerHTML = '';
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'snap-empty';
    li.textContent = 'None yet. Open Scorly on a page and press “Save snapshot”, or load a URL above.';
    host.appendChild(li);
    el('clearAllBtn').classList.add('hidden');
    return;
  }
  el('clearAllBtn').classList.remove('hidden');

  list.forEach((snap) => {
    const li = document.createElement('li');

    const url = document.createElement('span');
    url.className = 'snap-url';
    url.textContent = snap.url;
    li.appendChild(url);

    if (snap.isLocalhost) li.appendChild(pill('localhost', 'pill-local'));
    if (snap.origin === 'background') li.appendChild(pill('background', 'pill-bg'));

    const when = document.createElement('span');
    when.className = 'snap-when';
    when.textContent = scorlyRelativeTime(snap.capturedAt);
    li.appendChild(when);

    const del = document.createElement('button');
    del.className = 'btn btn-danger-ghost';
    del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      await scorlyDeleteSnapshot(snap.id);
      if (state.snapA && state.snapA.id === snap.id) state.snapA = null;
      if (state.snapB && state.snapB.id === snap.id) state.snapB = null;
      await showSetup();
    });
    li.appendChild(del);

    host.appendChild(li);
  });
}

function pill(text, cls) {
  const span = document.createElement('span');
  span.className = 'pill ' + (cls || '');
  span.textContent = text;
  return span;
}

async function selectSnapshot(slot, id) {
  const snap = id ? await scorlyGetSnapshot(id) : null;
  if (slot === 'a') state.snapA = snap;
  else state.snapB = snap;
  if (state.snapA && state.snapB && state.snapA.id !== state.snapB.id) {
    renderDiff();
    return;
  }
  await showSetup();
}

async function captureIntoSlot(slot, url) {
  if (!url) return;
  if (scorlyIsRestrictedUrl(url)) {
    setStatus("That URL can't be analyzed (browser-internal or store page).", true);
    return;
  }
  busy(`Loading ${url} in a background tab…`);
  try {
    const data = await scorlyAnalyzeUrlInBackgroundTab(url);
    const snap = await scorlySaveSnapshot(data, { origin: 'background' });
    if (slot === 'a') state.snapA = snap;
    else state.snapB = snap;

    // Capturing the second side is the last thing standing between the user
    // and the diff they came for — don't make them press Compare as well.
    if (state.snapA && state.snapB) {
      renderDiff();
      return;
    }
    await showSetup();
    setStatus(`Captured ${snap.url}. Pick or capture the other side to compare.`);
  } catch (err) {
    await showSetup();
    setStatus('Could not capture that URL: ' + (err && err.message ? err.message : String(err)), true);
  }
}

// ---------------------------------------------------------------------------
// Diff render
// ---------------------------------------------------------------------------

function renderDiff() {
  const scoreA = scorlyComputeScore(state.snapA.data);
  const scoreB = scorlyComputeScore(state.snapB.data);
  state.diff = scorlyBuildDiff(state.snapA, state.snapB, scoreA, scoreB);

  showPane('diffPane');
  renderSides();
  renderScoreTable();
  renderSections();
  window.scrollTo(0, 0);
}

function renderSides() {
  const d = state.diff;
  ['a', 'b'].forEach((k) => {
    const side = d[k];
    const up = k.toUpperCase();
    el('sideLabel' + up).textContent = side.label;
    el('sideScore' + up).textContent = d.scores.overall[k];
    el('sideUrl' + up).textContent = side.url;
    const meta = el('sideMeta' + up);
    meta.innerHTML = '';
    meta.appendChild(document.createTextNode(scorlyRelativeTime(side.capturedAt)));
    if (side.isLocalhost) meta.appendChild(pill('localhost', 'pill-local'));
    if (side.origin === 'background') meta.appendChild(pill('background capture', 'pill-bg'));
  });

  const delta = d.scores.overall.delta;
  const node = el('sidesDelta');
  node.textContent = delta === 0 ? 'same' : (delta > 0 ? '▲ ' : '▼ ') + Math.abs(delta);
  node.className = 'sides-delta ' + (delta === 0 ? 'flat' : delta > 0 ? 'good' : 'bad');

  el('summaryRow').innerHTML = '';
  el('summaryRow').append(
    strongText(String(d.totalChanged)),
    document.createTextNode(d.totalChanged === 1 ? ' difference found across ' : ' differences found across '),
    strongText(String(d.sections.filter((s) => s.changed).length)),
    document.createTextNode(' sections. B scores '),
    strongText(delta === 0 ? 'the same as' : (delta > 0 ? `${delta} higher than` : `${Math.abs(delta)} lower than`)),
    document.createTextNode(' A.'),
  );
}

function strongText(text) {
  const s = document.createElement('strong');
  s.textContent = text;
  return s;
}

function renderScoreTable() {
  const d = state.diff;
  const host = el('scoreTable');
  host.innerHTML = '';

  const sec = document.createElement('details');
  sec.className = 'sec';
  sec.open = true;
  sec.appendChild(sectionSummary('Scores', d.scores.categories.filter((c) => c.delta !== 0).length));

  const body = document.createElement('div');
  body.className = 'sec-body';
  body.appendChild(numGrid('Overall', d.scores.overall.a, d.scores.overall.b,
    { betterWhen: d.scores.perfComparable ? 'higher' : null }));
  d.scores.categories.forEach((c) => {
    body.appendChild(numGrid(c.label + (c.unreliable ? ' *' : ''), c.a, c.b,
      { betterWhen: c.unreliable ? null : 'higher' }));
  });
  body.appendChild(numGrid('Failing checks', d.scores.counts.a.issues, d.scores.counts.b.issues, { betterWhen: 'lower' }));
  body.appendChild(numGrid('Warnings', d.scores.counts.a.warnings, d.scores.counts.b.warnings, { betterWhen: 'lower' }));

  if (!d.scores.perfComparable) {
    const note = document.createElement('p');
    note.className = 'sec-hint warn-hint';
    note.textContent = '* One side was captured in a background tab, which records no paint timings. ' +
      'The Performance score — and the overall score it feeds — is not a like-for-like number here.';
    body.appendChild(note);
  }
  sec.appendChild(body);
  host.appendChild(sec);
}

function sectionSummary(label, count) {
  const summary = document.createElement('summary');
  const text = document.createElement('span');
  text.textContent = label;
  summary.appendChild(text);
  const badge = document.createElement('span');
  badge.className = 'sec-count' + (count ? '' : ' zero');
  badge.textContent = count ? count + (count === 1 ? ' change' : ' changes') : 'identical';
  summary.appendChild(badge);
  return summary;
}

function renderSections() {
  const d = state.diff;
  const host = el('sectionHost');
  host.innerHTML = '';

  const nav = el('jumpNav');
  nav.innerHTML = '';

  d.sections.forEach((section) => {
    const rows = section.rows.filter((row) => rowVisible(row, section));
    if (!rows.length && state.diffOnly) return;

    const link = document.createElement('a');
    link.href = '#sec-' + section.id;
    link.className = section.changed ? '' : 'clean';
    link.textContent = section.label;
    if (section.changed) {
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = section.changed;
      link.appendChild(n);
    }
    nav.appendChild(link);

    const sec = document.createElement('details');
    sec.className = 'sec';
    sec.id = 'sec-' + section.id;
    sec.open = section.changed > 0;
    sec.appendChild(sectionSummary(section.label, section.changed));

    if (section.hint) {
      const hint = document.createElement('div');
      hint.className = 'sec-hint' + (section.unreliable ? ' warn-hint' : '');
      hint.textContent = section.hint;
      sec.appendChild(hint);
    }

    const body = document.createElement('div');
    body.className = 'sec-body';
    if (!rows.length) {
      const note = document.createElement('p');
      note.className = 'empty-note';
      note.textContent = state.filter ? 'Nothing matches that filter in this section.' : 'No differences in this section.';
      body.appendChild(note);
    } else {
      rows.forEach((row) => body.appendChild(renderRow(row)));
    }
    sec.appendChild(body);
    host.appendChild(sec);
  });
}

function rowVisible(row, section) {
  if (state.filter) {
    const haystack = [row.label, row.a, row.b, section.label].filter(Boolean).join(' ').toLowerCase();
    if (!haystack.includes(state.filter)) return false;
  }
  if (!state.diffOnly) return true;
  return row.status !== 'same';
}

function renderRow(row) {
  switch (row.kind) {
    case 'num': return numGrid(row.label, row.a, row.b, row);
    case 'seq': return seqRow(row);
    case 'set': return setRow(row);
    case 'check': return checkRow(row);
    case 'text': return textRow(row);
    default: return valueRow(row);
  }
}

const STATUS_LABEL = { changed: 'changed', 'a-only': 'A only', 'b-only': 'B only', same: 'identical' };

function rowHead(row, extraNote) {
  const head = document.createElement('div');
  head.className = 'row-head';

  const label = document.createElement('span');
  label.className = 'row-label';
  label.textContent = row.label;
  head.appendChild(label);

  const tag = document.createElement('span');
  tag.className = 'row-tag tag-' + row.status;
  tag.textContent = STATUS_LABEL[row.status] || row.status;
  head.appendChild(tag);

  const note = extraNote || row.note || row.ideal;
  if (note) {
    const n = document.createElement('span');
    n.className = 'row-note';
    n.textContent = note;
    head.appendChild(n);
  }
  return head;
}

function cell(side, value, lengthNote) {
  const div = document.createElement('div');
  div.className = 'cell cell-' + side;

  const tag = document.createElement('span');
  tag.className = 'cell-tag';
  tag.textContent = side.toUpperCase();
  div.appendChild(tag);

  if (value === null || value === undefined) {
    const miss = document.createElement('span');
    miss.className = 'missing';
    miss.textContent = '— not present';
    div.appendChild(miss);
  } else {
    div.appendChild(document.createTextNode(value));
  }

  if (lengthNote) {
    const len = document.createElement('span');
    len.className = 'cell-len';
    len.textContent = lengthNote;
    div.appendChild(len);
  }
  return div;
}

function valueRow(row) {
  const wrap = document.createElement('div');
  wrap.className = 'row';
  wrap.appendChild(rowHead(row));

  const sbs = document.createElement('div');
  sbs.className = 'sbs';
  sbs.appendChild(cell('a', row.a));
  sbs.appendChild(cell('b', row.b));
  wrap.appendChild(sbs);

  if (row.preview === 'image' && (row.a || row.b)) {
    const pair = document.createElement('div');
    pair.className = 'img-pair';
    [row.a, row.b].forEach((src) => {
      if (!src) return;
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = '';
      img.src = src;
      pair.appendChild(img);
    });
    wrap.appendChild(pair);
  }
  return wrap;
}

function textRow(row) {
  const wrap = document.createElement('div');
  wrap.className = 'row';
  const lenNote = (row.lenA || row.lenB)
    ? `${row.lenA} → ${row.lenB} chars`
    : null;
  wrap.appendChild(rowHead(row, row.ideal ? `${lenNote || ''}${lenNote ? '  ·  ' : ''}ideal ${row.ideal}` : lenNote));

  const sbs = document.createElement('div');
  sbs.className = 'sbs';
  sbs.appendChild(cell('a', row.a, row.a === null ? null : row.lenA + ' chars'));
  sbs.appendChild(cell('b', row.b, row.b === null ? null : row.lenB + ' chars'));
  wrap.appendChild(sbs);

  if (row.ops && row.ops.length) {
    const diff = document.createElement('div');
    diff.className = 'inline-diff';
    row.ops.forEach((op) => {
      if (op.type === 'eq') { diff.appendChild(document.createTextNode(op.text)); return; }
      const span = document.createElement('span');
      span.className = op.type === 'ins' ? 'ins' : 'del';
      span.textContent = op.text;
      diff.appendChild(span);
    });
    wrap.appendChild(diff);
  }
  return wrap;
}

function numGrid(label, a, b, opts) {
  const o = opts || {};
  const grid = document.createElement('div');
  grid.className = 'num-grid';

  const l = document.createElement('span');
  l.className = 'nlabel';
  l.textContent = label;
  grid.appendChild(l);

  [a, b].forEach((v) => {
    const span = document.createElement('span');
    span.className = 'nval';
    span.textContent = (v === null || v === undefined) ? '—' : formatNum(v) + (o.unit || '');
    grid.appendChild(span);
  });

  const delta = (a === null || a === undefined || b === null || b === undefined) ? null : b - a;
  const d = document.createElement('span');
  d.className = 'ndelta ' + deltaClass(delta, o.betterWhen);
  d.textContent = delta === null ? '' : delta === 0 ? '—' : (delta > 0 ? '▲ ' : '▼ ') + formatNum(Math.abs(delta)) + (o.unit || '');
  grid.appendChild(d);

  return grid;
}

function deltaClass(delta, betterWhen) {
  if (delta === null || delta === 0 || !betterWhen) return 'flat';
  const better = betterWhen === 'higher' ? delta > 0 : delta < 0;
  return better ? 'good' : 'bad';
}

function formatNum(n) {
  if (typeof n !== 'number') return String(n);
  if (Math.abs(n) >= 10000) return n.toLocaleString();
  return String(Math.round(n * 1000) / 1000);
}

// Sequence rows can be hundreds of lines where only a handful changed, so
// unchanged runs are collapsed down to a little context on each side.
const SEQ_CONTEXT = 2;

function seqRow(row) {
  const wrap = document.createElement('div');
  wrap.className = 'row';
  wrap.appendChild(rowHead(row, row.changedCount
    ? `${row.ops.filter((o) => o.type === 'ins').length} added · ${row.ops.filter((o) => o.type === 'del').length} removed`
    : null));

  const box = document.createElement('div');
  box.className = 'seq';

  const keep = new Set();
  row.ops.forEach((op, i) => {
    if (op.type === 'eq') return;
    for (let j = Math.max(0, i - SEQ_CONTEXT); j <= Math.min(row.ops.length - 1, i + SEQ_CONTEXT); j++) keep.add(j);
  });

  let skipped = 0;
  const flushGap = () => {
    if (!skipped) return;
    const gap = document.createElement('div');
    gap.className = 'seq-gap';
    gap.textContent = `… ${skipped} unchanged ${skipped === 1 ? 'line' : 'lines'} …`;
    box.appendChild(gap);
    skipped = 0;
  };

  row.ops.forEach((op, i) => {
    if (state.diffOnly && !keep.has(i)) { skipped++; return; }
    flushGap();
    box.appendChild(seqLine(op, row.render));
  });
  flushGap();

  if (!box.childNodes.length) {
    const note = document.createElement('p');
    note.className = 'empty-note';
    note.textContent = 'Identical on both pages.';
    wrap.appendChild(note);
  } else {
    wrap.appendChild(box);
  }
  return wrap;
}

function seqLine(op, render) {
  const item = op.type === 'ins' ? op.b : op.a;
  const line = document.createElement('div');
  line.className = 'seq-line ' + op.type;

  const sigil = document.createElement('span');
  sigil.className = 'sigil';
  sigil.textContent = op.type === 'ins' ? '+' : op.type === 'del' ? '−' : ' ';
  line.appendChild(sigil);

  if (render === 'heading') {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = 'H' + item.level;
    line.appendChild(tag);
    line.appendChild(document.createTextNode(item.text));
  } else if (render === 'textblock') {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = '<' + item.tag + '>';
    line.appendChild(tag);
    line.appendChild(document.createTextNode(item.text));
  } else if (render === 'jsonline') {
    line.appendChild(document.createTextNode(item.line));
  } else {
    line.appendChild(document.createTextNode(String(item)));
  }
  return line;
}

function setRow(row) {
  const wrap = document.createElement('div');
  wrap.className = 'row';
  wrap.appendChild(rowHead(row, `${row.countA} → ${row.countB}`));

  if (!row.items.length) {
    const note = document.createElement('p');
    note.className = 'empty-note';
    note.textContent = 'Same set on both pages.';
    wrap.appendChild(note);
    return wrap;
  }

  const list = document.createElement('ul');
  list.className = 'set-list';
  row.items.forEach((item) => {
    const li = document.createElement('li');
    li.className = item.status;

    const sigil = document.createElement('span');
    sigil.className = 'sigil';
    sigil.textContent = item.status === 'a-only' ? '−' : item.status === 'b-only' ? '+' : '~';
    li.appendChild(sigil);

    const key = document.createElement('span');
    key.className = 'skey';
    key.textContent = item.key;
    li.appendChild(key);

    const val = document.createElement('span');
    val.className = 'sval';
    if (item.status === 'changed') val.textContent = `${item.a || '(empty)'} → ${item.b || '(empty)'}`;
    else val.textContent = (item.status === 'a-only' ? item.a : item.b) || '';
    li.appendChild(val);

    list.appendChild(li);
  });
  wrap.appendChild(list);
  return wrap;
}

function checkRow(row) {
  const wrap = document.createElement('div');
  wrap.className = 'check-row';

  const left = document.createElement('div');
  const label = document.createElement('div');
  label.className = 'cr-label';
  label.textContent = row.label;
  const cat = document.createElement('span');
  cat.className = 'cr-cat';
  cat.textContent = '  ' + row.category;
  label.appendChild(cat);
  left.appendChild(label);

  const detail = document.createElement('div');
  detail.className = 'cr-detail';
  detail.textContent = `A: ${row.detailA}`;
  left.appendChild(detail);
  const detailB = document.createElement('div');
  detailB.className = 'cr-detail';
  detailB.textContent = `B: ${row.detailB}`;
  left.appendChild(detailB);
  wrap.appendChild(left);

  const move = document.createElement('div');
  move.className = 'cr-move';
  const from = document.createElement('span');
  from.className = 'st-' + row.a;
  from.textContent = row.a;
  const to = document.createElement('span');
  to.className = 'st-' + row.b;
  to.textContent = row.b;
  move.append(from, document.createTextNode(' → '), to);
  wrap.appendChild(move);

  return wrap;
}

// ---------------------------------------------------------------------------
// Export menu
// ---------------------------------------------------------------------------

const EXPORTERS = {
  pdf: exportDiffPdf,
  csv: exportDiffCsv,
  json: exportDiffJson,
  md: exportDiffMarkdown,
};

function closeExportMenu() {
  el('exportPop').classList.add('hidden');
  el('exportBtn').setAttribute('aria-expanded', 'false');
}

function toggleExportMenu() {
  const open = el('exportPop').classList.toggle('hidden') === false;
  el('exportBtn').setAttribute('aria-expanded', String(open));
  if (open) el('exportPop').querySelector('button').focus();
}

function initExportMenu() {
  el('exportBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleExportMenu();
  });

  el('exportPop').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-export]');
    if (!btn || !state.diff) return;
    closeExportMenu();
    EXPORTERS[btn.dataset.export](state.diff);
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#exportWrap')) closeExportMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeExportMenu();
    el('exportBtn').focus();
  });
}
