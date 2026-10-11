// `scorly install|uninstall <app>`: add or remove Scorly's MCP server in an
// agent app's config, then prove the result instead of assuming it.
//
//   install    writes the entry, then launches the server exactly as the app
//              will (same command, args and env, without this shell's PATH)
//              and checks it answers with Scorly's tools
//   uninstall  removes the entry, then re-reads the config to confirm it's gone
//   check      reports, per app, whether Scorly is configured and starts

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const PACKAGE = 'github:dazecoop/scorly';
const SERVER_NAME = 'scorly';
const EXPECTED_TOOLS = ['scorly_audit', 'scorly_compare', 'scorly_status'];

const claudeDesktopFile = process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  : process.platform === 'win32'
    ? path.join(process.env.APPDATA || '', 'Claude', 'claude_desktop_config.json')
    : path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json');

// kind 'json': we edit the file. kind 'claude-cli': Claude Code owns
// ~/.claude.json and rewrites it while running, so changes go through its
// own `claude mcp` command and the file is only read, to verify.
const TARGETS = {
  'claude-code': {
    name: 'Claude Code', kind: 'claude-cli', file: path.join(os.homedir(), '.claude.json'), key: 'mcpServers',
    after: 'Start a new Claude Code session (in VS Code: reload the window).',
    afterRemove: 'Start a new Claude Code session (in VS Code: reload the window).',
  },
  'claude-desktop': {
    name: 'Claude Desktop', kind: 'json', file: claudeDesktopFile, key: 'mcpServers',
    after: 'Fully quit Claude Desktop (⌘Q) and reopen it; a new chat is not enough.',
    afterRemove: 'Fully quit Claude Desktop (⌘Q) and reopen it.',
  },
  cursor: {
    name: 'Cursor', kind: 'json', file: path.join(os.homedir(), '.cursor', 'mcp.json'), key: 'mcpServers',
    after: 'Reload Cursor, then check scorly is enabled under Cursor Settings → MCP.',
    afterRemove: 'Reload Cursor.',
  },
  vscode: {
    name: 'VS Code (this project)', kind: 'json', file: path.join(process.cwd(), '.vscode', 'mcp.json'), key: 'servers', stdioType: true,
    after: 'In VS Code, run "MCP: List Servers" and start scorly.',
    afterRemove: 'Reload the VS Code window.',
  },
};

const ok = (m) => console.log('✔ ' + m);
const bad = (m) => console.log('✘ ' + m);
const info = (m) => console.log('  ' + m);

// ---- Config entries --------------------------------------------------------

// Desktop apps launched from the Dock/Start menu don't get the shell's PATH,
// so a bare "npx" fails for anyone whose Node came from nvm, Volta or
// Homebrew. The entry names the Node running this command by absolute path
// and puts its folder on PATH for npx's own "#!/usr/bin/env node".
function mcpEntry({ local, stdioType }) {
  const nodeDir = path.dirname(process.execPath);
  const env = { PATH: [nodeDir, '/usr/local/bin', '/usr/bin', '/bin'].join(path.delimiter) };
  if (process.env.SCORLY_PORT) env.SCORLY_PORT = process.env.SCORLY_PORT;
  let entry;
  if (local) {
    entry = { command: process.execPath, args: [path.join(__dirname, 'cli.js'), 'mcp'], env };
  } else {
    const npx = path.join(nodeDir, process.platform === 'win32' ? 'npx.cmd' : 'npx');
    entry = { command: fs.existsSync(npx) ? npx : 'npx', args: ['-y', PACKAGE, 'mcp'], env };
  }
  return stdioType ? { type: 'stdio', ...entry } : entry;
}

function readJson(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8');
  try { return raw.trim() ? JSON.parse(raw) : {}; } catch (e) {
    throw new Error(`${file} isn't valid JSON, so it was left alone. Fix it and run this again.`);
  }
}

function readEntry(target) {
  const servers = readJson(target.file)[target.key];
  return (servers && servers[SERVER_NAME]) || null;
}

