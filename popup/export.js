// JSON / CSV / PDF export helpers.

function safeFilename(url) {
  try {
    const u = new URL(url);
    return (u.hostname + u.pathname).replace(/[^a-z0-9.-]+/gi, '_').slice(0, 60);
  } catch (e) {
    return 'scorly-report';
  }
}

function downloadFile(filename, content, mime) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function csvEscape(v) {
  const s = v === undefined || v === null ? '' : String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function buildExportPayload(data, scoreResult) {
  return {
    url: data.url,
    analyzedAt: data.analyzedAt,
    overallScore: scoreResult.overallScore,
    // aiVisibility is already in categoryScores.aiSeo below (the two were
    // unified so every surface agrees on one number) — aiInsights is the
    // richer breakdown behind it.
    aiInsights: (typeof scorlyComputeAiInsights === 'function') ? scorlyComputeAiInsights(data, scoreResult) : undefined,
    aiBotAccess: data.aiBotAccess || null,
    llmsTxt: data.llmsTxt,
    categoryScores: scoreResult.categoryScores,
    counts: scoreResult.counts,
    meta: {
      title: data.title, metaDescription: data.metaDescription, canonical: data.canonical,
      robotsMeta: data.robotsMeta, viewport: data.viewport, charset: data.charset, lang: data.lang,
      favicon: data.favicon, hasDoctype: data.hasDoctype,
    },
    headings: data.headings,
    images: {
      total: data.images.total, missingAlt: data.images.missingAlt,
      oversized: data.images.oversized, legacyFormat: data.images.legacyFormat,
      missingDimensions: data.images.missingDimensions, lazyLoaded: data.images.lazyLoaded,
      list: data.images.list,
    },
    links: { internal: data.links.internal, external: data.links.external, nofollow: data.links.nofollow, missingAnchorText: data.links.missingAnchorText },
    linkCheck: data.linkCheck || null,
    structuredDataIssues: data.jsonLd && data.jsonLd.length ? scorlyValidateStructuredData(data.jsonLd) : [],
    content: data.content,
    og: data.og,
    twitter: data.twitter,
    jsonLdTypes: data.jsonLdTypes,
    perf: data.perf,
    resources: data.resources,
    security: data.security,
    robotsTxt: data.robotsTxt,
    sitemapXml: data.sitemapXml,
    checks: scoreResult.allChecks,
  };
}

function toCsv(data, scoreResult) {
  const rows = [['Field', 'Value']];
  rows.push(['URL', data.url]);
  rows.push(['Analyzed At', data.analyzedAt]);
  rows.push(['Overall Score', scoreResult.overallScore]);
  Object.keys(scoreResult.categoryScores).forEach((k) => rows.push([CATEGORY_LABELS[k] + ' Score', scoreResult.categoryScores[k]]));
  rows.push(['Title', data.title.text]);
  rows.push(['Title Length', data.title.length]);
  rows.push(['Title Pixel Width', data.title.pixels]);
  rows.push(['Meta Description', data.metaDescription.text]);
  rows.push(['Meta Description Length', data.metaDescription.length]);
  rows.push(['Meta Description Pixel Width', data.metaDescription.pixels]);
  rows.push(['Canonical', data.canonical || '']);
  rows.push(['Word Count', data.content.wordCount]);
  rows.push(['Readability', data.content.readability]);
  rows.push(['H1 Count', data.headings.counts.h1]);
  rows.push(['Images Total', data.images.total]);
  rows.push(['Images Missing Alt', data.images.missingAlt]);
  rows.push(['Internal Links', data.links.internal]);
  rows.push(['External Links', data.links.external]);
  if (data.linkCheck) {
    rows.push(['Internal Links Checked', data.linkCheck.checked]);
    rows.push(['Broken Internal Links', data.linkCheck.broken]);
    rows.push(['Redirected Internal Links', data.linkCheck.redirected]);
  }
  rows.push(['Has Open Graph', Object.keys(data.og.raw || {}).length > 0]);
  rows.push(['Has Twitter Card', Object.keys(data.twitter.raw || {}).length > 0]);
  rows.push(['Structured Data Types', data.jsonLdTypes.join('; ')]);
  rows.push(['TTFB (ms)', data.perf.ttfb]);
  rows.push(['FCP (ms)', data.perf.fcp]);
  rows.push(['LCP (ms)', data.perf.lcp]);
  rows.push(['CLS', data.perf.cls]);
  rows.push(['TBT approx (ms)', data.perf.tbt]);
  rows.push(['INP (ms)', data.perf.inp]);
  rows.push(['Render-Blocking Resources', data.perf.renderBlockingCount]);
  rows.push(['Requests', data.perf.requestCount]);
  rows.push(['Transferred Size (bytes)', data.perf.transferSize]);
  rows.push(['HTTPS', data.security.https]);
  rows.push(['Robots.txt Found', data.robotsTxt]);
  rows.push(['Sitemap.xml Found', data.sitemapXml]);
  rows.push([]);
  rows.push(['Check', 'Category', 'Status', 'Severity', 'Detail']);
  scoreResult.allChecks.forEach((c) => rows.push([c.label, CATEGORY_LABELS[c.category] || c.category, c.status, c.severity, c.detail]));

  if (data.resources && data.resources.length) {
    rows.push([]);
    rows.push(['Request URL', 'Type', 'Transferred (bytes)', 'Duration (ms)', 'Render-Blocking']);
    data.resources.forEach((r) => rows.push([r.url, r.type, r.transferSize, r.duration, r.renderBlocking === null ? '' : r.renderBlocking]));
  }

  return rows.map((r) => r.map(csvEscape).join(',')).join('\r\n');
}

function toMarkdown(data, scoreResult) {
  const lines = [];
  const pct = (n) => `${n}/100`;

  lines.push('# Scorly report');
  lines.push('');
  lines.push(`**${data.url}**`);
  lines.push('');
  lines.push(`Analyzed ${new Date(data.analyzedAt).toLocaleString()}`);
  lines.push('');
  lines.push(`## Overall score: ${pct(scoreResult.overallScore)}`);
  lines.push('');
  lines.push(`${scoreResult.counts.issues} issues · ${scoreResult.counts.warnings} warnings · ${scoreResult.counts.passed} passed`);
  lines.push('');
  lines.push('| Category | Score |');
  lines.push('| --- | --- |');
  Object.keys(CATEGORY_LABELS).forEach((key) => {
    lines.push(`| ${CATEGORY_LABELS[key]} | ${scoreResult.categoryScores[key]} |`);
  });
  lines.push('');

  lines.push('## Page');
  lines.push('');
  lines.push(`- **Title** (${data.title.length} chars): ${data.title.text || '_missing_'}`);
  lines.push(`- **Meta description** (${data.metaDescription.length} chars): ${data.metaDescription.text || '_missing_'}`);
  lines.push(`- **Canonical**: ${data.canonical || '_missing_'}`);
  lines.push(`- **Language**: ${data.lang || '_missing_'}`);
  lines.push(`- **Word count**: ${data.content.wordCount} (${data.content.readTimeMin} min read, readability ${data.content.readability})`);
  lines.push(`- **Headings**: H1 ${data.headings.counts.h1}, H2 ${data.headings.counts.h2}, H3 ${data.headings.counts.h3}`);
  lines.push(`- **Links**: ${data.links.internal} internal, ${data.links.external} external, ${data.links.nofollow} nofollow`);
  lines.push(`- **Images**: ${data.images.total} total, ${data.images.missingAlt} missing alt text`);
  lines.push(`- **Structured data**: ${data.jsonLdTypes.length ? data.jsonLdTypes.join(', ') : '_none_'}`);
  const p = data.perf;
  const msOr = (v) => (v != null ? v + 'ms' : 'n/a');
  lines.push(`- **Web vitals**: TTFB ${msOr(p.ttfb)}, FCP ${msOr(p.fcp)}, LCP ${msOr(p.lcp)}, CLS ${p.cls != null ? p.cls : 'n/a'}, TBT≈ ${msOr(p.tbt)}, INP ${msOr(p.inp)}`);
  lines.push('');

  // Issues first — a report is read for what needs fixing.
  const order = { fail: 0, warn: 1, pass: 2 };
  Object.keys(CATEGORY_LABELS).forEach((key) => {
    const checks = scoreResult.categories[key];
    if (!checks || !checks.length) return;
    lines.push(`## ${CATEGORY_LABELS[key]} — ${pct(scoreResult.categoryScores[key])}`);
    lines.push('');
    checks.slice().sort((a, b) => order[a.status] - order[b.status]).forEach((c) => {
      const mark = c.status === 'pass' ? 'x' : ' ';
      lines.push(`- [${mark}] **${c.label}** (${c.status}) — ${c.detail}`);
    });
    lines.push('');
  });

  return lines.join('\n');
}

function exportMarkdown(data, scoreResult) {
  const base = safeFilename(data.url);
  downloadFile(`scorly-${base}.md`, toMarkdown(data, scoreResult), 'text/markdown');
}

function exportJson(data, scoreResult) {
  const base = safeFilename(data.url);
  downloadFile(`scorly-${base}.json`, JSON.stringify(buildExportPayload(data, scoreResult), null, 2), 'application/json');
}

function exportCsv(data, scoreResult) {
  const base = safeFilename(data.url);
  downloadFile(`scorly-${base}.csv`, toCsv(data, scoreResult), 'text/csv');
}

function exportPdf(data, scoreResult) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const marginX = 40;
  let y = 50;

  function ensureSpace(h) {
    if (y + h > pageHeight - 40) { doc.addPage(); y = 50; }
  }

  function heading(text, size) {
    ensureSpace(size + 10);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(size);
    doc.setTextColor(30, 30, 40);
    doc.text(text, marginX, y);
    y += size + 8;
  }

  function paragraph(text, size, color) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(size || 10);
    doc.setTextColor(color ? color[0] : 80, color ? color[1] : 80, color ? color[2] : 90);
    const lines = doc.splitTextToSize(text, pageWidth - marginX * 2);
    lines.forEach((line) => {
      ensureSpace(size ? size + 4 : 14);
      doc.text(line, marginX, y);
      y += (size || 10) + 4;
    });
  }

  function statusColor(status) {
    if (status === 'pass') return [22, 163, 74];
    if (status === 'warn') return [217, 119, 6];
    return [220, 38, 38];
  }

  heading('Scorly Report', 20);
  paragraph(data.url, 10, [79, 70, 229]);
  paragraph('Analyzed: ' + new Date(data.analyzedAt).toLocaleString(), 9);
  y += 6;

  // Overall score banner
  ensureSpace(50);
  doc.setFillColor(...statusColor(scoreResult.overallScore >= 80 ? 'pass' : scoreResult.overallScore >= 50 ? 'warn' : 'fail'));
  doc.roundedRect(marginX, y, pageWidth - marginX * 2, 40, 6, 6, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.text(`Overall SEO Score: ${scoreResult.overallScore}/100`, marginX + 14, y + 26);
  y += 55;
  doc.setFont('helvetica', 'normal');

  // Counts
  paragraph(`Issues: ${scoreResult.counts.issues}   Warnings: ${scoreResult.counts.warnings}   Passed: ${scoreResult.counts.passed}`, 11, [40, 40, 50]);
  y += 6;

  // Category score table
  heading('Category Scores', 13);
  Object.keys(CATEGORY_LABELS).forEach((key) => {
    ensureSpace(18);
    const score = scoreResult.categoryScores[key];
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(60, 60, 70);
    doc.text(CATEGORY_LABELS[key], marginX, y);
    doc.setDrawColor(230, 230, 235);
    doc.setFillColor(235, 236, 240);
    doc.roundedRect(marginX + 120, y - 9, 220, 10, 3, 3, 'F');
    const c = statusColor(score >= 80 ? 'pass' : score >= 50 ? 'warn' : 'fail');
    doc.setFillColor(...c);
    doc.roundedRect(marginX + 120, y - 9, Math.max(6, (220 * score) / 100), 10, 3, 3, 'F');
    doc.setTextColor(40, 40, 40);
    doc.text(String(score), marginX + 350, y);
    y += 18;
  });
  y += 10;

  // Per-category detail
  Object.keys(CATEGORY_LABELS).forEach((key) => {
    const checks = scoreResult.categories[key];
    if (!checks || !checks.length) return;
    heading(CATEGORY_LABELS[key] + ' — ' + scoreResult.categoryScores[key] + '/100', 13);
    checks.forEach((c) => {
      ensureSpace(16);
      const col = statusColor(c.status);
      doc.setFillColor(...col);
      doc.circle(marginX + 4, y - 4, 3, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.setTextColor(30, 30, 30);
      doc.text(c.label, marginX + 14, y);
      y += 13;
      paragraph(c.detail, 9, [100, 100, 110]);
    });
    y += 6;
  });

  const base = safeFilename(data.url);
  doc.save(`scorly-${base}.pdf`);
}
