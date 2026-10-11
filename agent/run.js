// Picks how a page is read: through the Scorly extension in the user's own
// browser when it is connected, headless Chrome otherwise.

const engine = require('./engine');
const { extensionRecentlySeen } = require('./bridge');

// How long scorly_status waits for an extension that has connected before.
const STATUS_WAIT_MS = 35000;

// A freshly started bridge only hears from the extension on its next retry
// (every ~30s), so when the extension has been used before it is worth
// waiting that long once rather than silently falling back.
const FIRST_CONNECT_WAIT_MS = 35000;

const ENGINE_LABEL = {
  browser: 'the Scorly extension (your browser)',
  headless: 'headless Chrome',
};

// Progress hooks, so a terminal can show what's happening (the MCP server
// passes none). Each returns a function that's called once the step ends:
//   waiting(ms)          waiting up to `ms` for the extension → done(connected)
//   auditing(url, where) one audit running ('browser' | 'headless') → done(ok)
const NO_PROGRESS = { waiting: () => () => {}, auditing: () => () => {} };

// via: 'auto' | 'browser' | 'headless'
async function runAudit(url, { bridge, via = 'auto', log = () => {}, progress = NO_PROGRESS } = {}) {
  if (!/^https?:\/\//i.test(url)) throw new Error(`Only http(s) URLs can be audited (got "${url}").`);
  let note = null;

  if (via !== 'headless' && bridge) {
    // Opens the bridge for this audit (it closes itself after idling). A
    // never-seen extension isn't waited for: it picks the bridge up on its
    // next retry, in time for the following audit.
    try { await bridge.use(); } catch (e) { log('Scorly bridge unavailable: ' + e.message); }
    let connected = await bridge.extensionConnected();
    if (!connected && (via === 'browser' || extensionRecentlySeen())) {
      const waited = progress.waiting(FIRST_CONNECT_WAIT_MS);
      connected = await bridge.waitForExtension(FIRST_CONNECT_WAIT_MS);
      waited(connected);
    }
    if (connected) {
      const done = progress.auditing(url, 'browser');
      try {
        const { data, origin } = await bridge.auditViaExtension(url);
        done(true);
        bridge.touch();
        return { audit: engine.makeAudit(data, origin || 'background'), engine: 'browser', note };
      } catch (err) {
        done(false);
        if (via === 'browser') throw err;
        note = `Extension audit failed (${err.message}); fell back to headless Chrome.`;
      }
    } else if (via === 'browser') {
      throw new Error('The Scorly extension is not connected. Turn on "Let AI agents use Scorly" in the extension\'s Agent settings.');
    }
  }

  const done = progress.auditing(url, 'headless');
  let data;
  try {
    data = await engine.captureHeadless(url);
  } catch (err) {
    done(false);
    throw err;
  }
  done(true);
  return { audit: engine.makeAudit(data, 'headless'), engine: 'headless', note };
}

// Bridge status for scorly_status / `scorly status`: opens the bridge and,
// when the extension has been used before, gives it one retry interval to
// connect so the answer reflects whether the switch is on.
async function bridgeStatus(bridge) {
  try { await bridge.use(); } catch (e) { return { mode: 'none', port: bridge.port, extension: null, agents: [], error: e.message }; }
  if (!(await bridge.extensionConnected()) && extensionRecentlySeen()) await bridge.waitForExtension(STATUS_WAIT_MS);
  bridge.touch();
  return bridge.status().catch(() => ({ mode: 'none', port: bridge.port, extension: null, agents: [] }));
}

module.exports = { runAudit, bridgeStatus, ENGINE_LABEL };
