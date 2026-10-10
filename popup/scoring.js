// Turns raw page data into category scores + a detailed, severity-tagged checklist.
// Loaded as a plain script in popup.html (no module system needed).

// Google's published good / needs-improvement / poor bands for the Web
// Vitals (plus the TTFB guidance scoring already uses). Shared by the popup
// tiles and the compare rows so a value is never colored two different ways.
const SCORLY_VITAL_BANDS = {
  ttfb: [600, 1000],
  fcp: [1800, 3000],
  lcp: [2500, 4000],
  cls: [0.1, 0.25],
  tbt: [200, 600],
  inp: [200, 500],
};

function scorlyVitalStatus(metric, value) {
  const bands = SCORLY_VITAL_BANDS[metric];
  if (!bands || value === null || value === undefined) return null;
  return value < bands[0] ? 'pass' : value < bands[1] ? 'warn' : 'fail';
}

// ---------------------------------------------------------------------------
// Structured-data validation
// ---------------------------------------------------------------------------
// Checks JSON-LD against the documented required/recommended properties for
// the common Google rich-result types. This is a local subset, not Rich
// Results Test parity — Google's full ruleset is not published as a spec.
// Shared by the popup (schema tab + scoring) and the compare view (diff rows).
function scorlyValidateStructuredData(jsonLd) {
  const issues = [];
  const err = (type, message) => issues.push({ severity: 'error', type, message });
  const warn = (type, message) => issues.push({ severity: 'warn', type, message });

  const has = (node, prop) => {
    const v = node && node[prop];
    if (v === undefined || v === null || v === '') return false;
    return !(Array.isArray(v) && v.length === 0);
  };
  const typeOf = (node) => {
    const t = node && node['@type'];
    return Array.isArray(t) ? t[0] : t || null;
  };
  const asArray = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
  const isIsoDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}(-\d{2})?([T ]|$)/.test(v);

  function checkDates(node, type) {
    ['datePublished', 'dateModified'].forEach((prop) => {
      if (has(node, prop) && !isIsoDate(node[prop])) {
        warn(type, `${prop} "${String(node[prop]).slice(0, 40)}" is not an ISO 8601 date (e.g. 2026-10-09).`);
      }
    });
  }

  function checkItem(node) {
    const type = typeOf(node);
    if (!type) return;
    const base = String(type);

    if (/^(Article|NewsArticle|BlogPosting|TechArticle)$/i.test(base)) {
      if (!has(node, 'headline')) err(base, 'Missing required property "headline".');
      else if (String(node.headline).length > 110) warn(base, `"headline" is ${String(node.headline).length} chars — Google truncates past ~110.`);
      if (!has(node, 'image')) err(base, 'Missing required property "image".');
      if (!has(node, 'datePublished')) warn(base, 'Missing recommended property "datePublished".');
      if (!has(node, 'author')) warn(base, 'Missing recommended property "author".');
      checkDates(node, base);
    }

    if (/^Product$/i.test(base)) {
      if (!has(node, 'name')) err(base, 'Missing required property "name".');
      if (!has(node, 'offers') && !has(node, 'review') && !has(node, 'aggregateRating')) {
        err(base, 'Needs at least one of "offers", "review" or "aggregateRating" for rich results.');
      }
      asArray(node.offers).forEach((offer) => {
        if (!offer || typeof offer !== 'object') return;
        const isAggregate = /AggregateOffer/i.test(typeOf(offer) || '');
        if (isAggregate ? !has(offer, 'lowPrice') : !has(offer, 'price')) err('Offer', `Missing required property "${isAggregate ? 'lowPrice' : 'price'}".`);
        if (!has(offer, 'priceCurrency')) err('Offer', 'Missing required property "priceCurrency".');
      });
    }

    if (/^FAQPage$/i.test(base)) {
      if (!has(node, 'mainEntity')) err(base, 'Missing required property "mainEntity" (the list of questions).');
      asArray(node.mainEntity).forEach((q, i) => {
        if (!q || typeof q !== 'object') return;
        if (!has(q, 'name')) err(base, `Question ${i + 1}: missing "name" (the question text).`);
        const answer = q.acceptedAnswer;
        if (!answer || !has(answer, 'text')) err(base, `Question ${i + 1}: missing "acceptedAnswer.text".`);
      });
    }

    if (/^Review$/i.test(base)) {
      if (!has(node, 'itemReviewed')) err(base, 'Missing required property "itemReviewed".');
      if (!has(node, 'reviewRating')) err(base, 'Missing required property "reviewRating".');
      else if (!has(node.reviewRating, 'ratingValue')) err(base, 'reviewRating is missing "ratingValue".');
      if (!has(node, 'author')) err(base, 'Missing required property "author".');
    }

    if (/^AggregateRating$/i.test(base)) {
      if (!has(node, 'ratingValue')) err(base, 'Missing required property "ratingValue".');
      if (!has(node, 'ratingCount') && !has(node, 'reviewCount')) err(base, 'Needs "ratingCount" or "reviewCount".');
    }
    // Also validate an aggregateRating nested inside another type.
    if (has(node, 'aggregateRating') && typeof node.aggregateRating === 'object') {
      const ar = node.aggregateRating;
      if (!has(ar, 'ratingValue')) err(base, 'aggregateRating is missing "ratingValue".');
      if (!has(ar, 'ratingCount') && !has(ar, 'reviewCount')) err(base, 'aggregateRating needs "ratingCount" or "reviewCount".');
    }

    if (/^Organization$/i.test(base)) {
      if (!has(node, 'name')) err(base, 'Missing required property "name".');
      if (!has(node, 'url')) warn(base, 'Missing recommended property "url".');
      if (!has(node, 'logo')) warn(base, 'Missing recommended property "logo".');
    }

    if (/^BreadcrumbList$/i.test(base)) {
      if (!has(node, 'itemListElement')) err(base, 'Missing required property "itemListElement".');
      asArray(node.itemListElement).forEach((li, i) => {
        if (!li || typeof li !== 'object') return;
        if (!has(li, 'position')) err(base, `Breadcrumb ${i + 1}: missing "position".`);
        if (!has(li, 'name') && !(li.item && has(li.item, 'name'))) err(base, `Breadcrumb ${i + 1}: missing "name".`);
      });
    }

    if (/^HowTo$/i.test(base)) {
      if (!has(node, 'name')) err(base, 'Missing required property "name".');
      if (!has(node, 'step')) err(base, 'Missing required property "step".');
    }
  }

  (jsonLd || []).forEach((block, i) => {
    if (!block || typeof block !== 'object') return;
    if (block.parseError) {
      err('JSON-LD', `Block ${i + 1} is not valid JSON and will be ignored by search engines.`);
      return;
    }
    // A block can be a single node, an array of nodes, or an @graph container.
    const nodes = Array.isArray(block) ? block : block['@graph'] ? asArray(block['@graph']) : [block];
    if (!Array.isArray(block) && !has(block, '@context')) warn(typeOf(block) || 'JSON-LD', `Block ${i + 1} has no "@context".`);
    nodes.forEach((node) => {
      if (!node || typeof node !== 'object') return;
      if (!typeOf(node)) warn('JSON-LD', `Block ${i + 1} contains a node with no "@type".`);
      else checkItem(node);
    });
  });

  return issues;
}

