# Privacy Policy

Scorly does not collect or transmit any of your data. There is no account,
no analytics, no tracking, and no remote server — Scorly doesn't have one.
The only thing it ever stores is a page snapshot you explicitly ask it to
save for comparison, and that stays on your own machine.

## What Scorly does

When you click the Scorly icon, it reads the page open in your active tab
and runs its analysis there and then. The result is shown in the popup and
discarded when you close it — closing the popup and reopening it runs the
analysis again from scratch.

## Snapshots and page comparison

The compare feature is the one part of Scorly that stores anything. When you
press **Save snapshot**, or load a URL from the compare view, Scorly writes
that page's analysis to `chrome.storage.local` so it can be diffed against
another page later.

- Snapshots are stored **only in local extension storage on this machine**.
  They are never uploaded, never synced between devices, and no server ever
  sees them.
- A snapshot holds what the analysis found: the page URL, its meta tags, its
  heading outline and visible text, its links and image alt text, its
  structured data, and its measured timings.
- Nothing is saved unless you ask for it. Simply opening the popup still
  stores nothing.
- Scorly keeps at most 8 snapshots and discards the oldest beyond that.
- You can delete any snapshot, or all of them, from the compare view at any
  time. Uninstalling the extension removes them too.

## Network requests

Scorly makes network requests only to the site you are already looking at,
and only to check things that are part of its public footprint:

- `robots.txt` and `sitemap.xml`, fetched from the page's own origin
- the page's favicon, to confirm it loads

The compare view can also load a URL **that you type into it**, in a
background tab, so it can analyze that page the same way it analyzes the one
in front of you. That tab is closed as soon as the analysis finishes. Scorly
never loads a page you did not ask it to.

No request is ever made to a Scorly-owned or third-party server. There is no
telemetry, crash reporting, or usage tracking of any kind.

## Permissions

- **activeTab / scripting** — used to read and analyze the tab you have open
  when you click the icon, and the background tab the compare view opens for
  a URL you typed. Scorly never runs on a schedule and never reads a page you
  did not point it at.
- **tabs** — used to identify which tab is active, so the popup knows what
  to analyze, and to open and close the background tab when you ask the
  compare view to load a specific URL.
- **storage** — used only to hold the comparison snapshots you explicitly
  save, in local (not synced) extension storage.
- **host permissions (`<all_urls>`)** — needed because Scorly can analyze
  any site you're on, including `localhost` and private-network addresses.
  It is never used to read or modify pages you aren't actively inspecting.

## Exports

The PDF, CSV, JSON and Markdown exports — both the popup's footer buttons
and the compare view's Export menu — generate files locally in your browser
(PDF via a bundled, offline copy of jsPDF) and save them to your device
through the browser's normal download flow. Scorly never uploads them
anywhere.

## Changes

If this policy ever changes, the change will be reflected in this file in
the same repository, and the version history is public.

## Contact

Questions about this policy can be opened as an issue on the
[Scorly repository](https://github.com/dazecoop/scorly).
