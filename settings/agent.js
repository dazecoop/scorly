// AI agent settings page: the on/off switch, live bridge status, setup
// instructions (folded away once an agent has connected) and a prompt
// builder. The background worker (background/agent-bridge.js) owns the
// connection; this page writes the settings record and renders the status
// and "seen" records it keeps.

const agentPageApi = (typeof browser !== 'undefined') ? browser : chrome;
const SETTINGS_KEY = 'scorly-agent-settings';
const STATUS_KEY = 'scorly-agent-status';
const SEEN_KEY = 'scorly-agent-seen';
const DEFAULTS = { enabled: false, port: 47615, localhostOnly: false };
const PACKAGE = 'github:dazecoop/scorly';
const DEFAULT_AUDIT_URL = 'http://localhost:3000';

// The one-shot CLI also connects to the bridge, but it says nothing about
// whether the MCP server is set up in an agent.
const CLI_CLIENT = 'scorly-cli';

// MCP clientInfo names → what the user calls the app.
const CLIENT_NAMES = [
  [/^claude-code$/i, 'Claude Code'],
  [/^claude-ai$|claude desktop/i, 'Claude Desktop'],
  [/cursor/i, 'Cursor'],
  [/visual studio code|vscode|copilot/i, 'VS Code'],
];

const $ = (id) => document.getElementById(id);
let settings = { ...DEFAULTS };
let status = { state: 'off', agents: [] };
let seen = {};
let client = 'all';
let lastDetected = null;

function prettyClient(name) {
  const hit = CLIENT_NAMES.find(([re]) => re.test(name));
  return hit ? hit[1] : name;
}

function relTime(iso) {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return '';
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

const isConnected = () => settings.enabled && status.state === 'connected';
const liveAgents = () => (isConnected() ? (status.agents || []) : []).filter(Boolean);

// ---- Status ----------------------------------------------------------------

function renderStatus() {
  const box = $('statusBox');
  let state = settings.enabled ? (status.state === 'connected' ? 'connected' : 'waiting') : 'off';
  if (state === 'connected' && status.busy) state = 'busy';
  box.dataset.state = state;

  const agents = liveAgents().map(prettyClient);
  if (state === 'off') {
    $('statusTitle').textContent = 'Off';
    $('statusSub').textContent = 'Turn on to let agents audit pages in this browser and to detect your setup.';
  } else if (state === 'waiting') {
    $('statusTitle').textContent = 'On · waiting for an agent';
    $('statusSub').textContent = 'Start a session in your agent. Scorly connects within 30 seconds.';
  } else if (state === 'busy') {
    $('statusTitle').textContent = 'Auditing…';
    $('statusSub').textContent = status.busy;
  } else {
    $('statusTitle').textContent = 'Connected';
    $('statusSub').textContent = agents.length ? `In use by ${agents.join(', ')}` : 'Linked to Scorly\'s agent tool';
  }
  $('reconnectBtn').classList.toggle('hidden', state !== 'waiting');

  const last = status.lastAudit;
  const lastEl = $('lastAudit');
  lastEl.classList.toggle('hidden', !last || !settings.enabled);
  if (last) {
    lastEl.textContent = '';
    const tag = document.createElement('span');
    tag.className = last.ok ? 'ok' : 'bad';
    tag.textContent = last.ok ? 'Last audit' : 'Last audit failed';
    lastEl.append(tag, ` · ${last.url} · ${relTime(last.at)}` + (last.ok ? '' : ` · ${last.message || ''}`));
  }
}

// ---- Setup detection -------------------------------------------------------

// "Set up" means an MCP client has connected to this browser at least once.
// The extension can't read an agent's config files, so this is the only
// signal there is, and it needs the switch on and a session running once.
function renderSetup() {
  const live = liveAgents().filter((n) => n !== CLI_CLIENT);
  const known = Object.entries(seen)
    .filter(([name]) => name !== CLI_CLIENT)
    .sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]));
  const detected = known.length > 0 || live.length > 0;

  $('setupDetected').classList.toggle('hidden', !detected);
  $('setupNeeded').classList.toggle('hidden', detected);
  $('setupNeeded').querySelector('[data-step]').toggleAttribute('data-step-off', detected);

  if (detected) {
    const names = Array.from(new Set(live.concat(known.map(([n]) => n)).map(prettyClient)));
    $('detectedTitle').textContent = `Scorly is set up in ${names.join(', ')}`;
    $('detectedSub').textContent = live.length
      ? 'Connected right now.'
      : `Last connected ${relTime(known[0][1])}. It reconnects whenever you start a session` +
        (settings.enabled ? '.' : ' and the switch above is on.');
    $('setupSummary').textContent = 'Setup and uninstall instructions';
  } else {
    $('setupSummary').textContent = 'Setup instructions';
    $('setupHint').textContent = settings.enabled
      ? 'Once it\'s added, start a new session in your agent. Scorly detects it here and hides these steps.'
      : 'Already added it? Turn on the switch above and start a session in your agent. Scorly detects it and hides these steps.';
  }

  // Fold or unfold only when detection changes, so a user who opened the
  // instructions isn't overruled by the next status update.
  if (detected !== lastDetected) {
    $('setupFold').open = !detected;
    $('setupFold').classList.toggle('ag-fold-plain', !detected);
    lastDetected = detected;
  }
  numberSteps();
}