function writeJsonEntry(target, entry) {
  const config = readJson(target.file);
  if (fs.existsSync(target.file)) fs.copyFileSync(target.file, target.file + '.scorly-backup');
  else fs.mkdirSync(path.dirname(target.file), { recursive: true });
  const servers = { ...(config[target.key] || {}) };
  if (entry) servers[SERVER_NAME] = entry;
  else delete servers[SERVER_NAME];
  config[target.key] = servers;
  fs.writeFileSync(target.file, JSON.stringify(config, null, 2) + '\n');
}

function claudeCli(args) {
  const r = spawnSync('claude', args, { encoding: 'utf8' });
  if (r.error && r.error.code === 'ENOENT') {
    throw new Error('The `claude` command wasn\'t found. Install Claude Code first, or add Scorly from its settings.');
  }
  return r;
}

function setEntry(target, entry) {
  if (target.kind === 'json') return writeJsonEntry(target, entry);
  // Claude Code: replace through its CLI, user scope (all projects).
  claudeCli(['mcp', 'remove', SERVER_NAME, '-s', 'user']); // fine if absent
  if (!entry) return;
  const r = claudeCli(['mcp', 'add-json', SERVER_NAME, JSON.stringify({ type: 'stdio', ...entry }), '-s', 'user']);
  if (r.status !== 0) throw new Error(`claude mcp add-json failed: ${(r.stderr || r.stdout || '').trim()}`);
}

// ---- Verification ----------------------------------------------------------

