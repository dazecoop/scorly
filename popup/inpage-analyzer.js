// Executed inside the inspected page via chrome.scripting.executeScript.
// Must be fully self-contained (no references to outer scope).
function scorlyInPageAnalyze() {
  function abs(u) {
    if (!u) return null;
    try { return new URL(u, document.baseURI).href; } catch (e) { return u; }
  }
  function metaContent(selector) {
    const el = document.querySelector(selector);
    return el ? (el.getAttribute('content') || '').trim() : null;
  }
  function allMeta(prefix) {
    const out = {};
    document.querySelectorAll('meta[property^="' + prefix + '"], meta[name^="' + prefix + '"]').forEach((el) => {
      const key = el.getAttribute('property') || el.getAttribute('name');
      const val = el.getAttribute('content');
      if (key && val != null) out[key] = val;
    });
    return out;
  }
  function textOf(el) {
    return (el && el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  // ---------- Meta ----------
  const titleEl = document.querySelector('title');
  const titleText = textOf(titleEl);

  const descEl = document.querySelector('meta[name="description"]');
  const descText = descEl ? (descEl.getAttribute('content') || '').trim() : '';

  const canonicalEl = document.querySelector('link[rel="canonical"]');
  const canonical = canonicalEl ? abs(canonicalEl.getAttribute('href')) : null;

  const robotsMeta = metaContent('meta[name="robots"]');
  const viewport = metaContent('meta[name="viewport"]');
  const charset = document.characterSet || null;
  const lang = document.documentElement.getAttribute('lang') || null;
  const hasDoctype = !!document.doctype;

  let favicon = null;
  const iconEl = document.querySelector('link[rel~="icon"]');
  if (iconEl) favicon = abs(iconEl.getAttribute('href'));
  else favicon = abs('/favicon.ico');

  // ---------- Headings ----------
  const headingList = [];
  const headingCounts = { h1: 0, h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 };
  document.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((h) => {
    const level = Number(h.tagName.substring(1));
    headingCounts['h' + level]++;
    headingList.push({ level, text: textOf(h).slice(0, 200) });
  });
  const h1Texts = headingList.filter((h) => h.level === 1).map((h) => h.text);

  // ---------- Images ----------
  const imgEls = Array.from(document.querySelectorAll('img'));
  const imageList = imgEls.slice(0, 200).map((img) => {
    const alt = img.getAttribute('alt');
    return {
      src: abs(img.getAttribute('src') || img.currentSrc || ''),
      alt: alt || '',
      missing: !img.hasAttribute('alt') || img.getAttribute('alt').trim() === '',
    };
  });
  const images = {
    total: imgEls.length,
    missingAlt: imageList.filter((i) => i.missing).length + Math.max(0, imgEls.length - imageList.length),
    list: imageList,
  };

  // ---------- Links ----------
  const anchors = Array.from(document.querySelectorAll('a[href]'));
  const internalList = [];
  const externalList = [];
  let nofollowCount = 0;
  let missingAnchorText = 0;
  anchors.forEach((a) => {
    const href = a.getAttribute('href') || '';
    if (/^(mailto:|tel:|javascript:|#)/i.test(href)) return;
    let isInternal = true;
    let fullHref = href;
    try {
      const u = new URL(href, document.baseURI);
      isInternal = u.hostname === location.hostname;
      fullHref = u.href;
    } catch (e) { /* relative, treat internal */ }

    const text = textOf(a);
    const hasAccessibleText = text || a.getAttribute('aria-label') || a.querySelector('img[alt]');
    if (!hasAccessibleText) missingAnchorText++;

    const rel = (a.getAttribute('rel') || '').toLowerCase();
    const isNofollow = rel.includes('nofollow');
    if (isNofollow) nofollowCount++;

    const entry = { href: fullHref, text: text.slice(0, 120), nofollow: isNofollow };
    if (isInternal) { if (internalList.length < 300) internalList.push(entry); }
    else if (externalList.length < 300) externalList.push(entry);
  });

  // ---------- Content ----------
  const bodyText = (document.body && document.body.innerText) ? document.body.innerText.trim() : '';
  const words = bodyText ? bodyText.split(/\s+/).filter(Boolean) : [];
  const wordCount = words.length;
  const paragraphCount = Array.from(document.querySelectorAll('p')).filter((p) => textOf(p).length > 0).length;
  const sentences = bodyText ? bodyText.split(/[.!?]+(?:\s|$)/).map((s) => s.trim()).filter((s) => s.split(/\s+/).length > 2) : [];
  const sentenceCount = sentences.length;
  const avgSentenceLength = sentenceCount ? Math.round((wordCount / sentenceCount) * 10) / 10 : 0;
  const readTimeMin = Math.max(1, Math.round(wordCount / 200));

  // Approximate Flesch Reading Ease
  function countSyllables(word) {
    word = word.toLowerCase().replace(/[^a-z]/g, '');
    if (!word) return 0;
    const matches = word.match(/[aeiouy]+/g);
    let count = matches ? matches.length : 1;
    if (word.endsWith('e') && count > 1) count--;
    return Math.max(1, count);
  }
  let syllableTotal = 0;
  const sampleWords = words.slice(0, 2000);
  sampleWords.forEach((w) => { syllableTotal += countSyllables(w); });
  let readability = 0;
  if (sentenceCount > 0 && sampleWords.length > 0) {
    const wps = sampleWords.length / sentenceCount;
    const spw = syllableTotal / sampleWords.length;
    readability = Math.round(206.835 - 1.015 * wps - 84.6 * spw);
    readability = Math.max(0, Math.min(100, readability));
  }

  // Top keywords (excluding stopwords)
  const STOPWORDS = new Set('a,an,the,and,or,but,if,then,else,for,of,to,in,on,at,by,with,from,as,is,are,was,were,be,been,being,this,that,these,those,it,its,i,you,he,she,we,they,them,his,her,our,your,their,not,no,so,do,does,did,have,has,had,will,would,can,could,should,may,might,must,about,into,over,after,before,up,down,out,off,than,too,very,just,also,more,most,such,only,own,same,s,t,re,ve,ll,d,m'.split(','));
  const freq = new Map();
  words.forEach((raw) => {
    const w = raw.toLowerCase().replace(/[^a-z0-9'-]/g, '');
    if (w.length < 3 || STOPWORDS.has(w) || /^\d+$/.test(w)) return;
    freq.set(w, (freq.get(w) || 0) + 1);
  });
  const topKeywords = Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([word, count]) => ({ word, count, pct: wordCount ? Math.round((count / wordCount) * 1000) / 10 : 0 }));

  // ---------- Open Graph / Twitter ----------
  const ogRaw = allMeta('og:');
  const og = {
    title: ogRaw['og:title'] || null,
    description: ogRaw['og:description'] || null,
    image: ogRaw['og:image'] ? abs(ogRaw['og:image']) : null,
    url: ogRaw['og:url'] || null,
    type: ogRaw['og:type'] || null,
    siteName: ogRaw['og:site_name'] || null,
    raw: ogRaw,
  };
  const twRaw = allMeta('twitter:');
  const twitter = {
    card: twRaw['twitter:card'] || null,
    title: twRaw['twitter:title'] || null,
    description: twRaw['twitter:description'] || null,
    image: twRaw['twitter:image'] ? abs(twRaw['twitter:image']) : null,
    site: twRaw['twitter:site'] || null,
    raw: twRaw,
  };

  // ---------- Structured data ----------
  const jsonLdNodes = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
  const jsonLd = [];
  const jsonLdTypes = [];
  jsonLdNodes.forEach((node) => {
    try {
      const parsed = JSON.parse(node.textContent);
      jsonLd.push(parsed);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      items.forEach((it) => {
        if (it && it['@type']) {
          const t = Array.isArray(it['@type']) ? it['@type'].join(', ') : it['@type'];
          jsonLdTypes.push(t);
        }
      });
    } catch (e) {
      jsonLd.push({ parseError: true, raw: node.textContent.slice(0, 200) });
    }
  });

  const hreflangs = Array.from(document.querySelectorAll('link[rel="alternate"][hreflang]')).map((l) => ({
    lang: l.getAttribute('hreflang'),
    href: abs(l.getAttribute('href')),
  }));

  // ---------- Performance ----------
  let ttfb = null, transferSize = 0, requestCount = 0, nextHopProtocol = null;
  try {
    const nav = performance.getEntriesByType('navigation')[0];
    if (nav) {
      ttfb = Math.round(nav.responseStart - nav.requestStart);
      nextHopProtocol = nav.nextHopProtocol || null;
      transferSize += nav.transferSize || 0;
    }
    const resources = performance.getEntriesByType('resource');
    requestCount = resources.length + (nav ? 1 : 0);
    resources.forEach((r) => { transferSize += r.transferSize || 0; });
  } catch (e) { /* performance API unavailable */ }

  // ---------- Security ----------
  const isSecureContext = !!window.isSecureContext;
  let mixedContentCount = 0;
  try {
    const resources = performance.getEntriesByType('resource');
    if (location.protocol === 'https:') {
      mixedContentCount = resources.filter((r) => r.name.startsWith('http://')).length;
    }
  } catch (e) { /* ignore */ }

  // ---------- AI-SEO / E-E-A-T heuristics ----------
  const hasFaqSchema = jsonLdTypes.some((t) => /FAQPage/i.test(t));
  const hasArticleSchema = jsonLdTypes.some((t) => /Article/i.test(t));
  const hasOrgOrPersonSchema = jsonLdTypes.some((t) => /Organization|Person/i.test(t));
  const semanticLandmarks = ['main', 'article', 'nav', 'header', 'footer'].filter((tag) => document.querySelector(tag)).length;

  const authorMeta = metaContent('meta[name="author"]');
  const hasAuthorByline = !!(authorMeta || document.querySelector('[rel="author"]') || document.querySelector('[itemprop="author"]') || jsonLd.some((j) => JSON.stringify(j).includes('"author"')));
  const publishMeta = metaContent('meta[property="article:published_time"]') || metaContent('meta[name="date"]');
  const hasPublishDate = !!(publishMeta || document.querySelector('time[datetime]') || jsonLd.some((j) => JSON.stringify(j).includes('datePublished')));
  const lowerLinks = anchors.map((a) => ((a.getAttribute('href') || '') + ' ' + textOf(a)).toLowerCase());
  const hasAboutLink = lowerLinks.some((s) => /\babout\b/.test(s));
  const hasContactLink = lowerLinks.some((s) => /\bcontact\b/.test(s));
  const hasPrivacyLink = lowerLinks.some((s) => /\bprivacy\b/.test(s));

  const hostname = location.hostname;
  const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' ||
    hostname.endsWith('.local') || /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname);

  let htmlSize = 0;
  try { htmlSize = new Blob([document.documentElement.outerHTML]).size; } catch (e) { htmlSize = document.documentElement.outerHTML.length; }

  const firstParagraph = (() => {
    const p = document.querySelector('p');
    return p ? textOf(p).slice(0, 200) : '';
  })();

  return {
    url: location.href,
    hostname,
    protocol: location.protocol,
    isLocalhost,
    title: { text: titleText, length: titleText.length },
    metaDescription: { text: descText, length: descText.length },
    canonical,
    robotsMeta,
    viewport,
    charset,
    lang,
    hasDoctype,
    favicon,
    headings: { list: headingList, counts: headingCounts, h1: h1Texts },
    images,
    links: {
      internalList, externalList,
      internal: internalList.length, external: externalList.length,
      nofollow: nofollowCount, total: anchors.length, missingAnchorText,
    },
    content: {
      wordCount, paragraphCount, sentenceCount, avgSentenceLength, readTimeMin, readability, topKeywords,
    },
    wordCount,
    htmlSize,
    og,
    twitter,
    jsonLd,
    jsonLdTypes,
    hreflangs,
    firstParagraph,
    perf: { ttfb, transferSize, requestCount, nextHopProtocol },
    security: { isSecureContext, mixedContentCount, https: location.protocol === 'https:' },
    aiSeo: { hasFaqSchema, hasArticleSchema, semanticLandmarks, hasStructuredData: jsonLd.length > 0, hasMetaDescription: !!descText, hasClearH1: h1Texts.length === 1 },
    eeat: { hasAuthorByline, hasPublishDate, hasAboutLink, hasContactLink, hasPrivacyLink, hasOrgOrPersonSchema },
    analyzedAt: new Date().toISOString(),
  };
}