function scorlyComputeScore(data) {

  function makeCategory() {
    const checks = [];
    return {
      checks,
      add(id, label, status, detail, severity) {
        checks.push({ id, label, status, detail, severity: severity || (status === 'fail' ? 'high' : status === 'warn' ? 'med' : 'low') });
      },
      score() {
        if (!checks.length) return 100;
        const earned = checks.reduce((s, c) => s + (c.status === 'pass' ? 1 : c.status === 'warn' ? 0.5 : 0), 0);
        return Math.round((earned / checks.length) * 100);
      },
    };
  }

  // ===================== CONTENT =====================
  const content = makeCategory();
  const tLen = data.title.length;
  const tPx = data.title.pixels;
  const tPxNote = tPx ? `, ≈${tPx}px` : '';
  if (!tLen) content.add('title', 'Title tag', 'fail', 'Missing <title> tag.', 'high');
  else if (tLen < 10) content.add('title', 'Title tag', 'warn', `Title is very short (${tLen} chars${tPxNote}). Aim for 10–60.`, 'med');
  else if (tLen > 60) content.add('title', 'Title tag', 'warn', `Title is long (${tLen} chars${tPxNote}) and may be truncated in search results.`, 'med');
  else if (tPx && tPx > 580) content.add('title', 'Title tag', 'warn', `Title fits the character guideline (${tLen} chars) but is ≈${tPx}px wide — Google truncates titles around 580px.`, 'med');
  else content.add('title', 'Title tag', 'pass', `"${data.title.text}" (${tLen} chars${tPxNote}).`);

  const dLen = data.metaDescription.length;
  const dPx = data.metaDescription.pixels;
  const dPxNote = dPx ? `, ≈${dPx}px` : '';
  if (!dLen) content.add('description', 'Meta description', 'fail', 'Missing meta description.', 'high');
  else if (dLen < 50) content.add('description', 'Meta description', 'warn', `Description is short (${dLen} chars${dPxNote}). Aim for 50–160.`, 'med');
  else if (dLen > 160) content.add('description', 'Meta description', 'warn', `Description is long (${dLen} chars${dPxNote}) and may be truncated.`, 'med');
  else if (dPx && dPx > 920) content.add('description', 'Meta description', 'warn', `Description fits the character guideline (${dLen} chars) but is ≈${dPx}px wide — Google truncates around 920px on desktop.`, 'med');
  else content.add('description', 'Meta description', 'pass', `${dLen} characters${dPxNote} — good length.`);

  const h1Count = data.headings.h1.length;
  if (h1Count === 0) content.add('h1', 'H1 heading', 'fail', 'No H1 found on the page.', 'high');
  else if (h1Count > 1) content.add('h1', 'H1 heading', 'warn', `${h1Count} H1 tags found — use exactly one.`, 'med');
  else content.add('h1', 'H1 heading', 'pass', `"${data.headings.h1[0]}"`);

  content.add('headings', 'Heading structure', data.headings.counts.h2 > 0 ? 'pass' : 'warn',
    `H2: ${data.headings.counts.h2}, H3: ${data.headings.counts.h3}, H4: ${data.headings.counts.h4}`, 'low');

  if (data.content.wordCount < 150) content.add('wordcount', 'Content length', 'warn', `${data.content.wordCount} words — thin content may rank poorly.`, 'med');
  else content.add('wordcount', 'Content length', 'pass', `${data.content.wordCount} words.`);

  if (data.images.total === 0) content.add('imgalt', 'Image alt text', 'pass', 'No images on page.');
  else if (data.images.missingAlt === 0) content.add('imgalt', 'Image alt text', 'pass', `All ${data.images.total} images have alt text.`);
  else {
    const ratio = data.images.missingAlt / data.images.total;
    content.add('imgalt', 'Image alt text', ratio > 0.5 ? 'fail' : 'warn', `${data.images.missingAlt} of ${data.images.total} images missing alt text.`, ratio > 0.5 ? 'high' : 'med');
  }

  if (data.images.distorted !== undefined && data.images.total > 0) {
    content.add('imgdistorted', 'Image aspect ratio', data.images.distorted === 0 ? 'pass' : 'warn',
      data.images.distorted === 0 ? 'No stretched or squashed images detected.' : `${data.images.distorted} image(s) rendered at a different aspect ratio than their source — they will look stretched or squashed.`, 'low');
  }

  content.add('links', 'Internal / external links', data.links.total > 0 ? 'pass' : 'warn',
    `${data.links.internal} internal, ${data.links.external} external, ${data.links.nofollow} nofollow.`, 'low');

  if (data.links.missingAnchorText > 0) {
    content.add('anchortext', 'Link anchor text', 'warn', `${data.links.missingAnchorText} link(s) with missing anchor text.`, 'med');
  } else {
    content.add('anchortext', 'Link anchor text', 'pass', 'All links have accessible anchor text.');
  }

  if (data.content.readability >= 60) content.add('readability', 'Readability', 'pass', `Flesch reading ease ≈ ${data.content.readability}/100 (easy to read).`);
  else if (data.content.readability >= 30) content.add('readability', 'Readability', 'warn', `Flesch reading ease ≈ ${data.content.readability}/100 (fairly difficult).`, 'low');
  else content.add('readability', 'Readability', 'warn', `Flesch reading ease ≈ ${data.content.readability}/100 (difficult to read).`, 'med');

  if (data.content.emptyBoldCount > 0) {
    content.add('emptytags', 'Empty bold/strong tags', 'warn', `${data.content.emptyBoldCount} empty <b>/<strong> tag(s) found — remove or fill them.`, 'low');
  } else {
    content.add('emptytags', 'Empty bold/strong tags', 'pass', 'No empty bold/strong tags found.');
  }

  if (data.headings.duplicateCount > 0) {
    content.add('dupheadings', 'Duplicate heading texts', 'warn', `${data.headings.duplicateCount} heading text(s) repeated on this page.`, 'med');
  } else {
    content.add('dupheadings', 'Duplicate heading texts', 'pass', 'No duplicate heading texts.');
  }

  if (data.content.duplicateParagraphCount > 0) {
    content.add('duptext', 'On-page text duplication', 'warn', `${data.content.duplicateParagraphCount} paragraph(s) of text repeated elsewhere on the page.`, 'low');
  } else {
    content.add('duptext', 'On-page text duplication', 'pass', 'No duplicated paragraph text found.');
  }

  // ===================== TECHNICAL =====================
  const technical = makeCategory();
  technical.add('https', 'HTTPS', (data.isLocalhost || data.security.https) ? 'pass' : 'fail',
    data.isLocalhost ? 'Localhost — HTTPS not required.' : (data.security.https ? 'Site is served over HTTPS.' : 'Site is not served over HTTPS.'), 'high');
  technical.add('canonical', 'Canonical URL', data.canonical ? 'pass' : 'fail',
    data.canonical || 'No canonical link tag found.', 'med');
  technical.add('viewport', 'Viewport', data.viewport ? 'pass' : 'fail',
    data.viewport || 'No viewport meta tag — page may not be mobile-friendly.', 'high');
  technical.add('lang', 'Language', data.lang ? 'pass' : 'warn', data.lang || 'Missing lang attribute on <html>.', 'low');
  // faviconOk is undefined during a progressive render (the reachability
  // check is still in flight) — skip rather than flash a false warning.
  if (data.faviconOk !== undefined) {
    technical.add('favicon', 'Favicon', data.faviconOk ? 'pass' : 'warn', data.faviconOk ? 'Favicon present.' : 'Favicon missing or not loading.', 'low');
  }
  technical.add('doctype', 'DOCTYPE', data.hasDoctype ? 'pass' : 'warn', data.hasDoctype ? '<!DOCTYPE html> declared.' : 'Missing DOCTYPE declaration.', 'low');
  technical.add('charset', 'Character encoding', data.charset ? 'pass' : 'warn', data.charset || 'No charset detected.', 'low');
  const robotsBlocking = data.robotsMeta && /noindex/i.test(data.robotsMeta);
  technical.add('robotsmeta', 'Robots meta tag', robotsBlocking ? 'warn' : 'pass',
    data.robotsMeta ? data.robotsMeta : 'No robots meta tag (defaults to index, follow).', robotsBlocking ? 'med' : 'low');
  if (data.robotsTxt !== undefined) {
    technical.add('robotstxt', 'robots.txt', data.robotsTxt ? 'pass' : 'warn',
      data.robotsTxt ? 'robots.txt found at site root.' : 'robots.txt not found at site root.', 'low');
  }
  if (data.sitemapXml !== undefined) {
    technical.add('sitemap', 'sitemap.xml', data.sitemapXml ? 'pass' : 'warn',
      data.sitemapXml ? 'sitemap.xml found at site root.' : 'sitemap.xml not found at site root.', 'low');
  }
  // Only present on snapshots captured since the link checker existed; older
  // snapshots simply don't get the check rather than a false warning.
  if (data.linkCheck && data.linkCheck.checked > 0) {
    const lc = data.linkCheck;
    if (lc.broken === 0) technical.add('brokenlinks', 'Internal link targets', 'pass', `All ${lc.checked} checked internal links respond OK.`);
    else technical.add('brokenlinks', 'Internal link targets', 'fail', `${lc.broken} of ${lc.checked} checked internal links are broken (4xx/5xx or unreachable).`, 'high');
  }
  // Hygiene signals only exist on captures made since the hygiene block
  // landed — old snapshots skip them instead of failing them.
  if (data.hygiene) {
    const hy = data.hygiene;
    if (hy.metaRefresh != null) {
      technical.add('metarefresh', 'Meta refresh', 'fail', `Page uses a meta refresh ("${String(hy.metaRefresh).slice(0, 60)}") — use a proper 301 redirect instead.`, 'high');
    } else {
      technical.add('metarefresh', 'Meta refresh', 'pass', 'No meta refresh redirect.');
    }
    if (hy.deprecatedTagCount > 0) {
      const names = Object.keys(hy.deprecatedTags).map((t) => `<${t}> ×${hy.deprecatedTags[t]}`).join(', ');
      technical.add('deprecated', 'Deprecated HTML tags', 'warn', `${hy.deprecatedTagCount} deprecated tag(s) found: ${names}.`, 'low');
    } else {
      technical.add('deprecated', 'Deprecated HTML tags', 'pass', 'No deprecated HTML tags found.');
    }
    technical.add('analytics', 'Analytics', hy.analytics.length ? 'pass' : 'warn',
      hy.analytics.length ? `Detected: ${hy.analytics.join(', ')}.` : 'No analytics tool detected — you may be flying blind on traffic (or this is deliberate).', 'low');
  }
  if (data.notFoundPage) {
    const nf = data.notFoundPage;
    if (nf.soft404) technical.add('custom404', 'Custom 404 page', 'fail', `A made-up URL returned HTTP ${nf.status} instead of 404 — search engines may index junk URLs (soft 404).`, 'high');
    else if (nf.status === 404 && nf.custom) technical.add('custom404', 'Custom 404 page', 'pass', 'Dead URLs return a proper 404 with a real error page.');
    else if (nf.status === 404) technical.add('custom404', 'Custom 404 page', 'warn', 'Dead URLs return 404, but the error page looks like a bare server default — a custom page keeps lost visitors on the site.', 'low');
    else technical.add('custom404', 'Custom 404 page', 'warn', `A made-up URL returned HTTP ${nf.status}.`, 'low');
  }
  if (data.wwwRedirect) {
    const wr = data.wwwRedirect;
    if (wr.unreachable) {
      technical.add('wwwredirect', 'www / non-www redirect', 'pass', `${wr.altHost} is not reachable — no duplicate-content risk.`);
    } else if (wr.duplicate) {
      technical.add('wwwredirect', 'www / non-www redirect', 'fail', `${wr.altHost} serves content without redirecting to ${data.hostname} — this can cause duplicate-content issues.`, 'high');
    } else {
      technical.add('wwwredirect', 'www / non-www redirect', 'pass', `${wr.altHost} redirects to ${data.hostname}.`);
    }
  }

  // ===================== MOBILE =====================
  const mobile = makeCategory();
  mobile.add('viewport', 'Responsive viewport', data.viewport ? 'pass' : 'fail',
    data.viewport ? data.viewport : 'No viewport meta tag.', 'high');
  const viewportScalable = !data.viewport || !/user-scalable=no|maximum-scale=1(\.0)?\b/i.test(data.viewport);
  mobile.add('zoom', 'Pinch-zoom allowed', viewportScalable ? 'pass' : 'warn',
    viewportScalable ? 'Zooming is not disabled.' : 'Viewport disables user scaling — an accessibility issue.', 'med');

  // Heuristic — measured at whatever viewport the page was actually open at,
  // not a true mobile-emulated layout (no headless browser here to resize).
  if (data.mobile && data.mobile.tapTargets && data.mobile.tapTargets.checked > 0) {
    const tt = data.mobile.tapTargets;
    const ratio = tt.small / tt.checked;
    if (ratio === 0) mobile.add('taptargets', 'Tap target size', 'pass', `All ${tt.checked} checked tap targets are at least 44×44px.`);
    else mobile.add('taptargets', 'Tap target size', ratio > 0.3 ? 'fail' : 'warn',
      `${tt.small} of ${tt.checked} tap targets (links/buttons) are smaller than the recommended 44×44px minimum.`, ratio > 0.3 ? 'high' : 'med');
  }
  if (data.hygiene && data.hygiene.mediaQueries && data.hygiene.mediaQueries.readable > 0) {
    const mq = data.hygiene.mediaQueries;
    mobile.add('mediaqueries', 'Responsive CSS (@media)', mq.count > 0 ? 'pass' : 'warn',
      mq.count > 0 ? `${mq.count} @media rule(s) across ${mq.readable} readable stylesheet(s).`
        : `No @media rules found in the ${mq.readable} readable stylesheet(s)${mq.total > mq.readable ? ` (${mq.total - mq.readable} cross-origin sheet(s) could not be inspected)` : ''} — layout may not adapt to screen size.`, 'med');
  }
  if (data.mobile && data.mobile.fontSizes && data.mobile.fontSizes.checked > 0) {
    const fs = data.mobile.fontSizes;
    const ratio = fs.small / fs.checked;
    if (ratio === 0) mobile.add('fontsize', 'Mobile font size', 'pass', `No text smaller than 12px found in ${fs.checked} sampled elements.`);
    else mobile.add('fontsize', 'Mobile font size', ratio > 0.3 ? 'fail' : 'warn',
      `${fs.small} of ${fs.checked} sampled text elements render smaller than 12px — may be hard to read on mobile.`, ratio > 0.3 ? 'high' : 'med');
  }

  // ===================== SCHEMA =====================
  const schema = makeCategory();
  if (data.jsonLd.length === 0) {
    schema.add('jsonld', 'Structured data (JSON-LD)', 'fail', 'No structured data found on this page.', 'high');
  } else {
    const hasParseError = data.jsonLd.some((j) => j && j.parseError);
    schema.add('jsonld', 'Structured data (JSON-LD)', hasParseError ? 'warn' : 'pass',
      `${data.jsonLd.length} JSON-LD block(s): ${data.jsonLdTypes.join(', ') || 'unknown type'}` + (hasParseError ? ' (one or more blocks failed to parse)' : ''),
      hasParseError ? 'med' : 'low');
  }
  if (data.jsonLd.length > 0) {
    const sdIssues = scorlyValidateStructuredData(data.jsonLd);
    const sdErrors = sdIssues.filter((i) => i.severity === 'error').length;
    const sdWarns = sdIssues.length - sdErrors;
    if (sdErrors > 0) schema.add('validation', 'Structured data validation', 'fail', `${sdErrors} error(s)${sdWarns ? `, ${sdWarns} warning(s)` : ''} against common rich-result requirements — see the Schema tab.`, 'high');
    else if (sdWarns > 0) schema.add('validation', 'Structured data validation', 'warn', `${sdWarns} warning(s) — recommended properties are missing. See the Schema tab.`, 'low');
    else schema.add('validation', 'Structured data validation', 'pass', `No issues found in ${data.jsonLd.length} block(s) (checked against common Google rich-result requirements).`);
  }
  schema.add('og', 'Open Graph tags', Object.keys(data.og.raw || {}).length > 0 ? 'pass' : 'warn',
    Object.keys(data.og.raw || {}).length > 0 ? `${Object.keys(data.og.raw).length} Open Graph tags found.` : 'No Open Graph tags found.', 'med');
  schema.add('twitter', 'Twitter Card tags', Object.keys(data.twitter.raw || {}).length > 0 ? 'pass' : 'warn',
    Object.keys(data.twitter.raw || {}).length > 0 ? `${Object.keys(data.twitter.raw).length} Twitter Card tags found.` : 'No Twitter Card tags found.', 'low');

  // ===================== PERFORMANCE =====================
  const perf = makeCategory();

  const lcp = data.perf.lcp;
  if (lcp == null) perf.add('lcp', 'Largest Contentful Paint', 'warn', 'Could not measure LCP (page may have been analyzed before it finished painting).', 'low');
  else if (lcp < 2500) perf.add('lcp', 'Largest Contentful Paint', 'pass', `${(lcp / 1000).toFixed(1)}s — good.`);
  else if (lcp < 4000) perf.add('lcp', 'Largest Contentful Paint', 'warn', `${(lcp / 1000).toFixed(1)}s — needs improvement.`, 'med');
  else perf.add('lcp', 'Largest Contentful Paint', 'fail', `${(lcp / 1000).toFixed(1)}s — poor. Users perceive this as slow.`, 'high');

  const cls = data.perf.cls;
  if (cls == null) perf.add('cls', 'Cumulative Layout Shift', 'warn', 'Could not measure CLS.', 'low');
  else if (cls < 0.1) perf.add('cls', 'Cumulative Layout Shift', 'pass', `${cls} — good.`);
  else if (cls < 0.25) perf.add('cls', 'Cumulative Layout Shift', 'warn', `${cls} — needs improvement.`, 'med');
  else perf.add('cls', 'Cumulative Layout Shift', 'fail', `${cls} — poor. Content is shifting noticeably as the page loads.`, 'high');

  const fcp = data.perf.fcp;
  if (fcp == null) perf.add('fcp', 'First Contentful Paint', 'warn', 'Could not measure FCP.', 'low');
  else if (fcp < 1800) perf.add('fcp', 'First Contentful Paint', 'pass', `${(fcp / 1000).toFixed(1)}s — good.`);
  else if (fcp < 3000) perf.add('fcp', 'First Contentful Paint', 'warn', `${(fcp / 1000).toFixed(1)}s — needs improvement.`, 'med');
  else perf.add('fcp', 'First Contentful Paint', 'fail', `${(fcp / 1000).toFixed(1)}s — poor.`, 'high');

  // TBT (longtask API) and render-blocking flags are Chromium-only, and INP
  // needs a real interaction before capture — these checks only appear when
  // the browser actually measured something, so Firefox isn't penalized.
  const tbt = data.perf.tbt;
  if (tbt != null) {
    if (tbt < 200) perf.add('tbt', 'Total Blocking Time (approx)', 'pass', `≈${tbt}ms of main-thread blocking — good.`);
    else if (tbt < 600) perf.add('tbt', 'Total Blocking Time (approx)', 'warn', `≈${tbt}ms of main-thread blocking — needs improvement.`, 'med');
    else perf.add('tbt', 'Total Blocking Time (approx)', 'fail', `≈${tbt}ms of main-thread blocking — poor. Long JS tasks are freezing the page.`, 'high');
  }

  const inp = data.perf.inp;
  if (inp != null) {
    if (inp < 200) perf.add('inp', 'Interaction to Next Paint', 'pass', `${inp}ms worst interaction — good.`);
    else if (inp < 500) perf.add('inp', 'Interaction to Next Paint', 'warn', `${inp}ms worst interaction — needs improvement.`, 'med');
    else perf.add('inp', 'Interaction to Next Paint', 'fail', `${inp}ms worst interaction — poor.`, 'high');
  }

  const blocking = data.perf.renderBlockingCount;
  if (blocking != null) {
    if (blocking <= 4) perf.add('blocking', 'Render-blocking resources', 'pass', `${blocking} render-blocking resource(s).`);
    else if (blocking <= 10) perf.add('blocking', 'Render-blocking resources', 'warn', `${blocking} render-blocking resources — consider deferring or inlining some.`, 'med');
    else perf.add('blocking', 'Render-blocking resources', 'fail', `${blocking} render-blocking resources delay first paint.`, 'high');
  }

  const ttfb = data.perf.ttfb;
  if (ttfb == null) perf.add('ttfb', 'Time to first byte', 'warn', 'Could not measure TTFB.', 'low');
  else if (ttfb < 200) perf.add('ttfb', 'Time to first byte', 'pass', `${ttfb}ms — excellent.`);
  else if (ttfb < 600) perf.add('ttfb', 'Time to first byte', 'pass', `${ttfb}ms — good.`);
  else if (ttfb < 1000) perf.add('ttfb', 'Time to first byte', 'warn', `${ttfb}ms — could be faster.`, 'med');
  else perf.add('ttfb', 'Time to first byte', 'fail', `${ttfb}ms — slow server response.`, 'high');

  const reqs = data.perf.requestCount;
  if (reqs <= 50) perf.add('requests', 'Request count', 'pass', `${reqs} requests.`);
  else if (reqs <= 120) perf.add('requests', 'Request count', 'warn', `${reqs} requests — consider reducing.`, 'low');
  else perf.add('requests', 'Request count', 'fail', `${reqs} requests — likely to slow down loading.`, 'med');

  // Third-party origins each cost a DNS lookup + TLS handshake before their
  // first byte. Counted from the captured waterfall, so absent on old snapshots.
  if (data.resources && data.resources.length) {
    const thirdPartyOrigins = new Set();
    data.resources.forEach((r) => {
      try {
        const u = new URL(r.url);
        if (u.hostname !== data.hostname) thirdPartyOrigins.add(u.origin);
      } catch (e) { /* ignore */ }
    });
    const tp = thirdPartyOrigins.size;
    if (tp === 0) perf.add('thirdparty', 'Third-party origins', 'pass', 'Everything loads from the page\'s own origin.');
    else if (tp <= 6) perf.add('thirdparty', 'Third-party origins', 'pass', `${tp} third-party origin(s) — each adds a DNS + TLS hop.`);
    else if (tp <= 12) perf.add('thirdparty', 'Third-party origins', 'warn', `${tp} third-party origins — each adds a DNS + TLS hop before its first byte.`, 'med');
    else perf.add('thirdparty', 'Third-party origins', 'fail', `${tp} third-party origins — connection overhead alone is hurting load time.`, 'med');
  }

  if (data.hygiene) {
    const hy = data.hygiene;
    if (hy.domSize <= 1500) perf.add('domsize', 'DOM size', 'pass', `${hy.domSize.toLocaleString()} elements.`);
    else if (hy.domSize <= 3000) perf.add('domsize', 'DOM size', 'warn', `${hy.domSize.toLocaleString()} elements — large DOMs slow style/layout work (Lighthouse flags >1,500).`, 'low');
    else perf.add('domsize', 'DOM size', 'fail', `${hy.domSize.toLocaleString()} elements — an excessive DOM makes every interaction and render more expensive.`, 'med');

    if (hy.compression && hy.compression.decodedBodySize > 20000) {
      const c = hy.compression;
      if (c.compressed) {
        const saved = Math.round((1 - c.encodedBodySize / c.decodedBodySize) * 100);
        perf.add('gzip', 'HTML compression', 'pass', `Document is compressed on the wire (${saved}% smaller than its decoded size).`);
      } else {
        perf.add('gzip', 'HTML compression', 'fail', `The HTML document is served uncompressed (${Math.round(c.decodedBodySize / 1024)} KB) — enable gzip or brotli on the server.`, 'med');
      }
    }

    const proto = (data.perf.nextHopProtocol || '').toLowerCase();
    if (proto) {
      if (proto === 'h2' || proto === 'h3') perf.add('http2', 'HTTP/2+', 'pass', `Served over ${proto.toUpperCase()} — parallel requests without connection overhead.`);
      else perf.add('http2', 'HTTP/2+', 'warn', `Served over ${proto.toUpperCase()} — HTTP/2 or HTTP/3 would let requests share one connection.`, 'med');
    }
  }
  if (data.assetCheck) {
    const ac = data.assetCheck;
    const name = (u) => { try { return new URL(u).pathname.split('/').pop(); } catch (e) { return u; } };
    if (ac.uncached === 0) perf.add('caching', 'Static asset caching', 'pass', `All ${ac.checked} sampled static assets send caching headers.`);
    else perf.add('caching', 'Static asset caching', ac.uncached > ac.checked / 2 ? 'fail' : 'warn',
      `${ac.uncached} of ${ac.checked} sampled assets have no (or disabled) caching headers: ${ac.uncachedList.slice(0, 3).map(name).join(', ')}${ac.uncachedList.length > 3 ? '…' : ''} — repeat visitors re-download them.`, ac.uncached > ac.checked / 2 ? 'med' : 'low');
    if (ac.codeChecked > 0) {
      if (ac.unminified === 0) perf.add('minify', 'JS/CSS minification', 'pass', `All ${ac.codeChecked} sampled script/style files look minified.`);
      else perf.add('minify', 'JS/CSS minification', 'warn',
        `${ac.unminified} of ${ac.codeChecked} sampled script/style files look unminified: ${ac.unminifiedList.slice(0, 3).map(name).join(', ')}${ac.unminifiedList.length > 3 ? '…' : ''}.`, 'med');
    }
  }
  if (data.hygiene && data.hygiene.cdns && data.hygiene.cdns.length) {
    perf.add('cdn', 'CDN usage', 'pass', `Assets served via: ${data.hygiene.cdns.join(', ')}.`, 'low');
  }

  const sizeKb = data.perf.transferSize / 1024;
  if (sizeKb <= 1024) perf.add('size', 'Transferred size', 'pass', `${sizeKb.toFixed(0)} KB.`);
  else if (sizeKb <= 3072) perf.add('size', 'Transferred size', 'warn', `${sizeKb.toFixed(0)} KB — on the heavier side.`, 'low');
  else perf.add('size', 'Transferred size', 'fail', `${sizeKb.toFixed(0)} KB — very heavy page.`, 'med');

  // ===================== SECURITY =====================
  const security = makeCategory();
  security.add('https', 'HTTPS', (data.isLocalhost || data.security.https) ? 'pass' : 'fail',
    data.isLocalhost ? 'Localhost — HTTPS not required.' : (data.security.https ? 'Encrypted connection active.' : 'Not served over HTTPS.'), 'high');
  security.add('mixed', 'Mixed content', data.security.mixedContentCount === 0 ? 'pass' : 'fail',
    data.security.mixedContentCount === 0 ? 'All sampled resources loaded securely.' : `${data.security.mixedContentCount} insecure (http://) resource(s) on an HTTPS page.`,
    data.security.mixedContentCount === 0 ? 'low' : 'high');
  security.add('context', 'Secure context', data.security.isSecureContext ? 'pass' : 'warn',
    data.security.isSecureContext ? 'Page is in a secure origin.' : 'Page is not a secure context (some browser APIs unavailable).', 'low');
  security.add('protocol', 'Protocol', 'pass', data.perf.nextHopProtocol ? data.perf.nextHopProtocol.toUpperCase() : 'Unknown', 'low');
  if (data.hygiene) {
    const hy = data.hygiene;
    security.add('unsafeblank', 'Unsafe cross-origin links', hy.unsafeCrossOrigin === 0 ? 'pass' : 'warn',
      hy.unsafeCrossOrigin === 0 ? 'All external target="_blank" links carry rel="noopener" or "noreferrer".'
        : `${hy.unsafeCrossOrigin} external target="_blank" link(s) without rel="noopener"/"noreferrer" — the opened page can access window.opener.`, 'med');
    security.add('plainemail', 'Plaintext email addresses', hy.textEmails.length === 0 ? 'pass' : 'warn',
      hy.textEmails.length === 0 ? 'No raw email addresses in the page text for spam bots to harvest.'
        : `${hy.textEmails.length} email address(es) in plain text (${hy.textEmails.slice(0, 2).join(', ')}${hy.textEmails.length > 2 ? '…' : ''}) — harvestable by spam bots; consider a contact form or obfuscation.`, 'low');
  }
  if (data.securityHeaders) {
    const sh = data.securityHeaders;
    if (data.security.https) {
      security.add('hsts', 'HSTS header', sh.hsts ? 'pass' : 'warn',
        sh.hsts ? `Strict-Transport-Security: ${sh.hsts}` : 'No Strict-Transport-Security header — HTTPS downgrade attacks are not mitigated.', sh.hsts ? 'low' : 'med');
    }
    security.add('csp', 'Content-Security-Policy', sh.csp ? 'pass' : 'warn',
      sh.csp ? 'Content-Security-Policy header present.' : 'No Content-Security-Policy header — reduces protection against XSS/injection attacks.', sh.csp ? 'low' : 'med');
    security.add('xcto', 'X-Content-Type-Options', sh.xContentTypeOptions ? 'pass' : 'warn',
      sh.xContentTypeOptions ? `X-Content-Type-Options: ${sh.xContentTypeOptions}` : 'No X-Content-Type-Options header — browsers may MIME-sniff responses.', 'low');
    const hasFrameAncestors = sh.csp && /frame-ancestors/i.test(sh.csp);
    security.add('xfo', 'Clickjacking protection', (sh.xFrameOptions || hasFrameAncestors) ? 'pass' : 'warn',
      sh.xFrameOptions ? `X-Frame-Options: ${sh.xFrameOptions}` : (hasFrameAncestors ? 'frame-ancestors set via CSP.' : 'No X-Frame-Options header or frame-ancestors CSP directive — page can be framed by other sites.'), 'low');
  }

  // ===================== AI SEO (heuristic) =====================
  const aiSeo = makeCategory();
  aiSeo.add('structured', 'Structured data present', data.aiSeo.hasStructuredData ? 'pass' : 'fail',
    data.aiSeo.hasStructuredData ? 'Helps AI assistants and search engines understand the page.' : 'No structured data — harder for AI systems to parse page meaning.', 'high');
  aiSeo.add('faq', 'FAQ / Article schema', (data.aiSeo.hasFaqSchema || data.aiSeo.hasArticleSchema) ? 'pass' : 'warn',
    (data.aiSeo.hasFaqSchema || data.aiSeo.hasArticleSchema) ? 'FAQ or Article schema found — good for AI answer extraction.' : 'No FAQ/Article schema — consider adding for better AI snippet eligibility.', 'low');
  aiSeo.add('semantic', 'Semantic HTML landmarks', data.aiSeo.semanticLandmarks >= 3 ? 'pass' : 'warn',
    `${data.aiSeo.semanticLandmarks}/5 semantic landmarks found (main, article, nav, header, footer).`, 'low');
  aiSeo.add('meta', 'Meta description for snippets', data.aiSeo.hasMetaDescription ? 'pass' : 'fail',
    data.aiSeo.hasMetaDescription ? 'Present — usable as an AI/SERP summary.' : 'Missing meta description.', 'med');
  aiSeo.add('h1clear', 'Single clear H1 topic', data.aiSeo.hasClearH1 ? 'pass' : 'warn',
    data.aiSeo.hasClearH1 ? 'Exactly one H1 defines the page topic.' : 'Page topic is not clearly defined by a single H1.', 'low');
  // AI crawler access & llms.txt only exist on captures made since the
  // origin-level AI checks landed — old snapshots simply skip them.
  if (data.aiBotAccess) {
    const answerBots = data.aiBotAccess.filter((b) => !/Common Crawl/.test(b.engine));
    const blocked = answerBots.filter((b) => !b.allowed);
    if (blocked.length === 0) {
      aiSeo.add('aicrawlers', 'AI crawler access', 'pass', 'robots.txt does not block any major AI crawler (GPTBot, ClaudeBot, PerplexityBot, Google-Extended…).');
    } else if (blocked.length < answerBots.length) {
      aiSeo.add('aicrawlers', 'AI crawler access', 'warn', `robots.txt blocks ${blocked.map((b) => b.bot).join(', ')} — this page can't be read or cited by ${blocked.map((b) => b.engine).join(', ')}.`, 'med');
    } else {
      aiSeo.add('aicrawlers', 'AI crawler access', 'fail', 'robots.txt blocks all major AI crawlers — the page is invisible to AI answer engines.', 'high');
    }
  }
  if (data.llmsTxt !== undefined) {
    aiSeo.add('llmstxt', 'llms.txt', data.llmsTxt ? 'pass' : 'warn',
      data.llmsTxt ? 'llms.txt found at site root — gives AI systems a curated guide to the site.' : 'No llms.txt at site root. An emerging (optional) convention that gives AI systems a curated guide to your content.', 'low');
  }
  if (data.freshness) {
    const f = data.freshness;
    const now = new Date();
    const latestMs = f.latestDate ? new Date(f.latestDate).getTime() : null;
    const monthsOld = latestMs ? (now.getTime() - latestMs) / (86400000 * 30.4) : null;
    const copyrightCurrent = f.copyrightYear && f.copyrightYear >= now.getFullYear() - 1;
    if (monthsOld != null && monthsOld <= 18) {
      aiSeo.add('freshness', 'Content freshness signals', 'pass', `Most recent dated signal is ${monthsOld < 1 ? 'less than a month' : Math.round(monthsOld) + ' month(s)'} old — reads as actively maintained.`);
    } else if (monthsOld != null) {
      aiSeo.add('freshness', 'Content freshness signals', 'warn', `Most recent dated signal is ≈${Math.round(monthsOld)} months old — may read as stale to AI systems weighing recency.`, 'med');
    } else if (copyrightCurrent) {
      aiSeo.add('freshness', 'Content freshness signals', 'pass', `No explicit content dates, but a current copyright notice (${f.copyrightYear}) signals the site is maintained.`, 'low');
    } else {
      aiSeo.add('freshness', 'Content freshness signals', 'warn', 'No dates or current copyright notice found — nothing on the page signals it is up to date.', 'med');
    }
  }

  // AI-written copy and generated-boilerplate markup. Both deduct from the
  // AI Visibility number (see scorlyComputeAiVisibility) and both are
  // guarded, because an old saved snapshot has neither field and must not
  // pick up a warning it had no chance to answer.
  const copyCheck = scorlyComputeAiCopy(data);
  if (copyCheck) {
    if (!copyCheck.available) {
      aiSeo.add('aicopy', 'AI-written copy', 'pass', `Only ${copyCheck.proseWords} words of prose — too little to judge writing patterns either way.`, 'low');
    } else if (copyCheck.score >= 75) {
      aiSeo.add('aicopy', 'AI-written copy', 'fail', `${copyCheck.band} — scores ${copyCheck.displayScore}/100 on ${copyCheck.familyCount} independent tells. Unedited model output gives AI engines nothing specific to cite and is what Google's scaled-content-abuse policy targets.`, 'high');
    } else if (copyCheck.score >= 50) {
      aiSeo.add('aicopy', 'AI-written copy', 'fail', `${copyCheck.band} — scores ${copyCheck.displayScore}/100 on ${copyCheck.familyCount} independent tells. Rewriting the flagged passages in your own words is the single biggest win here.`, 'med');
    } else if (copyCheck.score >= 25) {
      aiSeo.add('aicopy', 'AI-written copy', 'warn', `${copyCheck.band} — scores ${copyCheck.displayScore}/100. Some stock LLM patterns in the copy, listed in the AI Copy Signals panel.`, 'low');
    } else {
      aiSeo.add('aicopy', 'AI-written copy', 'pass', `${copyCheck.band} — scores ${copyCheck.displayScore}/100 over ${copyCheck.proseWords} words of prose.`);
    }
  }

  const vibeCheck = scorlyComputeVibeCode(data);
  if (vibeCheck) {
    const faultCount = vibeCheck.faults.length;
    // When the faults and the confidence band disagree — a hand-built SPA with
    // no builder fingerprint still serves an empty shell — the faults lead.
    // They are the part that actually costs visibility.
    const faultList = vibeCheck.faults.map((f) => f.label).join('; ');
    const origin = vibeCheck.score >= 26
      ? vibeCheck.band
      : 'No AI-builder fingerprint, but the same faults apply';
    if (faultCount && vibeCheck.penalty >= 5) {
      aiSeo.add('vibecode', 'Generated-site faults', 'fail', `Scores ${vibeCheck.buildScore}/100 — ${faultCount} fault(s) that cost visibility: ${faultList}. ${origin}.`, 'high');
    } else if (faultCount) {
      aiSeo.add('vibecode', 'Generated-site faults', 'warn', `Scores ${vibeCheck.buildScore}/100 — ${faultCount} fault(s): ${faultList}. ${origin}.`, 'med');
    } else if (vibeCheck.score >= 51) {
      aiSeo.add('vibecode', 'Generated-site faults', 'pass', `Scores 100/100. ${vibeCheck.band}${vibeCheck.builders.length ? ' (' + vibeCheck.builders.map((b) => b.name).join(', ') + ')' : ''}, but none of the usual faults are present — the toolchain itself costs nothing.`);
    } else {
      aiSeo.add('vibecode', 'Generated-site faults', 'pass', `Scores 100/100. ${vibeCheck.band}, no generated-site faults found.`);
    }
  }

  // ===================== E-E-A-T (heuristic) =====================
  const eeat = makeCategory();
  eeat.add('author', 'Author byline', data.eeat.hasAuthorByline ? 'pass' : 'warn',
    data.eeat.hasAuthorByline ? 'Author information found.' : 'No author byline or meta author tag detected.', 'med');
  eeat.add('date', 'Published/updated date', data.eeat.hasPublishDate ? 'pass' : 'warn',
    data.eeat.hasPublishDate ? 'Publish/modified date found.' : 'No publish or last-updated date detected.', 'med');
  eeat.add('org', 'Organization / Person schema', data.eeat.hasOrgOrPersonSchema ? 'pass' : 'warn',
    data.eeat.hasOrgOrPersonSchema ? 'Organization or Person schema present.' : 'No Organization/Person schema found.', 'low');
  // These are name-matching heuristics: they scan every link's URL and
  // anchor text on THIS page for common names of the page type. The details
  // name the matched term (pass) or the terms searched for (fail), so a
  // miss on an unusually-named page is explainable rather than mysterious.
  const matchNote = (match) => match && typeof match === 'string' ? ` (matched "${match}" in a link)` : '';
  eeat.add('about', 'About page linked', data.eeat.hasAboutLink ? 'pass' : 'warn',
    data.eeat.hasAboutLink ? `Found a link to an About page${matchNote(data.eeat.aboutMatch)}.`
      : 'No link on this page matches "about", "our story", "who we are", "our team", "company" or "mission" (checked in link URLs and anchor text). If your About page uses a different name, this check can’t see it — but neither can a crawler guess it.', 'low');
  eeat.add('contact', 'Contact page linked', data.eeat.hasContactLink ? 'pass' : 'warn',
    data.eeat.hasContactLink ? `Found a link to a Contact page${matchNote(data.eeat.contactMatch)}.`
      : 'No link on this page matches "contact", "get in touch", "reach us", "support" or "help" (checked in link URLs and anchor text). If your contact route uses a different name, consider also linking it under one of these common names.', 'low');
  eeat.add('privacy', 'Privacy policy linked', data.eeat.hasPrivacyLink ? 'pass' : 'warn',
    data.eeat.hasPrivacyLink ? `Found a link to a Privacy Policy${matchNote(data.eeat.privacyMatch)}.`
      : 'No link on this page matches "privacy" or "data protection" (checked in link URLs and anchor text).', 'low');
  eeat.add('https', 'Trust signal: HTTPS', (data.isLocalhost || data.security.https) ? 'pass' : 'fail',
    data.isLocalhost ? 'Localhost — skipped.' : (data.security.https ? 'Secure connection.' : 'Not served over HTTPS.'), 'high');

  const categories = { technical, content, perf, schema, security, mobile, aiSeo, eeat };
  const categoryScores = {};
  Object.keys(categories).forEach((k) => { categoryScores[k] = categories[k].score(); });

  // "AI Visibility" is the one AI-related number shown everywhere — the
  // Overview bar, exports, compare, and the AI Insights tab header. It
  // replaces the plain pass/fail ratio of the aiSeo checklist (computed
  // above) with the broader formula below, which also weighs E-E-A-T and
  // freshness — the AI SEO checks still run and still show in detail (on
  // the AI Insights tab), they just no longer produce a second, disagreeing
  // score. Must run after categoryScores.eeat exists (the formula uses it)
  // and before the overall-score weighting below (which should weigh this
  // same number, not the superseded checklist ratio).
  categoryScores.aiSeo = scorlyComputeAiVisibility(data, categoryScores);

  const WEIGHTS = { technical: 0.20, content: 0.20, perf: 0.10, schema: 0.10, security: 0.15, mobile: 0.10, aiSeo: 0.075, eeat: 0.075 };
  let overallScore = 0;
  Object.keys(WEIGHTS).forEach((k) => { overallScore += categoryScores[k] * WEIGHTS[k]; });
  overallScore = Math.round(overallScore);

  const allChecks = [];
  Object.keys(categories).forEach((cat) => {
    categories[cat].checks.forEach((c) => allChecks.push({ ...c, category: cat }));
  });

  const counts = {
    issues: allChecks.filter((c) => c.status === 'fail').length,
    warnings: allChecks.filter((c) => c.status === 'warn').length,
    passed: allChecks.filter((c) => c.status === 'pass').length,
  };

  return {
    overallScore,
    score: overallScore, // alias for backwards-compat callers
    aiVisibility: categoryScores.aiSeo,
    categoryScores,
    categories: {
      technical: technical.checks, content: content.checks, perf: perf.checks,
      schema: schema.checks, security: security.checks, mobile: mobile.checks,
      aiSeo: aiSeo.checks, eeat: eeat.checks,
    },
    allChecks,
    counts,
  };
}