// Launches the server the way the app will and asks for its tools. The env
// is the entry's own plus the basics, NOT this terminal's PATH, so a config
// that only works from a shell fails here too. Identifies as scorly-cli so
// the extension doesn't count the check as an agent having connected.
function verifyEntry(entry, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    const base = { HOME: os.homedir(), USER: os.userInfo().username, TMPDIR: os.tmpdir(), PATH: '/usr/bin:/bin' };
    if (process.platform === 'win32') Object.assign(base, process.env);
    let proc;
    try {
      proc = spawn(entry.command, entry.args || [], { env: { ...base, ...(entry.env || {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ ok: false, error: e.message });
      return;
    }
    let out = '';
    let err = '';
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { proc.kill(); } catch (e) { /* gone */ }
      // npm's update banner and log-file pointer bury the actual error.
      const lines = err.trim().split('\n').filter((l) => l.trim() && !/^npm notice|A complete log of this run/.test(l));
      resolve({ ...result, stderr: lines.slice(-6).join('\n') });
    };
    const timer = setTimeout(() => finish({ ok: false, error: `no answer within ${Math.round(timeoutMs / 1000)}s` }), timeoutMs);
    const send = (msg) => { try { proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n'); } catch (e) { /* closed */ } };

    proc.on('error', (e) => finish({ ok: false, error: e.code === 'ENOENT' ? `command not found: ${entry.command}` : e.message }));
    proc.on('exit', (code) => finish({ ok: false, error: `the server exited (code ${code}) before answering` }));
    proc.stderr.on('data', (d) => { err += d; });
    proc.stdout.on('data', (d) => {
      out += d;
      let i;
      while ((i = out.indexOf('\n')) >= 0) {
        let msg;
        try { msg = JSON.parse(out.slice(0, i)); } catch (e) { msg = null; }
        out = out.slice(i + 1);
        if (!msg) continue;
        if (msg.id === 1) {
          send({ method: 'notifications/initialized' });
          send({ id: 2, method: 'tools/list' });
        } else if (msg.id === 2) {
          const tools = ((msg.result && msg.result.tools) || []).map((t) => t.name);
          const missing = EXPECTED_TOOLS.filter((t) => !tools.includes(t));
          finish(missing.length
            ? { ok: false, error: `the server is missing ${missing.join(', ')}` }
            : { ok: true, tools, version: msg.version });
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'scorly-cli' }, capabilities: {} } });
  });
}

function reportFailure(result, entry, app) {
  bad(`…but the server failed to start: ${result.error}.`);
  if (result.stderr) result.stderr.split('\n').forEach((l) => info('│ ' + l));
  if ((entry.args || []).includes(PACKAGE) && /could not determine executable|404|not found/i.test(result.stderr + result.error)) {
    info(`The GitHub copy of Scorly (${PACKAGE}) doesn't include the agent tool yet.`);
  }
  info(`The entry was left in place so you can see it; run \`scorly uninstall ${app}\` to remove it.`);
}

// ---- Commands --------------------------------------------------------------

function targetOrThrow(app, verb) {
  const target = TARGETS[app];
  if (!target) {
    throw new Error(`Usage: scorly ${verb} <${Object.keys(TARGETS).join('|')}${verb === 'uninstall' ? '|all' : ''}>` +
      (verb === 'install' ? ' [--local]' : ''));
  }
  return target;
}

async function install(app, { local = false } = {}) {
  const target = targetOrThrow(app, 'install');
  const existed = !!readEntry(target);
  const entry = mcpEntry({ local, stdioType: target.stdioType });
  setEntry(target, entry);

  if (!readEntry(target)) {
    bad(`Couldn't add Scorly to ${target.name}: the entry isn't in ${target.file} after writing it.`);
    return false;
  }
  ok(`${existed ? 'Updated' : 'Added'} Scorly in ${target.name} (${target.file})${local ? ', running this checkout' : ''}.`);
  if (target.kind === 'json' && fs.existsSync(target.file + '.scorly-backup')) info(`Previous config saved as ${path.basename(target.file)}.scorly-backup`);

  info(local ? 'Checking it starts…' : 'Checking it starts (the first run downloads Scorly, which can take a minute)…');
  const result = await verifyEntry(entry);
  if (!result.ok) {
    reportFailure(result, entry, app);
    return false;
  }
  ok(`Verified: the Scorly MCP server starts and offers ${result.tools.filter((t) => t.startsWith('scorly_')).join(', ')}.`);
  info(`Next: ${target.after}`);
  info('Then paste the "Test it" prompt from Scorly\'s AI agents settings into a new session.');
  return true;
}

async function uninstall(app) {
  if (app === 'all') {
    let all = true;
    for (const key of Object.keys(TARGETS)) {
      if (TARGETS[key].kind === 'claude-cli' || readEntry(TARGETS[key])) all = (await uninstall(key)) && all;
    }
    return all;
  }
  const target = targetOrThrow(app, 'uninstall');
  let had;
  try { had = !!readEntry(target); } catch (e) { bad(e.message); return false; }
  if (!had) {
    ok(`Scorly isn't installed in ${target.name}. Nothing to remove.`);
    return true;
  }
  setEntry(target, null);
  if (readEntry(target)) {
    bad(`Scorly is still in ${target.file} after removing it. Remove the "${SERVER_NAME}" entry by hand.`);
    return false;
  }
  ok(`Removed Scorly from ${target.name}. Verified: no "${SERVER_NAME}" entry left in ${target.file}.`);
  info(`Next: ${target.afterRemove}`);
  return true;
}

// One line per app: configured or not, and whether the configured server
// actually starts. Used by `scorly status`.
async function checkAll() {
  const lines = [];
  for (const target of Object.values(TARGETS)) {
    let entry = null;
    try { entry = readEntry(target); } catch (e) { lines.push(`✘ ${target.name}: ${e.message}`); continue; }
    if (!entry) {
      lines.push(`· ${target.name}: not installed`);
      continue;
    }
    const result = await verifyEntry(entry, { timeoutMs: 60000 });
    lines.push(result.ok
      ? `✔ ${target.name}: installed, server starts`
      : `✘ ${target.name}: installed, but the server fails to start (${result.error}). Run \`scorly install ${Object.keys(TARGETS).find((k) => TARGETS[k] === target)}\` again.`);
  }
  return lines;
}

module.exports = { install, uninstall, checkAll, verifyEntry, TARGETS };
