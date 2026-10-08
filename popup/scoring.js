// Turns raw page data into category scores + a detailed, severity-tagged checklist.
// Loaded as a plain script in popup.html (no module system needed).

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
  if (!tLen) content.add('title', 'Title tag', 'fail', 'Missing <title> tag.', 'high');
  else if (tLen < 10) content.add('title', 'Title tag', 'warn', `Title is very short (${tLen} chars). Aim for 10–60.`, 'med');
  else if (tLen > 60) content.add('title', 'Title tag', 'warn', `Title is long (${tLen} chars) and may be truncated in search results.`, 'med');
  else content.add('title', 'Title tag', 'pass', `"${data.title.text}" (${tLen} chars).`);

  const dLen = data.metaDescription.length;
  if (!dLen) content.add('description', 'Meta description', 'fail', 'Missing meta description.', 'high');
  else if (dLen < 50) content.add('description', 'Meta description', 'warn', `Description is short (${dLen} chars). Aim for 50–160.`, 'med');
  else if (dLen > 160) content.add('description', 'Meta description', 'warn', `Description is long (${dLen} chars) and may be truncated.`, 'med');
  else content.add('description', 'Meta description', 'pass', `${dLen} characters — good length.`);

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