function numberSteps() {
  let n = 0;
  document.querySelectorAll('[data-step]').forEach((el) => {
    if (el.hasAttribute('data-step-off')) return;
    el.textContent = String(++n);
  });
}

// ---- Setup snippets --------------------------------------------------------

// `scorly install` adds Scorly to every agent app it finds (Claude Code,
// Claude Desktop, Cursor), writing absolute Node paths into each config
// (desktop apps don't get the shell's PATH, so a pasted bare "npx" fails for
// nvm/Homebrew Node), then starts the server once to prove it works.
// `uninstall` reverses it everywhere and checks. VS Code's config is per
// project, so it has its own command.
function snippetFor(which, port) {
  const prefix = Number(port) !== DEFAULTS.port ? `SCORLY_PORT=${port} ` : '';
  const verified = 'It lists each app it set up with ✔, then ends with ✔ Verified when Scorly starts, or ✘ and the reason. ';
  if (which === 'vscode') {
    return {
      where: 'Run this in your project folder. It adds Scorly to .vscode/mcp.json (Copilot agent mode).',
      code: `${prefix}npx -y ${PACKAGE} install vscode`,
      after: verified + 'Then run "MCP: List Servers" in VS Code and start scorly.',
      remove: `npx -y ${PACKAGE} uninstall vscode`,
      removeNote: 'To remove Scorly from this project, run this in the project folder. It confirms the entry is gone:',
    };
  }
  if (which === 'cli') {
    return {
      where: 'No MCP? Run audits from a terminal or script instead:',
      code: [
        `${prefix}npx -y ${PACKAGE} audit http://localhost:3000 --save before.json`,
        '# …make changes…',
        `${prefix}npx -y ${PACKAGE} audit http://localhost:3000 --compare before.json`,
      ].join('\n'),
      after: 'Add --detail full for the complete report. Works in CI too (headless Chrome).',
      remove: `npx -y ${PACKAGE} uninstall`,
      removeNote: 'Nothing to remove for terminal use. This removes Scorly from every agent app it was added to:',
    };
  }
  return {
    where: 'Adds Scorly to every agent app on this computer (Claude Code, Claude Desktop and Cursor, whichever you have):',
    code: `${prefix}npx -y ${PACKAGE} install`,
    after: verified + 'Then restart those apps: a new Claude Code session; fully quit and reopen Claude Desktop or Cursor. Installed a new agent app later? Run it again.',
    remove: `npx -y ${PACKAGE} uninstall`,
    removeNote: 'To remove Scorly from every agent app, run this. It confirms each entry is gone:',
  };
}

function renderSnippet() {
  const s = snippetFor(client, settings.port);
  $('snippetWhere').textContent = s.where;
  $('snippet').textContent = s.code;
  $('snippetAfter').textContent = s.after;
  $('removeNote').textContent = s.removeNote || 'To remove Scorly again, run this. It confirms the entry is gone:';
  $('removeSnippet').textContent = s.remove;
  document.querySelectorAll('.ag-tab').forEach((t) => {
    const on = t.dataset.client === client;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
  });
  $('infoAddr').textContent = `ws://127.0.0.1:${settings.port}`;
}

// ---- Prompt builder --------------------------------------------------------