// ---------------------------------------------------------------------------
// AI Insights (all local heuristics — no AI, no network)
// ---------------------------------------------------------------------------
// Approximates the "AI Insights" sections of hosted SEO tools from signals
// already captured on the page: who the site is, how trustworthy and fresh
// its content looks to an AI answer engine, and what to improve. Every value
// is rule-based and explainable; nothing here is generated or uploaded.

// ---------------------------------------------------------------------------
// AI-written copy / "vibe coded" detection (both local heuristics)
// ---------------------------------------------------------------------------
// Why these sit under AI Visibility: Google's spam policies treat
// mass-produced, low-added-value pages as "scaled content abuse" regardless
// of how they were made (generative AI, a freelance mill or a template fed
// from a spreadsheet), and the policy is about volume + thin value + ranking
// intent, not about the tool. AI answer engines likewise prefer sources with
// something specific to say. So unedited LLM prose and generated-boilerplate
// markup are both treated here as a deduction from AI Visibility, never as a
// separate headline score — and the deduction is bounded, because neither
// signal can ever be proof.

// Likelihood that this page's copy is unedited LLM output, from the surface
// tells catalogued in Wikipedia's "Signs of AI writing".
//
// The single most important rule, stated outright by that source: individual
// tells mean nothing. One em dash, curly quotes, a stray "however" — all
// ordinary human writing. Only a CLUSTER of independent families is evidence,
// so a page that trips fewer than three of them is held below the
// "some patterns" band no matter how hard it trips them.
function scorlyComputeAiCopy(data) {
  const c = data && data.aiCopy;
  if (!c) return null;
  // Under ~150 words of prose there is nothing to measure: rates swing wildly
  // and a single stock phrase would read as a page-wide pattern.
  if (!c.proseWords || c.proseWords < 150) {
    return { available: false, proseWords: c.proseWords || 0, score: 0, band: 'Not enough copy', families: [], penalty: 0 };
  }

  const families = [];
  // `tier` picks the first threshold the value clears, so each family
  // contributes once and its ceiling is fixed — no single signal can carry
  // the whole score.
  const tier = (value, steps) => {
    for (let i = 0; i < steps.length; i++) if (value >= steps[i][0]) return steps[i][1];
    return 0;
  };
  const add = (key, label, points, detail, samples) => {
    if (points > 0) families.push({ key, label, points, detail, samples: samples || [] });
  };

  // Chatbot correspondence and knowledge-cutoff text. Near-conclusive: no
  // one writes "as of my last update" into their own page copy.
  add('artifacts', 'Chatbot text left in the copy', c.artifactCount ? 40 : 0,
    c.artifactCount ? `${c.artifactCount} phrase(s) that only appear in chat transcripts or unedited model output.` : '',
    (c.artifactHits || []).map((h) => `“${h.term}” ×${h.count}`));

  add('phrases', 'LLM phrase formulas', tier(c.phraseCount || 0, [[6, 18], [3, 12], [1, 6]]),
    `${c.phraseCount} stock formula(s) ("stands as a testament", "in today's fast-paced", "unlock the potential"…).`,
    (c.phraseHits || []).map((h) => `“${h.term}” ×${h.count}`));

  add('vocab', 'Over-represented AI vocabulary', tier(c.vocabPer1k || 0, [[8, 16], [5, 11], [2.5, 6]]),
    `${c.vocabCount} hit(s), ≈${c.vocabPer1k} per 1,000 words, from the word list measurably over-used in post-2023 text.`,
    (c.vocabHits || []).map((h) => `${h.term} ×${h.count}`));

  add('falseRanges', 'False ranges ("from X to Y")', tier(c.falseRanges || 0, [[4, 14], [2, 9], [1, 4]]),
    `${c.falseRanges} "from X to Y" construction(s) where the two ends are not points on any real scale.`,
    c.falseRangeSamples || []);

  // The generic triad and the verb triad overlap by construction (a verb
  // triad is also a triad), so the family takes whichever reads worse rather
  // than summing the two.
  // Floored at two: one "X, Y and Z" in a few hundred words is just English.
  const triadPoints = (c.triads || 0) < 2 ? 0 : Math.max(
    tier(c.triadsPer1k || 0, [[6, 12], [3, 8], [1.5, 4]]),
    tier(c.verbTriads || 0, [[4, 12], [2, 8], [1, 4]]));
  add('triads', 'Rule-of-three cadence', triadPoints,
    `${c.triads} "X, Y and Z" triad(s)${c.verbTriads ? `, ${c.verbTriads} of them the repeating "We verb, verb and verb" shape` : ''}.`,
    (c.verbTriadSamples || []).concat(c.triadSamples || []).slice(0, 6));

  add('negParallel', 'Negative parallelism', tier(c.negParallel || 0, [[3, 10], [1, 5]]),
    `${c.negParallel} "it's not just X, it's Y" / "not only… but also" construction(s).`);

  add('participles', 'Participle tails', tier(c.participleTails || 0, [[4, 10], [2, 6], [1, 3]]),
    `${c.participleTails} sentence(s) ending in a bolted-on "…, highlighting/ensuring/reflecting…" clause.`);

  add('copula', 'Copula avoidance', tier(c.copulaCount || 0, [[4, 8], [2, 5]]),
    `${c.copulaCount} elaborate stand-in(s) for a plain "is"/"are" ("serves as", "boasts a").`,
    (c.copulaHits || []).map((h) => `“${h.term}” ×${h.count}`));

  add('weasel', 'Vague attribution', tier(c.weaselCount || 0, [[3, 8], [1, 4]]),
    `${c.weaselCount} claim(s) attributed to an unnamed authority ("experts argue", "studies suggest").`,
    (c.weaselHits || []).map((h) => `“${h.term}” ×${h.count}`));

  // Gated on the raw count as well as the rate: two dashes in 250 words is a
  // high rate and no evidence at all.
  add('emDash', 'Em-dash density', (c.emDashes || 0) >= 3 ? tier(c.emDashPer1k || 0, [[4, 9], [2, 6], [1, 3]]) : 0,
    `${c.emDashes} em/en dash(es), ≈${c.emDashPer1k} per 1,000 words. Plenty of human writers use these heavily — only the density counts, and only alongside other tells.`);

  add('inlineHeaders', 'Inline-header list items', tier(c.inlineHeaderItems || 0, [[5, 8], [2, 5]]),
    `${c.inlineHeaderItems} list item(s) in the "**Label:** sentence" shape that chat models default to.`);

  add('emoji', 'Emoji in headings', tier(c.emojiHeadings || 0, [[2, 6], [1, 3]]),
    `${c.emojiHeadings} heading(s) decorated with an emoji.`);

  if (c.headingsChecked >= 3) {
    const ratio = c.titleCaseHeadings / c.headingsChecked;
    add('titleCase', 'Title Case headings', ratio >= 0.6 ? 5 : 0,
      `${c.titleCaseHeadings} of ${c.headingsChecked} multi-word headings capitalise every word.`);
  }

  // Even cadence. Real writing alternates short and long sentences; LLM prose
  // holds a mid-length rhythm. Measured as coefficient of variation, and only
  // when there were enough sentences to make it stable.
  if (c.sentenceCv != null) {
    add('cadence', 'Uniform sentence rhythm', tier(-c.sentenceCv, [[-0.35, 8], [-0.45, 4]]),
      `Sentence lengths vary by only ${Math.round(c.sentenceCv * 100)}% of their average — human prose typically varies 50%+.`);
  }

  // Curly quotes on their own are worthless (every CMS and word processor
  // curls them automatically), so they are only admitted once other families
  // have already fired.
  const beforeQuotes = families.length;
  if (beforeQuotes >= 3 && c.curlyQuotes >= 4) {
    add('curlyQuotes', 'Curly quotation marks', 3, `${c.curlyQuotes} curly quote mark(s), counted only because other tells are present.`);
  }

  const raw = families.reduce((sum, f) => sum + f.points, 0);
  const hasArtifacts = (c.artifactCount || 0) > 0;
  const familyCount = families.length;
  let score = Math.min(100, raw);
  let gated = false;
  if (hasArtifacts) {
    score = Math.max(score, 70);
  } else if (familyCount < 3) {
    // Fewer than three independent families is not a cluster, and the source
    // these patterns come from is explicit that isolated tells prove nothing.
    score = Math.min(score, 24);
    gated = true;
  }

  // Reported the same way round as every other number in the app: high is
  // good. `score` stays as the internal risk (how much reads as AI-written)
  // because the tiers and the penalty are built on it, but `displayScore` is
  // what the UI and the exports show, so a reassuring verdict can never sit
  // next to a number that looks like a failing grade.
  const displayScore = 100 - score;
  const band = displayScore >= 76 ? 'No real signs of AI writing'
    : displayScore >= 51 ? 'Some AI writing patterns'
      : displayScore >= 26 ? 'Likely AI-written'
        : 'Almost certainly AI-written';

  // Deduction ramps in from 35 — below that the evidence is too thin to cost
  // anything — and is capped at 12 of the 100 AI Visibility points.
  const penalty = score < 35 ? 0 : Math.min(12, Math.round(((score - 35) / 65) * 12));

  families.sort((a, b) => b.points - a.points);
  // Each family's points are a deduction from displayScore, so the UI shows
  // them as negative. `floored` says the artifact rule overrode the sum, in
  // which case the individual numbers no longer add up to the total and the
  // UI has to say so rather than appear to have miscounted.
  return {
    available: true, proseWords: c.proseWords, score, displayScore, band,
    families, familyCount, gated, floored: hasArtifacts, penalty,
  };
}

