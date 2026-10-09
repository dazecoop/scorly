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

Fill either side from a snapshot you saved earlier or let Scorly load a URL
in a background tab. Filter to just the differences, then copy the whole
thing out as Markdown for a pull request or a client email.

Snapshots live in local extension storage, are capped at 8, and can be
deleted at any time. Nothing is uploaded, and nothing is stored unless you
press Save.

---

## What it does

**Scores the whole page, not just the title tag.** One overall score (0–100)
broken into 8 categories — Technical, Content, Perf, Schema, Security,
Mobile, AI SEO, E-E-A-T — each with its own bar, so you can see exactly which
part of the page is dragging the score down.

**Explains every check.** 13 tabs of detail: Overview with a SERP preview,
Meta, Content (readability, word/sentence stats, top keywords), H Tags,
Links, Internal/External link lists, Images (alt-text audit), Schema (JSON-LD
viewer), Tech, Perf (TTFB, requests, transfer size), Security, and Open Graph
Preview. Every check is tagged pass / warn / fail with a severity, and rolled
up into the Issues / Warnings / Passed counts on the Overview tab.

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

**Exports what it finds.** PDF, CSV, or JSON from the footer bar, all
generated locally — PDF via a bundled copy of jsPDF, no network call
involved.

**Costs nothing to run.** No account, no API key, no rate limit, no
subscription. Light/dark theme follows your OS by default, with a manual
toggle.

> **About "AI SEO" and "E-E-A-T"** — these two categories are heuristic
> signals (structured data, semantic HTML landmarks, author byline, publish
> date, about/contact/privacy links, and the like), not an official metric
> from any search engine or AI provider. Treat them as directional
> indicators, not ground truth.

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
- `robots.txt` and `sitemap.xml` are checked with same-origin `fetch()` calls
  made from the popup, to the site you're already looking at.
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
  inpage-analyzer.js   Function injected into the page to extract all SEO/content/perf/security data
  analyze.js           Shared capture step: run the analyzer in a tab, add robots/sitemap/favicon checks
  snapshots.js         Local snapshot store (chrome.storage.local) for the compare view
  scoring.js           Turns extracted data into 8 category scores + a severity-tagged checklist
  render.js            All DOM rendering for every tab
  export.js            JSON / CSV / PDF generation
  vendor/jspdf.umd.min.js   Bundled jsPDF (MIT) — used for local, offline PDF export
compare/
  compare.html         Full-tab comparison view
  compare.css          Comparison styling
  diff.js              Pure diff engine: two snapshots in, a renderable comparison model out
  compare.js           Compare-view controller and renderers
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
