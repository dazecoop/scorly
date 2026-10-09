// Executed inside the inspected page via chrome.scripting.executeScript.
// Must be fully self-contained (no references to outer scope).
async function scorlyInPageAnalyze() {
  // largest-contentful-paint / layout-shift entries are only backfilled to a
  // PerformanceObserver that explicitly asks for `buffered: true` — plain
  // getEntriesByType() returns nothing for them. Delivery of buffered entries
  // is async, so wait one tick (or the real-time callback, whichever is first).
  function collectBuffered(type, timeoutMs, extraOpts) {
    return new Promise((resolve) => {
      if (typeof PerformanceObserver === 'undefined' ||
          !PerformanceObserver.supportedEntryTypes ||
          !PerformanceObserver.supportedEntryTypes.includes(type)) {
        resolve([]);
        return;
      }
      let entries = [];
      let observer;
      try {
        observer = new PerformanceObserver((list) => { entries = entries.concat(list.getEntries()); });
        observer.observe(Object.assign({ type, buffered: true }, extraOpts || {}));
      } catch (e) {
        resolve([]);
        return;
      }
      setTimeout(() => {
        try { observer.disconnect(); } catch (e) { /* ignore */ }
        resolve(entries);
      }, timeoutMs);
    });
  }
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
    headingList.push({ level, text: textOf(h).slice(0, 500) });
  });
  const h1Texts = headingList.filter((h) => h.level === 1).map((h) => h.text);

  // ---------- Images ----------
  function imageFormat(url) {
    if (!url) return null;
    if (/^data:image\/([a-z0-9+.-]+)/i.test(url)) return RegExp.$1.toLowerCase().replace('jpeg', 'jpg');
    try {
      const m = new URL(url, document.baseURI).pathname.match(/\.([a-z0-9]{2,5})$/i);
      if (!m) return null;
      const ext = m[1].toLowerCase();
      return ext === 'jpeg' ? 'jpg' : ext;
    } catch (e) { return null; }
  }
  const imgEls = Array.from(document.querySelectorAll('img'));
  const imageList = imgEls.slice(0, 200).map((img) => {
    const alt = img.getAttribute('alt');
    const src = abs(img.currentSrc || img.getAttribute('src') || '');
    const rect = img.getBoundingClientRect();
    const renderedW = Math.round(rect.width);
    const renderedH = Math.round(rect.height);
    const naturalW = img.naturalWidth || 0;
    const naturalH = img.naturalHeight || 0;
    // Oversized = intrinsic pixels are ≥2× what the layout slot needs even on
    // a 2× (retina) screen — the classic "shipping a 2400px hero into a 600px
    // column" waste. Only judged once both sizes are known and non-trivial.
    const oversized = !!(naturalW && renderedW > 20 &&
      naturalW >= renderedW * 2 * Math.min(2, window.devicePixelRatio || 1));
    return {
      src,
      alt: alt || '',
      missing: !img.hasAttribute('alt') || img.getAttribute('alt').trim() === '',
      naturalW,
      naturalH,
      renderedW,
      renderedH,
      format: imageFormat(src),
      loading: img.getAttribute('loading') || null,
      fetchpriority: img.getAttribute('fetchpriority') || null,
      hasExplicitSize: img.hasAttribute('width') && img.hasAttribute('height'),
      oversized,
    };
  });
  const LEGACY_FORMATS = ['png', 'jpg', 'gif', 'bmp'];
  const images = {
    total: imgEls.length,
    missingAlt: imageList.filter((i) => i.missing).length + Math.max(0, imgEls.length - imageList.length),
    missingDimensions: imageList.filter((i) => !i.hasExplicitSize).length,
    oversized: imageList.filter((i) => i.oversized).length,
    legacyFormat: imageList.filter((i) => i.format && LEGACY_FORMATS.includes(i.format)).length,
    lazyLoaded: imageList.filter((i) => i.loading === 'lazy').length,
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

  // ---------- Text blocks (for exact-wording comparison) ----------
  // One entry per visible copy-bearing element, in document order, so two
  // captures of the same page can be diffed as a sequence rather than as a
  // single wall of text.
  const TEXT_BLOCK_SELECTOR = 'h1,h2,h3,h4,h5,h6,p,li,td,th,blockquote,figcaption,button,label,summary,dt,dd';
  const textBlocks = [];
  // Per-block cap is generous (so copy can be verified verbatim) but a total
  // character budget keeps a pathological page from blowing the storage quota.
  let textBudget = 400000;
  document.querySelectorAll(TEXT_BLOCK_SELECTOR).forEach((node) => {
    if (textBlocks.length >= 800 || textBudget <= 0) return;
    // Skip wrappers whose text comes entirely from a nested block we already
    // captured (e.g. <li><p>…</p></li>) to avoid duplicate diff rows.
    if (node.querySelector(TEXT_BLOCK_SELECTOR)) return;
    const text = textOf(node);
    if (!text) return;
    const kept = text.slice(0, Math.min(4000, textBudget));
    textBudget -= kept.length;
    textBlocks.push({ tag: node.tagName.toLowerCase(), text: kept });
  });

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
  const resourceList = [];
  let renderBlockingCount = null;
  try {
    const nav = performance.getEntriesByType('navigation')[0];
    if (nav) {
      ttfb = Math.round(nav.responseStart - nav.requestStart);
      nextHopProtocol = nav.nextHopProtocol || null;
      transferSize += nav.transferSize || 0;
      resourceList.push({
        url: nav.name,
        type: 'document',
        transferSize: nav.transferSize || 0,
        duration: Math.round(nav.duration) || null,
        startTime: 0,
        renderBlocking: true,
      });
    }
    const resources = performance.getEntriesByType('resource');
    requestCount = resources.length + (nav ? 1 : 0);
    // renderBlockingStatus is Chromium-only (107+); null means "unknown", not
    // "not blocking", so Firefox renders no blocking flags rather than wrong ones.
    const hasBlockingInfo = resources.length > 0 && 'renderBlockingStatus' in resources[0];
    resources.forEach((r) => {
      transferSize += r.transferSize || 0;
      if (resourceList.length >= 400) return;
      resourceList.push({
        url: r.name,
        type: r.initiatorType || 'other',
        transferSize: r.transferSize || 0,
        duration: Math.round(r.duration),
        startTime: Math.round(r.startTime),
        renderBlocking: hasBlockingInfo ? r.renderBlockingStatus === 'blocking' : null,
      });
    });
    if (hasBlockingInfo) renderBlockingCount = resourceList.filter((r) => r.renderBlocking && r.type !== 'document').length;
  } catch (e) { /* performance API unavailable */ }

  // Real Web Vitals, read from the browser's own performance entry buffer
  // (no network calls — just local Performance Observer APIs).
  let lcp = null, cls = null, fcp = null, tbt = null, inp = null;
  try {
    const [lcpEntries, shiftEntries, paintEntries, longTasks, eventEntries] = await Promise.all([
      collectBuffered('largest-contentful-paint', 150),
      collectBuffered('layout-shift', 150),
      collectBuffered('paint', 150),
      collectBuffered('longtask', 150),
      // Event Timing: buffered interaction latencies. durationThreshold 16 is
      // the API minimum — anything slower than one frame is kept.
      collectBuffered('event', 150, { durationThreshold: 16 }),
    ]);
    if (lcpEntries.length) lcp = Math.round(lcpEntries[lcpEntries.length - 1].startTime);
    if (shiftEntries.length || PerformanceObserver.supportedEntryTypes.includes('layout-shift')) {
      cls = Math.round(shiftEntries.reduce((sum, e) => sum + (e.hadRecentInput ? 0 : e.value), 0) * 1000) / 1000;
    }
    const fcpEntry = paintEntries.find((p) => p.name === 'first-contentful-paint');
    if (fcpEntry) fcp = Math.round(fcpEntry.startTime);
    // TBT approximation: sum of main-thread blocking time (long task duration
    // beyond 50ms) after FCP. Lab TBT proper stops at TTI; without a TTI
    // estimate this slightly over-counts, so it is labelled "approx".
    // Chromium-only — Firefox has no longtask entries, leaving this null.
    if (longTasks.length || (PerformanceObserver.supportedEntryTypes || []).includes('longtask')) {
      tbt = Math.round(longTasks.reduce((sum, t) => {
        if (fcp != null && t.startTime + t.duration <= fcp) return sum;
        return sum + Math.max(0, t.duration - 50);
      }, 0));
    }
    // INP needs real interactions: the worst buffered interaction latency so
    // far. Null on a fresh load where the user has not interacted yet.
    const interactions = eventEntries.filter((e) => e.interactionId);
    if (interactions.length) inp = Math.round(Math.max.apply(null, interactions.map((e) => e.duration)));
  } catch (e) { /* not supported */ }

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

  // SERP pixel widths, measured locally with a canvas at Google's desktop
  // rendering sizes (title ≈20px Arial, truncates ≈580px; description ≈14px
  // Arial, truncates ≈920px). Approximate but far closer than char counts.
  function serpPixelWidth(text, font) {
    if (!text) return 0;
    try {
      const ctx = document.createElement('canvas').getContext('2d');
      ctx.font = font;
      return Math.round(ctx.measureText(text).width);
    } catch (e) { return null; }
  }
  const titlePixels = serpPixelWidth(titleText, '20px Arial');
  const descPixels = serpPixelWidth(descText, '14px Arial');

  return {
    url: location.href,
    hostname,
    protocol: location.protocol,
    isLocalhost,
    title: { text: titleText, length: titleText.length, pixels: titlePixels },
    metaDescription: { text: descText, length: descText.length, pixels: descPixels },
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
    textBlocks,
    perf: { ttfb, transferSize, requestCount, nextHopProtocol, lcp, cls, fcp, tbt, inp, renderBlockingCount },
    resources: resourceList,
    security: { isSecureContext, mixedContentCount, https: location.protocol === 'https:' },
    aiSeo: { hasFaqSchema, hasArticleSchema, semanticLandmarks, hasStructuredData: jsonLd.length > 0, hasMetaDescription: !!descText, hasClearH1: h1Texts.length === 1 },
    eeat: { hasAuthorByline, hasPublishDate, hasAboutLink, hasContactLink, hasPrivacyLink, hasOrgOrPersonSchema },
    analyzedAt: new Date().toISOString(),
  };
}