// Likelihood that this page was produced by an AI app-builder, kept
// deliberately separate from what that costs it.
//
// A builder badge is not an SEO fault: a Lovable or v0 site that
// server-renders, has real metadata and real copy is fine, and penalising it
// for its toolchain would be wrong. What costs AI Visibility are the traits
// these builders ship by default — a client-rendered shell with no crawlable
// text, placeholder metadata, template marketing copy — so `penalty` is
// computed from those faults, with only a small component from confidence
// itself (generated boilerplate at scale being exactly what Google's
// scaled-content-abuse policy is aimed at).
function scorlyComputeVibeCode(data) {
  const v = data && data.vibeCode;
  if (!v) return null;
  const served = data.servedHtml || null;
  const signals = [];
  const add = (label, points, detail) => { if (points > 0) signals.push({ label, points, detail }); };

  // --- Confidence: was this generated? ---
  (v.builders || []).forEach((b, i) => {
    add(`Builder fingerprint: ${b.name}`, i === 0 ? 40 : 10, b.evidence);
  });
  if (served && served.generator && !(v.builders || []).length) {
    add('Generator meta tag', 12, `Served HTML declares generator "${served.generator}".`);
  }
  const ui = v.ui || {};
  const kitParts = [ui.radixEls > 0 && 'Radix primitives', ui.lucideIcons > 0 && 'Lucide icons', ui.shadcnVars && 'shadcn/ui CSS variables'].filter(Boolean);
  add('Default AI-builder UI kit', kitParts.length >= 3 ? 18 : kitParts.length === 2 ? 10 : 0,
    `${kitParts.join(', ')} — the stack every current AI app-builder emits by default.`);
  if (ui.tailwindCdn) add('Tailwind CDN build', 8, 'Tailwind is loaded from its CDN, which its own docs say is for prototyping only.');

  const tw = v.tailwind || {};
  add('Tailwind utility soup', (tw.heavyClassPct >= 25 && tw.avgClassesPerEl >= 6) ? 12 : (tw.heavyClassPct >= 12 ? 6 : 0),
    `${tw.heavyClassPct}% of classed elements carry 10+ utility classes (average ${tw.avgClassesPerEl}).`);

  add('AI-labelled section comments', tier0(v.labelComments, [[3, 10], [1, 5]]),
    `${v.labelComments} Title Case section comment(s) ("<!-- Hero Section -->") of the kind a model emits to label its own output.`);
  add('Leftover JSX comments', v.jsxComments > 0 ? 8 : 0, `${v.jsxComments} unclosed "{/*" comment(s) rendered into the HTML.`);

  const dc = v.designCliches || {};
  add('Generated-template visual clichés', (dc.backdropBlur >= 3 || dc.gradients >= 6) ? 8 : (dc.gradients >= 3 || dc.gradientText > 0 ? 4 : 0),
    `${dc.gradients} gradient utilit(ies), ${dc.backdropBlur} glassmorphism blur(s), ${dc.gradientText} gradient-text heading(s).`);

  if (v.placeholderTitle) add('Untouched default title', 12, `<title> is still the scaffold default: "${v.placeholderTitle}".`);
  if (v.defaultFavicon) add('Default framework favicon', 8, 'The favicon is still the starter-template one.');
  if (v.genericDescription) add('Boilerplate meta description', 10, 'The meta description is generated filler, not a description of the page.');
  if (v.lorem) add('Lorem ipsum in live copy', 14, 'Placeholder Latin is still on the page.');
  if (v.placeholderCopy) add('Placeholder copy', 12, 'Text like "Your Company", "Feature One" or "Coming soon" was never replaced.');

  add('Template marketing copy', tier0((v.genericCopyHits || []).length, [[4, 10], [2, 5]]),
    `Generated hero-copy phrases: ${(v.genericCopyHits || []).slice(0, 6).join(', ')}.`);
  add('Interchangeable CTAs', v.genericCtas >= 3 ? 4 : 0, `${v.genericCtas} buttons/links say only "Get started", "Learn more" or similar.`);
  add('Stock placeholder images', tier0(v.stockImages, [[3, 6], [1, 3]]), `${v.stockImages} image(s) still point at Unsplash/Pexels/placeholder services.`);

  // --- The faults that actually cost visibility ---
  const faults = [];
  const fault = (label, points, detail) => { if (points > 0) faults.push({ label, points, detail }); };

  // The big one. The in-page analyzer reads the DOM after JavaScript has run;
  // this compares that with the HTML as served. A crawler that does not
  // execute scripts — which includes most AI answer-engine fetchers — sees
  // only the served version.
  let shellRatio = null;
  if (served && data.content && data.content.wordCount >= 150) {
    shellRatio = served.words / data.content.wordCount;
    if (shellRatio < 0.1) {
      fault('Crawlers see an empty shell', 5,
        `The page renders ${data.content.wordCount} words in the browser but the served HTML contains only ${served.words}. Any crawler that does not run JavaScript sees almost nothing.`);
    } else if (shellRatio < 0.4) {
      fault('Most copy is client-rendered', 3,
        `${served.words} of ${data.content.wordCount} words are in the served HTML; the rest only appear once JavaScript runs.`);
    }
    if (!served.hasH1) fault('No H1 in the served HTML', 1, 'The page topic is only established after JavaScript runs.');
    if (!served.titleLength) fault('No title in the served HTML', 1, 'The <title> is set client-side, so crawlers and link previews may see none.');
  }
  if (v.placeholderTitle) fault('Default page title', 1, `"${v.placeholderTitle}" tells engines and users nothing about the page.`);
  if (v.genericDescription || v.defaultFavicon) fault('Scaffold metadata left in place', 1, 'Meta description and/or favicon are still the template defaults.');
  if (v.lorem || v.placeholderCopy) fault('Placeholder text in live copy', 2, 'Placeholder content signals an unfinished page to both readers and engines.');
  if ((v.genericCopyHits || []).length >= 4) {
    fault('Interchangeable template copy', 2,
      'The copy is built from generic hero phrases that would fit any product — the low-added-value pattern Google’s scaled-content-abuse policy describes.');
  }
  if (v.semanticLandmarks != null && v.semanticLandmarks <= 1) {
    fault('No semantic landmarks', 1, 'Everything is <div>s, so nothing marks out the main content.');
  }

  const confidence = Math.min(100, signals.reduce((s, x) => s + x.points, 0));
  const band = confidence >= 76 ? 'Almost certainly AI-generated'
    : confidence >= 51 ? 'Probably AI-generated'
      : confidence >= 26 ? 'Mixed signals'
        : 'No real signs of AI generation';

  let penalty = faults.reduce((s, f) => s + f.points, 0);
  // Small confidence component so a page that is plainly generated boilerplate
  // carries some cost even when each individual fault is mild.
  if (confidence >= 60) penalty += 2;
  penalty = Math.min(10, penalty);

  // Two different things, deliberately reported differently. `buildScore` is
  // an app-convention score (high = good) for the faults, because that is
  // what costs visibility and what the user can fix. Detection confidence is
  // a verdict, not a score: a well-built generated site should not show a red
  // bar for its toolchain, so confidence gets a text band and evidence
  // strengths instead of a number that looks like a grade.
  const buildScore = Math.round(((10 - penalty) / 10) * 100);
  signals.sort((a, b) => b.points - a.points);
  signals.forEach((x) => { x.strength = x.points >= 20 ? 'strong' : x.points >= 8 ? 'moderate' : 'weak'; });
  return {
    available: true,
    score: confidence,
    buildScore,
    band,
    builders: v.builders || [],
    framework: v.framework || null,
    platform: served ? served.platform : null,
    servedWords: served ? served.words : null,
    renderedWords: (data.content && data.content.wordCount) || 0,
    shellRatio,
    signals,
    faults,
    penalty,
  };
}

