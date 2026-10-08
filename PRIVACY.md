# Privacy Policy

Scorly does not collect, store, or transmit any of your data. There is no
account, no analytics, no tracking, and no remote server — Scorly doesn't
have one.

## What Scorly does

When you click the Scorly icon, it reads the page open in your active tab
and runs its analysis there and then. The result is shown in the popup and
discarded when you close it. Nothing is saved to disk, to `chrome.storage`,
or anywhere else — closing the popup and reopening it runs the analysis
again from scratch.

## Network requests

Scorly makes network requests only to the site you are already looking at,
and only to check things that are part of its public footprint:

- `robots.txt` and `sitemap.xml`, fetched from the page's own origin
- the page's favicon, to confirm it loads

No request is ever made to a Scorly-owned or third-party server. There is no
telemetry, crash reporting, or usage tracking of any kind.

## Permissions

- **activeTab / scripting** — used to read and analyze the single tab you
  have open when you click the icon. Scorly never runs in the background and
  never touches a tab you haven't explicitly opened the popup on.
- **tabs** — used only to identify which tab is active, so the popup knows
  what to analyze.
- **host permissions (`<all_urls>`)** — needed because Scorly can analyze
  any site you're on, including `localhost` and private-network addresses.
  It is never used to read or modify pages you aren't actively inspecting.

## Exports

The PDF, CSV, and JSON export buttons generate files locally in your browser
(PDF via a bundled, offline copy of jsPDF) and save them to your device
through the browser's normal download flow. Scorly never uploads them
anywhere.

## Changes

If this policy ever changes, the change will be reflected in this file in
the same repository, and the version history is public.

## Contact

Questions about this policy can be opened as an issue on the
[Scorly repository](https://github.com/dazecoop/scorly).
