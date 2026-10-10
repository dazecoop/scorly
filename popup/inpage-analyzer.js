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

  // ---------- AI-written copy signals ----------
  // Surface tells of unedited LLM prose, taken from Wikipedia's "Signs of AI
  // writing" catalogue (WikiProject AI Cleanup) — the same list the
  // humanizer guidance is built on. Every signal here is a literal
  // string/pattern count over the page's own visible text: nothing is sent
  // anywhere and no model is involved. Scoring (scoring.js) deliberately
  // requires a CLUSTER of independent families before it penalises anything,
  // because that source is explicit that single tells — one em dash, curly
  // quotes, a lone "however" — mean nothing on their own.
  const aiCopy = (() => {
    // Prose only: headings, paragraphs, list items and quotes. Nav labels,
    // button text and table cells are UI chrome and would skew the rates.
    const proseBlocks = textBlocks.filter((b) => /^(p|li|blockquote|h[1-6]|dd)$/.test(b.tag));
    const prose = proseBlocks.map((b) => b.text).join('\n');
    const proseWords = prose ? prose.split(/\s+/).filter(Boolean).length : 0;
    // Per 1,000 words, so a long page is not penalised for simply being long.
    const per1k = (n) => (proseWords ? Math.round((n / proseWords) * 10000) / 10 : 0);
    const countMatches = (re) => { const m = prose.match(re); return m ? m.length : 0; };
    // Collects which terms from a list actually hit, so the UI can show the
    // evidence rather than an unexplained number.
    const hitTerms = (terms) => {
      const hits = [];
      let total = 0;
      terms.forEach((t) => {
        // A term containing ".{" is already a deliberate pattern (a formula
        // with a variable middle, e.g. "from X to Y, we") — leave it raw.
        const body = /\.\{/.test(t) ? t : t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp('\\b' + body.replace(/ /g, '\\s+') + '\\b', 'gi');
        const n = countMatches(re);
        if (n) { total += n; hits.push({ term: t, count: n }); }
      });
      hits.sort((a, b) => b.count - a.count);
      return { total, hits: hits.slice(0, 12) };
    };
    // Like countMatches, but keeps a few de-duplicated examples so the UI can
    // show the actual sentences rather than an unexplained tally — these
    // patterns are judgement calls and the reader has to be able to check them.
    const sampleMatches = (re, max) => {
      const m = prose.match(re) || [];
      const samples = [];
      m.forEach((raw) => {
        const clean = raw.replace(/\s+/g, ' ').trim().slice(0, 100);
        if (!samples.some((x) => x.toLowerCase() === clean.toLowerCase())) samples.push(clean);
      });
      return { total: m.length, samples: samples.slice(0, max || 6) };
    };

    // §14 — em/en dashes used as punctuation (not numeric ranges, not hyphens).
    const dashMatches = prose.match(/[^\d\s]\s*[—–]\s*[^\d\s]|\s--\s/g) || [];
    // §19 — curly quotes. On their own these mean nothing (every CMS curls
    // quotes automatically); they only count inside a cluster.
    const curlyQuotes = countMatches(/[\u201c\u201d\u2018\u2019]/g);

    // §7 — the words measurably over-represented in post-2023 text.
    const vocab = hitTerms([
      'delve', 'delves', 'delving', 'tapestry', 'testament', 'underscore', 'underscores', 'underscoring',
      'pivotal', 'intricate', 'intricacies', 'showcase', 'showcases', 'showcasing', 'vibrant',
      'foster', 'fosters', 'fostering', 'garner', 'garnered', 'interplay', 'realm', 'myriad', 'plethora',
      'meticulous', 'meticulously', 'holistic', 'paradigm', 'synergy', 'seamless', 'seamlessly',
      'leverage', 'leveraging', 'elevate', 'elevating', 'unlock', 'unlocking', 'harness', 'harnessing',
      'embark', 'bustling', 'nestled', 'robust', 'crucial', 'cutting-edge', 'ever-evolving',
      'game-changer', 'unparalleled', 'transformative', 'multifaceted', 'nuanced', 'profound',
      'navigate', 'navigating', 'resonate', 'resonates', 'curated', 'bespoke', 'invaluable',
    ]);

    // §§1,4,6,12,27,28,32 — the multi-word formulas. A phrase hit is much
    // stronger evidence than a single word, so these are weighted higher.
    const phrases = hitTerms([
      'stands as a testament', 'serves as a testament', 'is a testament to',
      'plays a crucial role', 'plays a vital role', 'plays a pivotal role', 'plays a key role',
      'in today\u2019s fast-paced', 'in today\'s fast-paced', 'in today\u2019s digital', 'in today\'s digital',
      'in the ever-evolving', 'ever-evolving landscape', 'the digital landscape', 'evolving landscape',
      'when it comes to', 'it is important to note', 'it\u2019s important to note', 'it\'s important to note',
      'it is worth noting', 'needless to say', 'rest assured', 'look no further',
      'let\u2019s dive in', 'let\'s dive in', 'let us dive', 'let\u2019s explore', 'let\'s explore',
      'let\u2019s break', 'let\'s break', 'here\u2019s what you need to know', 'here\'s what you need to know',
      'without further ado', 'in conclusion', 'in summary', 'to sum up',
      'navigating the complexities', 'unlock the potential', 'unlock the power', 'unleash the power',
      'take your .{0,20} to the next level', 'at its core', 'the real question is',
      'the world of', 'a wide range of', 'a myriad of', 'a plethora of',
      'whether you\u2019re a', 'whether you\'re a',
      'in the realm of', 'the key to', 'is key to', 'commitment to excellence',
      'we understand that', 'designed to meet your', 'tailored to your',
      'look no further than', 'the heart of', 'deeply rooted', 'indelible mark',
      'marking a pivotal', 'setting the stage for', 'reflects a broader', 'reflecting a broader',
      'faces several challenges', 'despite these challenges', 'the future looks bright',
      'exciting times', 'step in the right direction', 'memories to last a lifetime',
    ]);

    // §§20,21 — chatbot correspondence and knowledge-cutoff text pasted
    // straight into the page. Unlike everything else here these are close to
    // conclusive on their own: no human writes them into their own copy.
    const artifacts = hitTerms([
      'as an ai language model', 'as an ai model', 'i\u2019m sorry, but i cannot', 'i\'m sorry, but i cannot',
      'i cannot browse the internet', 'i do not have access to real-time',
      'i hope this helps', 'let me know if you', 'would you like me to', 'want me to',
      'should i continue', 'certainly! here', 'of course! here', 'here\u2019s a draft', 'here\'s a draft',
      'up to my last training', 'as of my last update', 'as of my knowledge cutoff',
      'my training data', 'while specific details are limited', 'while specific details about',
      'based on available information', 'is not publicly available', 'maintains a low profile',
      'certainly! below', 'sure! here\u2019s', 'sure! here\'s', 'feel free to ask',
      'insert .{0,20} here', 'your company name', 'lorem ipsum',
    ]);

    // §9 — negative parallelism ("it's not just X, it's Y").
    const negParallel = countMatches(/\b(?:it(?:\u2019|')?s|that(?:\u2019|')?s|this is)\s+not\s+(?:just|merely|only)\b/gi) +
      countMatches(/\bnot\s+only\b[^.!?]{0,80}\bbut\s+(?:also\b)?/gi) +
      countMatches(/\b(?:is|are)\s+more\s+than\s+just\b/gi);

    // §8 — copula avoidance: elaborate verbs standing in for "is"/"are".
    const copula = hitTerms(['serves as', 'serves as a', 'stands as', 'boasts a', 'boasts an', 'boasts over', 'represents a shift', 'marks a shift']);

    // §3 — participle tails: a comma followed by an "-ing" analysis verb,
    // the formula LLMs use to bolt fake depth onto the end of a sentence.
    const participleTails = countMatches(/,\s+(?:highlighting|underscoring|emphasizing|emphasising|ensuring|reflecting|symbolizing|symbolising|contributing to|cultivating|fostering|encompassing|showcasing|demonstrating|solidifying|cementing|paving the way)\b/gi);

    // §5 — vague attribution with no named source.
    const weasel = hitTerms(['industry reports', 'observers have', 'experts argue', 'experts believe', 'experts say', 'studies suggest', 'research shows that', 'some critics argue', 'it is believed that', 'many believe']);

    // §16 — inline-header vertical lists: "**Label:** sentence" as markup.
    let inlineHeaderItems = 0;
    document.querySelectorAll('li, p').forEach((node) => {
      const first = node.firstElementChild;
      if (!first || !/^(strong|b)$/i.test(first.tagName)) return;
      const label = textOf(first);
      if (!label || label.length > 40) return;
      const rest = textOf(node).slice(label.length).trim();
      if (/^[:\u2013\u2014-]/.test(rest) && rest.length > 20) inlineHeaderItems++;
    });

    // §18 — emoji decorating headings, and §17 — Title Case headings.
    const EMOJI_RE = /[\u2600-\u27bf]|[\u{1f300}-\u{1faff}]|[\u{1f000}-\u{1f2ff}]/u;
    let emojiHeadings = 0, titleCaseHeadings = 0, headingsChecked = 0;
    headingList.forEach((h) => {
      const t = h.text || '';
      if (!t) return;
      if (EMOJI_RE.test(t)) emojiHeadings++;
      const words = t.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w));
      if (words.length >= 4) {
        headingsChecked++;
        const minor = /^(a|an|the|and|or|but|for|nor|of|to|in|on|at|by|with|from|as|is|vs)$/i;
        const capped = words.filter((w, i) => i === 0 || minor.test(w) || /^[A-Z]/.test(w)).length;
        if (capped === words.length && words.filter((w) => /^[A-Z]/.test(w)).length >= words.length - 1) titleCaseHeadings++;
      }
    });

    // §31 / "Signs of human writing" — LLM prose holds an even, mid-length
    // cadence; real writing alternates short and long. Measured as the
    // coefficient of variation of sentence length (low = suspiciously even).
    let sentenceCv = null;
    const proseSentences = prose.split(/[.!?]+(?:\s|$)/).map((s) => s.trim().split(/\s+/).filter(Boolean).length).filter((n) => n > 2);
    if (proseSentences.length >= 12) {
      const mean = proseSentences.reduce((a, b) => a + b, 0) / proseSentences.length;
      const variance = proseSentences.reduce((a, b) => a + (b - mean) * (b - mean), 0) / proseSentences.length;
      sentenceCv = mean > 0 ? Math.round((Math.sqrt(variance) / mean) * 100) / 100 : null;
    }

    // §10 — the rule of three. Counts both the Oxford-comma form ("X, Y, and
    // Z") and the British form without it ("Straight edges, smooth ceilings
    // and neat skylight reveals"), which is the shape that actually dominates
    // UK marketing copy and would be missed by an Oxford-comma-only pattern.
    // The auxiliary-verb exclusions are what stop a parenthetical aside from
    // reading as a list: "houses in south Bristol, mostly BS3 and BS4, and
    // have done since 1998" is one clause with an aside, not a triad.
    const AUX = '(?!(?:have|has|had|is|are|was|were|do|does|did|will|would|can|could|should|then|so|but|which|who)\\b)';
    const ITEM = AUX + "[A-Za-z][\\w'-]*(?:\\s+[\\w'-]+){0,3}";
    const triadRes = sampleMatches(new RegExp('\\b' + ITEM + ',\\s+' + ITEM + ',?\\s+and\\s+' + ITEM + '\\b', 'g'));
    const triads = triadRes.total;
    // The same formula applied to verbs — "We plaster, skim and finish…" —
    // which reads as a separate tic because the subject is reused and only
    // the verb list changes. Counted separately so a page full of them is not
    // double-penalised by the generic triad pattern above.
    const verbTriadRes = sampleMatches(/\b(?:We|They|It|You|Our\s+\w+|The\s+\w+)\s+[a-z]+(?:s|ed|ing)?(?:\s+[\w'-]+){0,3},\s+[a-z]+(?:s|ed|ing)?(?:\s+[\w'-]+){0,3},?\s+and\s+[a-z]+(?:s|ed|ing)?\b/g, 4);

    // §12 — false ranges: "from X to Y" where X and Y are not two points on
    // any real scale ("from a small patch to a whole room"). Numeric, date
    // and price ranges are genuine and excluded. One of these is ordinary
    // English; several on one page is one of the most reliable tells there is,
    // so the examples are kept for the reader to judge.
    // The capital-letter exclusions on the endpoints matter: "from London to
    // Brighton" and "from June to August" are real ranges between real
    // points, and flagging them would bury the signal in false positives.
    // "from" is matched in both cases explicitly rather than with the /i
    // flag, which would also fold [A-Z] in the exclusions and reject
    // everything.
    const falseRangeRes = sampleMatches(/\b[Ff]rom\s+(?![\d£$€A-Z])[a-z][\w'-]*(?:\s+[\w'-]+){0,4}\s+(?:all\s+the\s+way\s+)?to\s+(?![\d£$€A-Z])[a-z][\w'-]*(?:\s+[\w'-]+){0,4}\b/g);

    return {
      proseWords,
      emDashes: dashMatches.length,
      emDashPer1k: per1k(dashMatches.length),
      curlyQuotes,
      vocabCount: vocab.total,
      vocabPer1k: per1k(vocab.total),
      vocabHits: vocab.hits,
      phraseCount: phrases.total,
      phraseHits: phrases.hits,
      artifactCount: artifacts.total,
      artifactHits: artifacts.hits,
      negParallel,
      copulaCount: copula.total,
      copulaHits: copula.hits,
      participleTails,
      weaselCount: weasel.total,
      weaselHits: weasel.hits,
      inlineHeaderItems,
      emojiHeadings,
      titleCaseHeadings,
      headingsChecked,
      sentenceCv,
      triads,
      triadsPer1k: per1k(triads),
      triadSamples: triadRes.samples,
      verbTriads: verbTriadRes.total,
      verbTriadSamples: verbTriadRes.samples,
      falseRanges: falseRangeRes.total,
      falseRangeSamples: falseRangeRes.samples,
    };
  })();

  // ---------- "Vibe coded" signals ----------
  // Fingerprints of a page generated by an AI app-builder (Lovable, v0,
  // Bolt, Replit, GPT Engineer…) together with the traits that actually cost
  // such a page visibility: a client-rendered shell with no crawlable text,
  // placeholder metadata, generated-boilerplate copy and no semantic markup.
  // Scoring keeps those two things apart on purpose — a builder badge is not
  // itself an SEO fault, so only the consequences carry a penalty.
  const vibeCode = (() => {
    const html = document.documentElement.outerHTML;
    const htmlHead = html.slice(0, 400000);
    const scriptSrcs = Array.from(document.scripts).map((s) => s.src || '').filter(Boolean);
    const allUrls = scriptSrcs.concat(resourceUrls);
    const generator = metaContent('meta[name="generator" i]') || '';

    // --- Builder fingerprints (which tool, and what gave it away) ---
    const builders = [];
    const flag = (name, evidence) => {
      if (!builders.some((b) => b.name === name)) builders.push({ name, evidence });
    };
    const inUrls = (re) => allUrls.some((u) => re.test(u));
    if (/lovable/i.test(generator) || inUrls(/lovable\.(dev|app)|gptengineer\.js|cdn\.gpteng\.co/i) ||
        document.querySelector('[class*="lovable" i], [id*="lovable" i], a[href*="lovable.dev"]')) {
      flag('Lovable / GPT Engineer', 'gptengineer script, lovable.dev asset or badge link');
    }
    if (/\bv0\b|vercel v0/i.test(generator) || document.querySelector('[data-v0-t], [data-v0]') || inUrls(/v0\.dev|v0\.app/i)) {
      flag('Vercel v0', 'data-v0 attribute, v0.dev asset or generator tag');
    }
    if (/bolt\.new|stackblitz/i.test(generator) || inUrls(/bolt\.new|stackblitz\.io/i) || document.querySelector('a[href*="bolt.new"]')) {
      flag('Bolt.new / StackBlitz', 'bolt.new asset, badge link or generator tag');
    }
    if (/replit/i.test(generator) || inUrls(/replit\.(com|dev|app)|repl\.co/i) || /\.repl\.co$|\.replit\.(dev|app)$/i.test(location.hostname)) {
      flag('Replit', 'replit host or asset');
    }
    if (/\b(base44|famous\.ai|tempo\.new|softr|a0\.dev|rork|create\.xyz|bubble)\b/i.test(generator) || inUrls(/base44|famous\.ai|tempo\.new|a0\.dev|create\.xyz/i)) {
      flag('AI app builder', 'generator tag or asset from a known AI builder');
    }
    if (/claude|chatgpt|gpt-4|copilot|cursor|windsurf/i.test(generator)) {
      flag('AI coding assistant', 'generator meta tag names an LLM: "' + generator.slice(0, 60) + '"');
    }

    // --- Source-location attributes left in the served markup ---
    // AI builders and dev inspectors tag every element with the file and line
    // it came from, so the editor can map a click in the preview back to the
    // source. None of it is meant to ship. It is the single most reliable
    // fingerprint available: no hand-written page has it, and each tagger's
    // attribute names identify the tool outright.
    const SOURCE_ATTRS = [
      ['data-lov-id', 'Lovable'], ['data-lov-name', 'Lovable'],
      ['data-component-path', 'Lovable'], ['data-component-name', 'Lovable'],
      ['data-component-file', 'Lovable'], ['data-component-line', 'Lovable'],
      ['data-tsd-source', 'TanStack Start (dev)'],
      ['data-inspector-line', 'react-dev-inspector'], ['data-inspector-relative-path', 'react-dev-inspector'],
      ['data-v0-t', 'Vercel v0'],
      ['data-sentry-component', 'Sentry'], ['data-sentry-source-file', 'Sentry'],
      ['data-locatorjs-id', 'LocatorJS'], ['data-dyn-source', 'AI builder'],
    ];
    const sourceAttrs = (() => {
      let total = 0;
      const tools = [];
      SOURCE_ATTRS.forEach(([attr, tool]) => {
        const n = document.querySelectorAll('[' + attr + ']').length;
        if (!n) return;
        total += n;
        if (!tools.includes(tool)) tools.push(tool);
      });
      return { total, tools };
    })();

    // --- Served by a dev server rather than a production build ---
    // Unbundled /src/ asset paths, Vite's client and filesystem routes. A
    // real build emits hashed, minified files from /assets/ or /_next/. This
    // is expected on localhost and only a fault once it is public.
    const devServer = (() => {
      const refs = Array.from(document.querySelectorAll('[src], [href]'))
        .map((n) => n.getAttribute('src') || n.getAttribute('href') || '');
      const unbundled = refs.filter((u) => /^(?:\/|\.\/)?src\//.test(u) || /\/src\/(?:assets|styles|components|routes)\//.test(u)).length;
      return {
        unbundled,
        viteClient: /\/@vite\/client|\/@react-refresh/.test(html),
        fsPaths: (html.match(/\/@fs\/|\/@id\//g) || []).length,
        devStyles: /-dev-styles|data-tanstack-router-dev|\/@tanstack-start\//.test(html),
      };
    })();

    // --- Stack / UI-kit markers (the default vibe-code toolchain) ---
    const radixEls = document.querySelectorAll('[data-radix-collection-item], [data-radix-scroll-area-viewport], [data-radix-popper-content-wrapper], [data-state][data-orientation], [data-slot]').length;
    const lucideIcons = document.querySelectorAll('svg.lucide, svg[class*="lucide-"]').length;
    let shadcnVars = false;
    try {
      const rootStyle = getComputedStyle(document.documentElement);
      shadcnVars = !!(rootStyle.getPropertyValue('--radius').trim() &&
        (rootStyle.getPropertyValue('--primary').trim() || rootStyle.getPropertyValue('--muted-foreground').trim()));
    } catch (e) { /* ignore */ }
    const isNext = !!document.getElementById('__next') || /\/_next\/static\//.test(html);
    const isViteSpa = !!document.querySelector('script[type="module"][src*="/assets/index-"], script[type="module"][src^="/src/main"]');
    const framework = isNext ? 'Next.js' : isViteSpa ? 'Vite SPA' : /__nuxt/i.test(html) ? 'Nuxt' : /astro-island|astro-/i.test(html) ? 'Astro' : null;

    // --- Tailwind "utility soup": how many classes per element ---
    let classedEls = 0, classTotal = 0, heavyClassEls = 0, arbitraryValues = 0;
    document.querySelectorAll('div, section, span, a, button, p, h1, h2, h3, li').forEach((node) => {
      const cls = (node.getAttribute('class') || '').trim();
      if (!cls) return;
      const n = cls.split(/\s+/).length;
      classedEls++;
      classTotal += n;
      if (n >= 10) heavyClassEls++;
      if (/\[[^\]]+\]/.test(cls)) arbitraryValues++;
    });
    const avgClassesPerEl = classedEls ? Math.round((classTotal / classedEls) * 10) / 10 : 0;
    const heavyClassPct = classedEls ? Math.round((heavyClassEls / classedEls) * 100) : 0;
    const tailwindCdn = /cdn\.tailwindcss\.com/.test(html);

    // Density alone misses a Tailwind build with a custom theme, where class
    // names stay short ("bg-brand-ink text-brand-paper"). These two patterns
    // identify Tailwind by its vocabulary instead: its distinctive utility
    // names, and its variant prefixes, which no other CSS convention uses.
    const allClasses = Array.from(document.querySelectorAll('[class]'))
      .map((n) => (typeof n.className === 'string' ? n.className : '')).join(' ');
    const TW_UTILITIES = /\b(?:flex|grid|hidden|block|inline-flex|items-(?:center|start|end)|justify-(?:center|between|around|end)|gap-\d|space-[xy]-\d|[pm][txblrye]?-\d{1,2}|min-[wh]-|max-[wh]-|text-(?:xs|sm|base|lg|xl|\dxl)|font-(?:thin|light|normal|medium|semibold|bold|extrabold)|rounded(?:-(?:sm|md|lg|xl|full))?|shadow(?:-(?:sm|md|lg|xl))?|border-[trbl]?\d?|opacity-\d|z-\d|sr-only|truncate|uppercase|tracking-(?:tight|wide|wider)|leading-(?:none|tight|snug|relaxed)|transition(?:-[a-z]+)?|overflow-(?:hidden|auto|scroll))\b/g;
    const tailwindUtilityHits = (allClasses.match(TW_UTILITIES) || []).length;
    const tailwindPrefixed = (allClasses.match(/\b(?:sm|md|lg|xl|2xl|hover|focus|focus-visible|active|disabled|group-hover|dark|first|last|odd|even):[a-z[-]/g) || []).length;

    // --- Signals that survive a production build ---
    // Everything above (source attributes, /src/ paths, Vite's client) is
    // stripped by a real build, so on a deployed site none of it fires. What
    // is left is the stack itself: an icon library, utility CSS and a
    // hydrating JS framework. That trio is the default output of every
    // current AI builder, which is weak evidence individually and worth
    // something together.
    const iconLibrary = (() => {
      const sets = [
        ['Lucide', 'svg.lucide, svg[class*="lucide-"]'],
        ['Heroicons', 'svg[class*="heroicon"]'],
        ['Feather', 'svg.feather, svg[class*="feather-"]'],
        ['Phosphor', 'svg[class*="ph-"]'],
        ['Tabler', 'svg[class*="tabler-icon"]'],
      ];
      for (let i = 0; i < sets.length; i++) {
        const n = document.querySelectorAll(sets[i][1]).length;
        if (n) return { name: sets[i][0], count: n };
      }
      return null;
    })();

    // React's SSR output marks text boundaries with empty comments and
    // Suspense boundaries with <!--$-->; these identify a hydrating React
    // render even after minification.
    const reactSsr = (html.match(/<!-- -->|<!--\$-->|<!--\/\$-->/g) || []).length;
    // A production bundle: content-hashed files under /assets/ or /_next/.
    const hashedBundle = /\/(?:assets|_next\/static)\/[^"']*[-.][a-z0-9]{8,}\.(?:js|css)/i.test(html);

    // A recognised CMS or site-builder explains the stack without any AI
    // involvement, so finding one argues against the whole hypothesis.
    const cmsFingerprint = (() => {
      const tests = [
        [/wp-content|wp-includes|wp-json/i, 'WordPress'],
        [/webflow/i, 'Webflow'],
        [/squarespace|static1\.squarespace/i, 'Squarespace'],
        [/wix\.com|wixstatic/i, 'Wix'],
        [/cdn\.shopify|shopify\.com/i, 'Shopify'],
        [/drupal/i, 'Drupal'],
        [/joomla/i, 'Joomla'],
        [/hubspot|hs-scripts/i, 'HubSpot'],
        [/ghost(?:-sdk|\.io)/i, 'Ghost'],
      ];
      for (let i = 0; i < tests.length; i++) if (tests[i][0].test(html)) return tests[i][1];
      return null;
    })();

    // --- Generated-template design clichés ---
    const countClass = (frag) => document.querySelectorAll('[class*="' + frag + '"]').length;
    const backdropBlur = countClass('backdrop-blur');
    const gradients = countClass('bg-gradient-to') + countClass('bg-linear-to');
    const gradientText = countClass('bg-clip-text');
    const designCliches = { backdropBlur, gradients, gradientText };

    // --- AI-written HTML comments: Title Case section labels ---
    // "<!-- Hero Section -->", "<!-- Features Grid -->" — the way a model
    // labels the blocks it just emitted. Also catches leftover JSX comments.
    const commentMatches = htmlHead.match(/<!--[\s\S]{0,120}?-->/g) || [];
    let labelComments = 0;
    commentMatches.forEach((c) => {
      const body = c.replace(/^<!--|-->$/g, '').trim();
      if (!body || body.length > 60) return;
      if (/^(\/?[a-z-]+|\[if|\/\*)/.test(body)) return; // closing-tag notes, IE conditionals
      if (/^[A-Z][A-Za-z0-9]*(?:\s+[A-Za-z0-9/&]+){0,5}$/.test(body) &&
          /\b(section|hero|header|footer|nav|navigation|cta|features?|testimonials?|pricing|faq|about|contact|grid|card|banner|sidebar)\b/i.test(body)) {
        labelComments++;
      }
    });
    const jsxComments = (htmlHead.match(/\{\/\*/g) || []).length;

    // --- Placeholder / default metadata that nobody renamed ---
    const DEFAULT_TITLES = /^(vite(\s*\+\s*(react|vue|ts|svelte))*( app)?|react app|create next app|next\.js|my app|my website|untitled|document|index|home|app|website|landing page|new project|v0 app|lovable|lovable generated project|generated by .+)$/i;
    const placeholderTitle = DEFAULT_TITLES.test(titleText.trim()) ? titleText.trim() : null;
    const defaultFavicon = !!(favicon && /\/(vite|react|next|favicon-default|logo192|placeholder)\.(svg|ico|png)$/i.test(favicon));
    const genericDescription = !!(descText && /^(generated (by|with)|created (by|with)|a (modern|simple|beautiful) .{0,40}(app|website|landing page)|lovable generated project|web site created using)/i.test(descText.trim()));

    // --- Generated marketing copy and stock placeholders ---
    const prose = textBlocks.map((b) => b.text).join('\n');
    const GENERIC_COPY = [
      /\btransform(?:ing)? your\b/i, /\brevolutioni[sz](?:e|ing)\b/i, /\bsupercharge\b/i,
      /\bthe future of\b/i, /\ball-in-one\b/i, /\bpowered by ai\b/i, /\bnext-generation\b/i,
      /\beffortlessly\b/i, /\b10x\b/i, /\bbuilt for (?:modern|teams|the future)\b/i,
      /\bone platform\b/i, /\beverything you need\b/i, /\bjoin thousands of\b/i,
      /\btrusted by (?:thousands|millions|\d[\d,+]*)\b/i, /\bno credit card required\b/i,
      /\bget started (?:in (?:seconds|minutes)|for free|today)\b/i, /\bloved by\b/i,
      /\bship faster\b/i, /\bbeautifully (?:designed|crafted)\b/i, /\bseamless experience\b/i,
    ];
    const genericCopyHits = [];
    GENERIC_COPY.forEach((re) => { const m = prose.match(re); if (m) genericCopyHits.push(m[0]); });
    const lorem = /\blorem ipsum\b|\bdolor sit amet\b/i.test(prose);
    const placeholderCopy = /\b(your (?:company|brand|business|product|logo|name here)|company name|insert .{0,20} here|coming soon|placeholder text|example\.com|john doe|jane doe|feature (?:one|two|three)|card (?:title|description))\b/i.test(prose);
    const genericCtas = (() => {
      const labels = Array.from(document.querySelectorAll('a, button')).map((n) => textOf(n).toLowerCase());
      const GENERIC = ['get started', 'learn more', 'try it free', 'start free trial', 'book a demo', 'sign up free', 'see how it works', 'explore now'];
      return labels.filter((l) => GENERIC.includes(l)).length;
    })();
    const stockImages = (() => {
      const hosts = [/images\.unsplash\.com/i, /pexels\.com/i, /placehold(?:er)?\.co/i, /picsum\.photos/i, /via\.placeholder\.com/i, /dicebear\.com/i, /loremflickr/i, /dummyimage/i];
      return (images.list || []).filter((im) => im.src && hosts.some((h) => h.test(im.src))).length;
    })();

    return {
      generator: generator || null,
      builders,
      framework,
      clientRendered: !!(isViteSpa || (!isNext && framework === null && document.querySelector('#root, #app') && domSize < 2000 && scriptSrcs.length > 0 && paragraphCount <= 2)),
      ui: { radixEls, lucideIcons, shadcnVars, tailwindCdn },
      tailwind: { classedEls, avgClassesPerEl, heavyClassEls, heavyClassPct, arbitraryValues, utilityHits: tailwindUtilityHits, prefixed: tailwindPrefixed },
      sourceAttrs,
      devServer,
      iconLibrary,
      reactSsr,
      hashedBundle,
      cmsFingerprint,
      designCliches,
      labelComments,
      jsxComments,
      placeholderTitle,
      defaultFavicon,
      genericDescription,
      genericCopyHits: genericCopyHits.slice(0, 10),
      lorem,
      placeholderCopy,
      genericCtas,
      stockImages,
      semanticLandmarks,
      headingLevels: headingCounts,
    };
  })();

  const hostname = location.hostname;
  const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' ||
    hostname.endsWith('.local') || /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname);

  let htmlSize = 0;
  try { htmlSize = new Blob([document.documentElement.outerHTML]).size; } catch (e) { htmlSize = document.documentElement.outerHTML.length; }
  // Visible-text bytes, measured the same way as htmlSize so the two divide
  // cleanly into a text-to-code ratio.
  let textSize = 0;
  try { textSize = new Blob([bodyText]).size; } catch (e) { textSize = bodyText.length; }

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
    textSize,
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
    aiCopy,
    vibeCode,
    analyzedAt: new Date().toISOString(),
  };
}