// Shared tiering helper for the vibe-code signal list (same shape as the
// local `tier` in scorlyComputeAiCopy, named separately because it is used
// from module scope).
function tier0(value, steps) {
  const v = value || 0;
  for (let i = 0; i < steps.length; i++) if (v >= steps[i][0]) return steps[i][1];
  return 0;
}

// How visible this page can be to AI answer engines: can their crawlers read
// it, can they parse it (structure), can they trust it (E-E-A-T + trust
// signals), and does it look current. 0–100.
// Content Trust Score and Content Freshness, as shown on the AI Insights
// tab. Pulled out of scorlyComputeAiInsights so the AI Visibility breakdown
// bars can show the same number as the panel each one scrolls to — two
// formulas for one thing is how a bar ends up green while its panel is amber.
function scorlyComputeTrustBreakdown(data) {
  const ts = data.trustSignals;
  if (!ts) return null;
  const eeat = data.eeat || {};
  const pctOf = (items) => Math.round((items.filter(Boolean).length / items.length) * 100);
  const identity = pctOf([ts.hasPhone, ts.hasEmail, ts.hasAddress, ts.hasCompanyNumber || ts.hasVatNumber]);
  const transparency = pctOf([eeat.hasAboutLink, eeat.hasContactLink, eeat.hasPrivacyLink, ts.hasTermsLink]);
  const evidence = pctOf([eeat.hasOrgOrPersonSchema, ts.hasReviewSignal, eeat.hasAuthorByline, (ts.socialProfiles || []).length > 0]);
  return {
    score: Math.round(identity * 0.4 + transparency * 0.3 + evidence * 0.3),
    subs: [
      { label: 'Identity & contact', score: identity, detail: 'Phone, email, address, company/VAT number' },
      { label: 'Transparency', score: transparency, detail: 'About, contact, privacy and terms pages' },
      { label: 'Evidence & proof', score: evidence, detail: 'Org/Person schema, reviews, authorship, social profiles' },
    ],
  };
}

