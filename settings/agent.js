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

const $ = (id) => document.getElementById(id);
let settings = { ...DEFAULTS };
let status = { state: 'off', agents: [] };
let seen = {};
let client = 'all';
let lastDetected = null;

const prettyClient = scorlyAgentAppName; // popup/agent-names.js

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
    $('statusTitle').textContent = 'On · idle';
    $('statusSub').textContent = 'Nothing runs until an agent audits a page. Its bridge then opens, Scorly connects within 30 seconds, and the bridge closes again after 10 idle minutes.';
  } else if (state === 'busy') {
    $('statusTitle').textContent = 'Auditing…';
    $('statusSub').textContent = status.busy;
  } else {
    $('statusTitle').textContent = 'Connected';
    $('statusSub').textContent = agents.length ? `In use by ${agents.join(', ')}` : 'Linked to Scorly\'s agent tool';
  }
  $('reconnectBtn').classList.toggle('hidden', state !== 'waiting');
  $('stopBtn').classList.toggle('hidden', state !== 'connected' && state !== 'busy');
  if (state === 'waiting' || state === 'off') $('stopBtn').disabled = false;

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
// project, so it has its own command. (Plain CLI use needs no install; it's
// under "How to use".)
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
  document.querySelectorAll('#clientTabs .ag-tab').forEach((t) => {
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

// Pasted paths: Windows' "Copy as path" adds quotes, a dragged file URL
// starts with file://.
function normalizePath(raw) {
  let v = String(raw || '').trim().replace(/^["']|["']$/g, '');
  if (/^file:\/\//i.test(v)) {
    try { v = decodeURIComponent(new URL(v).pathname); } catch (e) { /* keep as typed */ }
  }
  return v.replace(/(.)[\\/]+$/, '$1');
}

// How to copy a folder's full path on this OS, since the folder picker can
// only ever hand the page the folder's name.
function copyPathTip() {
  const p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  if (/mac/i.test(p)) return 'To get the full path: select the folder in Finder and press ⌥⌘C, then paste it here.';
  if (/win/i.test(p)) return 'To get the full path: Shift + right-click the folder in Explorer, choose "Copy as path", then paste it here.';
  return 'To get the full path: run pwd in a terminal inside the folder, then paste it here.';
}

let useMode = 'agent'; // 'agent' | 'cli'

// Terminal commands for the same URLs. Paths are relative, so they land in
// whatever folder the terminal is in.
function cliCommands(target, other) {
  const prefix = Number(settings.port) !== DEFAULTS.port ? `SCORLY_PORT=${settings.port} ` : '';
  const run = (args) => `${prefix}npx -y ${PACKAGE} ${args}`;
  if (other) {
    return [
      `# Audit both pages and keep the results`,
      run(`audit ${other} --save compare-with.json`),
      run(`audit ${target} --save page.json`),
      '',
      `# Field-by-field differences`,
      run('compare compare-with.json page.json'),
    ].join('\n');
  }
  return [
    '# Audit and keep the result',
    run(`audit ${target} --save before.json`),
    '',
    '# …make changes, then see what moved',
    run(`audit ${target} --compare before.json`),
  ].join('\n');
}

function renderPrompt() {
  const target = normalizeUrl($('auditUrl').value) || DEFAULT_AUDIT_URL;
  const other = normalizeUrl($('compareUrl').value);
  const agentMode = useMode === 'agent';
  const fix = agentMode && $('fixToggle').checked;

  document.querySelectorAll('#useTabs .ag-tab').forEach((t) => {
    const on = t.dataset.use === useMode;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
  });
  $('useAgent').classList.toggle('hidden', !agentMode);
  $('useCli').classList.toggle('hidden', agentMode);
  $('cliSnippet').textContent = cliCommands(target, other);
  const folder = normalizePath($('codebasePath').value);
  const isPath = /[\\/]/.test(folder);

  $('codebaseField').classList.toggle('hidden', !fix);
  $('auditLabel').textContent = fix ? 'Page to audit and fix' : 'Page to audit';
  $('auditSub').textContent = fix
    ? 'Usually your local dev server: the agent edits the code behind it.'
    : 'Any page: your local dev server or a live site.';
  $('fixSub').textContent = fix
    ? 'The agent fixes what it can, re-audits and reports the before/after score.'
    : 'Off: the agent only audits and reports back. No files are changed.';
  $('codebaseSub').textContent = folder && !isPath
    ? 'Only the folder name is known (browsers don\'t reveal full paths). ' + copyPathTip()
    : 'Optional if your agent already has the project open. ' + copyPathTip();
  $('pasteHint').textContent = fix
    ? 'Paste this into a new agent session. In Claude Desktop, attach the project folder first with + → Add folder.'
    : 'Paste this into a new agent session:';

  // Names the tool outright: told only "use Scorly", an agent without the
  // tool goes looking for a browser extension. Desktop agents also prefix MCP
  // tool names (mcp__scorly__…) and load tools on demand, so the prompt says
  // to search before concluding it's missing.
  const find = 'Use the Scorly MCP tools (scorly_audit, scorly_compare; names may have a prefix like mcp__scorly__, and if your tools load on demand, search your tools for "scorly" first). ';
  const guard = ' If no Scorly tool exists after searching, stop and tell me instead of using a browser.';
  const where = !folder ? 'in this codebase'
    : isPath ? `in the codebase at ${folder}` : `in the project folder named "${folder}"`;

  let body;
  if (fix && other) {
    body = `Audit ${target} and ${other} and compare them. ` +
      `Fix the issues on ${target} that you can ${where}, most severe first. ` +
      `Then re-audit ${target} and tell me how its score changed, what you fixed, and what still differs from ${other}.`;
  } else if (fix) {
    body = `Audit ${target}. Fix the issues you can ${where}, most severe first. ` +
      'Then re-audit it and tell me how the score changed and what you fixed.';
  } else if (other) {
    body = `Audit ${target} and ${other} and compare them. Report back both scores, what differs between the two, ` +
      `and the most important issues on ${target} with how to fix each, most severe first. Don't change any files.`;
  } else {
    body = `Audit ${target} and report back the overall and category scores, then the most important issues ` +
      'with how to fix each, most severe first. Don\'t change any files.';
  }
  $('promptExample').textContent = find + body + guard;
}

function saveFields() {
  try {
    localStorage.setItem('scorly-agent-fields', JSON.stringify({
      audit: $('auditUrl').value,
      compare: $('compareUrl').value,
      codebase: $('codebasePath').value,
      fix: $('fixToggle').checked,
      use: useMode,
    }));
  } catch (e) { /* per-viewer convenience only */ }
}

// The File System Access picker (Chrome) returns a handle whose only
// location detail is the folder's name. Firefox has no picker: the button
// hides and the path is typed or pasted.
async function chooseFolder() {
  try {
    const handle = await window.showDirectoryPicker({ mode: 'read' });
    const current = normalizePath($('codebasePath').value);
    // Keep a typed full path that already ends in this folder.
    if (!current.endsWith('/' + handle.name) && !current.endsWith('\\' + handle.name)) $('codebasePath').value = handle.name;
    renderPrompt();
    saveFields();
  } catch (e) { /* cancelled */ }
}

// Restores the last-typed fields, then applies ?url= from the popup (the page
// it was showing): a dev-server URL is the page to fix; a live URL becomes
// the comparison when a dev server is already filled in.
function initFields() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('scorly-agent-fields') || '{}') || {}; } catch (e) { /* ignore */ }
  $('auditUrl').value = saved.audit || '';
  $('compareUrl').value = saved.compare || '';
  $('codebasePath').value = saved.codebase || '';
  $('fixToggle').checked = saved.fix !== false;
  useMode = saved.use === 'cli' ? 'cli' : 'agent';

  const fromPopup = new URLSearchParams(location.search).get('url');
  if (fromPopup && /^https?:\/\//i.test(fromPopup)) {
    let host = '';
    try { host = new URL(fromPopup).host; } catch (e) { /* ignore */ }
    const auditIsLocal = (() => { try { return isLocalHost(new URL(normalizeUrl($('auditUrl').value)).host); } catch (e) { return false; } })();
    if (isLocalHost(host) || !auditIsLocal) $('auditUrl').value = fromPopup;
    else if (fromPopup !== $('auditUrl').value) $('compareUrl').value = fromPopup;
    saveFields();
  }

  if (typeof window.showDirectoryPicker !== 'function') $('chooseFolderBtn').classList.add('hidden');
  $('chooseFolderBtn').addEventListener('click', chooseFolder);
  ['auditUrl', 'compareUrl', 'codebasePath'].forEach((id) => $(id).addEventListener('input', () => { renderPrompt(); saveFields(); }));
  $('fixToggle').addEventListener('change', () => { renderPrompt(); saveFields(); });
  $('useTabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.ag-tab');
    if (!tab) return;
    useMode = tab.dataset.use;
    renderPrompt();
    saveFields();
  });
  renderPrompt();
}

// ---- Wiring ----------------------------------------------------------------

async function saveSettings(patch) {
  settings = { ...settings, ...patch };
  await agentPageApi.storage.local.set({ [SETTINGS_KEY]: settings });
  renderAll();
  renderPrompt(); // the CLI commands carry the port
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
  $('stopBtn').addEventListener('click', () => {
    $('stopBtn').disabled = true;
    try { agentPageApi.runtime.sendMessage({ type: 'scorly-agent-stop' }).catch(() => {}); } catch (e) { /* ignore */ }
  });

  try { client = localStorage.getItem('scorly-agent-client') || client; } catch (err) { /* ignore */ }
  if (!['all', 'vscode'].includes(client)) client = 'all'; // saved from older tab sets
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
