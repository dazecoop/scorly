// JSON / CSV / Markdown / PDF export helpers.
//
// All four exporters are built from one shared model (buildReportModel) so
// they can't drift apart — the PDF, the Markdown doc and the CSV describe
// the same page, the same way, every time.

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

const SCORLY_SEV_RANK = { high: 0, med: 1, low: 2 };
const SCORLY_STATUS_RANK = { fail: 0, warn: 1, pass: 2 };

// Same ordering the popup uses: within a status group, worst severity first.
function scorlySortChecks(checks) {
  return checks.slice().sort((a, b) => (SCORLY_SEV_RANK[a.severity] ?? 3) - (SCORLY_SEV_RANK[b.severity] ?? 3));
}
function scorlySortChecksFull(checks) {
  return checks.slice().sort((a, b) => {
    if (SCORLY_STATUS_RANK[a.status] !== SCORLY_STATUS_RANK[b.status]) return SCORLY_STATUS_RANK[a.status] - SCORLY_STATUS_RANK[b.status];
    return (SCORLY_SEV_RANK[a.severity] ?? 3) - (SCORLY_SEV_RANK[b.severity] ?? 3);
  });
}

// ---------------------------------------------------------------------------
// Shared report model — every exporter reads from this, not from `data`
// directly, so a field that's missing on an older snapshot is handled once
// here instead of in four separate places.
// ---------------------------------------------------------------------------
// Tap-target line for the Mobile sections. Captures since the WCAG rule
// carry `threshold` (24px, with exemptions); older ones were measured at 44px.
function tapTargetSummary(tt) {
  if (!tt.threshold) return `${tt.small} of ${tt.checked} tap targets smaller than 44×44px (older capture)`;
  return `${tt.small} of ${tt.checked} tap targets under ${tt.threshold}×${tt.threshold}px and crowded (WCAG 2.5.8; ${tt.inlineExempt || 0} inline and ${tt.spacedExempt || 0} well-spaced exempt)`;
}

// One-line accessibility summary for the exports.
function a11ySummary(ax) {
  const c = ax.contrast;
  return [
    `${c.failing} of ${c.checked} sampled text elements below WCAG AA contrast`,
    ax.forms.fields ? `${ax.forms.unlabelled} of ${ax.forms.fields} form fields unlabelled` : null,
    `${ax.namelessButtons.count} unnamed button(s)`,
    `skip link: ${ax.skipLink ? 'yes' : 'no'}`,
    `${ax.landmarks.main} <main> landmark(s)`,
    ax.duplicateIds.count ? `${ax.duplicateIds.count} duplicate id(s)` : null,
  ].filter(Boolean);
}

function buildReportModel(data, scoreResult) {
  const insights = (typeof scorlyComputeAiInsights === 'function') ? scorlyComputeAiInsights(data, scoreResult) : null;
  const sdIssues = data.jsonLd && data.jsonLd.length ? scorlyValidateStructuredData(data.jsonLd) : [];
  const problemImages = (data.images.list || []).filter((i) =>
    i.missing || i.oversized || i.distorted || i.hasExplicitSize === false || (i.format && ['png', 'jpg', 'gif', 'bmp'].includes(i.format)));
  const linkProblems = data.linkCheck ? data.linkCheck.list.filter((r) => r.skipped || !r.ok || r.redirectedTo) : [];
  const heaviestRequests = (data.resources || []).slice().sort((a, b) => (b.transferSize || 0) - (a.transferSize || 0)).slice(0, 12);

  let thirdPartyOrigins = 0;
  if (data.resources && data.resources.length) {
    const origins = new Set();
    data.resources.forEach((r) => { try { const u = new URL(r.url); if (u.hostname !== data.hostname) origins.add(u.origin); } catch (e) { /* ignore */ } });
    thirdPartyOrigins = origins.size;
  }

  return {
    data, scoreResult, insights, sdIssues, problemImages, linkProblems, heaviestRequests, thirdPartyOrigins,
    allChecksSorted: scorlySortChecksFull(scoreResult.allChecks),
  };
}

function buildExportPayload(data, scoreResult) {
  const m = buildReportModel(data, scoreResult);
  return {
    url: data.url,
    analyzedAt: data.analyzedAt,
    overallScore: scoreResult.overallScore,
    // AI Visibility lives in categoryScores.aiSeo below (unified so every
    // surface agrees on one number) — aiInsights is the richer breakdown.
    aiInsights: m.insights,
    aiBotAccess: data.aiBotAccess || null,
    llmsTxt: data.llmsTxt,
    categoryScores: scoreResult.categoryScores,
    counts: scoreResult.counts,
    meta: {
      title: data.title, metaDescription: data.metaDescription, canonical: data.canonical,
      robotsMeta: data.robotsMeta, viewport: data.viewport, charset: data.charset, lang: data.lang,
      favicon: data.favicon, faviconOk: data.faviconOk, hasDoctype: data.hasDoctype,
    },
    headings: data.headings,
    images: {
      total: data.images.total, missingAlt: data.images.missingAlt,
      oversized: data.images.oversized, distorted: data.images.distorted, legacyFormat: data.images.legacyFormat,
      missingDimensions: data.images.missingDimensions, lazyLoaded: data.images.lazyLoaded,
      list: data.images.list,
    },
    links: { internal: data.links.internal, external: data.links.external, nofollow: data.links.nofollow, missingAnchorText: data.links.missingAnchorText },
    linkCheck: data.linkCheck || null,
    wwwRedirect: data.wwwRedirect || null,
    notFoundPage: data.notFoundPage || null,
    structuredDataIssues: m.sdIssues,
    content: data.content,
    og: data.og,
    twitter: data.twitter,
    jsonLdTypes: data.jsonLdTypes,
    perf: data.perf,
    resources: data.resources,
    security: data.security,
    securityHeaders: data.securityHeaders || null,
    mobile: data.mobile || null,
    hygiene: data.hygiene || null,
    assetCheck: data.assetCheck || null,
    robotsTxt: data.robotsTxt,
    sitemapXml: data.sitemapXml,
    checks: scoreResult.allChecks,
  };
}

