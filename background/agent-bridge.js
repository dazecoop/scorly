// Agent bridge: lets an AI agent on this computer (Scorly's MCP server or
// CLI) ask the extension to audit a URL in this browser.
//
// Off by default. While the user has it on, the worker keeps one WebSocket
// open to ws://127.0.0.1:<port>, a server that only Scorly's own Node process
// (agent/bridge.js) runs. Nothing is sent anywhere else: an audit request
// opens the URL in a background tab, runs the same capture as the compare
// view (scorlyAnalyzeUrlInBackgroundTab), closes the tab and sends the raw
// result back over that local socket. Scoring happens on the agent's side
// with the same scoring.js.
//
// Agents open their end only while they're auditing (and close it after 10
// idle minutes), so the worker is woken by an alarm every ~30s to look for
// it, and the popup's Stop button can close it early.

if (typeof scorlyAnalyzeUrlInBackgroundTab === 'undefined' && typeof importScripts === 'function') {
  // Chrome service worker. Firefox lists these in manifest background.scripts.
  importScripts('/popup/inpage-analyzer.js', '/popup/analyze.js');
}

const agentApi = (typeof browser !== 'undefined') ? browser : chrome;

const SCORLY_AGENT_SETTINGS_KEY = 'scorly-agent-settings';
const SCORLY_AGENT_STATUS_KEY = 'scorly-agent-status';
// Which agent apps have ever connected, and when last: the settings page uses
// it to know Scorly's MCP server is set up without asking the user.
const SCORLY_AGENT_SEEN_KEY = 'scorly-agent-seen';
const SCORLY_AGENT_DEFAULTS = { enabled: false, port: 47615, localhostOnly: false };
const SCORLY_AGENT_ALARM = 'scorly-agent-reconnect';

let agentSettings = { ...SCORLY_AGENT_DEFAULTS };
let agentSocket = null;
let agentStatus = { state: 'off', agents: [] };
let auditQueue = Promise.resolve();

async function agentLoadSettings() {
  const stored = await agentApi.storage.local.get([SCORLY_AGENT_SETTINGS_KEY, SCORLY_AGENT_STATUS_KEY]);
  agentSettings = { ...SCORLY_AGENT_DEFAULTS, ...(stored[SCORLY_AGENT_SETTINGS_KEY] || {}) };
  agentStatus = { ...agentStatus, ...(stored[SCORLY_AGENT_STATUS_KEY] || {}) };
}

// The settings page and the popup's agent button render from this record.
function agentSetStatus(patch) {
  agentStatus = { ...agentStatus, ...patch, updatedAt: new Date().toISOString() };
  return agentApi.storage.local.set({ [SCORLY_AGENT_STATUS_KEY]: agentStatus });
}

function agentSend(msg) {
  if (agentSocket && agentSocket.readyState === WebSocket.OPEN) agentSocket.send(JSON.stringify(msg));
}

function agentIsLocalhost(url) {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0.0.0.0' || /^127\./.test(h);
  } catch (e) {
    return false;
  }
}

function agentConnect() {
  if (!agentSettings.enabled) return;
  if (agentSocket && (agentSocket.readyState === WebSocket.CONNECTING || agentSocket.readyState === WebSocket.OPEN)) return;

  let sock;
  try {
    sock = new WebSocket(`ws://127.0.0.1:${agentSettings.port}`);
  } catch (e) {
    agentSetStatus({ state: 'waiting', agents: [], error: 'Invalid port' });
    return;
  }
  agentSocket = sock;

  sock.onopen = () => {
    const isFirefox = typeof browser !== 'undefined' && /firefox/i.test(navigator.userAgent);
    sock.send(JSON.stringify({
      type: 'hello',
      role: 'extension',
      version: agentApi.runtime.getManifest().version,
      browser: isFirefox ? 'Firefox' : 'Chrome',
      localhostOnly: !!agentSettings.localhostOnly,
    }));
    agentSetStatus({ state: 'connected', agents: [], error: null, connectedAt: new Date().toISOString() });
  };

  sock.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch (e) { return; }
    if (msg.type === 'ping') {
      agentSend({ type: 'pong' });
      // Firefox ends an idle background page regardless of open sockets; an
      // extension API call counts as activity and keeps it alive.
      try { agentApi.runtime.getPlatformInfo(); } catch (e) { /* ignore */ }
    } else if (msg.type === 'agents') {
      const agents = Array.isArray(msg.clients) ? msg.clients.map(String).slice(0, 10) : [];
      agentSetStatus({ agents });
      agentRememberSeen(agents);
    } else if (msg.type === 'audit') {
      // One at a time: each audit opens its own tab, and a burst of them
      // would compete for the network and skew the timings.
      auditQueue = auditQueue.then(() => agentRunAudit(msg)).catch(() => {});
    }
  };

  sock.onclose = () => {
    if (agentSocket !== sock) return;
    agentSocket = null;
    agentSetStatus({ state: agentSettings.enabled ? 'waiting' : 'off', agents: [] });
  };
  sock.onerror = () => { /* onclose follows; a refused connection just means no agent yet */ };
}

