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

// How visible this page can be to AI answer engines: can their crawlers read
// it, can they parse it (structure), can they trust it (E-E-A-T + trust
// signals), and does it look current. 0–100.
function scorlyComputeAiVisibility(data, categoryScores) {
  let score = 0;

  // Access (30): blocked crawlers cap everything else.
  if (data.aiBotAccess) {
    const answerBots = data.aiBotAccess.filter((b) => !/Common Crawl/.test(b.engine));
    const allowed = answerBots.filter((b) => b.allowed).length;
    score += Math.round((allowed / answerBots.length) * 30);
  } else {
    score += 24; // unknown (old snapshot) — assume the common case, mostly open
  }

  // Machine-readability (30): structured data, clear topic, semantics.
  const ai = data.aiSeo || {};
  score += ai.hasStructuredData ? 10 : 0;
  score += (ai.hasFaqSchema || ai.hasArticleSchema) ? 5 : 0;
  score += ai.hasClearH1 ? 5 : 0;
  score += ai.hasMetaDescription ? 4 : 0;
  score += Math.min(6, Math.round((ai.semanticLandmarks || 0) * 1.2));

  // Trust (25): scaled from the E-E-A-T category score + hard trust signals.
  score += Math.round(((categoryScores && categoryScores.eeat) || 0) * 0.15);
  const ts = data.trustSignals;
  if (ts) {
    score += (ts.hasPhone || ts.hasEmail) ? 3 : 0;
    score += ts.hasAddress ? 3 : 0;
    score += ts.hasReviewSignal ? 2 : 0;
    score += (ts.socialProfiles && ts.socialProfiles.length) ? 2 : 0;
  } else {
    score += 5; // old snapshot — neutral middle
  }

  // Freshness (15).
  if (data.freshness) {
    const f = data.freshness;
    const latestMs = f.latestDate ? new Date(f.latestDate).getTime() : null;
    const monthsOld = latestMs ? (Date.now() - latestMs) / (86400000 * 30.4) : null;
    if (monthsOld != null && monthsOld <= 6) score += 15;
    else if (monthsOld != null && monthsOld <= 18) score += 11;
    else if (f.copyrightYear && f.copyrightYear >= new Date().getFullYear() - 1) score += 8;
    else if (monthsOld != null) score += 4;
  } else {
    score += 8;
  }

  return Math.max(0, Math.min(100, score));
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

  // ---------- Content trust score ----------
  function pctOf(items) {
    const got = items.filter(Boolean).length;
    return Math.round((got / items.length) * 100);
  }
  const trust = ts ? (() => {
    const identity = pctOf([ts.hasPhone, ts.hasEmail, ts.hasAddress, ts.hasCompanyNumber || ts.hasVatNumber]);
    const transparency = pctOf([eeat.hasAboutLink, eeat.hasContactLink, eeat.hasPrivacyLink, ts.hasTermsLink]);
    const evidence = pctOf([eeat.hasOrgOrPersonSchema, ts.hasReviewSignal, eeat.hasAuthorByline, (ts.socialProfiles || []).length > 0]);
    const score = Math.round(identity * 0.4 + transparency * 0.3 + evidence * 0.3);
    return {
      score,
      subs: [
        { label: 'Identity & contact', score: identity, detail: 'Phone, email, address, company/VAT number' },
        { label: 'Transparency', score: transparency, detail: 'About, contact, privacy and terms pages' },
        { label: 'Evidence & proof', score: evidence, detail: 'Org/Person schema, reviews, authorship, social profiles' },
      ],
    };
  })() : null;

  // ---------- Content freshness ----------
  const freshness = fr ? (() => {
    const positives = [];
    const negatives = [];
    let score = 50;
    const latestMs = fr.latestDate ? new Date(fr.latestDate).getTime() : null;
    const monthsOld = latestMs ? (Date.now() - latestMs) / (86400000 * 30.4) : null;
    if (monthsOld != null) {
      const when = new Date(fr.latestDate).toISOString().slice(0, 10);
      if (monthsOld <= 6) { score += 35; positives.push(`Dated content signal from ${when}`); }
      else if (monthsOld <= 18) { score += 20; positives.push(`Most recent dated signal: ${when}`); }
      else { score -= 20; negatives.push(`Newest dated signal is from ${when} (≈${Math.round(monthsOld)} months ago)`); }
    } else {
      negatives.push('No explicit content dates (datePublished, <time>, article meta)');
    }
    if (fr.copyrightYear) {
      if (fr.copyrightYear >= now.getFullYear() - 1) { score += 15; positives.push(`Current copyright notice (${fr.copyrightYear})`); }
      else { score -= 15; negatives.push(`Stale copyright notice (${fr.copyrightYear})`); }
    } else {
      negatives.push('No copyright year found');
    }
    if (ts && ts.hasOpeningHours) { score += 5; positives.push('Business hours listed'); }
    if (ts && (ts.hasPhone || ts.hasEmail)) { positives.push('Live contact details present'); }
    return { score: Math.max(0, Math.min(100, score)), positives, negatives };
  })() : null;

  // ---------- Opportunities (quick wins, rule-based) ----------
  const opportunities = [];
  if (!ai.hasFaqSchema) opportunities.push('Add an FAQ section with FAQPage schema — the questions people actually ask, each with a 2–3 sentence answer. This is the most direct route into AI answers and rich results.');
  if (content.wordCount > 0 && content.wordCount < 600) opportunities.push('Deepen the page copy: expand each service or topic into its own paragraph with specifics (materials, process, turnaround, pricing signals) rather than one-line claims.');
  if (ts && !ts.hasReviewSignal) opportunities.push('Surface reviews or testimonials with Review/AggregateRating markup so ratings can appear in search results.');
  if (!eeat.hasAuthorByline) opportunities.push('Add a short author or team byline (with a person/company name) — AI systems weigh identifiable sources higher.');
  if (!(fr && fr.latestDate)) opportunities.push('Show a visible "last updated" date (with a <time datetime> tag or dateModified in schema) so both users and crawlers can see the content is current.');
  if (ts && !ts.hasTermsLink && !eeat.hasPrivacyLink) opportunities.push('Link privacy and terms pages in the footer — a baseline trust signal for users, search engines and AI alike.');
  if (data.llmsTxt === false) opportunities.push('Consider publishing an llms.txt at the site root — an emerging convention that hands AI systems a curated map of your best content.');
  if (!eeat.hasOrgOrPersonSchema) opportunities.push('Add Organization schema (name, logo, address, sameAs social links) so engines can connect this page to a real entity.');
  if ((data.jsonLdTypes || []).every((t) => !/BreadcrumbList/i.test(t)) && data.jsonLdTypes) opportunities.push('Add BreadcrumbList schema so results show your site structure instead of a bare URL.');

  return {
    aiVisibility: scoreResult ? scoreResult.aiVisibility : scorlyComputeAiVisibility(data, scoreResult && scoreResult.categoryScores),
    businessContext,
    strengths,
    weaknesses,
    trust,
    freshness,
    opportunities: opportunities.slice(0, 6),
    captured: { trustSignals: !!ts, freshness: !!fr, businessContext: !!bc, aiBotAccess: !!data.aiBotAccess },
  };
}
