// Diff engine: turns two snapshots into a renderable comparison model.
//
// Everything here is a pure function of its inputs — no DOM, no storage, no
// network — so the compare view can re-render (filter, swap sides, export)
// without recomputing anything.

// ---------------------------------------------------------------------------
// Sequence diff
// ---------------------------------------------------------------------------

// Longest-common-subsequence diff over two arrays, returning a flat op list.
// Used for heading outlines, body copy and JSON-LD, where an inserted item
// should read as one insertion rather than shifting everything after it.
function scorlyLcsDiff(a, b, keyFn) {
  const key = keyFn || ((x) => String(x));
  const ka = a.map(key);
  const kb = b.map(key);
  const n = ka.length;
  const m = kb.length;

  // Trim the matching head and tail first — for two captures of the same page
  // this usually reduces the DP table to almost nothing.
  let head = 0;
  while (head < n && head < m && ka[head] === kb[head]) head++;
  let tail = 0;
  while (tail < n - head && tail < m - head && ka[n - 1 - tail] === kb[m - 1 - tail]) tail++;

  const ops = [];
  for (let i = 0; i < head; i++) ops.push({ type: 'eq', a: a[i], b: b[i] });

  const midA = a.slice(head, n - tail);
  const midB = b.slice(head, m - tail);
  const mka = ka.slice(head, n - tail);
  const mkb = kb.slice(head, m - tail);
  const p = mka.length;
  const q = mkb.length;

  if (p && q) {
    const width = q + 1;
    const table = new Int32Array((p + 1) * width);
    for (let i = p - 1; i >= 0; i--) {
      for (let j = q - 1; j >= 0; j--) {
        table[i * width + j] = mka[i] === mkb[j]
          ? table[(i + 1) * width + (j + 1)] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + (j + 1)]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < p && j < q) {
      if (mka[i] === mkb[j]) {
        ops.push({ type: 'eq', a: midA[i], b: midB[j] });
        i++; j++;
      } else if (table[(i + 1) * width + j] >= table[i * width + (j + 1)]) {
        ops.push({ type: 'del', a: midA[i] });
        i++;
      } else {
        ops.push({ type: 'ins', b: midB[j] });
        j++;
      }
    }
    while (i < p) { ops.push({ type: 'del', a: midA[i] }); i++; }
    while (j < q) { ops.push({ type: 'ins', b: midB[j] }); j++; }
  } else {
    midA.forEach((item) => ops.push({ type: 'del', a: item }));
    midB.forEach((item) => ops.push({ type: 'ins', b: item }));
  }

  for (let t = tail; t > 0; t--) ops.push({ type: 'eq', a: a[n - t], b: b[m - t] });
  return ops;
}