function scorlyComputeFreshnessBreakdown(data) {
  const fr = data.freshness;
  if (!fr) return null;
  const ts = data.trustSignals;
  const positives = [];
  const negatives = [];
  let score = 50;
  const latestMs = fr.latestDate ? new Date(fr.latestDate).getTime() : null;
  const monthsOld = latestMs ? (Date.now() - latestMs) / (86400000 * 30.4) : null;
  if (monthsOld != null) {
    const when = new Date(fr.latestDate).toISOString().slice(0, 10);
    if (monthsOld <= 6) { score += 35; positives.push(`Dated content signal from ${when}`); }
    else if (monthsOld <= 18) { score += 20; positives.push(`Most recent dated signal: ${when}`); }
    else { score -= 20; negatives.push(`Newest dated signal is from ${when} (\u2248${Math.round(monthsOld)} months ago)`); }
  } else {
    negatives.push('No explicit content dates (datePublished, <time>, article meta)');
  }
  if (fr.copyrightYear) {
    if (fr.copyrightYear >= new Date().getFullYear() - 1) { score += 15; positives.push(`Current copyright notice (${fr.copyrightYear})`); }
    else { score -= 15; negatives.push(`Stale copyright notice (${fr.copyrightYear})`); }
  } else {
    negatives.push('No copyright year found');
  }
  if (ts && ts.hasOpeningHours) { score += 5; positives.push('Business hours listed'); }
  if (ts && (ts.hasPhone || ts.hasEmail)) { positives.push('Live contact details present'); }
  return { score: Math.max(0, Math.min(100, score)), positives, negatives };
}