function toCsv(data, scoreResult) {
  const m = buildReportModel(data, scoreResult);
  const rows = [['Field', 'Value']];
  const push = (label, value) => { if (value !== undefined && value !== null && value !== '') rows.push([label, value]); };

  push('URL', data.url);
  push('Analyzed At', data.analyzedAt);
  push('Overall Score', scoreResult.overallScore);
  Object.keys(scoreResult.categoryScores).forEach((k) => push((CATEGORY_LABELS[k] || k) + ' Score', scoreResult.categoryScores[k]));
  push('Issues', scoreResult.counts.issues);
  push('Warnings', scoreResult.counts.warnings);
  push('Passed', scoreResult.counts.passed);

  push('Title', data.title.text);
  push('Title Length', data.title.length);
  push('Title Pixel Width', data.title.pixels);
  push('Meta Description', data.metaDescription.text);
  push('Meta Description Length', data.metaDescription.length);
  push('Meta Description Pixel Width', data.metaDescription.pixels);
  push('Canonical', data.canonical || '');
  push('Robots Meta', data.robotsMeta);
  push('Viewport', data.viewport);
  push('Charset', data.charset);
  push('Language', data.lang);
  push('Favicon OK', data.faviconOk);

  push('Word Count', data.content.wordCount);
  push('Readability (Flesch)', data.content.readability);
  push('Paragraphs', data.content.paragraphCount);
  push('Sentences', data.content.sentenceCount);
  push('Avg Sentence Length', data.content.avgSentenceLength);
  push('Duplicate Paragraphs', data.content.duplicateParagraphCount);
  push('Empty Bold/Strong Tags', data.content.emptyBoldCount);
  push('H1 Count', data.headings.counts.h1);
  push('H2 Count', data.headings.counts.h2);
  push('H3 Count', data.headings.counts.h3);
  push('Duplicate Headings', data.headings.duplicateCount);

  push('Images Total', data.images.total);
  push('Images Missing Alt', data.images.missingAlt);
  push('Images Oversized', data.images.oversized);
  push('Images Distorted', data.images.distorted);
  push('Images Legacy Format', data.images.legacyFormat);
  push('Images Missing Dimensions', data.images.missingDimensions);

  push('Internal Links', data.links.internal);
  push('External Links', data.links.external);
  push('Nofollow Links', data.links.nofollow);
  push('Links Missing Anchor Text', data.links.missingAnchorText);
  if (data.linkCheck) {
    push('Internal Links Checked', data.linkCheck.checked);
    push('Broken Internal Links', data.linkCheck.broken);
    push('Redirected Internal Links', data.linkCheck.redirected);
  }

  push('Has Open Graph', Object.keys(data.og.raw || {}).length > 0);
  push('Has Twitter Card', Object.keys(data.twitter.raw || {}).length > 0);
  push('Structured Data Types', data.jsonLdTypes.join('; '));
  push('Structured Data Errors', m.sdIssues.filter((i) => i.severity === 'error').length);
  push('Structured Data Warnings', m.sdIssues.filter((i) => i.severity === 'warn').length);

  push('TTFB (ms)', data.perf.ttfb);
  push('FCP (ms)', data.perf.fcp);
  push('LCP (ms)', data.perf.lcp);
  push('CLS', data.perf.cls);
  push('TBT approx (ms)', data.perf.tbt);
  push('INP (ms)', data.perf.inp);
  push('Render-Blocking Resources', data.perf.renderBlockingCount);
  push('Requests', data.perf.requestCount);
  push('Transferred Size (bytes)', data.perf.transferSize);
  push('Third-Party Origins', m.thirdPartyOrigins);
  push('Protocol', data.perf.nextHopProtocol);
  if (data.hygiene) {
    push('DOM Size (elements)', data.hygiene.domSize);
    push('HTML Compressed', data.hygiene.compression ? data.hygiene.compression.compressed : undefined);
    push('Deprecated Tags', data.hygiene.deprecatedTagCount);
    push('Analytics Detected', data.hygiene.analytics.join('; '));
    push('CDNs Detected', data.hygiene.cdns.join('; '));
    push('Media Queries', data.hygiene.mediaQueries.count);
    push('Unsafe Cross-Origin Links', data.hygiene.unsafeCrossOrigin);
    push('Plaintext Emails Found', data.hygiene.textEmails.length);
  }
  if (data.assetCheck) {
    push('Sampled Assets Checked', data.assetCheck.checked);
    push('Sampled Assets Uncached', data.assetCheck.uncached);
    push('Sampled Code Files Unminified', data.assetCheck.unminified);
  }
  if (data.notFoundPage) push('Custom 404 Page', data.notFoundPage.soft404 ? 'No (soft 404)' : (data.notFoundPage.custom ? 'Yes' : 'Default/bare'));

  push('HTTPS', data.security.https);
  push('Mixed Content Resources', data.security.mixedContentCount);
  if (data.securityHeaders) {
    push('HSTS Header', data.securityHeaders.hsts || 'Not set');
    push('CSP Header', data.securityHeaders.csp ? 'Set' : 'Not set');
    push('X-Content-Type-Options', data.securityHeaders.xContentTypeOptions || 'Not set');
    push('X-Frame-Options', data.securityHeaders.xFrameOptions || 'Not set');
    if ('referrerPolicy' in data.securityHeaders) push('Referrer-Policy', data.securityHeaders.referrerPolicy || 'Not set');
    if ('permissionsPolicy' in data.securityHeaders) push('Permissions-Policy', data.securityHeaders.permissionsPolicy ? 'Set' : 'Not set');
    if (data.securityHeaders.xRobotsTag) push('X-Robots-Tag', data.securityHeaders.xRobotsTag);
  }
  push('Robots.txt Found', data.robotsTxt);
  push('Sitemap.xml Found', data.sitemapXml);
  push('llms.txt Found', data.llmsTxt);
  if (data.aiBotAccess) push('AI Crawlers Blocked', data.aiBotAccess.filter((b) => !b.allowed).map((b) => b.bot).join('; ') || 'None');
  if (data.mobile) {
    if (data.mobile.tapTargets) push('Small Tap Targets', `${data.mobile.tapTargets.small} of ${data.mobile.tapTargets.checked}`);
    if (data.mobile.fontSizes) push('Small Font Sizes', `${data.mobile.fontSizes.small} of ${data.mobile.fontSizes.checked}`);
  }
  if (data.a11y) {
    push('Contrast Failures', `${data.a11y.contrast.failing} of ${data.a11y.contrast.checked}`);
    push('Unlabelled Form Fields', data.a11y.forms.unlabelled);
    push('Unnamed Buttons', data.a11y.namelessButtons.count);
    push('Skip Link', data.a11y.skipLink || 'None');
    push('Duplicate IDs', data.a11y.duplicateIds.count);
  }
  if (data.content.gradeLevel != null) push('Reading Grade Level', data.content.gradeLevel);
  if (data.content.topPhrases) push('Top Phrases', data.content.topPhrases.slice(0, 10).map((p) => `${p.phrase} (${p.count})`).join('; '));

  if (m.insights) {
    push('AI Visibility Explained', m.insights.aiVisibility);
    if (m.insights.aiCopy && m.insights.aiCopy.available) {
      push('AI Copy Score', `${m.insights.aiCopy.displayScore}/100 (${m.insights.aiCopy.band})`);
      push('AI Copy Tells', m.insights.aiCopy.families.map((f) => f.label).join('; ') || 'None');
      push('AI Visibility Deduction (AI copy)', m.insights.aiCopy.penalty);
    }
    if (m.insights.vibeCode) {
      push('Build Quality Score', `${m.insights.vibeCode.buildScore}/100`);
      push('Vibe-Code Verdict', `${m.insights.vibeCode.band} (${m.insights.vibeCode.score}/100 confidence)`);
      push('Detected Builder', m.insights.vibeCode.builders.map((b) => b.name).join('; ') || 'None');
      push('Generated-Site Faults', m.insights.vibeCode.faults.map((f) => f.label).join('; ') || 'None');
      if (m.insights.vibeCode.servedWords != null) push('Words in Served HTML', scorlyServedWordsText(m.insights.vibeCode.servedWords, m.insights.vibeCode.renderedWords));
      push('AI Visibility Deduction (vibe code)', m.insights.vibeCode.penalty);
    }
    if (m.insights.trust) push('Content Trust Score', m.insights.trust.score);
    if (m.insights.freshness) push('Content Freshness Score', m.insights.freshness.score);
    if (m.insights.businessContext) push('Detected Business Name', m.insights.businessContext.siteName);
    if (m.insights.businessContext) push('Detected Locality', m.insights.businessContext.locality);
  }

  rows.push([]);
  rows.push(['Top Keywords', 'Count', '% of words']);
  (data.content.topKeywords || []).slice(0, 20).forEach((k) => rows.push([k.word, k.count, k.pct]));

  rows.push([]);
  rows.push(['Check', 'Category', 'Status', 'Severity', 'Detail']);
  m.allChecksSorted.forEach((c) => rows.push([c.label, CATEGORY_LABELS[c.category] || c.category, c.status, c.severity, c.detail]));

  if (m.sdIssues.length) {
    rows.push([]);
    rows.push(['Structured Data Issue', 'Severity', 'Message']);
    m.sdIssues.forEach((i) => rows.push([i.type, i.severity, i.message]));
  }

  if (m.problemImages.length) {
    rows.push([]);
    rows.push(['Image', 'Missing Alt', 'Oversized', 'Distorted', 'Legacy Format']);
    m.problemImages.forEach((i) => rows.push([displayImageSrc(i.src), i.missing, i.oversized, i.distorted, i.format && ['png', 'jpg', 'gif', 'bmp'].includes(i.format)]));
  }

  if (data.resources && data.resources.length) {
    rows.push([]);
    rows.push(['Request URL', 'Type', 'Transferred (bytes)', 'Duration (ms)', 'Render-Blocking']);
    data.resources.forEach((r) => rows.push([r.url, r.type, r.transferSize, r.duration, r.renderBlocking === null ? '' : r.renderBlocking]));
  }

  return rows.map((r) => r.map(csvEscape).join(',')).join('\r\n');
}

