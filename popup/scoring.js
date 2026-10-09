// Turns raw page data into category scores + a detailed, severity-tagged checklist.
// Loaded as a plain script in popup.html (no module system needed).

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

  // ===================== TECHNICAL =====================
  const technical = makeCategory();
  technical.add('https', 'HTTPS', (data.isLocalhost || data.security.https) ? 'pass' : 'fail',
    data.isLocalhost ? 'Localhost — HTTPS not required.' : (data.security.https ? 'Site is served over HTTPS.' : 'Site is not served over HTTPS.'), 'high');
  technical.add('canonical', 'Canonical URL', data.canonical ? 'pass' : 'fail',
    data.canonical || 'No canonical link tag found.', 'med');
  technical.add('viewport', 'Viewport', data.viewport ? 'pass' : 'fail',
    data.viewport || 'No viewport meta tag — page may not be mobile-friendly.', 'high');
  technical.add('lang', 'Language', data.lang ? 'pass' : 'warn', data.lang || 'Missing lang attribute on <html>.', 'low');
  technical.add('favicon', 'Favicon', data.faviconOk ? 'pass' : 'warn', data.faviconOk ? 'Favicon present.' : 'Favicon missing or not loading.', 'low');
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

  // ===================== MOBILE =====================
  const mobile = makeCategory();
  mobile.add('viewport', 'Responsive viewport', data.viewport ? 'pass' : 'fail',
    data.viewport ? data.viewport : 'No viewport meta tag.', 'high');
  const viewportScalable = !data.viewport || !/user-scalable=no|maximum-scale=1(\.0)?\b/i.test(data.viewport);
  mobile.add('zoom', 'Pinch-zoom allowed', viewportScalable ? 'pass' : 'warn',
    viewportScalable ? 'Zooming is not disabled.' : 'Viewport disables user scaling — an accessibility issue.', 'med');

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

  // ===================== E-E-A-T (heuristic) =====================
  const eeat = makeCategory();
  eeat.add('author', 'Author byline', data.eeat.hasAuthorByline ? 'pass' : 'warn',
    data.eeat.hasAuthorByline ? 'Author information found.' : 'No author byline or meta author tag detected.', 'med');
  eeat.add('date', 'Published/updated date', data.eeat.hasPublishDate ? 'pass' : 'warn',
    data.eeat.hasPublishDate ? 'Publish/modified date found.' : 'No publish or last-updated date detected.', 'med');
  eeat.add('org', 'Organization / Person schema', data.eeat.hasOrgOrPersonSchema ? 'pass' : 'warn',
    data.eeat.hasOrgOrPersonSchema ? 'Organization or Person schema present.' : 'No Organization/Person schema found.', 'low');
  eeat.add('about', 'About page linked', data.eeat.hasAboutLink ? 'pass' : 'warn', data.eeat.hasAboutLink ? 'Found a link to an About page.' : 'No About page link found.', 'low');
  eeat.add('contact', 'Contact page linked', data.eeat.hasContactLink ? 'pass' : 'warn', data.eeat.hasContactLink ? 'Found a link to a Contact page.' : 'No Contact page link found.', 'low');
  eeat.add('privacy', 'Privacy policy linked', data.eeat.hasPrivacyLink ? 'pass' : 'warn', data.eeat.hasPrivacyLink ? 'Found a link to a Privacy Policy.' : 'No Privacy Policy link found.', 'low');
  eeat.add('https', 'Trust signal: HTTPS', (data.isLocalhost || data.security.https) ? 'pass' : 'fail',
    data.isLocalhost ? 'Localhost — skipped.' : (data.security.https ? 'Secure connection.' : 'Not served over HTTPS.'), 'high');

  const categories = { technical, content, perf, schema, security, mobile, aiSeo, eeat };
  const categoryScores = {};
  Object.keys(categories).forEach((k) => { categoryScores[k] = categories[k].score(); });

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