// Word-level diff of two strings. "These two 155-character descriptions
// differ" is useless on its own; this shows that they differ by one word.
function scorlyWordDiff(a, b) {
  const tokenize = (s) => (s || '').split(/(\s+)/).filter((t) => t !== '');
  const ta = tokenize(a);
  const tb = tokenize(b);
  const ops = scorlyLcsDiff(ta, tb, (t) => t);

  // Collapse runs of the same type so the renderer emits one span per run.
  const out = [];
  ops.forEach((op) => {
    const text = op.type === 'ins' ? op.b : op.a;
    const last = out[out.length - 1];
    if (last && last.type === op.type) last.text += text;
    else out.push({ type: op.type, text });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Row builders
// ---------------------------------------------------------------------------

function scorlyNorm(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number') return String(v);
  const s = String(v).trim();
  return s === '' ? null : s;
}

function scorlyRowStatus(a, b) {
  if (a === null && b === null) return 'same';
  if (a === null) return 'b-only';
  if (b === null) return 'a-only';
  return a === b ? 'same' : 'changed';
}

function scorlyValueRow(label, a, b, opts) {
  const na = scorlyNorm(a);
  const nb = scorlyNorm(b);
  return Object.assign({ kind: 'value', label, a: na, b: nb, status: scorlyRowStatus(na, nb) }, opts || {});
}

// Long free text: same as a value row, but carries a word-level diff and a
// character count so title/description length changes are visible.
function scorlyTextRow(label, a, b, opts) {
  const row = scorlyValueRow(label, a, b, opts);
  row.kind = 'text';
  row.lenA = (scorlyNorm(a) || '').length;
  row.lenB = (scorlyNorm(b) || '').length;
  if (row.status === 'changed') row.ops = scorlyWordDiff(row.a, row.b);
  return row;
}

function scorlyNumRow(label, a, b, opts) {
  const o = opts || {};
  const na = (a === null || a === undefined || Number.isNaN(a)) ? null : Number(a);
  const nb = (b === null || b === undefined || Number.isNaN(b)) ? null : Number(b);
  return {
    kind: 'num',
    label,
    a: na,
    b: nb,
    delta: (na === null || nb === null) ? null : nb - na,
    status: (na === null && nb === null) ? 'same'
      : (na === null) ? 'b-only'
        : (nb === null) ? 'a-only'
          : (na === nb ? 'same' : 'changed'),
    unit: o.unit || '',
    betterWhen: o.betterWhen || null,
    note: o.note || null,
    vital: o.vital || null,
  };
}

// Set diff keyed on an identity (href, src, hreflang…), with in-place changes
// detected via a comparable value. Order is ignored, which is what you want
// for links and images: moving a link is not a content change.
function scorlySetRow(label, listA, listB, keyFn, valueFn, opts) {
  const mapA = new Map();
  const mapB = new Map();
  (listA || []).forEach((item) => { if (!mapA.has(keyFn(item))) mapA.set(keyFn(item), item); });
  (listB || []).forEach((item) => { if (!mapB.has(keyFn(item))) mapB.set(keyFn(item), item); });

  const items = [];
  mapA.forEach((item, key) => {
    if (!mapB.has(key)) {
      items.push({ key, status: 'a-only', a: valueFn(item), b: null });
      return;
    }
    const va = valueFn(item);
    const vb = valueFn(mapB.get(key));
    if (va !== vb) items.push({ key, status: 'changed', a: va, b: vb, ops: scorlyWordDiff(va, vb) });
  });
  mapB.forEach((item, key) => {
    if (!mapA.has(key)) items.push({ key, status: 'b-only', a: null, b: valueFn(item) });
  });

  const order = { 'a-only': 0, 'b-only': 1, changed: 2 };
  items.sort((x, y) => (order[x.status] - order[y.status]) || x.key.localeCompare(y.key));

  return Object.assign({
    kind: 'set',
    label,
    items,
    countA: mapA.size,
    countB: mapB.size,
    status: items.length ? 'changed' : 'same',
  }, opts || {});
}

function scorlySeqRow(label, listA, listB, keyFn, renderFn, opts) {
  const ops = scorlyLcsDiff(listA || [], listB || [], keyFn);
  const changedOps = ops.filter((o) => o.type !== 'eq').length;
  return Object.assign({
    kind: 'seq',
    label,
    ops,
    render: renderFn,
    status: changedOps ? 'changed' : 'same',
    changedCount: changedOps,
  }, opts || {});
}

// Every og:/twitter: tag present on either page, so a tag you only set on one
// side cannot slip through unnoticed.
function scorlyRawMetaRows(rawA, rawB, skipKeys) {
  const skip = new Set(skipKeys || []);
  const keys = Array.from(new Set(Object.keys(rawA || {}).concat(Object.keys(rawB || {}))))
    .filter((k) => !skip.has(k))
    .sort();
  return keys.map((k) => scorlyTextRow(k, (rawA || {})[k], (rawB || {})[k]));
}

function scorlyPrettyJsonLines(value) {
  if (value === null || value === undefined) return [];
  try {
    return JSON.stringify(value, Object.keys(flattenKeys(value)).sort(), 2).split('\n');
  } catch (e) {
    return String(value).split('\n');
  }

  // JSON.stringify's replacer-array form sorts keys for us, which keeps the
  // diff from flagging a pure key-order change as a content change.
  function flattenKeys(node, acc) {
    const out = acc || {};
    if (Array.isArray(node)) node.forEach((n) => flattenKeys(n, out));
    else if (node && typeof node === 'object') {
      Object.keys(node).forEach((k) => { out[k] = true; flattenKeys(node[k], out); });
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Section assembly
// ---------------------------------------------------------------------------

const SCORLY_CATEGORY_LABELS = {
  technical: 'Technical',
  content: 'Content',
  perf: 'Performance',
  schema: 'Structured data',
  security: 'Security',
  mobile: 'Mobile',
  aiSeo: 'AI SEO',
  eeat: 'E-E-A-T',
};

const SCORLY_CHECK_STATUS_RANK = { fail: 0, warn: 1, pass: 2 };

function scorlyBuildDiff(snapA, snapB, scoreA, scoreB) {
  const a = snapA.data;
  const b = snapB.data;

  // Paint timings are only recorded in a tab the browser actually renders, so
  // a background capture has no LCP/CLS and a lower resource count. Comparing
  // them against a foreground capture would invent a regression — in the
  // timings themselves, in every scoring check derived from them, and in the
  // Performance category score those checks roll up into.
  const perfComparable = snapA.origin !== 'background' && snapB.origin !== 'background';

  // ---- Scores ----
  // The Performance category is built from paint timings, so when one side
  // was captured in a background tab its score — and the overall score it
  // feeds — is not a like-for-like number.
  const categories = Object.keys(SCORLY_CATEGORY_LABELS).map((key) => ({
    key,
    label: SCORLY_CATEGORY_LABELS[key],
    a: scoreA.categoryScores[key],
    b: scoreB.categoryScores[key],
    delta: scoreB.categoryScores[key] - scoreA.categoryScores[key],
    unreliable: key === 'perf' && !perfComparable,
  }));

  const scores = {
    overall: {
      a: scoreA.overallScore,
      b: scoreB.overallScore,
      delta: scoreB.overallScore - scoreA.overallScore,
      unreliable: !perfComparable,
    },
    categories,
    perfComparable,
    counts: {
      a: scoreA.counts,
      b: scoreB.counts,
    },
  };

  // ---- Checks that changed verdict ----
  const checkMapA = new Map(scoreA.allChecks.map((c) => [c.category + '/' + c.id, c]));
  const checkMapB = new Map(scoreB.allChecks.map((c) => [c.category + '/' + c.id, c]));
  const checkRows = [];
  checkMapA.forEach((ca, key) => {
    const cb = checkMapB.get(key);
    if (!cb || ca.status === cb.status) return;
    if (ca.category === 'perf' && !perfComparable) return;
    checkRows.push({
      kind: 'check',
      label: ca.label,
      category: SCORLY_CATEGORY_LABELS[ca.category] || ca.category,
      a: ca.status,
      b: cb.status,
      detailA: ca.detail,
      detailB: cb.detail,
      // Did B get better or worse than A on this check?
      direction: SCORLY_CHECK_STATUS_RANK[cb.status] > SCORLY_CHECK_STATUS_RANK[ca.status] ? 'better' : 'worse',
      status: 'changed',
    });
  });
  checkRows.sort((x, y) => (x.direction === y.direction ? 0 : x.direction === 'worse' ? -1 : 1));

  // ---- Field sections ----
  const sections = [];

  sections.push({
    id: 'checks',
    label: 'Changed checks',
    rows: checkRows,
    hint: 'Scoring checks that reach a different verdict on each page.' +
      (perfComparable ? '' : ' Performance checks are left out — one side was captured in a background tab, where paint timings are never recorded.'),
  });

  sections.push({
    id: 'meta',
    label: 'Meta',
    rows: [
      scorlyTextRow('Title', a.title && a.title.text, b.title && b.title.text, { ideal: '10–60 chars' }),
      scorlyNumRow('Title width', a.title && a.title.pixels, b.title && b.title.pixels, { unit: ' px', betterWhen: null, note: 'Google truncates ≈580px' }),
      scorlyTextRow('Meta description', a.metaDescription && a.metaDescription.text, b.metaDescription && b.metaDescription.text, { ideal: '50–160 chars' }),
      scorlyNumRow('Description width', a.metaDescription && a.metaDescription.pixels, b.metaDescription && b.metaDescription.pixels, { unit: ' px', betterWhen: null, note: 'Google truncates ≈920px (desktop)' }),
      scorlyValueRow('Canonical', a.canonical, b.canonical),
      scorlyValueRow('Robots meta', a.robotsMeta, b.robotsMeta),
      scorlyValueRow('Viewport', a.viewport, b.viewport),
      scorlyValueRow('Language', a.lang, b.lang),
      scorlyValueRow('Charset', a.charset, b.charset),
      scorlyValueRow('DOCTYPE', a.hasDoctype, b.hasDoctype),
      scorlyValueRow('Favicon', a.favicon, b.favicon),
      scorlySetRow('hreflang', a.hreflangs, b.hreflangs, (h) => h.lang || '', (h) => h.href || ''),
    ],
  });

  sections.push({
    id: 'social',
    label: 'Open Graph & Twitter',
    rows: [
      scorlyTextRow('og:title', a.og && a.og.title, b.og && b.og.title),
      scorlyTextRow('og:description', a.og && a.og.description, b.og && b.og.description),
      scorlyValueRow('og:image', a.og && a.og.image, b.og && b.og.image, { preview: 'image' }),
      scorlyValueRow('og:url', a.og && a.og.url, b.og && b.og.url),
      scorlyValueRow('og:type', a.og && a.og.type, b.og && b.og.type),
      scorlyValueRow('og:site_name', a.og && a.og.siteName, b.og && b.og.siteName),
      scorlyValueRow('twitter:card', a.twitter && a.twitter.card, b.twitter && b.twitter.card),
      scorlyTextRow('twitter:title', a.twitter && a.twitter.title, b.twitter && b.twitter.title),
      scorlyTextRow('twitter:description', a.twitter && a.twitter.description, b.twitter && b.twitter.description),
      scorlyValueRow('twitter:image', a.twitter && a.twitter.image, b.twitter && b.twitter.image, { preview: 'image' }),
      scorlyValueRow('twitter:site', a.twitter && a.twitter.site, b.twitter && b.twitter.site),
    ].concat(
      scorlyRawMetaRows(a.og && a.og.raw, b.og && b.og.raw,
        ['og:title', 'og:description', 'og:image', 'og:url', 'og:type', 'og:site_name']),
      scorlyRawMetaRows(a.twitter && a.twitter.raw, b.twitter && b.twitter.raw,
        ['twitter:card', 'twitter:title', 'twitter:description', 'twitter:image', 'twitter:site']),
    ),
    hint: 'Includes every og: and twitter: tag found on either page.',
  });

  const headingKey = (h) => 'h' + h.level + '|' + h.text;
  sections.push({
    id: 'headings',
    label: 'Heading outline',
    rows: [
      scorlySeqRow('Outline', a.headings && a.headings.list, b.headings && b.headings.list, headingKey, 'heading'),
      scorlyNumRow('H1 count', a.headings && a.headings.counts.h1, b.headings && b.headings.counts.h1),
      scorlyNumRow('H2 count', a.headings && a.headings.counts.h2, b.headings && b.headings.counts.h2),
      scorlyNumRow('H3 count', a.headings && a.headings.counts.h3, b.headings && b.headings.counts.h3),
    ],
  });

  sections.push({
    id: 'text',
    label: 'Page text',
    rows: [
      scorlySeqRow('Copy blocks', a.textBlocks, b.textBlocks, (t) => t.tag + '|' + t.text, 'textblock'),
    ],
    hint: 'Every paragraph, list item, table cell, button and label, in document order.',
  });

  sections.push({
    id: 'content',
    label: 'Content metrics',
    rows: [
      scorlyNumRow('Word count', a.content && a.content.wordCount, b.content && b.content.wordCount, { unit: ' words' }),
      scorlyNumRow('Paragraphs', a.content && a.content.paragraphCount, b.content && b.content.paragraphCount),
      scorlyNumRow('Sentences', a.content && a.content.sentenceCount, b.content && b.content.sentenceCount),
      scorlyNumRow('Avg sentence length', a.content && a.content.avgSentenceLength, b.content && b.content.avgSentenceLength, { unit: ' words', betterWhen: 'lower' }),
      scorlyNumRow('Readability (Flesch)', a.content && a.content.readability, b.content && b.content.readability, { betterWhen: 'higher' }),
      scorlyNumRow('Read time', a.content && a.content.readTimeMin, b.content && b.content.readTimeMin, { unit: ' min' }),
      scorlySetRow('Top keywords', a.content && a.content.topKeywords, b.content && b.content.topKeywords,
        (k) => k.word, (k) => k.count + '× (' + k.pct + '%)'),
      scorlyTextRow('First paragraph', a.firstParagraph, b.firstParagraph),
    ],
  });

  sections.push({
    id: 'links',
    label: 'Links',
    rows: [
      scorlyNumRow('Total links', a.links && a.links.total, b.links && b.links.total),
      scorlyNumRow('Internal', a.links && a.links.internal, b.links && b.links.internal),
      scorlyNumRow('External', a.links && a.links.external, b.links && b.links.external),
      scorlyNumRow('Nofollow', a.links && a.links.nofollow, b.links && b.links.nofollow),
      scorlyNumRow('Missing anchor text', a.links && a.links.missingAnchorText, b.links && b.links.missingAnchorText, { betterWhen: 'lower' }),
      scorlyNumRow('Broken internal links', a.linkCheck && a.linkCheck.broken, b.linkCheck && b.linkCheck.broken, { betterWhen: 'lower' }),
      scorlyNumRow('Redirected internal links', a.linkCheck && a.linkCheck.redirected, b.linkCheck && b.linkCheck.redirected, { betterWhen: 'lower' }),
      scorlySetRow('Link target status', a.linkCheck && a.linkCheck.list, b.linkCheck && b.linkCheck.list,
        (r) => scorlyPathOf(r.url), scorlyLinkStatusFacts),
      scorlySetRow('Internal links', a.links && a.links.internalList, b.links && b.links.internalList,
        (l) => scorlyPathOf(l.href), (l) => l.text + (l.nofollow ? ' [nofollow]' : '')),
      scorlySetRow('External links', a.links && a.links.externalList, b.links && b.links.externalList,
        (l) => l.href, (l) => l.text + (l.nofollow ? ' [nofollow]' : '')),
    ],
    hint: 'Internal links are matched on path, so the same link on localhost and live is not reported as a change.',
  });

  sections.push({
    id: 'images',
    label: 'Images',
    rows: [
      scorlyNumRow('Images', a.images && a.images.total, b.images && b.images.total),
      scorlyNumRow('Missing alt text', a.images && a.images.missingAlt, b.images && b.images.missingAlt, { betterWhen: 'lower' }),
      scorlyNumRow('Oversized (≥2× rendered)', a.images && a.images.oversized, b.images && b.images.oversized, { betterWhen: 'lower' }),
      scorlyNumRow('Legacy format (PNG/JPG/GIF)', a.images && a.images.legacyFormat, b.images && b.images.legacyFormat, { betterWhen: 'lower' }),
      scorlyNumRow('Missing width/height', a.images && a.images.missingDimensions, b.images && b.images.missingDimensions, { betterWhen: 'lower' }),
      scorlyNumRow('Lazy-loaded', a.images && a.images.lazyLoaded, b.images && b.images.lazyLoaded),
      scorlySetRow('Alt text', a.images && a.images.list, b.images && b.images.list,
        (i) => scorlyPathOf(i.src), (i) => i.alt || '(no alt)'),
      scorlySetRow('Image details', a.images && a.images.list, b.images && b.images.list,
        (i) => scorlyPathOf(i.src), scorlyImageFacts,
        { note: 'intrinsic→rendered size · format · loading attrs' }),
    ],
  });

  sections.push({
    id: 'schema',
    label: 'Structured data',
    rows: [
      scorlySetRow('Schema types', (a.jsonLdTypes || []).map((t) => ({ t })), (b.jsonLdTypes || []).map((t) => ({ t })),
        (x) => x.t, () => ''),
      scorlySetRow('Validation issues',
        scorlyValidateStructuredData(a.jsonLd || []), scorlyValidateStructuredData(b.jsonLd || []),
        (i) => `[${i.severity}] ${i.type}: ${i.message}`, () => '',
        { note: 'checked against common Google rich-result requirements' }),
      scorlySeqRow('JSON-LD', scorlyPrettyJsonLines(a.jsonLd).map((line, i) => ({ line, i })),
        scorlyPrettyJsonLines(b.jsonLd).map((line, i) => ({ line, i })), (x) => x.line, 'jsonline'),
    ],
  });

  sections.push({
    id: 'tech',
    label: 'Technical',
    rows: [
      scorlyValueRow('URL', a.url, b.url),
      scorlyValueRow('Protocol', a.protocol, b.protocol),
      scorlyValueRow('robots.txt reachable', a.robotsTxt, b.robotsTxt),
      scorlyValueRow('sitemap.xml reachable', a.sitemapXml, b.sitemapXml),
      scorlyValueRow('Favicon loads', a.faviconOk, b.faviconOk),
      scorlyNumRow('HTML size', a.htmlSize, b.htmlSize, { unit: ' bytes', betterWhen: 'lower' }),
      scorlyNumRow('Semantic landmarks', a.aiSeo && a.aiSeo.semanticLandmarks, b.aiSeo && b.aiSeo.semanticLandmarks, { betterWhen: 'higher' }),
      scorlyValueRow('Author byline', a.eeat && a.eeat.hasAuthorByline, b.eeat && b.eeat.hasAuthorByline),
      scorlyValueRow('Publish date', a.eeat && a.eeat.hasPublishDate, b.eeat && b.eeat.hasPublishDate),
      scorlyValueRow('About link', a.eeat && a.eeat.hasAboutLink, b.eeat && b.eeat.hasAboutLink),
      scorlyValueRow('Contact link', a.eeat && a.eeat.hasContactLink, b.eeat && b.eeat.hasContactLink),
      scorlyValueRow('Privacy link', a.eeat && a.eeat.hasPrivacyLink, b.eeat && b.eeat.hasPrivacyLink),
      scorlyValueRow('HTTPS', a.security && a.security.https, b.security && b.security.https),
      scorlyValueRow('Secure context', a.security && a.security.isSecureContext, b.security && b.security.isSecureContext),
      scorlyNumRow('Mixed content', a.security && a.security.mixedContentCount, b.security && b.security.mixedContentCount, { betterWhen: 'lower' }),
    ],
  });

  sections.push({
    id: 'perf',
    label: 'Performance',
    rows: [
      scorlyNumRow('TTFB', a.perf && a.perf.ttfb, b.perf && b.perf.ttfb, { unit: ' ms', betterWhen: 'lower', vital: 'ttfb' }),
      scorlyNumRow('FCP', a.perf && a.perf.fcp, b.perf && b.perf.fcp, { unit: ' ms', betterWhen: 'lower', vital: 'fcp' }),
      scorlyNumRow('LCP', a.perf && a.perf.lcp, b.perf && b.perf.lcp, { unit: ' ms', betterWhen: 'lower', vital: 'lcp' }),
      scorlyNumRow('CLS', a.perf && a.perf.cls, b.perf && b.perf.cls, { betterWhen: 'lower', vital: 'cls' }),
      scorlyNumRow('TBT (approx)', a.perf && a.perf.tbt, b.perf && b.perf.tbt, { unit: ' ms', betterWhen: 'lower', note: 'Chromium only', vital: 'tbt' }),
      scorlyNumRow('INP', a.perf && a.perf.inp, b.perf && b.perf.inp, { unit: ' ms', betterWhen: 'lower', note: 'needs an interaction before capture', vital: 'inp' }),
      scorlyNumRow('Render-blocking resources', a.perf && a.perf.renderBlockingCount, b.perf && b.perf.renderBlockingCount, { betterWhen: 'lower', note: 'Chromium only' }),
      scorlyNumRow('Requests', a.perf && a.perf.requestCount, b.perf && b.perf.requestCount, { betterWhen: 'lower' }),
      scorlyNumRow('Transfer size', a.perf && a.perf.transferSize, b.perf && b.perf.transferSize, { unit: ' bytes', betterWhen: 'lower' }),
      scorlyValueRow('Protocol', a.perf && a.perf.nextHopProtocol, b.perf && b.perf.nextHopProtocol),
    ].map((row) => (perfComparable ? row : Object.assign(row, { betterWhen: null }))),
    unreliable: !perfComparable,
    hint: perfComparable
      ? 'Both pages were measured in a visible tab, on your machine and connection.'
      : 'One side was captured in a background tab, where the browser never paints — LCP, CLS and request counts are not comparable. Re-capture both from a visible tab for a reliable read.',
  });

  sections.push({
    id: 'requests',
    label: 'Requests',
    rows: scorlyRequestTypeRows(a.resources, b.resources, perfComparable).concat([
      scorlyNumRow('Third-party origins',
        (a.resources && a.resources.length) ? scorlyThirdPartyOrigins(a).length : null,
        (b.resources && b.resources.length) ? scorlyThirdPartyOrigins(b).length : null,
        { betterWhen: perfComparable ? 'lower' : null }),
      scorlySetRow('Third-party origins', scorlyThirdPartyOrigins(a), scorlyThirdPartyOrigins(b),
        (o) => o.origin, (o) => `${o.count} req · ${Math.round(o.bytes / 102.4) / 10} KB`),
      scorlySetRow('Per-request', a.resources, b.resources,
        (r) => scorlyPathOf(r.url), scorlyRequestFacts),
    ]),
    unreliable: !perfComparable,
    hint: (perfComparable
      ? 'Every request the page made, matched on path: type · transferred size'
      : 'One side was captured in a background tab, which loads fewer resources — request differences here may be capture artifacts, not page changes. Matched on path: type · transferred size')
      + (scorlyHasBlockingInfo(a.resources) || scorlyHasBlockingInfo(b.resources) ? ' · render-blocking flag (Chromium).' : '.'),
  });

  // ---- Totals ----
  sections.forEach((section) => {
    section.changed = section.rows.reduce((n, row) => {
      if (row.status === 'same') return n;
      if (row.kind === 'set') return n + row.items.length;
      if (row.kind === 'seq') return n + row.changedCount;
      return n + 1;
    }, 0);
  });

  return {
    a: { label: snapA.label, url: snapA.url, capturedAt: snapA.capturedAt, origin: snapA.origin, isLocalhost: snapA.isLocalhost },
    b: { label: snapB.label, url: snapB.url, capturedAt: snapB.capturedAt, origin: snapB.origin, isLocalhost: snapB.isLocalhost },
    scores,
    sections,
    totalChanged: sections.reduce((n, s) => n + s.changed, 0),
  };
}

function scorlyFormatKb(bytes) {
  if (!bytes) return 'cache/0 KB';
  return (Math.round((bytes / 1024) * 10) / 10) + ' KB';
}

// Comparable value for one request. Duration is deliberately left out of the
// diff identity — it varies on every capture and would flag every request as
// "changed" — but it still reaches the popup waterfall and the exports.
function scorlyRequestFacts(r) {
  return r.type + ' · ' + scorlyFormatKb(r.transferSize) + (r.renderBlocking && r.type !== 'document' ? ' · render-blocking' : '');
}

function scorlyHasBlockingInfo(resources) {
  return (resources || []).some((r) => r.renderBlocking !== null && r.renderBlocking !== undefined && r.type !== 'document');
}

// One numeric row per resource type (bytes), so "B ships 212 KB more script"
// is visible before scanning the per-request list.
function scorlyRequestTypeRows(resA, resB, perfComparable) {
  const sum = (list) => {
    const out = {};
    (list || []).forEach((r) => { out[r.type] = (out[r.type] || 0) + (r.transferSize || 0); });
    return out;
  };
  const a = sum(resA);
  const b = sum(resB);
  const types = Array.from(new Set(Object.keys(a).concat(Object.keys(b)))).sort((x, y) => (b[y] || 0) + (a[y] || 0) - (b[x] || 0) - (a[x] || 0));
  return types.map((t) => scorlyNumRow(t + ' bytes',
    t in a ? a[t] : null, t in b ? b[t] : null,
    { unit: ' bytes', betterWhen: perfComparable ? 'lower' : null }));
}

// Third-party = any origin other than the page's own host, aggregated with
// request count and bytes so "B added a new tag-manager host" is one row.
function scorlyThirdPartyOrigins(data) {
  const origins = new Map();
  (data.resources || []).forEach((r) => {
    let u;
    try { u = new URL(r.url); } catch (e) { return; }
    if (u.hostname === data.hostname) return;
    const o = origins.get(u.origin) || { origin: u.origin, count: 0, bytes: 0 };
    o.count++;
    o.bytes += r.transferSize || 0;
    origins.set(u.origin, o);
  });
  return Array.from(origins.values());
}

function scorlyLinkStatusFacts(r) {
  if (r.skipped) return 'not checked (time budget)';
  if (r.error || r.status === null) return 'unreachable';
  let out = 'HTTP ' + r.status;
  if (r.redirectedTo) out += ' → ' + scorlyPathOf(r.redirectedTo);
  return out;
}

function scorlyImageFacts(i) {
  const parts = [];
  if (i.naturalW) {
    parts.push(i.naturalW + '×' + i.naturalH +
      (i.renderedW && (i.renderedW !== i.naturalW || i.renderedH !== i.naturalH) ? '→' + i.renderedW + '×' + i.renderedH : ''));
  }
  if (i.format) parts.push(i.format);
  if (i.loading) parts.push('loading=' + i.loading);
  if (i.fetchpriority) parts.push('fetchpriority=' + i.fetchpriority);
  if (i.hasExplicitSize === false) parts.push('no width/height attrs');
  if (i.oversized) parts.push('oversized');
  return parts.join(' · ') || '(no data — recapture with the current version)';
}

// Path-only identity, so http://localhost:3000/about and
// https://example.com/about count as the same link.
function scorlyPathOf(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch (e) {
    return String(url);
  }
}