async function agentRememberSeen(agents) {
  if (!agents.length) return;
  const stored = await agentApi.storage.local.get(SCORLY_AGENT_SEEN_KEY);
  const seen = stored[SCORLY_AGENT_SEEN_KEY] || {};
  const now = new Date().toISOString();
  agents.forEach((name) => { seen[name.slice(0, 60)] = now; });
  await agentApi.storage.local.set({ [SCORLY_AGENT_SEEN_KEY]: seen });
}

function agentDisconnect() {
  const sock = agentSocket;
  agentSocket = null;
  if (sock) { try { sock.close(); } catch (e) { /* ignore */ } }
}

async function agentRunAudit(msg) {
  const url = String(msg.url || '');
  const client = String(msg.client || '').slice(0, 60) || null;
  // Every audit request counts as the app having used Scorly just now.
  if (client) agentRememberSeen([client]);
  const fail = (message) => {
    agentSend({ type: 'error', id: msg.id, message });
    return agentSetStatus({ lastAudit: { url, client, at: new Date().toISOString(), ok: false, message } });
  };
  if (!/^https?:\/\//i.test(url) || scorlyIsRestrictedUrl(url)) return fail('Scorly can only audit http(s) pages.');
  if (agentSettings.localhostOnly && !agentIsLocalhost(url)) {
    return fail('This browser only allows agent audits of localhost URLs (Scorly agent settings).');
  }
  await agentSetStatus({ busy: url });
  try {
    const data = await scorlyAnalyzeUrlInBackgroundTab(url);
    agentSend({ type: 'result', id: msg.id, data, origin: 'background' });
    await agentSetStatus({ busy: null, lastAudit: { url, client, at: new Date().toISOString(), ok: true } });
  } catch (err) {
    await agentSetStatus({ busy: null });
    await fail(err && err.message ? err.message : 'Audit failed.');
  }
}

async function agentApply() {
  await agentLoadSettings();
  if (agentSettings.enabled) {
    agentApi.alarms.create(SCORLY_AGENT_ALARM, { periodInMinutes: 0.5 });
    // Reconnect if the port changed under an open socket.
    if (agentSocket && !agentSocket.url.includes(`:${agentSettings.port}`)) agentDisconnect();
    if (!agentSocket) agentSetStatus({ state: 'waiting', agents: [], busy: null });
    agentConnect();
  } else {
    agentApi.alarms.clear(SCORLY_AGENT_ALARM);
    agentSend({ type: 'goodbye', reason: 'disabled' });
    agentDisconnect();
    // Off leaves nothing behind in storage; the UI reads a missing record as off.
    agentStatus = { state: 'off', agents: [] };
    agentApi.storage.local.remove(SCORLY_AGENT_STATUS_KEY);
  }
}

agentApi.runtime.onStartup.addListener(agentApply);
agentApi.runtime.onInstalled.addListener(agentApply);

agentApi.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== SCORLY_AGENT_ALARM) return;
  agentLoadSettings().then(agentConnect);
});

agentApi.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[SCORLY_AGENT_SETTINGS_KEY]) agentApply();
});

// The popup and settings page ask for an immediate retry when opened, so the
// user isn't left waiting up to 30s for the next alarm.
agentApi.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'scorly-agent-reconnect') agentLoadSettings().then(agentConnect);
  // Stop button (popup / settings): the agent's bridge closes now and opens
  // again on its next audit. The switch stays on.
  if (msg && msg.type === 'scorly-agent-stop') agentSend({ type: 'shutdown' });
});

agentApply();
