# Privacy Policy

Scorly does not collect or transmit any of your data. There is no account,
no analytics, no tracking, and no remote server — Scorly doesn't have one.
It stores only what you ask for, such as a page snapshot you save for
comparison or the AI agent settings you choose, and all of it stays on your
own machine.

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

- `robots.txt`, `sitemap.xml` and `llms.txt`, fetched from the page's own
  origin
- the page's favicon, to confirm it loads
- the page's own URL, requested once more. A browser extension cannot read
  response headers any other way, so this single response supplies both the
  security-header checks and the HTML as it was served before any JavaScript
  ran, which is what lets Scorly report what a non-executing crawler sees
- a random, almost certainly non-existent URL on the same origin, to check
  the site returns a real 404 rather than a soft 200
- a handful of the page's own largest static assets, re-requested to read
  their caching headers
- the internal links on the page, to check they resolve

The compare view can also load a URL **that you type into it**, in a
background tab, so it can analyze that page the same way it analyzes the one
in front of you. That tab is closed as soon as the analysis finishes. Scorly
never loads a page you did not ask it to.

No request is ever made to a Scorly-owned or third-party server. There is no
telemetry, crash reporting, or usage tracking of any kind.

## AI agents: MCP server and CLI

Scorly can also be used by an AI coding agent (Claude Code, Claude Desktop,
Cursor, VS Code) or from a terminal, through Scorly's own agent tool. That
tool is open source, runs on your own computer, and is only present if you
install it (`npx -y github:dazecoop/scorly install`).

### What the agent tool does on your computer

- **Setup.** `install` adds a "scorly" entry to the MCP configuration of each
  agent app it finds, after saving a `.scorly-backup` copy of that file.
  `uninstall` removes the entry again. It changes nothing else.
- **Audits.** An audit loads the page, runs the same checks the extension
  runs and makes the same requests listed under *Network requests* above, to
  the site being audited and nowhere else. By default it uses a separate
  headless Chrome, with no cookies or logins of yours.
- **Results.** The MCP server keeps a session's audits in memory so they can
  be compared, and forgets them when the agent app closes. The CLI writes an
  audit to disk only when you pass `--save`.
- **One small state file.** `~/.scorly/bridge.json` records when the
  extension last connected and when its switch was last turned off, so an
  agent knows whether to wait for it. Nothing else is in it.

### Running audits in your browser (off by default)

If you turn on **Let AI agents use Scorly** in the extension's AI agents
settings, audits can run in your own browser instead:

- The agent tool opens a WebSocket on `127.0.0.1` (your own computer, port
  47615 unless you change it) only while it is auditing, and closes it after
  10 idle minutes. The **Stop** button in the popup closes it immediately.
- The extension looks for that connection every 30 seconds while the switch
  is on. Web pages can't connect to it: only the extension and programs on
  your computer are accepted.
- For each audit, Scorly loads the URL in a background tab, runs the same
  analysis the popup runs, closes the tab and passes the result back over
  that local connection.
- Pages load with this browser's cookies, so an agent can audit pages you
  are signed in to. If you don't want that, leave the switch off, or tick
  **Only allow localhost URLs**.
- The extension stores, in local extension storage: your agent settings;
  while the switch is on, the connection status and the URL of the last
  audit (removed when you turn the switch off); and the names of agent apps
  that have connected (for example "claude-code") with when they last did,
  so the settings page can tell you setup is done. All of it is removed when
  you uninstall Scorly.

No Scorly-owned or third-party server is involved at any point. What your
agent does with an audit, including whether its AI provider sees the report,
is up to the agent you use, not Scorly.

## "AI" features do not use AI

Scorly has an AI Insights tab, an AI Visibility score, an AI-copy detector
and a vibe-code detector. None of them call a model, an API or a remote
service of any kind, and none of them send your page anywhere.

"AI" there refers to the audience, not the method. The AI Visibility score is
about how readable your page is to AI answer engines. The AI-copy and
vibe-code detectors are plain pattern matching — counting phrases, class
names, HTML attributes and punctuation in the page already open in your
browser — and every rule behind them is in
[`popup/scoring.js`](popup/scoring.js) and
[`popup/inpage-analyzer.js`](popup/inpage-analyzer.js) to read. Your page
text is never uploaded, to Anthropic or OpenAI or anyone else, and no
detector output is shared or retained beyond the popup you are looking at.

## Permissions

- **activeTab / scripting** — used to read and analyze the tab you have open
  when you click the icon, and the background tab the compare view opens for
  a URL you typed, or that a local AI agent asked for while you have agent
  access switched on. Scorly never reads a page that you, or an agent you
  connected, did not point it at.
- **tabs** — used to identify which tab is active, so the popup knows what
  to analyze, and to open and close the background tab when you ask the
  compare view to load a specific URL.
- **storage** — used to hold the comparison snapshots you explicitly save,
  and your AI-agent settings, in local (not synced) extension storage.
- **alarms** — used only while AI agent access is switched on, to retry the
  local connection every 30 seconds.
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