function isLocalHost(host) {
  return /^(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(host) || /\.localhost(:|$)/i.test(host);
}

// "localhost:3000" or "example.com" → a full URL the agent can use as-is.
function normalizeUrl(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  if (/^https?:\/\//i.test(v)) return v;
  return (isLocalHost(v) ? 'http://' : 'https://') + v;
}

function renderPrompt() {
  const target = normalizeUrl($('auditUrl').value) || DEFAULT_AUDIT_URL;
  const other = normalizeUrl($('compareUrl').value);
  // Names the tool outright: told only "use Scorly", an agent without the
  // MCP server goes looking for a browser extension instead of saying so.
  const guard = ' If you don\'t have the scorly_audit tool, stop and tell me instead of using a browser.';
  $('promptExample').textContent = other
    ? `Use the Scorly MCP tools to audit ${target} and ${other} (scorly_audit), and compare them (scorly_compare). ` +
      `Fix the issues on ${target} that you can in this codebase, most severe first. ` +
      `Then re-audit ${target} and tell me how its score changed, what you fixed, and what still differs from ${other}.` + guard
    : `Use the Scorly MCP tool scorly_audit to audit ${target}. Fix the issues you can in this codebase, most severe first. ` +
      `Then re-audit it and tell me how the score changed and what you fixed.` + guard;
}

function saveFields() {
  try {
    localStorage.setItem('scorly-agent-fields', JSON.stringify({ audit: $('auditUrl').value, compare: $('compareUrl').value }));
  } catch (e) { /* per-viewer convenience only */ }
}

// Restores the last-typed URLs, then applies ?url= from the popup (the page
// it was showing): a dev-server URL is the page to fix; a live URL becomes
// the comparison when a dev server is already filled in.
function initFields() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('scorly-agent-fields') || '{}') || {}; } catch (e) { /* ignore */ }
  $('auditUrl').value = saved.audit || '';
  $('compareUrl').value = saved.compare || '';

  const fromPopup = new URLSearchParams(location.search).get('url');
  if (fromPopup && /^https?:\/\//i.test(fromPopup)) {
    let host = '';
    try { host = new URL(fromPopup).host; } catch (e) { /* ignore */ }
    const auditIsLocal = (() => { try { return isLocalHost(new URL(normalizeUrl($('auditUrl').value)).host); } catch (e) { return false; } })();
    if (isLocalHost(host) || !auditIsLocal) $('auditUrl').value = fromPopup;
    else if (fromPopup !== $('auditUrl').value) $('compareUrl').value = fromPopup;
    saveFields();
  }

  ['auditUrl', 'compareUrl'].forEach((id) => $(id).addEventListener('input', () => { renderPrompt(); saveFields(); }));
  renderPrompt();
}

// ---- Wiring ----------------------------------------------------------------

async function saveSettings(patch) {
  settings = { ...settings, ...patch };
  await agentPageApi.storage.local.set({ [SETTINGS_KEY]: settings });
  renderAll();
}

function renderAll() {
  renderStatus();
  renderSetup();
  renderSnippet();
}

function reconnect() {
  try { agentPageApi.runtime.sendMessage({ type: 'scorly-agent-reconnect' }).catch(() => {}); } catch (e) { /* ignore */ }
}

async function init() {
  scorlyInitTheme();
  const stored = await agentPageApi.storage.local.get([SETTINGS_KEY, STATUS_KEY, SEEN_KEY]);
  settings = { ...DEFAULTS, ...(stored[SETTINGS_KEY] || {}) };
  status = { ...status, ...(stored[STATUS_KEY] || {}) };
  seen = stored[SEEN_KEY] || {};

  $('enabledToggle').checked = settings.enabled;
  $('localhostOnly').checked = settings.localhostOnly;
  $('portInput').value = settings.port;

  $('enabledToggle').addEventListener('change', (e) => saveSettings({ enabled: e.target.checked }));
  $('localhostOnly').addEventListener('change', (e) => saveSettings({ localhostOnly: e.target.checked }));
  $('portInput').addEventListener('change', (e) => {
    const port = Math.round(Number(e.target.value));
    if (port >= 1024 && port <= 65535) saveSettings({ port });
    else e.target.value = settings.port;
  });
  $('reconnectBtn').addEventListener('click', reconnect);

  try { client = localStorage.getItem('scorly-agent-client') || client; } catch (err) { /* ignore */ }
  if (!['all', 'vscode', 'cli'].includes(client)) client = 'all'; // saved from the old per-app tabs
  $('clientTabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.ag-tab');
    if (!tab) return;
    client = tab.dataset.client;
    try { localStorage.setItem('scorly-agent-client', client); } catch (err) { /* ignore */ }
    renderSnippet();
  });

  document.querySelectorAll('.ag-copy').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText($(btn.dataset.copy).textContent);
        btn.textContent = 'Copied';
      } catch (err) {
        btn.textContent = 'Select & copy';
      }
      setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    });
  });

  agentPageApi.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[STATUS_KEY]) status = { state: 'off', agents: [], ...(changes[STATUS_KEY].newValue || {}) };
    if (changes[SETTINGS_KEY]) settings = { ...DEFAULTS, ...(changes[SETTINGS_KEY].newValue || {}) };
    if (changes[SEEN_KEY]) seen = changes[SEEN_KEY].newValue || {};
    if (changes[STATUS_KEY] || changes[SETTINGS_KEY] || changes[SEEN_KEY]) {
      renderStatus();
      renderSetup();
      if (changes[SETTINGS_KEY]) renderSnippet();
    }
  });
  // Relative times ("last connected 5 min ago") stay current.
  setInterval(() => { renderStatus(); renderSetup(); }, 30000);

  initFields();
  renderAll();
  if (settings.enabled) reconnect();
}

init();