// ---------------------------------------------------------------------------
// Markdown report
// ---------------------------------------------------------------------------
function toMarkdown(data, scoreResult) {
  const m = buildReportModel(data, scoreResult);
  const insights = m.insights;
  const lines = [];
  const pct = (n) => (n == null ? 'not captured' : `${n}/100`);
  const msOr = (v) => (v != null ? (v >= 1000 ? (v / 1000).toFixed(1) + 's' : v + 'ms') : 'n/a');
  const yn = (b) => (b ? 'Yes' : 'No');
  const table = (head, rows) => {
    lines.push('| ' + head.join(' | ') + ' |');
    lines.push('| ' + head.map(() => '---').join(' | ') + ' |');
    rows.forEach((r) => lines.push('| ' + r.map((c) => String(c == null ? '' : c).replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ') + ' |'));
    lines.push('');
  };

  // ---- Cover ----
  lines.push('# Scorly SEO Report');
  lines.push('');
  lines.push(`**${data.url}**`);
  lines.push('');
  lines.push(`Analyzed ${new Date(data.analyzedAt).toLocaleString()} · Generated locally by [Scorly](https://github.com/dazecoop/scorly) — nothing on this page was sent anywhere.`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // ---- Executive summary ----
  lines.push(`## Overall score: ${pct(scoreResult.overallScore)}`);
  lines.push('');
  lines.push(`✕ ${scoreResult.counts.issues} issues · ! ${scoreResult.counts.warnings} warnings · ✓ ${scoreResult.counts.passed} passed`);
  lines.push('');
  table(['Category', 'Score'], Object.keys(CATEGORY_LABELS).map((k) => [CATEGORY_LABELS[k], pct(scoreResult.categoryScores[k])]));

  // ---- SERP preview ----
  lines.push('## SERP preview');
  lines.push('');
  lines.push('> ' + data.hostname + (new URL(data.url).pathname !== '/' ? ' › ' + new URL(data.url).pathname.split('/').filter(Boolean).join(' › ') : ''));
  lines.push('>');
  lines.push('> **' + (data.title.text || data.hostname) + '**');
  lines.push('>');
  lines.push('> ' + (data.metaDescription.text || data.firstParagraph || '_No description available._'));
  lines.push('');

  // ---- AI Insights ----
  if (insights) {
    lines.push('## AI Insights');
    lines.push('');
    lines.push(`**AI Visibility: ${pct(insights.aiVisibility)}** — how visible this page can be to AI answer engines (ChatGPT, Claude, Perplexity, Gemini): crawler access, machine-readable structure, trust signals and freshness. Computed locally from page signals — no AI involved.`);
    lines.push('');

    if (data.aiBotAccess) {
      lines.push('### AI crawler access (robots.txt)');
      lines.push('');
      table(['Crawler', 'Engine', 'Status'], data.aiBotAccess.map((b) => [b.bot, b.engine, b.allowed ? 'Allowed' : 'Blocked']));
      if (data.llmsTxt !== undefined) lines.push(`llms.txt: ${data.llmsTxt ? 'found at site root ✓' : 'not found (optional, emerging convention).'}`);
      lines.push('');
    }

    if (insights.businessContext && (insights.businessContext.captured || insights.businessContext.about)) {
      const bc = insights.businessContext;
      lines.push('### Domain business context');
      lines.push('');
      [['Site / business name', bc.siteName], ['Schema type', bc.schemaType], ['What this page is about', bc.about],
        ['Location', bc.locality], ['Telephone', bc.telephone],
        ['Social profiles', bc.socialProfiles && bc.socialProfiles.length ? bc.socialProfiles.join(', ') : null],
        ['Review platforms', bc.reviewPlatforms && bc.reviewPlatforms.length ? bc.reviewPlatforms.join(', ') : null]]
        .filter(([, v]) => v).forEach(([l, v]) => lines.push(`- **${l}**: ${v}`));
      lines.push('');
    }

    if (insights.aiCopy && insights.aiCopy.available) {
      const ac = insights.aiCopy;
      lines.push('### AI copy signals');
      lines.push('');
      lines.push(`**${ac.displayScore}/100 — ${ac.band}** (${ac.familyCount} tells found across ${ac.proseWords} words of prose${ac.penalty ? `, costing ${ac.penalty} AI Visibility points` : ', no deduction'}). Higher is better, as everywhere else in this report.`);
      lines.push('');
      lines.push('Matched against the surface tells catalogued in Wikipedia\u2019s *Signs of AI writing*. A high score matters because Google\u2019s spam policies discount mass-produced, low-added-value pages and AI answer engines cite sources that say something specific. No detector can prove authorship — the evidence is listed so it can be judged.');
      lines.push('');
      if (ac.families.length) {
        ac.families.forEach((f) => {
          lines.push(`- **${f.label}** (−${f.points}) — ${f.detail}`);
          if (f.samples && f.samples.length) lines.push(`  - Evidence: ${f.samples.map((x) => `\`${x}\``).join(', ')}`);
        });
      } else {
        lines.push('- None of the tracked AI writing patterns fired on this page.');
      }
      lines.push('');
    }

    if (insights.vibeCode) {
      const vc = insights.vibeCode;
      lines.push('### Vibe-code detection');
      lines.push('');
      lines.push(`**${vc.buildScore}/100** — ${vc.faults.length ? `${vc.faults.length} fault(s) costing ${vc.penalty} AI Visibility points` : 'no generated-site faults'}.`);
      lines.push('');
      lines.push(`**Verdict**: ${vc.band} (${vc.score}/100 confidence)${vc.builders.length ? ` — ${vc.builders.map((b) => b.name).join(', ')}` : ''}.`);
      lines.push('');
      lines.push('These are two separate things: an AI app-builder is not itself an SEO fault, so a generated site that server-renders and has real copy scores 100 above. Only the faults below deduct.');
      lines.push('');
      if (vc.servedWords != null) {
        lines.push(`**Served HTML**: ${scorlyServedWordsText(vc.servedWords, vc.renderedWords)} words are present before JavaScript runs — what a non-executing crawler sees.`);
        lines.push('');
      }
      lines.push('**Faults that cost visibility**');
      lines.push('');
      if (vc.faults.length) vc.faults.forEach((f) => lines.push(`- **${f.label}** (−${f.points}) — ${f.detail}`));
      else lines.push('- None — whatever built this page, it did not leave the usual visibility problems behind.');
      lines.push('');
      if (vc.signals.length) {
        lines.push('**Detection evidence**');
        lines.push('');
        vc.signals.forEach((f) => lines.push(`- **${f.label}** (${f.strength} evidence) — ${f.detail}`));
        lines.push('');
      }
    }

    lines.push('### Content strengths & weaknesses');
    lines.push('');
    lines.push('**Strengths**');
    lines.push('');
    (insights.strengths.length ? insights.strengths : [{ label: 'None stood out', detail: '' }])
      .forEach((s) => lines.push(`- **${s.label}** — ${s.detail}`));
    lines.push('');
    lines.push('**Weaknesses**');
    lines.push('');
    (insights.weaknesses.length ? insights.weaknesses : [{ label: 'None detected', detail: '' }])
      .forEach((s) => lines.push(`- **${s.label}** — ${s.detail}`));
    lines.push('');

    if (insights.trust) {
      lines.push(`### Content trust score: ${insights.trust.score}%`);
      lines.push('');
      table(['Signal', 'Score', 'What it checks'], insights.trust.subs.map((s) => [s.label, s.score + '%', s.detail]));
    }

    if (insights.freshness) {
      lines.push(`### Content freshness: ${insights.freshness.score}%`);
      lines.push('');
      insights.freshness.positives.forEach((p) => lines.push(`- ✓ ${p}`));
      insights.freshness.negatives.forEach((n) => lines.push(`- ! ${n}`));
      lines.push('');
    }

    if (insights.opportunities.length) {
      lines.push('### Content opportunities');
      lines.push('');
      insights.opportunities.forEach((o, i) => lines.push(`${i + 1}. ${o}`));
      lines.push('');
    }
  }

  // ---- Meta ----
  lines.push('## Meta & technical tags');
  lines.push('');
  table(['Field', 'Value'], [
    ['Title', `${data.title.text || '_missing_'} (${data.title.length} chars${data.title.pixels ? `, ≈${data.title.pixels}px` : ''})`],
    ['Meta description', `${data.metaDescription.text || '_missing_'} (${data.metaDescription.length} chars${data.metaDescription.pixels ? `, ≈${data.metaDescription.pixels}px` : ''})`],
    ['Canonical', data.canonical || '_missing_'],
    ['Robots meta', data.robotsMeta || 'index, follow (default)'],
    ['Viewport', data.viewport || '_missing_'],
    ['Charset', data.charset || '_missing_'],
    ['Language', data.lang || '_missing_'],
    ['Favicon', data.faviconOk === undefined ? (data.favicon || '_missing_') : (data.faviconOk ? 'Present ✓' : 'Missing or not loading'),
    ],
    ['DOCTYPE', yn(data.hasDoctype)],
    ['robots.txt', yn(data.robotsTxt)],
    ['sitemap.xml', yn(data.sitemapXml)],
    ['llms.txt', data.llmsTxt === undefined ? 'n/a' : yn(data.llmsTxt)],
  ]);

  // ---- Social preview ----
  const hasOg = Object.keys(data.og.raw || {}).length > 0;
  const hasTw = Object.keys(data.twitter.raw || {}).length > 0;
  if (hasOg || hasTw) {
    lines.push('## Social preview tags');
    lines.push('');
    if (hasOg) table(['Open Graph tag', 'Value'], Object.entries(data.og.raw));
    if (hasTw) table(['Twitter Card tag', 'Value'], Object.entries(data.twitter.raw));
  }

  // ---- Headings ----
  lines.push('## Heading structure');
  lines.push('');
  lines.push(`H1: ${data.headings.counts.h1} · H2: ${data.headings.counts.h2} · H3: ${data.headings.counts.h3} · H4: ${data.headings.counts.h4} · H5: ${data.headings.counts.h5} · H6: ${data.headings.counts.h6}` + (data.headings.duplicateCount ? ` · ${data.headings.duplicateCount} duplicate text(s)` : ''));
  lines.push('');
  if (data.headings.list.length) {
    data.headings.list.slice(0, 80).forEach((h) => lines.push(`${'  '.repeat(h.level - 1)}- H${h.level}: ${h.text || '_(empty)_'}`));
    if (data.headings.list.length > 80) lines.push(`- _…and ${data.headings.list.length - 80} more._`);
  } else {
    lines.push('_No heading tags found._');
  }
  lines.push('');

  // ---- Content ----
  lines.push('## Content analysis');
  lines.push('');
  const c = data.content;
  lines.push(`${c.wordCount} words · ${c.readTimeMin} min read · ${c.paragraphCount} paragraphs · ${c.sentenceCount} sentences · avg ${c.avgSentenceLength} words/sentence · Flesch readability ≈${c.readability}/100` +
    (c.duplicateParagraphCount ? ` · ${c.duplicateParagraphCount} duplicate paragraph(s)` : '') + (c.emptyBoldCount ? ` · ${c.emptyBoldCount} empty bold/strong tag(s)` : ''));
  lines.push('');
  if (c.topKeywords && c.topKeywords.length) {
    lines.push('### Top keywords');
    lines.push('');
    table(['Keyword', 'Count', '% of words'], c.topKeywords.slice(0, 20).map((k) => [k.word, k.count, k.pct + '%']));
  }

  // ---- Images ----
  lines.push('## Images');
  lines.push('');
  lines.push(`${data.images.total} total · ${data.images.missingAlt} missing alt · ${data.images.oversized ?? '—'} oversized · ${data.images.distorted ?? '—'} distorted · ${data.images.legacyFormat ?? '—'} legacy format (PNG/JPG/GIF) · ${data.images.missingDimensions ?? '—'} missing width/height · ${data.images.lazyLoaded ?? '—'} lazy-loaded`);
  lines.push('');
  if (m.problemImages.length) {
    table(['Image', 'Issue(s)'], m.problemImages.slice(0, 30).map((i) => {
      const flags = [];
      if (i.missing) flags.push('missing alt');
      if (i.oversized) flags.push('oversized');
      if (i.distorted) flags.push('distorted');
      if (i.hasExplicitSize === false) flags.push('no width/height');
      if (i.format && ['png', 'jpg', 'gif', 'bmp'].includes(i.format)) flags.push('legacy format');
      return [displayImageSrc(i.src), flags.join(', ')];
    }));
    if (m.problemImages.length > 30) lines.push(`_…and ${m.problemImages.length - 30} more image(s) with issues._`, '');
  }

  // ---- Links ----
  lines.push('## Links');
  lines.push('');
  lines.push(`${data.links.internal} internal · ${data.links.external} external · ${data.links.nofollow} nofollow · ${data.links.missingAnchorText} missing anchor text`);
  lines.push('');
  if (data.linkCheck) {
    lines.push(`Checked ${data.linkCheck.checked} of ${data.linkCheck.total} internal links: ${data.linkCheck.broken} broken, ${data.linkCheck.redirected} redirected.`);
    lines.push('');
    if (m.linkProblems.length) {
      table(['URL', 'Result'], m.linkProblems.slice(0, 40).map((r) => [r.url, r.skipped ? 'Skipped (time budget)' : r.error ? 'Unreachable' : r.ok ? `${r.status} via redirect${r.redirectedTo ? ' → ' + r.redirectedTo : ''}` : `HTTP ${r.status}`]));
      if (m.linkProblems.length > 40) lines.push(`_…and ${m.linkProblems.length - 40} more._`, '');
    }
  }
  if (data.wwwRedirect) {
    const wr = data.wwwRedirect;
    lines.push(wr.unreachable ? `${wr.altHost} is not reachable — no duplicate-content risk.`
      : wr.duplicate ? `⚠ ${wr.altHost} serves content without redirecting to ${data.hostname} — duplicate-content risk.`
      : `${wr.altHost} redirects correctly to ${data.hostname}.`);
    lines.push('');
  }

  // ---- Structured data ----
  lines.push('## Structured data');
  lines.push('');
  lines.push(data.jsonLdTypes.length ? `Types found: ${data.jsonLdTypes.join(', ')}` : '_No structured data found._');
  lines.push('');
  if (m.sdIssues.length) {
    table(['Severity', 'Type', 'Message'], m.sdIssues.map((i) => [i.severity.toUpperCase(), i.type, i.message]));
  }

  // ---- Performance ----
  lines.push('## Performance');
  lines.push('');
  const p = data.perf;
  table(['Metric', 'Value', 'Google band'], [
    ['TTFB', msOr(p.ttfb), '< 0.8s good'],
    ['First Contentful Paint', msOr(p.fcp), '< 1.8s good'],
    ['Largest Contentful Paint', msOr(p.lcp), '< 2.5s good'],
    ['Cumulative Layout Shift', p.cls != null ? p.cls : 'n/a', '< 0.1 good'],
    ['Total Blocking Time (approx)', msOr(p.tbt), '< 200ms good'],
    ['Interaction to Next Paint', msOr(p.inp), '< 200ms good'],
  ]);
  lines.push(`${p.requestCount} requests · ${(p.transferSize / 1024).toFixed(0)} KB transferred · ${p.renderBlockingCount ?? '—'} render-blocking · ${m.thirdPartyOrigins} third-party origin(s) · protocol ${(p.nextHopProtocol || 'n/a').toUpperCase()}`);
  lines.push('');
  if (data.hygiene) {
    const hy = data.hygiene;
    lines.push(`DOM size: ${hy.domSize.toLocaleString()} elements · HTML compression: ${hy.compression ? (hy.compression.compressed ? 'enabled ✓' : 'not enabled') : 'n/a'} · CDN: ${hy.cdns.length ? hy.cdns.join(', ') : 'none detected'} · Analytics: ${hy.analytics.length ? hy.analytics.join(', ') : 'none detected'}`);
    lines.push('');
  }
  if (data.assetCheck) {
    lines.push(`Sampled ${data.assetCheck.checked} static asset(s): ${data.assetCheck.uncached} without caching headers, ${data.assetCheck.unminified} of ${data.assetCheck.codeChecked} script/style files look unminified.`);
    lines.push('');
  }
  if (m.heaviestRequests.length) {
    lines.push('### Heaviest requests');
    lines.push('');
    table(['URL', 'Type', 'Size', 'Duration'], m.heaviestRequests.map((r) => [r.url, r.type, r.transferSize ? (r.transferSize / 1024).toFixed(1) + ' KB' : 'cache', r.duration != null ? r.duration + 'ms' : '']));
  }

  // ---- Security ----
  lines.push('## Security');
  lines.push('');
  lines.push(`HTTPS: ${yn(data.security.https)} · Mixed content: ${data.security.mixedContentCount} · Secure context: ${yn(data.security.isSecureContext)}`);
  lines.push('');
  if (data.securityHeaders) {
    table(['Header', 'Value'], [
      ['Strict-Transport-Security', data.securityHeaders.hsts || 'Not set'],
      ['Content-Security-Policy', data.securityHeaders.csp ? 'Set' : 'Not set'],
      ['X-Content-Type-Options', data.securityHeaders.xContentTypeOptions || 'Not set'],
      ['X-Frame-Options', data.securityHeaders.xFrameOptions || 'Not set'],
      ...('referrerPolicy' in data.securityHeaders ? [['Referrer-Policy', data.securityHeaders.referrerPolicy || 'Not set'], ['Permissions-Policy', data.securityHeaders.permissionsPolicy ? 'Set' : 'Not set']] : []),
    ]);
  }
  if (data.hygiene) {
    lines.push(`Unsafe cross-origin links (target="_blank" without rel="noopener/noreferrer"): ${data.hygiene.unsafeCrossOrigin} · Plaintext email addresses: ${data.hygiene.textEmails.length}`);
    lines.push('');
  }

  // ---- Mobile ----
  if (data.mobile) {
    lines.push('## Mobile');
    lines.push('');
    const parts = [];
    if (data.mobile.tapTargets) parts.push(tapTargetSummary(data.mobile.tapTargets));
    if (data.mobile.fontSizes) parts.push(`${data.mobile.fontSizes.small} of ${data.mobile.fontSizes.checked} sampled text elements smaller than 12px`);
    if (data.hygiene && data.hygiene.mediaQueries) parts.push(`${data.hygiene.mediaQueries.count} @media rule(s) in ${data.hygiene.mediaQueries.readable} readable stylesheet(s)`);
    lines.push(parts.join(' · '));
    lines.push('');
  }

  // ---- Accessibility ----
  if (data.a11y) {
    lines.push('## Accessibility');
    lines.push('');
    lines.push(a11ySummary(data.a11y).join(' · '));
    lines.push('');
    if (data.a11y.contrast.samples.length) {
      table(['Text', 'Contrast', 'Colours'], data.a11y.contrast.samples.map((x) => [x.text, `${x.ratio}:1 (needs ${x.need}:1)`, `${x.fg} on ${x.bg}`]));
    }
  }

  // ---- Full checklist appendix ----
  lines.push('## Full checklist');
  lines.push('');
  lines.push('Every automated check, worst severity first within each group.');
  lines.push('');
  ['fail', 'warn', 'pass'].forEach((status) => {
    const group = m.allChecksSorted.filter((c) => c.status === status);
    const title = status === 'fail' ? `✕ Issues (${group.length})` : status === 'warn' ? `! Warnings (${group.length})` : `✓ Passed (${group.length})`;
    lines.push(`### ${title}`);
    lines.push('');
    if (!group.length) {
      lines.push('_None._', '');
      return;
    }
    group.forEach((c) => lines.push(`- **${c.label}** [${(c.severity || 'low').toUpperCase()} · ${CATEGORY_LABELS[c.category] || c.category}] — ${c.detail}`));
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

// ---------------------------------------------------------------------------
// PDF report — a real report layout (letterhead, score banner, tables),
// not a text dump. Core jsPDF only (no autotable plugin bundled), so the
// table/checklist drawing below is hand-rolled but shared across sections.
// ---------------------------------------------------------------------------
function exportPdf(data, scoreResult) {
  const m = buildReportModel(data, scoreResult);
  const insights = m.insights;
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const marginX = 40;
  const contentWidth = pageWidth - marginX * 2;
  const bottomLimit = pageHeight - 46;
  let y = 50;

  // jsPDF's built-in fonts (Helvetica etc.) only have WinAnsi/CP1252 glyphs —
  // check text (from scoring.js) and page content can contain Unicode symbols
  // outside that set, which render as garbled boxes. Every piece of dynamic
  // text drawn into the PDF is routed through this first.
  function pdfSafe(text) {
    return String(text == null ? '' : text)
      .replace(/≈/g, '~')
      .replace(/✓/g, '[OK]')
      .replace(/✕|✗/g, 'x')
      .replace(/⚠/g, '!')
      .replace(/→/g, '->');
  }

  const COLOR = {
    accent: [79, 70, 229], text: [26, 29, 41], muted: [110, 116, 128],
    border: [228, 230, 236], surface: [248, 249, 251], white: [255, 255, 255],
    pass: [22, 163, 74], warn: [217, 119, 6], fail: [220, 38, 38],
  };
  const statusColor = (status) => (status === 'pass' ? COLOR.pass : status === 'warn' ? COLOR.warn : COLOR.fail);
  const bandColor = (score) => (score >= 80 ? COLOR.pass : score >= 50 ? COLOR.warn : COLOR.fail);

  function ensureSpace(h) {
    if (y + h > bottomLimit) { doc.addPage(); y = 50; }
  }

  function heading(text, size) {
    ensureSpace(size + 28);
    y += 14; // breathing room above a section title, even right after a table
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(size);
    doc.setTextColor(...COLOR.text);
    doc.text(text, marginX, y);
    y += 6;
    doc.setDrawColor(...COLOR.accent);
    doc.setLineWidth(1.4);
    doc.line(marginX, y, marginX + 28, y);
    y += size + 6;
  }

  function subheading(text) {
    ensureSpace(24);
    y += 8;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    doc.setTextColor(...COLOR.accent);
    doc.text(text.toUpperCase(), marginX, y);
    y += 15;
  }

  function paragraph(text, size, color, opts) {
    doc.setFont('helvetica', (opts && opts.bold) ? 'bold' : 'normal');
    doc.setFontSize(size || 10);
    doc.setTextColor(color ? color[0] : 80, color ? color[1] : 80, color ? color[2] : 90);
    const lines = doc.splitTextToSize(pdfSafe(text), contentWidth);
    lines.forEach((line) => {
      ensureSpace((size || 10) + 4);
      doc.text(line, marginX, y);
      y += (size || 10) + 4;
    });
  }

  function bullet(text, size) {
    ensureSpace((size || 9.5) + 5);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(size || 9.5);
    doc.setTextColor(...COLOR.text);
    const lines = doc.splitTextToSize('•  ' + pdfSafe(text), contentWidth - 6);
    lines.forEach((line, i) => {
      if (i > 0) ensureSpace((size || 9.5) + 3);
      doc.text(line, marginX + (i > 0 ? 10 : 0), y);
      y += (size || 9.5) + 3;
    });
  }

  function spacer(h) { y += h; }

  // A compact two-column label/value fact sheet (meta tags, business context…).
  function factSheet(pairs) {
    const labelW = 150;
    pairs.forEach(([label, value]) => {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.setTextColor(...COLOR.muted);
      const valueLines = doc.splitTextToSize(value == null || value === '' ? '—' : pdfSafe(value), contentWidth - labelW);
      const h = Math.max(valueLines.length * 12, 13);
      ensureSpace(h + 3);
      doc.text(pdfSafe(label).toUpperCase(), marginX, y);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9.5);
      doc.setTextColor(...COLOR.text);
      valueLines.forEach((ln, i) => doc.text(ln, marginX + labelW, y + i * 12));
      y += h + 3;
    });
    spacer(4);
  }

  // Generic table: headers + rows, column widths given as weights (not pt).
  function table(head, rows, weights, opts) {
    opts = opts || {};
    const fontSize = opts.fontSize || 9;
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const colW = weights.map((w) => (w / totalWeight) * contentWidth);
    const colX = (i) => marginX + colW.slice(0, i).reduce((a, b) => a + b, 0);
    const padX = 5, padY = 4, lineH = fontSize + 3;

    function drawHead() {
      ensureSpace(lineH + padY * 2 + 4);
      doc.setFillColor(...COLOR.accent);
      doc.rect(marginX, y, contentWidth, lineH + padY * 2, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(fontSize);
      doc.setTextColor(...COLOR.white);
      head.forEach((h, i) => doc.text(String(h), colX(i) + padX, y + padY + fontSize - 1));
      y += lineH + padY * 2;
    }

    if (!rows.length) {
      drawHead();
      paragraph(opts.emptyText || 'None.', 9, COLOR.muted);
      spacer(6);
      return;
    }

    drawHead();
    rows.forEach((row, rIdx) => {
      const wrapped = row.map((c, i) => doc.splitTextToSize(pdfSafe(c), colW[i] - padX * 2));
      const h = Math.max(...wrapped.map((w) => w.length), 1) * lineH + padY * 2;
      if (y + h > bottomLimit) { doc.addPage(); y = 50; drawHead(); }
      if (rIdx % 2 === 1) { doc.setFillColor(...COLOR.surface); doc.rect(marginX, y, contentWidth, h, 'F'); }
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(fontSize);
      wrapped.forEach((lines, i) => {
        const custom = opts.cellColor ? opts.cellColor(rIdx, i, row[i]) : null;
        doc.setTextColor(...(custom || COLOR.text));
        lines.forEach((ln, li) => doc.text(ln, colX(i) + padX, y + padY + fontSize - 1 + li * lineH));
      });
      y += h;
    });
    spacer(8);
  }

  // Popup-style checklist: colored status dot, bold label + severity badge, gray detail.
  function checklist(checks) {
    scorlySortChecks(checks).forEach((c) => {
      ensureSpace(26);
      const col = statusColor(c.status);
      doc.setFillColor(...col);
      doc.circle(marginX + 4, y - 3, 3, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9.5);
      doc.setTextColor(...COLOR.text);
      doc.text(pdfSafe(c.label), marginX + 14, y);
      const sevW = doc.getTextWidth((c.severity || 'low').toUpperCase()) + 10;
      doc.setFillColor(...col);
      doc.roundedRect(pageWidth - marginX - sevW, y - 9, sevW, 12, 2, 2, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7);
      doc.setTextColor(...COLOR.white);
      doc.text((c.severity || 'low').toUpperCase(), pageWidth - marginX - sevW + 5, y - 0.5);
      y += 12;
      if (c.detail) paragraph(pdfSafe(c.detail), 8.5, COLOR.muted);
      y += 4;
    });
  }

  function scoreBarRow(label, score) {
    ensureSpace(18);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(60, 60, 70);
    doc.text(label, marginX, y);
    const barX = marginX + 130, barW = contentWidth - 130 - 34;
    doc.setFillColor(...COLOR.surface);
    doc.roundedRect(barX, y - 8, barW, 10, 3, 3, 'F');
    doc.setFillColor(...bandColor(score));
    doc.roundedRect(barX, y - 8, Math.max(6, (barW * score) / 100), 10, 3, 3, 'F');
    doc.setTextColor(...COLOR.text);
    doc.setFont('helvetica', 'bold');
    doc.text(String(score), barX + barW + 8, y);
    y += 18;
  }

  // =========================================================================
  // Cover / letterhead
  // =========================================================================
  doc.setFillColor(...COLOR.accent);
  doc.rect(0, 0, pageWidth, 92, 'F');
  doc.setTextColor(...COLOR.white);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(24);
  doc.text('Scorly', marginX, 42);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.text('SEO & AI Visibility Report', marginX, 60);
  doc.setFontSize(10.5);
  doc.text(pdfSafe(data.url), marginX, 78);
  doc.setFontSize(8.5);
  doc.text('Generated ' + new Date(data.analyzedAt).toLocaleString(), pageWidth - marginX, 78, { align: 'right' });
  y = 118;

  // =========================================================================
  // Executive summary
  // =========================================================================
  ensureSpace(50);
  doc.setFillColor(...bandColor(scoreResult.overallScore));
  doc.roundedRect(marginX, y, contentWidth, 42, 6, 6, 'F');
  doc.setTextColor(...COLOR.white);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(19);
  doc.text(`Overall SEO Score: ${scoreResult.overallScore}/100`, marginX + 16, y + 27);
  y += 54;

  // Three stat tiles: issues / warnings / passed.
  const tileW = (contentWidth - 16) / 3;
  const tiles = [
    ['ISSUES', scoreResult.counts.issues, COLOR.fail],
    ['WARNINGS', scoreResult.counts.warnings, COLOR.warn],
    ['PASSED', scoreResult.counts.passed, COLOR.pass],
  ];
  ensureSpace(46);
  tiles.forEach(([label, n, col], i) => {
    const x = marginX + i * (tileW + 8);
    doc.setDrawColor(...COLOR.border);
    doc.setFillColor(...COLOR.surface);
    doc.roundedRect(x, y, tileW, 40, 5, 5, 'FD');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(16);
    doc.setTextColor(...col);
    doc.text(String(n), x + 12, y + 24);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(...COLOR.muted);
    doc.text(label, x + 12, y + 34);
  });
  y += 56;

  heading('Category Scores', 13);
  Object.keys(CATEGORY_LABELS).forEach((key) => { if (scoreResult.categoryScores[key] != null) scoreBarRow(CATEGORY_LABELS[key], scoreResult.categoryScores[key]); });
  spacer(6);

  // =========================================================================
  // SERP preview
  // =========================================================================
  heading('SERP Preview', 13);
  ensureSpace(62);
  doc.setDrawColor(...COLOR.border);
  doc.setFillColor(...COLOR.white);
  doc.roundedRect(marginX, y, contentWidth, 56, 5, 5, 'D');
  const path = (() => { try { const u = new URL(data.url); return u.hostname + (u.pathname !== '/' ? ' › ' + u.pathname.split('/').filter(Boolean).join(' › ') : ''); } catch (e) { return data.hostname; } })();
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(50, 60, 50);
  doc.text(pdfSafe(path), marginX + 12, y + 16);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(26, 13, 171);
  doc.text(doc.splitTextToSize(pdfSafe(data.title.text || data.hostname), contentWidth - 24)[0], marginX + 12, y + 32);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...COLOR.muted);
  doc.text(doc.splitTextToSize(pdfSafe(data.metaDescription.text || data.firstParagraph || 'No description available.'), contentWidth - 24).slice(0, 2), marginX + 12, y + 46);
  y += 70;

  // =========================================================================
  // AI Insights
  // =========================================================================
  if (insights) {
    doc.addPage(); y = 50;
    heading('AI Insights', 16);
    ensureSpace(50);
    doc.setFillColor(...bandColor(insights.aiVisibility));
    doc.roundedRect(marginX, y, 90, 34, 5, 5, 'F');
    doc.setTextColor(...COLOR.white); doc.setFont('helvetica', 'bold'); doc.setFontSize(18);
    doc.text(String(insights.aiVisibility), marginX + 45, y + 22, { align: 'center' });
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...COLOR.text);
    doc.splitTextToSize('AI Visibility — how visible this page can be to AI answer engines (ChatGPT, Claude, Perplexity, Gemini): crawler access, machine-readable structure, trust signals and freshness. Computed locally — no AI involved.', contentWidth - 104)
      .forEach((ln, i) => doc.text(ln, marginX + 100, y + 10 + i * 11));
    y += 54;

    if (data.aiBotAccess) {
      subheading('AI crawler access (robots.txt)');
      table(['Crawler', 'Engine', 'Status'], data.aiBotAccess.map((b) => [b.bot, b.engine, b.allowed ? 'Allowed' : 'Blocked']),
        [1, 1.6, 1], { cellColor: (r, i, v) => (i === 2 ? (v === 'Blocked' ? COLOR.fail : COLOR.pass) : null) });
      if (data.llmsTxt !== undefined) paragraph(`llms.txt: ${data.llmsTxt ? 'found at site root [OK]' : 'not found (optional, emerging convention).'}`, 8.5, COLOR.muted);
      spacer(6);
    }

    const bc = insights.businessContext;
    if (bc && (bc.captured || bc.about)) {
      subheading('Domain business context');
      factSheet([
        ['Site / business name', bc.siteName], ['Schema type', bc.schemaType], ['About', bc.about],
        ['Location', bc.locality], ['Telephone', bc.telephone],
        ['Social profiles', bc.socialProfiles && bc.socialProfiles.length ? bc.socialProfiles.join(', ') : null],
        ['Review platforms', bc.reviewPlatforms && bc.reviewPlatforms.length ? bc.reviewPlatforms.join(', ') : null],
      ].filter(([, v]) => v));
    }

    if (insights.aiCopy && insights.aiCopy.available) {
      const ac = insights.aiCopy;
      subheading(`AI copy signals — ${ac.displayScore}/100, ${ac.band}`);
      paragraph(`${ac.familyCount} tells found across ${ac.proseWords} words of prose${ac.penalty ? `, costing ${ac.penalty} AI Visibility points` : ', no deduction'}. Higher is better. Matched against the surface tells catalogued in Wikipedia's "Signs of AI writing". No detector can prove authorship — the evidence is listed so it can be judged.`, 8.5, COLOR.muted);
      if (ac.families.length) {
        ac.families.forEach((f) => bullet(`${f.label} (-${f.points}) — ${f.detail}${f.samples && f.samples.length ? ` Evidence: ${f.samples.join('; ')}` : ''}`));
      } else {
        bullet('None of the tracked AI writing patterns fired on this page.');
      }
      spacer(6);
    }

    if (insights.vibeCode) {
      const vc = insights.vibeCode;
      subheading(`Vibe-code detection — ${vc.buildScore}/100 build quality; verdict ${vc.band} (${vc.score}/100 confidence)`);
      paragraph(`${vc.builders.length ? `Builder: ${vc.builders.map((b) => b.name).join(', ')}. ` : ''}${vc.servedWords != null ? `A non-JavaScript crawler sees ${scorlyServedWordsText(vc.servedWords, vc.renderedWords).replace(/^All/, 'all')} words. ` : ''}An AI app-builder is not itself an SEO fault — only the faults below deduct${vc.penalty ? ` (${vc.penalty} AI Visibility points)` : ' (none here)'}.`, 8.5, COLOR.muted);
      if (vc.faults.length) vc.faults.forEach((f) => bullet(`${f.label} (-${f.points}) — ${f.detail}`));
      else bullet('No generated-site faults — whatever built this page, it did not leave the usual visibility problems behind.');
      if (vc.signals.length) vc.signals.slice(0, 8).forEach((f) => bullet(`Evidence: ${f.label} (${f.strength}) — ${f.detail}`));
      spacer(6);
    }

    subheading('Content strengths');
    (insights.strengths.length ? insights.strengths : [{ label: 'None stood out', detail: '' }]).forEach((s) => bullet(`${s.label} — ${s.detail}`));
    spacer(6);
    subheading('Content weaknesses');
    (insights.weaknesses.length ? insights.weaknesses : [{ label: 'None detected', detail: '' }]).forEach((s) => bullet(`${s.label} — ${s.detail}`));
    spacer(6);

    if (insights.trust) {
      subheading(`Content trust score — ${insights.trust.score}%`);
      insights.trust.subs.forEach((s) => scoreBarRow(s.label, s.score));
      spacer(6);
    }
    if (insights.freshness) {
      subheading(`Content freshness — ${insights.freshness.score}%`);
      insights.freshness.positives.forEach((p) => bullet(p));
      insights.freshness.negatives.forEach((n) => bullet(n));
      spacer(6);
    }
    if (insights.opportunities.length) {
      subheading('Content opportunities');
      insights.opportunities.forEach((o) => bullet(o));
      spacer(6);
    }

    subheading('AI SEO checks');
    checklist(scoreResult.categories.aiSeo);
  }

  // =========================================================================
  // Meta & social
  // =========================================================================
  doc.addPage(); y = 50;
  heading('Meta & Technical Tags', 16);
  factSheet([
    ['Title', `${data.title.text || '(missing)'} — ${data.title.length} chars${data.title.pixels ? `, ~${data.title.pixels}px` : ''}`],
    ['Meta description', `${data.metaDescription.text || '(missing)'} — ${data.metaDescription.length} chars${data.metaDescription.pixels ? `, ~${data.metaDescription.pixels}px` : ''}`],
    ['Canonical', data.canonical || '(missing)'],
    ['Robots meta', data.robotsMeta || 'index, follow (default)'],
    ['Viewport', data.viewport || '(missing)'],
    ['Charset', data.charset], ['Language', data.lang],
    ['Favicon', data.faviconOk === undefined ? data.favicon : (data.faviconOk ? 'Present' : 'Missing or not loading')],
    ['DOCTYPE', data.hasDoctype ? 'Declared' : 'Missing'],
    ['robots.txt', data.robotsTxt ? 'Found' : 'Not found'],
    ['sitemap.xml', data.sitemapXml ? 'Found' : 'Not found'],
    ['llms.txt', data.llmsTxt === undefined ? 'n/a' : (data.llmsTxt ? 'Found' : 'Not found')],
  ]);

  const hasOg = Object.keys(data.og.raw || {}).length > 0;
  const hasTw = Object.keys(data.twitter.raw || {}).length > 0;
  if (hasOg || hasTw) {
    heading('Social Preview Tags', 14);
    if (hasOg) { subheading('Open Graph'); table(['Tag', 'Value'], Object.entries(data.og.raw), [1, 2.4]); }
    if (hasTw) { subheading('Twitter Card'); table(['Tag', 'Value'], Object.entries(data.twitter.raw), [1, 2.4]); }
  }

  // =========================================================================
  // Headings
  // =========================================================================
  heading('Heading Structure', 16);
  paragraph(`H1: ${data.headings.counts.h1}  H2: ${data.headings.counts.h2}  H3: ${data.headings.counts.h3}  H4: ${data.headings.counts.h4}  H5: ${data.headings.counts.h5}  H6: ${data.headings.counts.h6}` +
    (data.headings.duplicateCount ? `  ·  ${data.headings.duplicateCount} duplicate text(s)` : ''), 9.5, COLOR.text, { bold: true });
  spacer(4);
  if (data.headings.list.length) {
    data.headings.list.slice(0, 70).forEach((h) => {
      ensureSpace(13);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(...COLOR.accent);
      doc.text('H' + h.level, marginX + (h.level - 1) * 10, y);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...COLOR.text);
      doc.text(doc.splitTextToSize(pdfSafe(h.text || '(empty)'), contentWidth - (h.level - 1) * 10 - 22)[0], marginX + (h.level - 1) * 10 + 18, y);
      y += 13;
    });
    if (data.headings.list.length > 70) paragraph(`…and ${data.headings.list.length - 70} more.`, 8.5, COLOR.muted);
  } else {
    paragraph('No heading tags found.', 9.5, COLOR.muted);
  }
  spacer(8);

  // =========================================================================
  // Content analysis
  // =========================================================================
  heading('Content Analysis', 16);
  const cnt = data.content;
  paragraph(`${cnt.wordCount} words  ·  ${cnt.readTimeMin} min read  ·  ${cnt.paragraphCount} paragraphs  ·  ${cnt.sentenceCount} sentences  ·  avg ${cnt.avgSentenceLength} words/sentence  ·  Flesch readability ~${cnt.readability}/100` +
    (cnt.duplicateParagraphCount ? `  ·  ${cnt.duplicateParagraphCount} duplicate paragraph(s)` : '') + (cnt.emptyBoldCount ? `  ·  ${cnt.emptyBoldCount} empty bold/strong tag(s)` : ''), 9.5);
  spacer(4);
  if (cnt.topKeywords && cnt.topKeywords.length) {
    subheading('Top keywords');
    table(['Keyword', 'Count', '% of words'], cnt.topKeywords.slice(0, 20).map((k) => [k.word, k.count, k.pct + '%']), [2, 1, 1]);
  }

  // =========================================================================
  // Images
  // =========================================================================
  heading('Images', 16);
  paragraph(`${data.images.total} total  ·  ${data.images.missingAlt} missing alt  ·  ${data.images.oversized ?? '—'} oversized  ·  ${data.images.distorted ?? '—'} distorted  ·  ${data.images.legacyFormat ?? '—'} legacy format  ·  ${data.images.missingDimensions ?? '—'} missing dimensions  ·  ${data.images.lazyLoaded ?? '—'} lazy-loaded`, 9.5);
  spacer(4);
  table(['Image', 'Issue(s)'], m.problemImages.slice(0, 30).map((i) => {
    const flags = [];
    if (i.missing) flags.push('missing alt');
    if (i.oversized) flags.push('oversized');
    if (i.distorted) flags.push('distorted');
    if (i.hasExplicitSize === false) flags.push('no width/height');
    if (i.format && ['png', 'jpg', 'gif', 'bmp'].includes(i.format)) flags.push('legacy format');
    return [displayImageSrc(i.src), flags.join(', ')];
  }), [2.6, 1.4], { fontSize: 8, emptyText: 'No flagged images.' });
  if (m.problemImages.length > 30) paragraph(`…and ${m.problemImages.length - 30} more image(s) with issues.`, 8.5, COLOR.muted);

  // =========================================================================
  // Links
  // =========================================================================
  heading('Links', 16);
  paragraph(`${data.links.internal} internal  ·  ${data.links.external} external  ·  ${data.links.nofollow} nofollow  ·  ${data.links.missingAnchorText} missing anchor text`, 9.5);
  if (data.linkCheck) {
    paragraph(`Checked ${data.linkCheck.checked} of ${data.linkCheck.total} internal links: ${data.linkCheck.broken} broken, ${data.linkCheck.redirected} redirected.`, 9);
    spacer(4);
    table(['URL', 'Result'], m.linkProblems.slice(0, 40).map((r) => [r.url, r.skipped ? 'Skipped' : r.error ? 'Unreachable' : r.ok ? `${r.status} via redirect` : `HTTP ${r.status}`]),
      [2.6, 1.2], { fontSize: 8, emptyText: 'Every checked internal link responds OK with no redirects.' });
  }
  if (data.wwwRedirect) {
    const wr = data.wwwRedirect;
    paragraph(wr.unreachable ? `${wr.altHost} is not reachable — no duplicate-content risk.`
      : wr.duplicate ? `[!] ${wr.altHost} serves content without redirecting to ${data.hostname} — duplicate-content risk.`
      : `${wr.altHost} redirects correctly to ${data.hostname}.`, 9, wr.duplicate ? COLOR.fail : COLOR.muted);
  }

  // =========================================================================
  // Structured data
  // =========================================================================
  heading('Structured Data', 16);
  paragraph(data.jsonLdTypes.length ? `Types found: ${data.jsonLdTypes.join(', ')}` : 'No structured data found.', 9.5);
  spacer(4);
  if (m.sdIssues.length) {
    table(['Severity', 'Type', 'Message'], m.sdIssues.map((i) => [i.severity.toUpperCase(), i.type, i.message]), [0.7, 1, 2.6],
      { fontSize: 8.5, cellColor: (r, i, v) => (i === 0 ? (v === 'ERROR' ? COLOR.fail : COLOR.warn) : null) });
  }

  // =========================================================================
  // Performance
  // =========================================================================
  heading('Performance', 16);
  const vitalRow = (metric, label, value) => {
    const status = (typeof scorlyVitalStatus === 'function') ? scorlyVitalStatus(metric, value) : null;
    const display = value == null ? 'n/a' : (metric === 'cls' ? String(value) : (value >= 1000 ? (value / 1000).toFixed(1) + 's' : value + 'ms'));
    return [label, display, status ? status.toUpperCase() : '—'];
  };
  table(['Web Vital', 'Value', 'Band'], [
    vitalRow('ttfb', 'Time to First Byte', data.perf.ttfb),
    vitalRow('fcp', 'First Contentful Paint', data.perf.fcp),
    vitalRow('lcp', 'Largest Contentful Paint', data.perf.lcp),
    vitalRow('cls', 'Cumulative Layout Shift', data.perf.cls),
    vitalRow('tbt', 'Total Blocking Time (approx)', data.perf.tbt),
    vitalRow('inp', 'Interaction to Next Paint', data.perf.inp),
  ], [1.6, 1, 1], {
    cellColor: (r, i, v) => (i === 2 && (v === 'PASS' || v === 'WARN' || v === 'FAIL') ? statusColor(v === 'PASS' ? 'pass' : v === 'WARN' ? 'warn' : 'fail') : null),
  });
  paragraph(`${data.perf.requestCount} requests  ·  ${(data.perf.transferSize / 1024).toFixed(0)} KB transferred  ·  ${data.perf.renderBlockingCount ?? '—'} render-blocking  ·  ${m.thirdPartyOrigins} third-party origin(s)  ·  protocol ${(data.perf.nextHopProtocol || 'n/a').toUpperCase()}`, 9.5);
  if (data.hygiene) {
    paragraph(`DOM size: ${data.hygiene.domSize.toLocaleString()} elements  ·  HTML compression: ${data.hygiene.compression ? (data.hygiene.compression.compressed ? 'enabled' : 'not enabled') : 'n/a'}  ·  CDN: ${data.hygiene.cdns.length ? data.hygiene.cdns.join(', ') : 'none detected'}  ·  Analytics: ${data.hygiene.analytics.length ? data.hygiene.analytics.join(', ') : 'none detected'}`, 9);
  }
  if (data.assetCheck) {
    paragraph(`Sampled ${data.assetCheck.checked} static asset(s): ${data.assetCheck.uncached} without caching headers, ${data.assetCheck.unminified} of ${data.assetCheck.codeChecked} script/style files look unminified.`, 9);
  }
  spacer(4);
  if (m.heaviestRequests.length) {
    subheading('Heaviest requests');
    table(['URL', 'Type', 'Size', 'Duration'], m.heaviestRequests.map((r) => [r.url, r.type, r.transferSize ? (r.transferSize / 1024).toFixed(1) + ' KB' : 'cache', r.duration != null ? r.duration + 'ms' : '']), [2.4, 0.8, 0.9, 0.9], { fontSize: 8 });
  }

  // =========================================================================
  // Security & mobile
  // =========================================================================
  heading('Security', 16);
  paragraph(`HTTPS: ${data.security.https ? 'Yes' : 'No'}  ·  Mixed content resources: ${data.security.mixedContentCount}  ·  Secure context: ${data.security.isSecureContext ? 'Yes' : 'No'}`, 9.5);
  spacer(4);
  if (data.securityHeaders) {
    table(['Header', 'Value'], [
      ['Strict-Transport-Security', data.securityHeaders.hsts || 'Not set'],
      ['Content-Security-Policy', data.securityHeaders.csp ? 'Set' : 'Not set'],
      ['X-Content-Type-Options', data.securityHeaders.xContentTypeOptions || 'Not set'],
      ['X-Frame-Options', data.securityHeaders.xFrameOptions || 'Not set'],
      ...('referrerPolicy' in data.securityHeaders ? [['Referrer-Policy', data.securityHeaders.referrerPolicy || 'Not set'], ['Permissions-Policy', data.securityHeaders.permissionsPolicy ? 'Set' : 'Not set']] : []),
    ], [1.2, 2]);
  }
  if (data.hygiene) {
    paragraph(`Unsafe cross-origin links: ${data.hygiene.unsafeCrossOrigin}  ·  Plaintext email addresses: ${data.hygiene.textEmails.length}`, 9);
  }

  if (data.mobile) {
    heading('Mobile', 16);
    const parts = [];
    if (data.mobile.tapTargets) parts.push(tapTargetSummary(data.mobile.tapTargets));
    if (data.mobile.fontSizes) parts.push(`${data.mobile.fontSizes.small} of ${data.mobile.fontSizes.checked} sampled text elements smaller than 12px`);
    if (data.hygiene && data.hygiene.mediaQueries) parts.push(`${data.hygiene.mediaQueries.count} @media rule(s) in ${data.hygiene.mediaQueries.readable} readable stylesheet(s)`);
    paragraph(parts.join('  ·  '), 9.5);
  }

  if (data.a11y) {
    heading('Accessibility', 16);
    paragraph(a11ySummary(data.a11y).join('  ·  '), 9.5);
    if (data.a11y.contrast.samples.length) {
      spacer(4);
      table(['Text', 'Contrast', 'Colours'], data.a11y.contrast.samples.map((x) => [x.text, `${x.ratio}:1 (needs ${x.need}:1)`, `${x.fg} on ${x.bg}`]), [2, 1.1, 1.3], { fontSize: 8 });
    }
  }

  // =========================================================================
  // Full checklist appendix
  // =========================================================================
  doc.addPage(); y = 50;
  heading('Full Checklist', 16);
  paragraph('Every automated check this report is built from, worst severity first within each group.', 9, COLOR.muted);
  spacer(4);
  ['fail', 'warn', 'pass'].forEach((status) => {
    const group = m.allChecksSorted.filter((c) => c.status === status);
    const title = status === 'fail' ? `Issues (${group.length})` : status === 'warn' ? `Warnings (${group.length})` : `Passed (${group.length})`;
    subheading(title);
    if (!group.length) { paragraph('None.', 9, COLOR.muted); spacer(4); return; }
    checklist(group.map((c) => ({ ...c, label: `${c.label}  ·  ${CATEGORY_LABELS[c.category] || c.category}` })));
  });

  // =========================================================================
  // Footer stamp on every page
  // =========================================================================
  const totalPages = doc.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    doc.setDrawColor(...COLOR.border);
    doc.setLineWidth(0.6);
    doc.line(marginX, pageHeight - 32, pageWidth - marginX, pageHeight - 32);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...COLOR.muted);
    doc.text('Scorly — local, private SEO analysis. Nothing on this page was sent anywhere.', marginX, pageHeight - 20);
    doc.text(`${data.hostname}  ·  Page ${p} of ${totalPages}`, pageWidth - marginX, pageHeight - 20, { align: 'right' });
  }

  const base = safeFilename(data.url);
  doc.save(`scorly-${base}.pdf`);
}
