// Picks how a page is read: through the Scorly extension in the user's own
// browser when it is connected, headless Chrome otherwise.

const engine = require('./engine');
const { extensionRecentlySeen } = require('./bridge');

// A freshly started bridge only hears from the extension on its next retry
// (every ~30s), so when the extension has been used before it is worth
// waiting that long once rather than silently falling back.
const FIRST_CONNECT_WAIT_MS = 35000;

const ENGINE_LABEL = {
  browser: 'the Scorly extension (your browser)',
  headless: 'headless Chrome',
};

// via: 'auto' | 'browser' | 'headless'
async function runAudit(url, { bridge, via = 'auto', log = () => {} } = {}) {
  if (!/^https?:\/\//i.test(url)) throw new Error(`Only http(s) URLs can be audited (got "${url}").`);
  let note = null;

  if (via !== 'headless' && bridge) {
    let connected = await bridge.extensionConnected();
    if (!connected && (via === 'browser' || extensionRecentlySeen())) {
      log('Waiting for the Scorly extension to connect…');
      connected = await bridge.waitForExtension(FIRST_CONNECT_WAIT_MS);
    }
    if (connected) {
      try {
        const { data, origin } = await bridge.auditViaExtension(url);
        return { audit: engine.makeAudit(data, origin || 'background'), engine: 'browser', note };
      } catch (err) {
        if (via === 'browser') throw err;
        note = `Extension audit failed (${err.message}); fell back to headless Chrome.`;
      }
    } else if (via === 'browser') {
      throw new Error('The Scorly extension is not connected. Turn on "Let AI agents use Scorly" in the extension\'s Agent settings.');
    }
  }

  const data = await engine.captureHeadless(url);
  return { audit: engine.makeAudit(data, 'headless'), engine: 'headless', note };
}

module.exports = { runAudit, ENGINE_LABEL };