function scorlyComputeAiVisibility(data, categoryScores) {
  return scorlyComputeAiVisibilityBreakdown(data, categoryScores).score;
}

// The same calculation, but returning the component parts as well as the
// total so the AI Insights tab can show what the number is made of. Each
// component is reported both as its raw contribution (out of its weight) and
// as a 0-100 percentage, so every bar in the UI reads the same way round as
// the Overview tab: higher is better.
function scorlyComputeAiVisibilityBreakdown(data, categoryScores) {
  const components = [];
  // `cap` is the component's share of the 100 AI Visibility points and
  // `earned` is what this page got of it; `section` is the id of the panel
  // the bar scrolls to.
  //
  // `pct` is what the bar actually draws, and it is the score shown by that
  // panel — not earned/cap. Those two differ: the copy and build deductions
  // only bite past a threshold, so a page can cost 0 points (earned === cap)
  // while its panel reads 79/100. Drawing earned/cap here is what made a
  // green bar sit above an amber panel for the same thing. Where a component
  // has no panel score of its own, earned/cap is the only number there is
  // and the two coincide.
  const addComponent = (key, label, earned, cap, section, detail, panelScore) => {
    const pct = panelScore != null ? panelScore : (cap ? Math.round((earned / cap) * 100) : 0);
    components.push({ key, label, earned, cap, section, detail, pct });
  };

  // Access (30): blocked crawlers cap everything else.
  let access;
  if (data.aiBotAccess) {
    const answerBots = data.aiBotAccess.filter((b) => !/Common Crawl/.test(b.engine));
    const allowed = answerBots.filter((b) => b.allowed).length;
    access = Math.round((allowed / answerBots.length) * 30);
    addComponent('access', 'Crawler access', access, 30, 'sec-crawlers',
      `${allowed} of ${answerBots.length} AI answer-engine crawlers are allowed by robots.txt.`);
  } else {
    access = 24; // unknown (old snapshot) — assume the common case, mostly open
    addComponent('access', 'Crawler access', access, 30, 'sec-crawlers', 'Not captured on this snapshot — assumed mostly open.');
  }

  // Machine-readability (30): structured data, clear topic, semantics.
  const ai = data.aiSeo || {};
  const parse = (ai.hasStructuredData ? 10 : 0) +
    ((ai.hasFaqSchema || ai.hasArticleSchema) ? 5 : 0) +
    (ai.hasClearH1 ? 5 : 0) +
    (ai.hasMetaDescription ? 4 : 0) +
    Math.min(6, Math.round((ai.semanticLandmarks || 0) * 1.2));
  addComponent('parse', 'Machine readability', parse, 30, 'sec-aichecks',
    `Structured data, FAQ/Article schema, a single H1, a meta description and ${ai.semanticLandmarks || 0}/5 semantic landmarks.`);

  // Trust (25): scaled from the E-E-A-T category score + hard trust signals.
  const ts = data.trustSignals;
  let trust = Math.round(((categoryScores && categoryScores.eeat) || 0) * 0.15);
  if (ts) {
    trust += (ts.hasPhone || ts.hasEmail) ? 3 : 0;
    trust += ts.hasAddress ? 3 : 0;
    trust += ts.hasReviewSignal ? 2 : 0;
    trust += (ts.socialProfiles && ts.socialProfiles.length) ? 2 : 0;
  } else {
    trust += 5; // old snapshot — neutral middle
  }
  const trustPanel = scorlyComputeTrustBreakdown(data);
  addComponent('trust', 'Trust signals', trust, 25, 'sec-trust',
    'E-E-A-T signals plus real-world contact details, reviews and social profiles.',
    trustPanel ? trustPanel.score : null);

  // Freshness (15).
  let fresh;
  if (data.freshness) {
    const f = data.freshness;
    const latestMs = f.latestDate ? new Date(f.latestDate).getTime() : null;
    const monthsOld = latestMs ? (Date.now() - latestMs) / (86400000 * 30.4) : null;
    if (monthsOld != null && monthsOld <= 6) fresh = 15;
    else if (monthsOld != null && monthsOld <= 18) fresh = 11;
    else if (f.copyrightYear && f.copyrightYear >= new Date().getFullYear() - 1) fresh = 8;
    else if (monthsOld != null) fresh = 4;
    else fresh = 0;
  } else {
    fresh = 8;
  }
  const freshPanel = scorlyComputeFreshnessBreakdown(data);
  addComponent('fresh', 'Freshness', fresh, 15, 'sec-freshness',
    'How recently the page says it was published or updated.',
    freshPanel ? freshPanel.score : null);

  // Quality deductions (up to -20 of the 100 above). Everything so far asks
  // "can an AI engine reach, parse and trust this page?" — these two ask
  // whether it would want to cite it. Google's spam policies discount
  // mass-produced, low-added-value pages (its "scaled content abuse" policy)
  // and AI answer engines prefer sources with something specific to say, so
  // copy that reads as unedited LLM output and markup that is generated
  // boilerplate both subtract here. Bounded on purpose: neither detection
  // can ever be proof, so neither can sink a page on its own.
  //
  // Guarded because both fields are captured only by newer analyses — an old
  // saved snapshot has no aiCopy/vibeCode and must not be penalised for it.
  const copyResult = scorlyComputeAiCopy(data);
  const vibeResult = scorlyComputeVibeCode(data);
  const copyPenalty = (copyResult && copyResult.penalty) || 0;
  const vibePenalty = (vibeResult && vibeResult.penalty) || 0;
  const deduction = Math.min(20, copyPenalty + vibePenalty);

  // The two deduction components are reported as "how much of the available
  // penalty you avoided", so they read higher-is-better like every other bar
  // rather than inverting halfway down the list.
  if (copyResult) {
    addComponent('copy', 'Human-written copy', 12 - copyPenalty, 12, 'sec-aicopy',
      copyResult.available
        ? `${copyResult.band} — costing ${copyPenalty} of the 12 points at stake.`
        : 'Too little prose on this page to judge writing patterns either way.',
      copyResult.available ? copyResult.displayScore : null);
  }
  if (vibeResult) {
    addComponent('vibe', 'Build quality', 10 - vibePenalty, 10, 'sec-vibecode',
      vibeResult.faults.length
        ? `${vibeResult.faults.length} generated-site fault(s) — costing ${vibePenalty} of the 10 points at stake.`
        : 'No generated-site faults found.',
      vibeResult.buildScore);
  }

  const score = Math.max(0, Math.min(100, access + parse + trust + fresh - deduction));
  return { score, components, deduction, copyPenalty, vibePenalty };
}

