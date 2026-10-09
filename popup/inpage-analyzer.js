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
  const headingTextCounts = new Map();
  headingList.forEach((h) => {
    const key = h.text.toLowerCase();
    if (!key) return;
    headingTextCounts.set(key, (headingTextCounts.get(key) || 0) + 1);
  });
  const duplicateHeadingCount = Array.from(headingTextCounts.values()).filter((n) => n > 1).length;

  // ---------- Empty bold/strong tags ----------
  let emptyBoldCount = 0;
  document.querySelectorAll('b, strong').forEach((el) => {
    if (!textOf(el)) emptyBoldCount++;
  });

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
    // Distorted = the rendered box squashes/stretches the intrinsic aspect
    // ratio by more than ~15% (and CSS isn't letting object-fit absorb it).
    let distorted = false;
    if (naturalW && naturalH && renderedW > 20 && renderedH > 20) {
      const ratioDrift = (naturalW / naturalH) / (renderedW / renderedH);
      if (ratioDrift > 1.15 || ratioDrift < 0.87) {
        const fit = (getComputedStyle(img).objectFit || 'fill');
        distorted = fit === 'fill';
      }
    }
    return {
      distorted,
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
    distorted: imageList.filter((i) => i.distorted).length,
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
    .slice(0, 30)
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

  // ---------- Duplicate paragraph text ----------
  // Only paragraphs long enough to be real content — short repeated phrases
  // ("Read more", "Share") are normal UI chrome, not duplicate content.
  const paraCounts = new Map();
  textBlocks.forEach((b) => {
    if (b.tag !== 'p' || b.text.length < 40) return;
    const key = b.text.toLowerCase();
    paraCounts.set(key, (paraCounts.get(key) || 0) + 1);
  });
  const duplicateParagraphCount = Array.from(paraCounts.values()).filter((n) => n > 1).length;

  // ---------- Mobile: tap targets & text size ----------
  // Heuristic, not a real mobile-viewport emulation (there's no headless
  // browser here to resize) — this measures whatever viewport the page is
  // actually open at, against the common ~44px tap-target guideline and the
  // ~12px legibility floor several mobile-SEO tools use.
  const TAP_TARGET_SELECTOR = 'a[href], button, input[type="button"], input[type="submit"], input[type="reset"], [role="button"]';
  let smallTapTargets = 0, tapTargetsChecked = 0;
  document.querySelectorAll(TAP_TARGET_SELECTOR).forEach((el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return; // not actually rendered/visible
    tapTargetsChecked++;
    if (rect.width < 44 || rect.height < 44) smallTapTargets++;
  });

  let smallFontCount = 0, fontSizeSamplesChecked = 0;
  document.querySelectorAll('p, li, span, a, td, dd, dt').forEach((el) => {
    // Leaf elements only (no nested elements) so a sentence isn't counted
    // once for itself and again for every inline tag inside it.
    if (fontSizeSamplesChecked >= 300 || el.children.length > 0) return;
    const text = textOf(el);
    if (!text || text.length < 10) return;
    fontSizeSamplesChecked++;
    const size = parseFloat(getComputedStyle(el).fontSize);
    if (size && size < 12) smallFontCount++;
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
  // Each check greps every link's URL + anchor text for common names of
  // that page type, and remembers WHICH term matched so the check detail can
  // show its evidence instead of a bare pass/fail.
  function findLinkTerm(patterns) {
    for (const [re, name] of patterns) {
      if (lowerLinks.some((s) => re.test(s))) return name;
    }
    return null;
  }
  const aboutMatch = findLinkTerm([
    [/\babout\b|about-us|aboutus/, 'about'],
    [/our[\s_-]story|ourstory/, 'our story'],
    [/who[\s_-]we[\s_-]are/, 'who we are'],
    [/(our|the|meet[\s_-](our|the))[\s_-]team\b/, 'our team'],
    [/\bcompany\b/, 'company'],
    [/\bmission\b/, 'mission'],
  ]);
  const contactMatch = findLinkTerm([
    [/\bcontact\b|contact-us|contactus/, 'contact'],
    [/get[\s_-]in[\s_-]touch/, 'get in touch'],
    [/reach[\s_-](us|out)/, 'reach us'],
    [/\bsupport\b/, 'support'],
    [/\bhelp\b|help[\s_-]cent(er|re)/, 'help'],
  ]);
  const privacyMatch = findLinkTerm([
    [/\bprivacy\b/, 'privacy'],
    [/data[\s_-]protection/, 'data protection'],
  ]);
  const hasAboutLink = !!aboutMatch;
  const hasContactLink = !!contactMatch;
  const hasPrivacyLink = !!privacyMatch;

  // ---------- Page hygiene ----------
  // Checks ported from hosted SEO checkers that are pure DOM/Performance
  // reads: deprecated markup, meta refresh, DOM weight, unsafe _blank links,
  // harvestable emails, analytics/CDN detection, responsive CSS, compression.
  const DEPRECATED_TAGS = ['center', 'font', 'marquee', 'blink', 'frame', 'frameset', 'big', 'strike', 'tt', 'acronym', 'applet', 'basefont', 'dir'];
  const deprecatedFound = {};
  DEPRECATED_TAGS.forEach((tag) => {
    const n = document.getElementsByTagName(tag).length;
    if (n) deprecatedFound[tag] = n;
  });

  const metaRefresh = metaContent('meta[http-equiv="refresh" i]');
  const domSize = document.getElementsByTagName('*').length;

  let unsafeCrossOrigin = 0;
  anchors.forEach((a) => {
    if ((a.getAttribute('target') || '').toLowerCase() !== '_blank') return;
    let external = false;
    try { external = new URL(a.getAttribute('href'), document.baseURI).hostname !== location.hostname; } catch (e) { return; }
    const rel = (a.getAttribute('rel') || '').toLowerCase();
    if (external && !rel.includes('noopener') && !rel.includes('noreferrer')) unsafeCrossOrigin++;
  });

  // Emails sitting in visible text (not mailto: links) are harvestable by
  // spam bots; mailto links are reported separately since they're deliberate.
  const textEmails = Array.from(new Set((bodyText.match(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g) || [])
    .filter((e) => !/\.(png|jpg|jpeg|gif|webp|svg|css|js)$/i.test(e)))).slice(0, 5);

  const resourceUrls = (() => {
    try { return performance.getEntriesByType('resource').map((r) => r.name); } catch (e) { return []; }
  })().concat(Array.from(document.scripts).map((s) => s.src).filter(Boolean));
  const ANALYTICS_PATTERNS = [
    [/googletagmanager\.com|google-analytics\.com|gtag\/js/i, 'Google Analytics / GTM'],
    [/plausible\.io/i, 'Plausible'], [/matomo|piwik/i, 'Matomo'], [/usefathom\.com/i, 'Fathom'],
    [/clarity\.ms/i, 'MS Clarity'], [/hotjar\.com/i, 'Hotjar'], [/segment\.(io|com)/i, 'Segment'],
    [/mixpanel\.com/i, 'Mixpanel'], [/umami\./i, 'Umami'], [/cdn\.heapanalytics/i, 'Heap'],
    [/static\.cloudflareinsights\.com/i, 'Cloudflare Analytics'], [/connect\.facebook\.net.*fbevents/i, 'Meta Pixel'],
  ];
  const analytics = ANALYTICS_PATTERNS.filter(([re]) => resourceUrls.some((u) => re.test(u))).map(([, name]) => name);
  const CDN_PATTERNS = [
    [/cloudfront\.net/i, 'CloudFront'], [/cdn\.cloudflare|cdnjs\.cloudflare/i, 'Cloudflare CDN'],
    [/fastly\.(net|com)/i, 'Fastly'], [/akamai(zed|hd)?\.net/i, 'Akamai'], [/jsdelivr\.net/i, 'jsDelivr'],
    [/unpkg\.com/i, 'unpkg'], [/azureedge\.net/i, 'Azure CDN'], [/\bbunny(cdn)?\.net/i, 'Bunny'],
    [/gstatic\.com|googleapis\.com/i, 'Google CDN'], [/\.b-cdn\.net/i, 'Bunny'], [/wp\.com/i, 'WordPress CDN'],
  ];
  const cdns = Array.from(new Set(CDN_PATTERNS.filter(([re]) => resourceUrls.some((u) => re.test(u))).map(([, name]) => name)));

  // @media rules in same-origin stylesheets (cross-origin sheets throw on
  // cssRules — counted as unknown, not as zero).
  let mediaQueryCount = 0, styleSheetsReadable = 0, styleSheetsTotal = 0;
  try {
    Array.from(document.styleSheets).forEach((sheet) => {
      styleSheetsTotal++;
      try {
        const rules = sheet.cssRules;
        styleSheetsReadable++;
        Array.from(rules).forEach((r) => { if (r.type === CSSRule.MEDIA_RULE) mediaQueryCount++; });
      } catch (e) { /* cross-origin */ }
    });
  } catch (e) { /* ignore */ }

  // Document compression, from the navigation entry: encoded (wire) vs
  // decoded body size. Equal sizes on a non-trivial page = no gzip/brotli.
  let compression = null;
  try {
    const nav0 = performance.getEntriesByType('navigation')[0];
    if (nav0 && nav0.decodedBodySize) {
      compression = {
        encodedBodySize: nav0.encodedBodySize || 0,
        decodedBodySize: nav0.decodedBodySize,
        compressed: nav0.encodedBodySize > 0 && nav0.encodedBodySize < nav0.decodedBodySize * 0.95,
      };
    }
  } catch (e) { /* ignore */ }

  const hygiene = {
    deprecatedTags: deprecatedFound,
    deprecatedTagCount: Object.values(deprecatedFound).reduce((a, b) => a + b, 0),
    metaRefresh,
    domSize,
    unsafeCrossOrigin,
    textEmails,
    analytics,
    cdns,
    mediaQueries: { count: mediaQueryCount, readable: styleSheetsReadable, total: styleSheetsTotal },
    compression,
  };

  // ---------- Trust / freshness / business-context signals ----------
  // All string-matched from the page itself — heuristic inputs for the AI
  // Insights tab. Nothing here calls out anywhere.
  const jsonLdText = (() => { try { return JSON.stringify(jsonLd); } catch (e) { return ''; } })();

  const telLinks = Array.from(document.querySelectorAll('a[href^="tel:"]')).map((a) => (a.getAttribute('href') || '').replace(/^tel:/i, '').trim());
  const mailtoLinks = Array.from(document.querySelectorAll('a[href^="mailto:"]')).map((a) => (a.getAttribute('href') || '').replace(/^mailto:/i, '').split('?')[0].trim());
  // Phone pattern in visible text (loose: intl or UK-style groups of digits).
  const phoneInText = /(?:\+\d{1,3}[\s.-]?)?(?:\(?0\d{2,4}\)?[\s.-]?)\d{3,4}[\s.-]?\d{3,4}/.test(bodyText);
  const hasPhone = telLinks.length > 0 || /"telephone"/.test(jsonLdText) || phoneInText;
  const hasEmail = mailtoLinks.length > 0 || /\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/i.test(bodyText);
  const hasAddress = !!document.querySelector('address') || /"PostalAddress"|"streetAddress"/.test(jsonLdText) ||
    /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/.test(bodyText); // UK postcode
  const hasCompanyNumber = /\b(company\s*(registration\s*)?(no\.?|number)|companies\s+house|registered\s+in\s+(england|scotland|wales))\b/i.test(bodyText);
  const hasVatNumber = /\bVAT\s*(no\.?|number|reg)/i.test(bodyText);
  const hasTermsLink = lowerLinks.some((s) => /\bterms\b|terms-of|terms_of/.test(s));
  const hasReviewSignal = jsonLdTypes.some((t) => /Review|AggregateRating/i.test(t)) || /"aggregateRating"|"reviewRating"/.test(jsonLdText);
  const SOCIAL_HOSTS = /facebook\.com|instagram\.com|linkedin\.com|x\.com|twitter\.com|youtube\.com|tiktok\.com|pinterest\./i;
  const socialLinks = Array.from(new Set(
    anchors.map((a) => a.getAttribute('href') || '').filter((h) => SOCIAL_HOSTS.test(h))
      .map((h) => { try { return new URL(h, document.baseURI).hostname.replace(/^www\./, ''); } catch (e) { return null; } })
      .filter(Boolean)
  ));
  const hasOpeningHours = /"openingHours|opening\s+hours|business\s+hours/i.test(jsonLdText + ' ' + bodyText.slice(0, 20000));

  // Copyright year: "© 2026", "(c) 2024-2026", "Copyright 2026".
  let copyrightYear = null;
  const tail = bodyText.slice(-3000) + ' ' + bodyText.slice(0, 500);
  const copyMatches = tail.match(/(?:©|\(c\)|copyright)\s*(?:\d{4}\s*[-–]\s*)?(\d{4})/gi);
  if (copyMatches) {
    copyMatches.forEach((m) => {
      const y = parseInt(m.match(/(\d{4})\s*$/)[1], 10);
      if (y >= 1995 && y <= new Date().getFullYear() + 1 && (!copyrightYear || y > copyrightYear)) copyrightYear = y;
    });
  }

  // Latest explicit date on the page: meta published/modified, JSON-LD
  // dates, or <time datetime> values.
  let latestDate = null;
  const dateCandidates = [];
  const pushDate = (v) => { if (v) dateCandidates.push(v); };
  pushDate(metaContent('meta[property="article:published_time"]'));
  pushDate(metaContent('meta[property="article:modified_time"]'));
  pushDate(metaContent('meta[name="date"]'));
  document.querySelectorAll('time[datetime]').forEach((t, i) => { if (i < 50) pushDate(t.getAttribute('datetime')); });
  (jsonLdText.match(/"(?:datePublished|dateModified)"\s*:\s*"([^"]{4,40})"/g) || []).forEach((m) => {
    pushDate(m.replace(/^.*:\s*"/, '').replace(/"$/, ''));
  });
  dateCandidates.forEach((v) => {
    const d = new Date(v);
    if (!isNaN(d) && d.getFullYear() >= 1995 && d.getTime() < Date.now() + 86400000 * 366) {
      if (!latestDate || d > new Date(latestDate)) latestDate = d.toISOString();
    }
  });

  // Business context from structured data: name / type / address / area.
  function findOrgNode(blocks) {
    let found = null;
    const visit = (node) => {
      if (!node || typeof node !== 'object' || found) return;
      const t = node['@type'];
      const types = Array.isArray(t) ? t : t ? [t] : [];
      if (types.some((x) => /Organization|LocalBusiness|Corporation|Store|Service|Restaurant|Hotel|Dentist|Attorney|Physician|Plumber|Electrician|AutoRepair|ProfessionalService/i.test(String(x)))) {
        found = node;
        return;
      }
      if (Array.isArray(node)) node.forEach(visit);
      else Object.keys(node).forEach((k) => { if (typeof node[k] === 'object') visit(node[k]); });
    };
    (blocks || []).forEach(visit);
    return found;
  }
  const orgNode = findOrgNode(jsonLd);
  const addrNode = orgNode && typeof orgNode.address === 'object' ? (Array.isArray(orgNode.address) ? orgNode.address[0] : orgNode.address) : null;
  const businessContext = {
    siteName: (orgNode && orgNode.name) || ogRaw['og:site_name'] || null,
    schemaType: orgNode ? (Array.isArray(orgNode['@type']) ? orgNode['@type'].join(', ') : orgNode['@type']) : null,
    description: (orgNode && typeof orgNode.description === 'string' && orgNode.description.slice(0, 300)) || null,
    locality: addrNode ? [addrNode.addressLocality, addrNode.addressRegion, addrNode.addressCountry].filter((v) => typeof v === 'string').join(', ') || null : null,
    telephone: (orgNode && typeof orgNode.telephone === 'string' && orgNode.telephone) || telLinks[0] || null,
    sameAsCount: orgNode && orgNode.sameAs ? (Array.isArray(orgNode.sameAs) ? orgNode.sameAs.length : 1) : 0,
  };

  const trustSignals = {
    hasPhone, hasEmail, hasAddress, hasCompanyNumber, hasVatNumber,
    hasTermsLink, hasReviewSignal, hasOpeningHours,
    socialProfiles: socialLinks,
  };
  const freshness = { copyrightYear, latestDate, dateCandidateCount: dateCandidates.length };

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
    headings: { list: headingList, counts: headingCounts, h1: h1Texts, duplicateCount: duplicateHeadingCount },
    images,
    links: {
      internalList, externalList,
      internal: internalList.length, external: externalList.length,
      nofollow: nofollowCount, total: anchors.length, missingAnchorText,
    },
    content: {
      wordCount, paragraphCount, sentenceCount, avgSentenceLength, readTimeMin, readability, topKeywords,
      emptyBoldCount, duplicateParagraphCount,
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
    mobile: {
      tapTargets: { checked: tapTargetsChecked, small: smallTapTargets },
      fontSizes: { checked: fontSizeSamplesChecked, small: smallFontCount },
    },
    aiSeo: { hasFaqSchema, hasArticleSchema, semanticLandmarks, hasStructuredData: jsonLd.length > 0, hasMetaDescription: !!descText, hasClearH1: h1Texts.length === 1 },
    eeat: { hasAuthorByline, hasPublishDate, hasAboutLink, hasContactLink, hasPrivacyLink, hasOrgOrPersonSchema, aboutMatch, contactMatch, privacyMatch },
    trustSignals,
    freshness,
    businessContext,
    hygiene,
    analyzedAt: new Date().toISOString(),
  };
}
