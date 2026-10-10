<img alt="social-preview" src="store-assets/social-preview.png" />

![Platform](https://img.shields.io/badge/platform-Chrome%20%7C%20Firefox%20%7C%20Edge-0A0A0C)
![Manifest](https://img.shields.io/badge/manifest-v3-10b981)
![Licence](https://img.shields.io/badge/licence-MIT-2F7DD1)

A free, open source browser extension that scores any page's on-page SEO in
depth, shows how it will look when shared on social platforms, and diffs the
version you're building against the one that's already live.

Click the icon and Scorly reads the page you're already on — no URL to paste,
no account, no subscription. Nothing leaves your browser except the requests
the page itself would normally make (robots.txt, sitemap.xml, favicon), and
nothing is sent to a remote server.

It works on `localhost` and private-network URLs too, where most SEO tools
simply refuse to run.

### Compare localhost against live

Press **Compare** and Scorly opens a full-tab diff of two pages — your local
build on one side, production on the other.

Not just the scores: the exact wording. Title, meta description, every `og:`
and `twitter:` tag, the heading outline, and every paragraph, list item,
button and label on the page, diffed word by word, so a one-word edit to a
155-character description reads as a one-word edit instead of "these differ".
Links and image alt text are matched by path, so the same link on localhost
and live is never reported as a change.

Scores, checks and findings are diffed too, including an **AI Copy & Vibe
Code** section — so you can see a rewrite move the copy score, or catch a
deploy that shipped a dev build.

Fill either side from a snapshot you saved earlier or let Scorly load a URL
in a background tab. Filter to just the differences, then export the whole
comparison as PDF, CSV, JSON or Markdown — for a pull request, a client
email, or a spreadsheet.

Snapshots live in local extension storage, are capped at 8, and can be
deleted at any time. Nothing is uploaded, and nothing is stored unless you
press Save.

---

## What it does

**Scores the whole page, not just the title tag.** One overall score (0–100)
broken into 9 categories — Technical, Content, Perf, Schema, Security,
Mobile, Accessibility, AI Visibility, E-E-A-T — each with its own bar, so you can see
exactly which part of the page is dragging the score down.

**Explains every check.** 15 tabs of detail: Overview with a SERP preview,
AI Insights, Meta, Content (readability and grade level, word/sentence stats, top keywords and phrases),
H Tags, Links, Internal/External link lists, Images (alt-text audit), Schema
(JSON-LD viewer), Tech, Perf (TTFB, requests, transfer size), Security,
Access (colour contrast, form labels, button names, skip link, landmarks), and
Open Graph Preview. Every check is tagged pass / warn / fail with a severity,
and rolled up into the Issues / Warnings / Passed counts on the Overview tab.

**Tells you how visible the page is to AI answer engines.** The AI Insights
tab breaks the AI Visibility score into the six things it is made of —
crawler access, machine readability, trust signals, freshness, human-written
copy and build quality — as one bar each. Click a bar to jump to the section
that explains it. Every bar shows the same number as the section it opens,
and all six read the same way round: higher is better.

**Flags copy that reads as unedited AI output.** Fifteen families of surface
tell, taken from Wikipedia's [Signs of AI
writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing):
em-dash density, curly quotes, over-represented AI vocabulary, stock phrase
formulas ("stands as a testament", "in today's fast-paced"), false ranges
("from X to Y"), rule-of-three cadence, negative parallelism, participle
tails, copula avoidance, vague attribution, inline-header lists, emoji
headings, Title Case headings, uniform sentence rhythm, and chatbot text left
in the page. Each one names the passages it matched, so you can read the
evidence rather than trust a number.

That source is explicit that isolated tells prove nothing — one em dash is
ordinary writing — so a page tripping fewer than three independent families
is held below the "some patterns" band no matter how hard it trips them.

**Spots a vibe-coded build, and separates it from what that costs.** Two
different questions, answered separately. The *verdict* identifies the
toolchain: builder fingerprints (Lovable, v0, Bolt, Replit), source-location
attributes left in the markup, dev-server artifacts, the shadcn/Radix/Lucide
kit, Tailwind by its own vocabulary, and the icon-library + utility-CSS +
hydrating-React stack that every AI builder emits. A recognised CMS cancels
it. The *score* is only about faults that actually cost visibility — chief
among them a client-rendered shell, found by comparing the HTML as served
against the DOM after JavaScript runs, which is the only way to see what a
non-executing crawler gets.

A generated site that server-renders and has real copy therefore scores
100/100 here and is still named as generated. The toolchain is not the fault.

**Shows you the share card before you post it.** The Open Graph tab renders
the page exactly as it would appear when shared on Facebook, X, LinkedIn,
WhatsApp, or Discord/Slack. No Open Graph tags? It builds a best-effort
fallback from the `<title>`, meta description, and favicon, and flags it
clearly as a fallback rather than pretending it's real.

**Measures real performance, not a synthetic lab score.** TTFB, request
count, and transferred size come straight from the browser's own
Navigation/Resource Timing entries for the page as it actually loaded — no
extra page load is triggered to measure it.

**Works where other SEO tools give up.** `localhost` and private-network
URLs are detected and shown with a badge; HTTPS checks are skipped there
instead of penalizing a page that was never meant to have a certificate yet.

**Diffs two versions of a page.** See
[Compare localhost against live](#compare-localhost-against-live) above —
side-by-side scores, every check whose verdict changed, and word-level diffs
of all the page's text and tags.

**Exports what it finds.** PDF, CSV, JSON or Markdown, from the popup's
footer bar or the compare view's Export menu — all generated locally, PDF via
a bundled copy of jsPDF, no network call involved.

**Costs nothing to run.** No account, no API key, no rate limit, no
subscription. Light/dark theme follows your OS by default, with a manual
toggle.

> **About "AI Visibility" and "E-E-A-T"** — these two categories are
> heuristic signals (structured data, semantic HTML landmarks, author byline,
> publish date, about/contact/privacy links, and the like), not an official
> metric from any search engine or AI provider. Treat them as directional
> indicators, not ground truth.
>
> **About the AI-copy and vibe-code detectors** — these count surface
> patterns and name the evidence. They cannot prove how a page was made, and
> nothing here should be read as proof. Both are deliberately bounded: at
> most 12 and 10 of the 100 AI Visibility points, 20 combined, so neither can
> sink a page on its own, and AI Visibility is itself 7.5% of the overall
> score — a full deduction moves it by 1.5.
>
> Two limits worth knowing. Good human writing can trip several copy tells at
> once, which is why a cluster is required before anything is deducted. And a
> production build strips most generated-site evidence (source attributes,
> unbundled paths, dev modules), so on a well-made deployed site the stack is
> all that remains detectable — and plenty of hand-built sites use the same
> stack. The better the page, the less there is to find.
>
> They are placed under AI Visibility because Google's spam policies discount
> mass-produced, low-added-value pages regardless of how they were made — its
> [scaled content
> abuse](https://developers.google.com/search/docs/essentials/spam-policies)
> policy — and because AI answer engines cite sources that say something
> specific. The deduction is about that, not about the tool.

---

## Install

### Chrome / Edge / Brave

1. Go to `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this folder (or `dist/chrome` after
   running `npm run build:chrome`).

### Firefox

1. Go to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and select `manifest.json` in this
   folder (or `dist/firefox` after running `npm run build:firefox`).

   Temporary add-ons are removed when Firefox closes — for a permanent
   install it needs to be signed via addons.mozilla.org, or loaded with
   `xpinstall.signatures.required=false` set in a Developer/Nightly build.

## How it works

- **No content script runs on every page load.** Analysis happens on demand
  (`chrome.scripting.executeScript`) only when you open the popup, so there's
  no background overhead and no always-on access to pages you're not
  inspecting.
- `robots.txt`, `sitemap.xml` and `llms.txt` are checked with same-origin
  `fetch()` calls made from the popup, to the site you're already looking at.
- **The page's own URL is requested once more**, because an extension cannot
  see response headers any other way. That one response does double duty: its
  headers give the security checks (HSTS, CSP, X-Frame-Options) and its body
  is the HTML *as served*. The injected analyzer reads the DOM after
  JavaScript has run, so comparing the two is the only way to tell what a
  crawler that does not execute scripts actually receives — the
  "crawlers see an empty shell" finding comes from that difference.
- Performance stats come from the page's own `performance` Navigation/
  Resource Timing entries — nothing is re-fetched or re-loaded to measure
  them.
- **Comparison snapshots stay on your machine.** Pressing *Save snapshot*
  writes one analysis result to `chrome.storage.local` (local, not synced).
  Nothing is stored unless you ask for it, at most 8 are kept, and the
  compare view can delete any or all of them. Nothing is ever uploaded.
- A page captured in a background tab is never painted by the browser, so it
  records no LCP or CLS. Scorly marks those snapshots and leaves their paint
  timings — and the scoring checks derived from them — out of the comparison
  rather than reporting a regression that isn't real.
- Everything is processed locally in the browser. The only network calls are
  to the inspected site itself (robots.txt / sitemap.xml / favicon), plus any
  URL you explicitly ask the compare view to load. See
  [PRIVACY.md](PRIVACY.md) for the full breakdown.

## Project structure

```
manifest.json
popup/
  popup.html           UI markup — 13 tabs + compare bar + export footer
  theme.css            Design tokens (light + dark), shared with the compare view
  popup.css            Popup styling
  popup.js             Orchestration: analyze, wire up tabs/buttons
  inpage-analyzer.js   Function injected into the page to extract all SEO/content/perf/security data,
                       including the AI-writing and generated-build signal counts
  analyze.js           Shared capture step: run the analyzer in a tab, add robots/sitemap/favicon
                       checks and read the page's served HTML + response headers
  snapshots.js         Local snapshot store (chrome.storage.local) for the compare view
  scoring.js           Turns extracted data into 9 category scores + a severity-tagged checklist,
                       plus the AI Visibility breakdown and the AI-copy / vibe-code detectors
  render.js            All DOM rendering for every tab
  export.js            JSON / CSV / PDF / Markdown generation
  vendor/jspdf.umd.min.js   Bundled jsPDF (MIT) — used for local, offline PDF export
compare/
  compare.html         Full-tab comparison view
  compare.css          Comparison styling
  diff.js              Pure diff engine: two snapshots in, a renderable comparison model out
  compare.js           Compare-view controller and renderers
  export-diff.js       PDF / CSV / JSON / Markdown export of a comparison
icons/
```

Build and test:

```
npm run build            # dist/chrome + dist/firefox, zipped and unpacked
npm test                 # end-to-end compare checks, driven in real Chrome
npm run store-assets     # regenerate the store screenshots in store-assets/
```

`npm test` and the store-asset scripts drive an unpacked build in Chrome via
Puppeteer against a local two-variant demo server, so `npm run build:chrome`
has to have run first.

## Licence

MIT