function scorlyComputeAiInsights(data, scoreResult) {
  const ts = data.trustSignals || null;
  const fr = data.freshness || null;
  const bc = data.businessContext || null;
  const eeat = data.eeat || {};
  const ai = data.aiSeo || {};
  const content = data.content || {};
  const now = new Date();

  // ---------- Domain / business context (detected, not generated) ----------
  const businessContext = {
    siteName: (bc && bc.siteName) || (data.og && data.og.siteName) || data.hostname || null,
    schemaType: bc ? bc.schemaType : null,
    about: (bc && bc.description) || (data.metaDescription && data.metaDescription.text) || data.firstParagraph || null,
    locality: bc ? bc.locality : null,
    telephone: bc ? bc.telephone : null,
    socialProfiles: ts ? ts.socialProfiles || [] : [],
    captured: !!bc,
  };

  // ---------- Strengths / weaknesses ----------
  const strengths = [];
  const weaknesses = [];
  const add = (list, label, detail) => list.push({ label, detail });

  if (ai.hasClearH1 && data.metaDescription && data.metaDescription.length) add(strengths, 'Clear page topic', 'One H1 plus a meta description define what this page is about.');
  if (ai.hasStructuredData) add(strengths, 'Machine-readable markup', `Structured data present (${(data.jsonLdTypes || []).slice(0, 4).join(', ') || 'JSON-LD'}).`);
  if (ts && (ts.hasPhone || ts.hasEmail) && ts.hasAddress) add(strengths, 'Visible trust signals', 'Real-world contact details (phone/email and an address) are on the page.');
  if (businessContext.locality) add(strengths, 'Strong local positioning', `Location is explicit in structured data (${businessContext.locality}).`);
  if (ts && ts.hasReviewSignal) add(strengths, 'Social proof', 'Review or rating markup found.');
  if (content.readability >= 60) add(strengths, 'Easy to read', `Flesch reading ease ≈ ${content.readability}/100.`);
  if (content.wordCount >= 600) add(strengths, 'Substantial content', `${content.wordCount} words of copy for engines to work with.`);
  if (eeat.hasAuthorByline && eeat.hasPublishDate) add(strengths, 'Clear authorship', 'Author and publish date are both stated.');

  if (content.wordCount > 0 && content.wordCount < 400) add(weaknesses, 'Thin content', `Only ${content.wordCount} words — little depth for engines or AI to cite.`);
  if (!ai.hasFaqSchema) add(weaknesses, 'No FAQ markup', 'FAQ schema makes answers directly liftable by AI assistants and rich results.');
  if (!eeat.hasAuthorByline) add(weaknesses, 'No visible author', 'Nothing says who is behind the content.');
  if (!eeat.hasPublishDate && !(fr && fr.latestDate)) add(weaknesses, 'Undated content', 'No publish or updated date anywhere on the page.');
  if (ts && !ts.hasTermsLink && !eeat.hasPrivacyLink) add(weaknesses, 'No policy pages linked', 'Privacy/terms links are a baseline credibility signal.');
  if (!ai.hasStructuredData) add(weaknesses, 'No structured data', 'AI systems have to guess at the page’s meaning.');
  if (content.readability > 0 && content.readability < 30) add(weaknesses, 'Hard to read', `Flesch reading ease ≈ ${content.readability}/100.`);
  if (data.aiBotAccess && data.aiBotAccess.some((b) => !b.allowed && !/Common Crawl/.test(b.engine))) {
    add(weaknesses, 'AI crawlers blocked', `robots.txt blocks ${data.aiBotAccess.filter((b) => !b.allowed).map((b) => b.bot).join(', ')}.`);
  }
  const copyNow = scorlyComputeAiCopy(data);
  if (copyNow && copyNow.available) {
    if (copyNow.score >= 50) add(weaknesses, 'Copy reads as AI-written', `${copyNow.band} (${copyNow.displayScore}/100) — ${copyNow.familyCount} independent tells, led by ${copyNow.families.slice(0, 2).map((f) => f.label.toLowerCase()).join(' and ')}.`);
    else if (copyNow.score < 25) add(strengths, 'Copy reads as human-written', `No cluster of LLM writing patterns across ${copyNow.proseWords} words of prose.`);
  }
  const vibeNow = scorlyComputeVibeCode(data);
  if (vibeNow && vibeNow.faults.length) {
    add(weaknesses, 'Generated-site faults', vibeNow.faults.map((f) => f.label).join('; ') + '.');
  }
  if (vibeNow && vibeNow.shellRatio != null && vibeNow.shellRatio >= 0.4) {
    add(strengths, 'Content is in the served HTML', `${vibeNow.servedWords} of ${vibeNow.renderedWords} words are present before JavaScript runs, so non-executing crawlers can read the page.`);
  }

  // ---------- Content trust score ----------
  const trust = scorlyComputeTrustBreakdown(data);

  // ---------- Content freshness ----------
  const freshness = scorlyComputeFreshnessBreakdown(data);

  // ---------- Opportunities (quick wins, rule-based) ----------
  const opportunities = [];
  if (copyNow && copyNow.available && copyNow.score >= 50) {
    opportunities.push(`Rewrite the flagged passages in your own voice — start with ${copyNow.families.slice(0, 3).map((f) => f.label.toLowerCase()).join(', ')}. Specific detail (real numbers, names, places, a stated opinion) is what AI answer engines quote; stock phrasing is what they skip.`);
  }
  if (vibeNow && vibeNow.shellRatio != null && vibeNow.shellRatio < 0.4) {
    opportunities.push(`Server-render or pre-render this page: a crawler that does not run JavaScript currently sees ${vibeNow.servedWords} of its ${vibeNow.renderedWords} words. This is the single largest visibility problem on the page.`);
  }
  if (vibeNow && (vibeNow.placeholder || vibeNow.faults.some((f) => /placeholder|Default|Scaffold/i.test(f.label)))) {
    opportunities.push('Replace the scaffold leftovers (default title, template meta description, placeholder copy) with text written for this specific page.');
  }
  if (!ai.hasFaqSchema) opportunities.push('Add an FAQ section with FAQPage schema — the questions people actually ask, each with a 2–3 sentence answer. This is the most direct route into AI answers and rich results.');
  if (content.wordCount > 0 && content.wordCount < 600) opportunities.push('Deepen the page copy: expand each service or topic into its own paragraph with specifics (materials, process, turnaround, pricing signals) rather than one-line claims.');
  if (ts && !ts.hasReviewSignal) opportunities.push('Surface reviews or testimonials with Review/AggregateRating markup so ratings can appear in search results.');
  if (!eeat.hasAuthorByline) opportunities.push('Add a short author or team byline (with a person/company name) — AI systems weigh identifiable sources higher.');
  if (!(fr && fr.latestDate)) opportunities.push('Show a visible "last updated" date (with a <time datetime> tag or dateModified in schema) so both users and crawlers can see the content is current.');
  if (ts && !ts.hasTermsLink && !eeat.hasPrivacyLink) opportunities.push('Link privacy and terms pages in the footer — a baseline trust signal for users, search engines and AI alike.');
  if (data.llmsTxt === false) opportunities.push('Consider publishing an llms.txt at the site root — an emerging convention that hands AI systems a curated map of your best content.');
  if (!eeat.hasOrgOrPersonSchema) opportunities.push('Add Organization schema (name, logo, address, sameAs social links) so engines can connect this page to a real entity.');
  if ((data.jsonLdTypes || []).every((t) => !/BreadcrumbList/i.test(t)) && data.jsonLdTypes) opportunities.push('Add BreadcrumbList schema so results show your site structure instead of a bare URL.');

  const aiCopy = scorlyComputeAiCopy(data);
  const vibeCode = scorlyComputeVibeCode(data);

  return {
    aiVisibility: scoreResult ? scoreResult.aiVisibility : scorlyComputeAiVisibility(data, scoreResult && scoreResult.categoryScores),
    aiVisibilityBreakdown: scorlyComputeAiVisibilityBreakdown(data, scoreResult && scoreResult.categoryScores),
    aiCopy,
    vibeCode,
    businessContext,
    strengths,
    weaknesses,
    trust,
    freshness,
    opportunities: opportunities.slice(0, 6),
    captured: { trustSignals: !!ts, freshness: !!fr, businessContext: !!bc, aiBotAccess: !!data.aiBotAccess, aiCopy: !!data.aiCopy, vibeCode: !!data.vibeCode },
  };
}
