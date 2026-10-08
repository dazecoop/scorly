# Scorly

Cross-browser (Chrome + Firefox) WebExtension that scores any page's on-page SEO in depth and previews how it will look when shared on social platforms (Open Graph preview).

## Features
- **Overall SEO score (0–100)**, broken down into 8 category scores with progress bars: Technical, Content, Perf, Schema, Security, Mobile, AI SEO, E-E-A-T.
- **13 tabs** of detail: Overview (with SERP preview + quick stats), Meta, Content (readability, word/sentence stats, top keywords), H Tags, Links (summary), Internal links list, External links list, Images (with alt-text audit), Schema (JSON-LD viewer), Tech, Perf (TTFB/requests/transfer size), Security (HTTPS/mixed content/secure context/protocol), and Open Graph Preview.
- Every check is tagged **pass / warn / fail** with a **severity** (high/med/low) and grouped into Issues / Warnings / Passed, same as the summary counts on the Overview tab.
- Works on `localhost` / private-network URLs — HTTPS checks are skipped there instead of penalized, and a "localhost" badge is shown.
- **Open Graph preview tab**: renders the page as it would appear when shared on Facebook, X, LinkedIn, WhatsApp, and Discord/Slack. If no OG tags are present, it builds a best-effort fallback from `<title>`, meta description, and favicon, and clearly flags it as a fallback.
- **Export**: download the full report as **PDF**, **CSV**, or **JSON** from the footer bar — all generated locally (PDF via a bundled copy of jsPDF, no network calls).
- Light/dark theme — follows OS preference by default, with a manual toggle.

### About the "AI SEO" and "E-E-A-T" scores
These two categories are heuristic signals (structured data presence, semantic HTML landmarks, author byline, publish date, about/contact/privacy links, etc.) — not an official metric from any search engine or AI provider. Treat them as directional indicators, not ground truth.

## Load it unpacked

### Chrome / Edge / Brave
1. Go to `chrome://extensions`.
2. Enable "Developer mode" (top right).
3. Click "Load unpacked" and select this folder.

### Firefox
1. Go to `about:debugging#/runtime/this-firefox`.
2. Click "Load Temporary Add-on…" and select `manifest.json` in this folder.
   (Temporary add-ons are removed when Firefox closes — for a permanent install it needs to be signed via addons.mozilla.org, or loaded via `about:config` → `xpinstall.signatures.required=false` in Developer/Nightly builds.)

## How it works
- No content script runs on every page load — analysis is performed on demand (`chrome.scripting.executeScript`) only when you open the popup, so there's no background overhead or always-on page access.
- `robots.txt` and `sitemap.xml` are checked with same-origin `fetch()` calls from the popup.
- Performance stats (TTFB, request count, transferred size) come from the page's own `performance` Navigation/Resource Timing entries — no synthetic load is triggered.
- All processing happens locally in the browser; nothing is sent to a remote server. The only network calls are to the inspected site itself (robots.txt/sitemap.xml/favicon checks).

## Project structure
```
manifest.json
popup/
  popup.html          UI markup — 13 tabs + export footer
  popup.css            Styling (light + dark, manual toggle)
  popup.js             Orchestration: analyze, wire up tabs/buttons
  inpage-analyzer.js   Function injected into the page to extract all SEO/content/perf/security data
  scoring.js           Turns extracted data into 8 category scores + a severity-tagged checklist
  render.js            All DOM rendering for every tab
  export.js            JSON / CSV / PDF generation
  vendor/jspdf.umd.min.js   Bundled jsPDF (MIT) — used for local, offline PDF export
icons/
```
