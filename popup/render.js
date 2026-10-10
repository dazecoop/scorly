// All DOM rendering for the popup. Depends on helpers being loaded after this
// (popup.js) only for data orchestration — this file is pure render functions.

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function truncate(str, n) {
  if (!str) return '';
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(1)} ${units[i]}`;
}

function scoreColor(score) {
  if (score >= 80) return 'var(--pass)';
  if (score >= 50) return 'var(--warn)';
  return 'var(--fail)';
}

// The inverse of scoreColor, for the two panels whose numbers mean risk
// rather than quality (AI copy likelihood, vibe-code confidence) so that red
// still reads as "problem" and green as "fine".
function riskColor(risk) {
  return scoreColor(100 - Math.max(0, Math.min(100, risk)));
}

function scoreLabel(score) {
  if (score >= 80) return 'Good SEO health';
  if (score >= 50) return 'Needs improvement';
  return 'Poor SEO health';
}

const CATEGORY_LABELS = {
  technical: 'Technical', content: 'Content', perf: 'Perf', schema: 'Schema',
  security: 'Security', mobile: 'Mobile', aiSeo: 'AI Visibility', eeat: 'E-E-A-T',
};

function statusIcon(status) {
  return status === 'pass' ? '✓' : status === 'warn' ? '!' : '✕';
}

function severityBadge(severity) {
  const map = { high: 'HIGH', med: 'MED', low: 'LOW' };
  return `<span class="sev-badge sev-${severity}">${map[severity] || 'LOW'}</span>`;
}

// ---- Shared "checklist" renderer used across detail tabs ----
function renderCheckList(checks) {
  if (!checks.length) return '<p class="empty-note">Nothing to show.</p>';
  return checks.map((c) => `
    <div class="check-row">
      <div class="check-icon ${c.status}">${statusIcon(c.status)}</div>
      <div class="check-body">
        <div class="check-label-row">
          <span class="check-label">${escapeHtml(c.label)}</span>
          <span class="status-pill status-${c.status}">${c.status.toUpperCase()}</span>
        </div>
        <div class="check-detail">${escapeHtml(c.detail)}</div>
      </div>
    </div>
  `).join('');
}

// ---- Issues / Warnings / Passed grouped list (matches reference tool style) ----
// opts.showCategory: prefix each row with which category/tab it came from (used on Overview,
// where checks from every tab are pooled together).
// opts.idPrefix: when set, group headings get stable ids (e.g. "overview-group-fail") so the
// Overview count tiles can scroll/link straight to them.
function renderGroupedChecks(checks, opts) {
  opts = opts || {};
  // Within each group, order by severity (high → med → low). The sort is
  // stable, so checks of equal severity keep their category/tab order.
  const SEV_RANK = { high: 0, med: 1, low: 2 };
  const bySeverity = (list) => list.slice().sort((a, b) => (SEV_RANK[a.severity] ?? 3) - (SEV_RANK[b.severity] ?? 3));
  const issues = bySeverity(checks.filter((c) => c.status === 'fail'));
  const warnings = bySeverity(checks.filter((c) => c.status === 'warn'));
  const passed = bySeverity(checks.filter((c) => c.status === 'pass'));

  function row(c) {
    return `
      <div class="group-row row-${c.status}">
        <div class="group-row-head">
          ${severityBadge(c.severity)}
          <span class="group-label">${escapeHtml(c.label)}</span>
          ${opts.showCategory ? `<span class="group-cat">${escapeHtml(CATEGORY_LABELS[c.category] || c.category)}</span>` : ''}
        </div>
        ${c.detail ? `<div class="group-detail">${escapeHtml(c.detail)}</div>` : ''}
      </div>`;
  }

  function idAttr(suffix) {
    return opts.idPrefix ? ` id="${opts.idPrefix}-${suffix}"` : '';
  }

  // "Ask your AI to fix these": copies a ready-made prompt (page context +
  // this list) to the clipboard. The checks ride along in a data attribute so
  // the click handler (popup.js) doesn't need to know which filtered subset
  // this particular list was rendered from.
  function aiFixButton(kind, checks) {
    const payload = escapeHtml(JSON.stringify(checks.map((c) => ({
      label: c.label, detail: c.detail, severity: c.severity, category: CATEGORY_LABELS[c.category] || c.category || null,
    }))));
    return `<div class="ai-fix-row">
      <button class="ai-fix-btn" data-aifix-kind="${kind}" data-aifix="${payload}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        Ask your AI to fix these
      </button>
      <span class="ai-fix-hint">Copies a ready-to-paste prompt — page details plus this list — for Claude, ChatGPT, Copilot or any AI assistant.</span>
    </div>`;
  }

  let html = '';
  html += `<div class="group-title"${idAttr('group-fail')}>✕ Issues (${issues.length})</div>`;
  html += issues.length ? issues.map(row).join('') + aiFixButton('issues', issues) : '<p class="empty-note">No issues here — nothing failed.</p>';
  html += `<div class="group-title"${idAttr('group-warn')}>! Warnings (${warnings.length})</div>`;
  html += warnings.length ? warnings.map(row).join('') + aiFixButton('warnings', warnings) : '<p class="empty-note">No warnings here.</p>';
  html += `<div class="group-title"${idAttr('group-pass')}>✓ Passed (${passed.length})</div>`;
  html += passed.length ? passed.map(row).join('') : '<p class="empty-note">Nothing passed here yet.</p>';
  return html;
}

function categoryScoreBox(score, label) {
  return `<div class="score-box"><div class="score-box-num" style="color:${scoreColor(score)}">${score}/100</div><div class="score-box-label">${escapeHtml(label)}</div></div>`;
}

// ===================== OVERVIEW =====================
// opts.pending: the in-page data is painted but the network checks are still
// running — the ring keeps spinning and the ticker in popup.js drives the
// number, so the score never looks locked-in before it actually is.
function renderOverview(data, scoreResult, opts) {
  const pending = !!(opts && opts.pending);
  const { overallScore, categoryScores, counts } = scoreResult;
  const svg = document.querySelector('#tab-overview .score-circle');
  const arc = el('scoreArc');
  svg.classList.toggle('score-pending-spin', pending);
  arc.classList.toggle('sk-arc', pending);
  el('scoreCaption').innerHTML = pending ? 'SCORE<br><span class="cap-sub">SO FAR</span>' : 'SCORE<br><span class="cap-sub">&nbsp;</span>';
  if (!pending) {
    const circumference = 326.7;
    const offset = circumference - (circumference * overallScore) / 100;
    arc.style.stroke = scoreColor(overallScore);
    requestAnimationFrame(() => { arc.style.strokeDashoffset = offset; });
    el('scoreNumber').textContent = overallScore;
    el('scoreNumber').style.color = scoreColor(overallScore);
    el('scoreChip').textContent = overallScore;
    el('scoreChip').style.background = scoreColor(overallScore);
  }

  el('issuesCount').textContent = counts.issues;
  el('warningsCount').textContent = counts.warnings;
  el('passedCount').textContent = counts.passed;

  // Technical is the one category still waiting on network checks
  // (robots.txt, sitemap, favicon, link targets) during a pending render —
  // its bar shimmers until the real score exists instead of showing a number
  // that is about to change.
  const PENDING_CATEGORIES = { technical: true };
  const barsHtml = Object.keys(CATEGORY_LABELS).map((key) => {
    const score = categoryScores[key];
    if (pending && PENDING_CATEGORIES[key]) {
      // Mirrors the bottom progress bar (popup.js updates this fill on the
      // same trickle), in a neutral loading color until the score locks in.
      return `
      <div class="bar-row">
        <div class="bar-label">${CATEGORY_LABELS[key]}</div>
        <div class="bar-track"><div class="bar-fill bar-fill-pending" id="techPendingFill" style="width:0%"></div></div>
        <div class="bar-value">…</div>
      </div>`;
    }
    return `
      <div class="bar-row">
        <div class="bar-label">${CATEGORY_LABELS[key]}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${score}%;background:${scoreColor(score)}"></div></div>
        <div class="bar-value">${score}</div>
      </div>`;
  }).join('');
  el('scoreBars').innerHTML = barsHtml;

  const og = data.og || {};
  const serpTitle = truncate(data.title.text || data.hostname, 65);
  const serpDesc = truncate(data.metaDescription.text || data.firstParagraph || 'No description available.', 160);
  el('serpPreview').innerHTML = `
    <div class="serp-url">${escapeHtml(data.hostname)}${escapeHtml(new URL(data.url).pathname !== '/' ? ' › ' + new URL(data.url).pathname.split('/').filter(Boolean).join(' › ') : '')}</div>
    <div class="serp-title">${escapeHtml(serpTitle)}</div>
    <div class="serp-desc">${escapeHtml(serpDesc)}</div>
  `;

  const stats = [
    ['Word count', data.content.wordCount.toLocaleString()],
    ['Page size', formatBytes(data.htmlSize)],
    ['Images', `${data.images.total} (${data.images.missingAlt} missing alt)`],
    ['Links', `${data.links.internal} internal / ${data.links.external} external`],
    ['Headings', `H1:${data.headings.counts.h1} H2:${data.headings.counts.h2} H3:${data.headings.counts.h3}`],
    ['Structured data', data.jsonLdTypes.join(', ') || 'None'],
  ];
  el('statGrid').innerHTML = stats.map(([label, value]) => `
    <div class="stat-card">
      <div class="stat-label">${escapeHtml(label)}</div>
      <div class="stat-value">${escapeHtml(String(value))}</div>
    </div>
  `).join('');

  el('allChecksPanel').innerHTML = renderGroupedChecks(scoreResult.allChecks, { showCategory: true, idPrefix: 'overview' });
}

// ===================== META =====================
function renderMetaTab(data) {
  function card(label, value, status, extra) {
    return `
      <div class="meta-card">
        <div class="meta-card-head">
          <span class="meta-card-label">${escapeHtml(label)}</span>
          ${status ? `<span class="status-pill status-${status}">${status.toUpperCase()}</span>` : ''}
          ${extra ? `<span class="meta-card-extra">${escapeHtml(extra)}</span>` : ''}
        </div>
        <div class="meta-card-value">${value ? escapeHtml(value) : '<em>(not set)</em>'}</div>
      </div>`;
  }
  const html = [
    card('Title', data.title.text, data.title.length ? 'pass' : 'fail',
      data.title.length ? `${data.title.length}c${data.title.pixels ? ` · ${data.title.pixels}px / 580px` : ''}` : ''),
    card('Description', data.metaDescription.text, data.metaDescription.length ? 'pass' : 'fail',
      data.metaDescription.length ? `${data.metaDescription.length}c${data.metaDescription.pixels ? ` · ${data.metaDescription.pixels}px / 920px` : ''}` : ''),
    card('Canonical', data.canonical, data.canonical ? 'pass' : 'fail'),
    card('Robots', data.robotsMeta, 'info'),
    card('Viewport', data.viewport, data.viewport ? 'pass' : 'fail'),
    card('Charset', data.charset, data.charset ? 'pass' : 'warn'),
    card('Language (html lang)', data.lang, data.lang ? 'pass' : 'warn'),
    card('Favicon', data.favicon, data.faviconOk === undefined ? '' : (data.faviconOk ? 'pass' : 'warn'), data.faviconOk === undefined ? 'checking…' : ''),
  ].join('');
  el('metaContent').innerHTML = html;
}

// ===================== CONTENT =====================
function renderContentTab(data, scoreResult) {
  const c = data.content;
  const tiles = [
    [c.wordCount, 'Words'],
    [c.readTimeMin + 'm', 'Read time'],
    [c.paragraphCount, 'Paragraphs'],
    [c.sentenceCount, 'Sentences'],
    [c.avgSentenceLength + 'w', 'Avg sent. len'],
    [c.readability + '/100', 'Readability'],
  ];
  const score = scoreResult.categoryScores.content;
  let html = '<div class="tile-grid">' + tiles.map(([v, l]) => `
    <div class="tile"><div class="tile-num">${escapeHtml(String(v))}</div><div class="tile-label">${escapeHtml(l)}</div></div>
  `).join('') + categoryScoreBox(score, 'CONTENT SCORE') + '</div>';

  html += '<div class="panel-title">Keyword Cloud</div>';
  if (c.topKeywords.length) {
    // Font size scales with sqrt of frequency so one dominant word doesn't
    // flatten everything else to the minimum.
    const max = Math.sqrt(c.topKeywords[0].count);
    html += '<div class="kw-cloud">' + c.topKeywords.map((k) => {
      const size = (11 + (Math.sqrt(k.count) / max) * 11).toFixed(1);
      return `<span class="kw-cloud-word" style="font-size:${size}px" title="${k.count}× (${k.pct}%)">${escapeHtml(k.word)}</span>`;
    }).join(' ') + '</div>';
    html += '<div class="keyword-chips">' + c.topKeywords.slice(0, 12).map((k) => `<span class="chip">${escapeHtml(k.word)} <b>${k.count}</b> (${k.pct}%)</span>`).join('') + '</div>';
  } else {
    html += '<p class="empty-note">Not enough text to extract keywords.</p>';
  }

  html += '<div class="panel-title">Checks</div>' + renderGroupedChecks(scoreResult.categories.content);
  el('contentContent').innerHTML = html;
}

// ===================== HEADINGS =====================
function renderHeadingsTab(data, scoreResult) {
  const list = data.headings.list;
  let html = '';
  if (!list.length) {
    html += `<div class="empty-state"><svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg><div>No heading tags found</div></div>`;
  } else {
    html += '<div class="heading-list">' + list.map((h) => `
      <div class="heading-row" style="padding-left:${(h.level - 1) * 14}px">
        <span class="heading-level">H${h.level}</span>
        <span class="heading-text">${escapeHtml(h.text || '(empty)')}</span>
      </div>
    `).join('') + '</div>';
  }
  html += '<div class="panel-title">Checks</div>' + renderGroupedChecks(scoreResult.categories.content.filter((c) => ['h1', 'headings'].includes(c.id)));
  el('headingsContent').innerHTML = html;
}

// ===================== LINKS (summary) =====================
function renderLinksTab(data) {
  const l = data.links;
  const lc = data.linkCheck;
  let html = `<div class="tile-grid">
    <div class="tile"><div class="tile-num">${l.internal}</div><div class="tile-label">Internal</div></div>
    <div class="tile"><div class="tile-num">${l.external}</div><div class="tile-label">External</div></div>
    <div class="tile"><div class="tile-num">${l.nofollow}</div><div class="tile-label">Nofollow</div></div>
    <div class="tile"><div class="tile-num">${l.total}</div><div class="tile-label">Total</div></div>
    ${lc ? `<div class="tile"><div class="tile-num" style="color:${lc.broken ? 'var(--fail)' : 'var(--pass)'}">${lc.broken}</div><div class="tile-label">Broken</div></div>
    <div class="tile"><div class="tile-num">${lc.redirected}</div><div class="tile-label">Redirected</div></div>` : ''}
  </div>`;

  // undefined = the check is still running (progressive render); null = the
  // page simply had no internal links to check.
  if (lc === undefined) {
    html += '<div class="panel-title">Link targets</div><p class="empty-note">Checking link targets…</p>';
  }
  if (lc) {
    const problems = lc.list.filter((r) => r.skipped || !r.ok || r.redirectedTo);
    html += `<div class="panel-title">Link targets (${lc.checked} of ${lc.total} internal links checked)</div>`;
    if (!problems.length) {
      html += '<p class="empty-note">Every checked internal link responds OK with no redirects.</p>';
    } else {
      html += '<div class="link-list">' + problems.map((r) => {
        const label = r.skipped ? 'SKIPPED (time budget)' : r.error ? 'UNREACHABLE' : r.ok ? `${r.status} via redirect` : `HTTP ${r.status}`;
        const cls = r.skipped ? '' : (r.ok ? 'alt-ok' : 'alt-missing');
        return `<div class="link-row">
          <div class="link-text"><span class="image-alt ${cls}">${escapeHtml(label)}</span>${r.redirectedTo ? ` <span class="link-href">→ ${escapeHtml(truncate(r.redirectedTo, 70))}</span>` : ''}</div>
          <div class="link-href">${escapeHtml(truncate(r.url, 90))}</div>
        </div>`;
      }).join('') + '</div>';
    }
  }

  html += '<div class="panel-title">Checks</div>';
  const checks = [];
  if (lc) checks.push({ status: lc.broken > 0 ? 'fail' : 'pass', severity: lc.broken > 0 ? 'high' : 'low', label: lc.broken > 0 ? `${lc.broken} broken internal link(s)` : `All ${lc.checked} checked internal links respond OK`, detail: '' });
  checks.push({ status: l.missingAnchorText > 0 ? 'warn' : 'pass', severity: 'med', label: l.missingAnchorText > 0 ? `${l.missingAnchorText} link(s) with missing anchor text` : 'All links have anchor text', detail: '' });
  checks.push({ status: 'pass', severity: 'low', label: `${l.total} total links found`, detail: '' });
  html += renderGroupedChecks(checks);
  el('linksContent').innerHTML = html;
}

function renderLinkListTab(targetId, list, emptyMsg) {
  if (!list.length) {
    el(targetId).innerHTML = `<div class="empty-state"><svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg><div>${escapeHtml(emptyMsg)}</div></div>`;
    return;
  }
  el(targetId).innerHTML = '<div class="link-list">' + list.map((l) => `
    <div class="link-row">
      <div class="link-text">${escapeHtml(l.text || '(no anchor text)')}${l.nofollow ? ' <span class="tag-nofollow">nofollow</span>' : ''}</div>
      <div class="link-href">${escapeHtml(truncate(l.href, 90))}</div>
    </div>
  `).join('') + '</div>';
}

// ===================== IMAGES =====================
function renderImagesTab(data) {
  const imgs = data.images;
  let html = `<div class="tile-grid">
    <div class="tile"><div class="tile-num">${imgs.total}</div><div class="tile-label">Total</div></div>
    <div class="tile"><div class="tile-num">${imgs.missingAlt}</div><div class="tile-label">Missing alt</div></div>
    <div class="tile"><div class="tile-num">${imgs.oversized != null ? imgs.oversized : '—'}</div><div class="tile-label">Oversized</div></div>
    <div class="tile"><div class="tile-num">${imgs.distorted != null ? imgs.distorted : '—'}</div><div class="tile-label">Distorted</div></div>
    <div class="tile"><div class="tile-num">${imgs.legacyFormat != null ? imgs.legacyFormat : '—'}</div><div class="tile-label">PNG/JPG/GIF</div></div>
    <div class="tile"><div class="tile-num">${imgs.missingDimensions != null ? imgs.missingDimensions : '—'}</div><div class="tile-label">No width/height</div></div>
    <div class="tile"><div class="tile-num">${imgs.lazyLoaded != null ? imgs.lazyLoaded : '—'}</div><div class="tile-label">Lazy-loaded</div></div>
  </div>`;
  if (!imgs.list.length) {
    html += `<div class="empty-state"><svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg><div>No images found</div></div>`;
  } else {
    html += '<div class="image-list">' + imgs.list.slice(0, 60).map((img) => {
      const facts = [];
      if (img.naturalW) {
        facts.push(`${img.naturalW}×${img.naturalH}` +
          (img.renderedW && (img.renderedW !== img.naturalW || img.renderedH !== img.naturalH)
            ? ` → ${img.renderedW}×${img.renderedH}` : ''));
      }
      if (img.format) facts.push(img.format.toUpperCase());
      if (img.loading) facts.push('loading=' + img.loading);
      if (img.fetchpriority) facts.push('priority=' + img.fetchpriority);
      const flags = [];
      if (img.oversized) flags.push('<span class="img-flag flag-warn">oversized</span>');
      if (img.distorted) flags.push('<span class="img-flag flag-warn">distorted</span>');
      if (img.format && ['png', 'jpg', 'gif', 'bmp'].includes(img.format)) flags.push('<span class="img-flag flag-warn">WebP/AVIF candidate</span>');
      if (img.hasExplicitSize === false) flags.push('<span class="img-flag flag-warn">no width/height</span>');
      return `
      <div class="image-row">
        <div class="image-thumb" style="background-image:url('${(img.src || '').replace(/'/g, '%27')}')"></div>
        <div class="image-meta">
          <div class="image-alt ${img.missing ? 'alt-missing' : 'alt-ok'}">${img.missing ? 'Missing alt' : escapeHtml(truncate(img.alt, 60))}</div>
          ${facts.length || flags.length ? `<div class="image-facts">${escapeHtml(facts.join(' · '))}${flags.length ? ' ' + flags.join(' ') : ''}</div>` : ''}
          <div class="image-src">${escapeHtml(truncate(img.src || '', 70))}</div>
        </div>
      </div>`;
    }).join('') + '</div>';
  }
  el('imagesContent').innerHTML = html;
}

// ===================== SCHEMA =====================
function renderSchemaTab(data, scoreResult) {
  let html = '';
  if (!data.jsonLd.length) {
    html += `<div class="empty-state"><svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg><div>No structured data found</div></div>`;
  } else {
    html += '<div class="schema-types">' + data.jsonLdTypes.map((t) => `<span class="chip">${escapeHtml(t)}</span>`).join('') + '</div>';

    const sdIssues = scorlyValidateStructuredData(data.jsonLd);
    html += '<div class="panel-title">Validation</div>';
    if (!sdIssues.length) {
      html += '<p class="empty-note">No issues found against common Google rich-result requirements (local subset — not full Rich Results Test parity).</p>';
    } else {
      html += '<div class="link-list">' + sdIssues.map((iss) => `
        <div class="link-row">
          <div class="link-text"><span class="image-alt ${iss.severity === 'error' ? 'alt-missing' : ''}" ${iss.severity === 'error' ? '' : 'style="color:var(--warn)"'}>${iss.severity.toUpperCase()}</span> <span class="tag-nofollow">${escapeHtml(iss.type)}</span></div>
          <div class="link-href">${escapeHtml(iss.message)}</div>
        </div>`).join('') + '</div>';
    }

    html += '<div class="schema-blocks">' + data.jsonLd.map((j, i) => `
      <details class="schema-block">
        <summary>Block ${i + 1}${j.parseError ? ' — parse error' : (j['@type'] ? ' — ' + escapeHtml(Array.isArray(j['@type']) ? j['@type'].join(', ') : j['@type']) : '')}</summary>
        <pre>${escapeHtml(JSON.stringify(j, null, 2).slice(0, 2000))}</pre>
      </details>
    `).join('') + '</div>';
  }
  html += categoryScoreBox(scoreResult.categoryScores.schema, 'SCHEMA SCORE');
  html += '<div class="panel-title">Checks</div>' + renderGroupedChecks(scoreResult.categories.schema);
  el('schemaContent').innerHTML = html;
}

// ===================== TECH =====================
function renderTechTab(data, scoreResult) {
  const rows = scoreResult.categories.technical.filter((c) => ['https', 'canonical', 'viewport', 'lang', 'favicon', 'doctype'].includes(c.id));
  let html = '<table class="check-table"><thead><tr><th>Check</th><th>Status</th></tr></thead><tbody>' +
    rows.map((c) => `<tr><td>${escapeHtml(c.label)}</td><td><span class="status-pill status-${c.status}">${c.status.toUpperCase()}</span></td></tr>`).join('') +
    '</tbody></table>';
  html += categoryScoreBox(scoreResult.categoryScores.technical, 'TECHNICAL SCORE');
  html += '<div class="panel-title">All Checks</div>' + renderGroupedChecks(scoreResult.categories.technical);
  el('techContent').innerHTML = html;
}

// ===================== PERF =====================
function renderPerfTab(data, scoreResult) {
  const p = data.perf;
  const score = scoreResult.categoryScores.perf;
  const ms = (v) => (v != null ? (v >= 1000 ? (v / 1000).toFixed(1) + 's' : v + 'ms') : '—');
  // Web Vital tiles are tinted by Google's good/needs-improvement/poor bands,
  // so the tab reads at a glance without knowing the thresholds.
  const vitalTile = (metric, display, label) => {
    const status = scorlyVitalStatus(metric, p[metric]);
    const color = status ? ` style="color:var(--${status})"` : '';
    return `<div class="tile"><div class="tile-num"${color}>${display}</div><div class="tile-label">${label}</div></div>`;
  };
  let html = `<div class="tile-grid">
    <div class="tile"><div class="tile-num" style="color:${scoreColor(score)}">${score}/100</div><div class="tile-label">Score</div></div>
    ${vitalTile('ttfb', ms(p.ttfb), 'TTFB')}
    ${vitalTile('fcp', ms(p.fcp), 'FCP')}
    ${vitalTile('lcp', ms(p.lcp), 'LCP')}
    ${vitalTile('cls', p.cls != null ? p.cls : '—', 'CLS')}
    ${vitalTile('tbt', ms(p.tbt), 'TBT ≈')}
    ${vitalTile('inp', ms(p.inp), 'INP')}
    <div class="tile"><div class="tile-num">${p.renderBlockingCount != null ? p.renderBlockingCount : '—'}</div><div class="tile-label">Blocking</div></div>
    <div class="tile"><div class="tile-num">${p.requestCount}</div><div class="tile-label">Requests</div></div>
    <div class="tile"><div class="tile-num">${formatBytes(p.transferSize)}</div><div class="tile-label">Size</div></div>
  </div>`;
  if (p.inp == null) {
    html += '<p class="empty-note">INP needs a real interaction — click or type on the page before analyzing to measure it. TBT and the render-blocking flag are only available in Chromium browsers.</p>';
  }
  // Banded gauges: where each measured vital sits inside Google's
  // good / needs-improvement / poor bands, speedtest-style.
  const gauges = [
    ['ttfb', 'Time to First Byte'], ['fcp', 'First Contentful Paint'], ['lcp', 'Largest Contentful Paint'],
    ['cls', 'Cumulative Layout Shift'], ['tbt', 'Total Blocking Time ≈'], ['inp', 'Interaction to Next Paint'],
  ].map(([m, label]) => renderVitalGauge(m, p[m], label)).filter(Boolean);
  if (gauges.length) html += '<div class="panel-title">Web Vitals vs Google bands</div>' + gauges.join('');
  html += renderWaterfall(data.resources);
  html += '<div class="panel-title">Checks</div>' + renderGroupedChecks(scoreResult.categories.perf);
  el('perfContent').innerHTML = html;
}

// A green/amber/red banded bar with a marker showing where the measured
// value sits relative to Google's published thresholds for that vital.
// Green runs to the "good" threshold, amber to "needs improvement", red
// beyond; the scale ends at 1.5× the poor threshold so a bad value still
// lands visibly inside the bar.
function renderVitalGauge(metric, value, label) {
  const bands = SCORLY_VITAL_BANDS[metric];
  if (!bands || value == null) return '';
  const [good, poor] = bands;
  const scaleMax = poor * 1.5;
  const pct = (v) => Math.min(100, (v / scaleMax) * 100);
  const fmt = (v) => metric === 'cls' ? String(v) : (v >= 1000 ? ((v / 1000) % 1 ? (v / 1000).toFixed(1) : (v / 1000)) + ' s' : v + ' ms');
  const status = scorlyVitalStatus(metric, value);
  const markerPct = Math.max(1.5, Math.min(98.5, pct(value)));
  return `
  <div class="gauge">
    <div class="gauge-head">
      <span class="gauge-label">${escapeHtml(label)}</span>
      <span class="gauge-value" style="color:var(--${status})">${escapeHtml(fmt(value))}</span>
    </div>
    <div class="gauge-bar-wrap">
      <div class="gauge-marker" style="left:${markerPct}%"><div class="gauge-marker-tip"></div></div>
      <div class="gauge-bar">
        <div class="gauge-seg seg-pass" style="width:${pct(good)}%"></div>
        <div class="gauge-seg seg-warn" style="width:${pct(poor) - pct(good)}%"></div>
        <div class="gauge-seg seg-fail" style="width:${100 - pct(poor)}%"></div>
      </div>
      <div class="gauge-tick" style="left:${pct(good)}%"><span>${escapeHtml(fmt(good))}</span></div>
      <div class="gauge-tick" style="left:${pct(poor)}%"><span>${escapeHtml(fmt(poor))}</span></div>
    </div>
  </div>`;
}

// Per-request breakdown: totals by type, then the heaviest requests with
// size, duration and render-blocking flag. All from the page's own
// PerformanceResourceTiming buffer — nothing is re-fetched.
function renderWaterfall(resources) {
  if (!resources || !resources.length) return '';
  const byType = new Map();
  resources.forEach((r) => {
    const t = byType.get(r.type) || { count: 0, bytes: 0 };
    t.count++;
    t.bytes += r.transferSize || 0;
    byType.set(r.type, t);
  });
  let html = '<div class="panel-title">Transfer by type</div><div class="keyword-chips">';
  html += Array.from(byType.entries())
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .map(([type, t]) => `<span class="chip">${escapeHtml(type)} <b>${t.count}</b> (${formatBytes(t.bytes)})</span>`)
    .join('');
  html += '</div>';

  // Third-party inventory: who else the page talks to, and what it costs.
  const origins = new Map();
  let pageHost = null;
  try { pageHost = new URL(resources[0].url).hostname; } catch (e) { /* ignore */ }
  resources.forEach((r) => {
    let u;
    try { u = new URL(r.url); } catch (e) { return; }
    if (u.hostname === pageHost) return;
    const o = origins.get(u.origin) || { count: 0, bytes: 0, types: new Set() };
    o.count++;
    o.bytes += r.transferSize || 0;
    o.types.add(r.type);
    origins.set(u.origin, o);
  });
  if (origins.size) {
    html += `<div class="panel-title">Third-party origins (${origins.size})</div><div class="req-list">`;
    html += Array.from(origins.entries())
      .sort((a, b) => b[1].bytes - a[1].bytes)
      .map(([origin, o]) => `<div class="req-row">
        <span class="req-name" title="${escapeHtml(origin)}">${escapeHtml(truncate(origin.replace(/^https?:\/\//, ''), 44))}</span>
        <span class="req-type">${escapeHtml(Array.from(o.types).join(','))}</span>
        <span class="req-size">${o.count} req · ${formatBytes(o.bytes)}</span>
      </div>`).join('');
    html += '</div><p class="empty-note">Each origin costs an extra DNS lookup + TLS handshake before its first byte.</p>';
  }

  const top = resources.slice().sort((a, b) => (b.transferSize || 0) - (a.transferSize || 0)).slice(0, 40);
  html += '<div class="panel-title">Requests (heaviest first)</div><div class="req-list">';
  html += top.map((r) => {
    let path;
    try { const u = new URL(r.url); path = u.pathname.split('/').pop() || u.hostname; } catch (e) { path = r.url; }
    return `<div class="req-row">
      <span class="req-type">${escapeHtml(r.type)}</span>
      <span class="req-name" title="${escapeHtml(r.url)}">${escapeHtml(truncate(path, 48))}</span>
      ${r.renderBlocking && r.type !== 'document' ? '<span class="req-blocking">blocking</span>' : ''}
      <span class="req-size">${r.transferSize ? formatBytes(r.transferSize) : 'cache'}</span>
      <span class="req-time">${r.duration != null ? r.duration + 'ms' : ''}</span>
    </div>`;
  }).join('');
  html += '</div>';
  if (resources.length > top.length) html += `<p class="empty-note">Showing the 40 heaviest of ${resources.length} requests. Exports include all captured requests.</p>`;
  return html;
}

// ===================== SECURITY =====================
function renderSecurityTab(data, scoreResult) {
  const score = scoreResult.categoryScores.security;
  const s = data.security;
  let html = `<div class="score-row compact">
    <div class="score-circle-wrap small">
      <svg viewBox="0 0 120 120" class="score-circle">
        <circle cx="60" cy="60" r="52" class="score-bg" />
        <circle cx="60" cy="60" r="52" class="score-fg" style="stroke:${scoreColor(score)};stroke-dashoffset:${326.7 - (326.7 * score) / 100}"/>
      </svg>
      <div class="score-number" style="color:${scoreColor(score)}">${score}</div>
      <div class="score-caption">SECURITY</div>
    </div>
    <div class="bar-list">
      <div class="bar-row"><div class="bar-label">HTTPS</div><div class="bar-track"><div class="bar-fill" style="width:${s.https ? 100 : 0}%;background:${s.https ? 'var(--pass)' : 'var(--fail)'}"></div></div><div class="bar-value">${s.https ? 'YES' : 'NO'}</div></div>
      <div class="bar-row"><div class="bar-label">Mixed</div><div class="bar-track"><div class="bar-fill" style="width:${s.mixedContentCount === 0 ? 100 : 20}%;background:${s.mixedContentCount === 0 ? 'var(--pass)' : 'var(--fail)'}"></div></div><div class="bar-value">${s.mixedContentCount}</div></div>
      <div class="bar-row"><div class="bar-label">Context</div><div class="bar-track"><div class="bar-fill" style="width:${s.isSecureContext ? 100 : 0}%;background:${s.isSecureContext ? 'var(--pass)' : 'var(--fail)'}"></div></div><div class="bar-value">${s.isSecureContext ? 'YES' : 'NO'}</div></div>
      <div class="bar-row"><div class="bar-label">Protocol</div><div class="bar-track"><div class="bar-fill" style="width:100%;background:var(--accent)"></div></div><div class="bar-value">${escapeHtml((data.perf.nextHopProtocol || 'n/a').toUpperCase())}</div></div>
    </div>
  </div>`;
  html += '<div class="panel-title">Checks</div>' + renderGroupedChecks(scoreResult.categories.security);
  el('securityContent').innerHTML = html;
}

// ===================== OPEN GRAPH PREVIEW =====================
function getOgPreviewData(data) {
  const og = data.og || {};
  const tw = data.twitter || {};
  const hasOg = Object.keys(og.raw || {}).length > 0;
  const title = og.title || tw.title || data.title.text || data.hostname;
  const description = og.description || tw.description || data.metaDescription.text || data.firstParagraph || '';
  const image = og.image || tw.image || data.favicon || null;
  const siteName = og.siteName || data.hostname;
  const displayUrl = (og.url || data.url || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  return { title, description, image, siteName, displayUrl, hasOg };
}

function imgBlock(image, fallbackText) {
  if (image) return `<div class="card-img" style="background-image:url('${image.replace(/'/g, '%27')}')"></div>`;
  return `<div class="card-img">${escapeHtml(fallbackText || 'No image')}</div>`;
}

function renderOgCard(platform, data) {
  const area = el('ogPreviewArea');
  const siteUpper = escapeHtml((data.siteName || '').toUpperCase());
  let html = '';
  switch (platform) {
    case 'facebook':
      html = `<div class="card">${imgBlock(data.image)}<div class="card-body"><div class="card-site">${siteUpper}</div><div class="card-title">${escapeHtml(truncate(data.title, 100))}</div><div class="card-desc">${escapeHtml(truncate(data.description, 150))}</div></div></div>`;
      break;
    case 'x':
      html = `<div class="card x-card">${imgBlock(data.image)}<div class="card-body"><div class="card-title">${escapeHtml(truncate(data.title, 70))}</div><div class="card-desc">${escapeHtml(truncate(data.description, 125))}</div><div class="card-site">${escapeHtml(data.displayUrl)}</div></div></div>`;
      break;
    case 'linkedin':
      html = `<div class="card">${imgBlock(data.image)}<div class="card-body"><div class="card-title">${escapeHtml(truncate(data.title, 150))}</div><div class="card-site">${escapeHtml(data.displayUrl)}</div></div></div>`;
      break;
    case 'whatsapp':
      html = `<div class="wa-bubble"><div class="wa-card">${imgBlock(data.image)}<div class="card-body"><div class="card-title">${escapeHtml(truncate(data.title, 65))}</div><div class="card-desc">${escapeHtml(truncate(data.description, 100))}</div><div class="card-site">${escapeHtml(data.displayUrl)}</div></div></div></div>`;
      break;
    case 'discord':
      html = `<div class="embed-bar"><div class="embed-accent"></div><div class="embed-content"><div class="card-site">${siteUpper}</div><div class="card-title">${escapeHtml(truncate(data.title, 100))}</div><div class="card-desc">${escapeHtml(truncate(data.description, 160))}</div>${data.image ? `<div class="card-img" style="background-image:url('${data.image.replace(/'/g, '%27')}'); margin-top:8px; border-radius:6px;"></div>` : ''}</div></div>`;
      break;
  }
  if (!data.hasOg) html += `<div class="fallback-tag">⚠ Fallback preview — no Open Graph tags present</div>`;
  area.innerHTML = html;
}

function renderOgTab(data) {
  const preview = getOgPreviewData(data);
  el('ogSourceNote').textContent = preview.hasOg
    ? 'Open Graph tags detected — showing how this page will appear when shared.'
    : 'No Open Graph tags found. Showing a best-effort fallback preview using the page title, meta description, and favicon — actual rendering will vary by platform.';
  return preview;
}

// ===================== AI INSIGHTS =====================
// Everything on this tab is rule-based and computed locally (scoring.js
// scorlyComputeAiInsights) — "AI" refers to the audience (AI answer
// engines), not the method. No model, no network.
function renderInsightsTab(data, scoreResult, insights) {
  const vis = insights.aiVisibility != null ? insights.aiVisibility : (scoreResult && scoreResult.aiVisibility) || 0;

  let html = `<div class="score-row compact">
    <div class="score-circle-wrap small">
      <svg viewBox="0 0 120 120" class="score-circle">
        <circle cx="60" cy="60" r="52" class="score-bg" />
        <circle cx="60" cy="60" r="52" class="score-fg" style="stroke:${scoreColor(vis)};stroke-dashoffset:${326.7 - (326.7 * vis) / 100}"/>
      </svg>
      <div class="score-number" style="color:${scoreColor(vis)}">${vis}</div>
      <div class="score-caption">AI<br>VISIBILITY</div>
    </div>
    <div class="insight-vis-blurb">
      <p>How visible this page can be to AI answer engines (ChatGPT, Claude, Perplexity, Gemini): crawler access, machine-readable structure, trust signals and freshness.</p>
    </div>
  </div>
  <div class="info-alert">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
    <span>Computed locally from page signals — no AI involved, nothing leaves your browser.</span>
  </div>`;

  // What the score above is made of, as one bar per component — the same
  // shape as the Overview tab's category bars, and every bar reads the same
  // way round (higher is better). Each row scrolls to the panel that explains
  // it, so the bars double as the tab's table of contents.
  const breakdown = insights.aiVisibilityBreakdown;
  if (breakdown && breakdown.components.length) {
    html += '<div class="panel-title">What Makes Up This Score</div>';
    html += '<div class="bar-list vis-bars">';
    html += breakdown.components.map((c) => `
      <button type="button" class="bar-row vis-bar" data-scrollto="${c.section}" title="${escapeHtml(c.detail)} Worth ${c.cap} of the 100 AI Visibility points; this page earns ${c.earned}.">
        <div class="bar-label">${escapeHtml(c.label)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.max(0, Math.min(100, c.pct))}%;background:${scoreColor(c.pct)}"></div></div>
        <div class="bar-value">${c.pct}%</div>
      </button>`).join('');
    html += '</div>';
    html += `<p class="empty-note">Each bar is the score shown by the section it opens, so the two always agree. How much each one is worth to AI Visibility is in its tooltip: the first four are worth 30, 30, 25 and 15 points, and the last two are deductions of up to 12 and 10 (capped at 20 together) that only bite past a threshold \u2014 so a section can score below 100 and still cost nothing. This page gives up ${breakdown.deduction} point${breakdown.deduction === 1 ? '' : 's'} in total. AI Visibility is itself 7.5% of the overall score at the top of the popup, so a full 20-point deduction moves that by 1.5.</p>`;
  }

  // ---- AI crawler access ----
  if (data.aiBotAccess) {
    html += '<div class="panel-title" id="sec-crawlers">AI Crawler Access (robots.txt)</div><div class="bot-grid">';
    html += data.aiBotAccess.map((b) => `
      <div class="bot-row">
        <span class="bot-dot" style="background:var(--${b.allowed ? 'pass' : 'fail'})"></span>
        <span class="bot-name">${escapeHtml(b.bot)}</span>
        <span class="bot-engine">${escapeHtml(b.engine)}</span>
        <span class="status-pill status-${b.allowed ? 'pass' : 'fail'}">${b.allowed ? 'ALLOWED' : 'BLOCKED'}</span>
      </div>`).join('');
    html += '</div>';
    if (data.llmsTxt !== undefined) {
      html += `<p class="empty-note">llms.txt: ${data.llmsTxt ? 'found at site root ✓' : 'not found (optional, emerging convention).'}</p>`;
    }
  }

  // ---- AI SEO checks (the markup-level checklist this score is built from) ----
  if (scoreResult && scoreResult.categories && scoreResult.categories.aiSeo) {
    html += '<div class="panel-title" id="sec-aichecks">AI SEO Checks</div>';
    html += '<p class="checks-intro">The structural checks behind the AI Visibility score above — structured data, schema, semantic HTML and crawler access.</p>';
    html += renderGroupedChecks(scoreResult.categories.aiSeo);
  }

  // ---- AI copy signals ----
  // Both of the panels below score the opposite way round to everything else
  // in the popup: a HIGH number is bad. riskColor inverts scoreColor so the
  // colour still means what the user expects (red = problem).
  html += '<div class="panel-title" id="sec-aicopy">AI Copy Signals</div>';
  if (!insights.aiCopy) {
    html += '<p class="empty-note">Captured on newer analyses — hit re-analyze to populate this section.</p>';
  } else if (!insights.aiCopy.available) {
    html += `<p class="empty-note">Only ${insights.aiCopy.proseWords} words of prose on this page — too little to judge writing patterns either way.</p>`;
  } else {
    const ac = insights.aiCopy;
    html += `<p class="checks-intro">How much this page's copy reads as written by a person rather than left as raw AI output, from the surface tells catalogued in Wikipedia's <i>Signs of AI writing</i>. Scored the same way round as everything else here: 100 is clean, and a low score deducts from AI Visibility above, because Google's spam policies discount mass-produced, low-added-value pages and AI answer engines cite sources that say something specific.</p>`;
    html += `<div class="risk-head">
      <div class="risk-big" style="color:${scoreColor(ac.displayScore)}">${ac.displayScore}<span class="risk-of">/100</span></div>
      <div class="risk-band">
        <div class="risk-band-label" style="color:${scoreColor(ac.displayScore)}">${escapeHtml(ac.band)}</div>
        <div class="risk-band-sub">${ac.familyCount} tell${ac.familyCount === 1 ? '' : 's'} found across ${ac.proseWords} words of prose${ac.penalty ? ` \u00b7 costs ${ac.penalty} AI Visibility point${ac.penalty === 1 ? '' : 's'}` : ' \u00b7 no deduction'}</div>
      </div>
    </div>`;
    if (ac.gated) {
      html += '<p class="empty-note">Fewer than three independent tells fired, so the deduction is held back on purpose \u2014 isolated patterns (one em dash, curly quotes) are ordinary human writing and prove nothing.</p>';
    }
    if (ac.floored) {
      html += '<p class="empty-note">Chatbot text was found in the copy, which sets a floor on the score regardless of the individual tells below \u2014 so these numbers will not add up to the total.</p>';
    }
    html += ac.families.length
      ? '<div class="sig-list">' + ac.families.map((f) => `
        <div class="sig-row">
          <div class="sig-head">
            <span class="sig-label">${escapeHtml(f.label)}</span>
            <span class="sig-weight" style="background:${riskColor(Math.min(100, f.points * 5))}">\u2212${f.points}</span>
          </div>
          <div class="sig-detail">${escapeHtml(f.detail)}</div>
          ${f.samples && f.samples.length ? '<div class="sig-samples">' + f.samples.map((x) => `<span class="sig-chip">${escapeHtml(x)}</span>`).join('') + '</div>' : ''}
        </div>`).join('') + '</div>'
      : '<p class="empty-note">None of the tracked AI writing patterns fired on this page.</p>';
    html += '<p class="empty-note">Each number above is what that pattern costs the score out of 100. Pattern-matched against the page\u2019s own text in your browser \u2014 no detector can prove authorship, so read the evidence and judge it yourself.</p>';
  }

  // ---- Vibe-code detection ----
  html += '<div class="panel-title" id="sec-vibecode">Vibe-Code Detection</div>';
  if (!insights.vibeCode) {
    html += '<p class="empty-note">Captured on newer analyses — hit re-analyze to populate this section.</p>';
  } else {
    const vc = insights.vibeCode;
    html += `<p class="checks-intro">Whether this page was built by an AI app-builder, and separately what that costs it. Two different questions on purpose: the toolchain is not a fault, so a generated site that server-renders and has real copy scores 100 here. The score is about the faults; the verdict under it is about the tooling.</p>`;
    html += `<div class="risk-head">
      <div class="risk-big" style="color:${scoreColor(vc.buildScore)}">${vc.buildScore}<span class="risk-of">/100</span></div>
      <div class="risk-band">
        <div class="risk-band-label" style="color:${scoreColor(vc.buildScore)}">${vc.faults.length ? `${vc.faults.length} fault${vc.faults.length === 1 ? '' : 's'} costing ${vc.penalty} AI Visibility point${vc.penalty === 1 ? '' : 's'}` : 'No generated-site faults'}</div>
        <div class="risk-band-sub">${['Verdict: ' + escapeHtml(vc.band),
          vc.builders.length ? vc.builders.map((b) => escapeHtml(b.name)).join(', ') : null,
          vc.framework ? escapeHtml(vc.framework) : null,
          vc.platform ? escapeHtml(vc.platform) : null,
        ].filter(Boolean).join(' \u00b7 ')}</div>
      </div>
    </div>`;

    if (vc.servedWords != null) {
      const pct = vc.renderedWords ? Math.round((vc.servedWords / vc.renderedWords) * 100) : 0;
      html += `<div class="sig-row">
        <div class="sig-head"><span class="sig-label">What a non-JavaScript crawler sees</span>
        <span class="sig-weight" style="background:${scoreColor(pct)}">${pct}%</span></div>
        <div class="sig-detail">${vc.servedWords} of ${vc.renderedWords} words are present in the HTML as served, before any JavaScript runs.</div>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.min(100, pct)}%;background:${scoreColor(pct)}"></div></div>
      </div>`;
    }

    html += '<div class="sig-sub-title">Faults that cost visibility</div>';
    html += vc.faults.length
      ? '<div class="sig-list">' + vc.faults.map((f) => `
        <div class="sig-row">
          <div class="sig-head"><span class="sig-label">${escapeHtml(f.label)}</span><span class="sig-weight" style="background:var(--fail)">−${f.points}</span></div>
          <div class="sig-detail">${escapeHtml(f.detail)}</div>
        </div>`).join('') + '</div>'
      : '<p class="empty-note">None — whatever built this page, it did not leave the usual visibility problems behind.</p>';

    // Evidence rows carry a strength word rather than a number: these feed the
    // verdict, not the score, so a signed number here would read as points
    // gained or lost when it is neither.
    html += '<div class="sig-sub-title">Detection evidence</div>';
    html += '<p class="checks-intro">What suggests this page was generated. None of this deducts anything by itself.</p>';
    html += vc.signals.length
      ? '<div class="sig-list">' + vc.signals.map((f) => `
        <div class="sig-row">
          <div class="sig-head"><span class="sig-label">${escapeHtml(f.label)}</span><span class="sig-weight sig-strength-${f.strength}">${f.strength}</span></div>
          <div class="sig-detail">${escapeHtml(f.detail)}</div>
        </div>`).join('') + '</div>'
      : '<p class="empty-note">No AI-builder fingerprints found.</p>';
  }

  // ---- Domain business context ----
  const bcx = insights.businessContext;
  html += '<div class="panel-title">Domain Business Context</div>';
  if (bcx.captured || bcx.about) {
    const rows = [
      ['Site / business name', bcx.siteName],
      ['Schema type', bcx.schemaType],
      ['What this page is about', bcx.about],
      ['Location', bcx.locality],
      ['Telephone', bcx.telephone],
      ['Social profiles', bcx.socialProfiles && bcx.socialProfiles.length ? bcx.socialProfiles.join(', ') : null],
    ].filter(([, v]) => v);
    html += rows.length ? rows.map(([l, v]) => `
      <div class="meta-card"><div class="meta-card-head"><span class="meta-card-label">${escapeHtml(l)}</span></div>
      <div class="meta-card-value">${escapeHtml(String(v))}</div></div>`).join('')
      : '<p class="empty-note">No business identity signals found (no Organization schema, og:site_name or meta description).</p>';
    html += '<p class="empty-note">Detected from the page’s own markup (structured data, Open Graph, meta tags) — shown verbatim, not generated.</p>';
  } else {
    html += '<p class="empty-note">Captured on newer analyses — hit re-analyze to populate this section.</p>';
  }

  // ---- Strengths & weaknesses ----
  html += '<div class="panel-title">Content Strengths &amp; Weaknesses</div>';
  html += '<div class="sw-cols">';
  html += '<div class="sw-col"><div class="sw-col-title sw-strength">Strengths</div>' +
    (insights.strengths.length ? insights.strengths.map((s) => `<div class="sw-item"><span class="sw-ic" style="color:var(--pass)">✓</span><div><b>${escapeHtml(s.label)}</b><div class="sw-detail">${escapeHtml(s.detail)}</div></div></div>`).join('') : '<p class="empty-note">Nothing stood out.</p>') + '</div>';
  html += '<div class="sw-col"><div class="sw-col-title sw-weakness">Weaknesses</div>' +
    (insights.weaknesses.length ? insights.weaknesses.map((s) => `<div class="sw-item"><span class="sw-ic" style="color:var(--warn)">!</span><div><b>${escapeHtml(s.label)}</b><div class="sw-detail">${escapeHtml(s.detail)}</div></div></div>`).join('') : '<p class="empty-note">No notable weaknesses detected.</p>') + '</div>';
  html += '</div>';

  // ---- Content trust score ----
  html += '<div class="panel-title" id="sec-trust">Content Trust Score</div>';
  if (insights.trust) {
    const t = insights.trust;
    html += `<div class="trust-row">
      <div class="trust-big" style="color:${scoreColor(t.score)}">${t.score}%</div>
      <div class="bar-list">` +
      t.subs.map((s) => `
        <div class="bar-row" title="${escapeHtml(s.detail)}">
          <div class="bar-label trust-label">${escapeHtml(s.label)}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${s.score}%;background:${scoreColor(s.score)}"></div></div>
          <div class="bar-value">${s.score}%</div>
        </div>`).join('') +
      '</div></div>';
  } else {
    html += '<p class="empty-note">Captured on newer analyses — hit re-analyze to populate this section.</p>';
  }

  // ---- Content freshness ----
  html += '<div class="panel-title" id="sec-freshness">Content Freshness</div>';
  if (insights.freshness) {
    const f = insights.freshness;
    html += `<div class="trust-row"><div class="trust-big" style="color:${scoreColor(f.score)}">${f.score}%</div><div class="fresh-signals">`;
    html += f.positives.map((p) => `<div class="sw-item"><span class="sw-ic" style="color:var(--pass)">✓</span><div>${escapeHtml(p)}</div></div>`).join('');
    html += f.negatives.map((n) => `<div class="sw-item"><span class="sw-ic" style="color:var(--warn)">!</span><div>${escapeHtml(n)}</div></div>`).join('');
    html += '</div></div>';
  } else {
    html += '<p class="empty-note">Captured on newer analyses — hit re-analyze to populate this section.</p>';
  }

  // ---- Opportunities ----
  html += '<div class="panel-title">Content Opportunities</div>';
  html += insights.opportunities.length
    ? '<div class="opps">' + insights.opportunities.map((o) => `<div class="opp-item"><span class="opp-bullet">→</span><div>${escapeHtml(o)}</div></div>`).join('') + '</div>'
    : '<p class="empty-note">No obvious quick wins — the fundamentals are covered.</p>';

  el('insightsContent').innerHTML = html;
}
