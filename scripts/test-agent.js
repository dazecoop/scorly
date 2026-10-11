#!/usr/bin/env node
/**
 * End-to-end check of the AI-agent bridge, driving a real unpacked build in
 * Chrome: turn the agent switch on in the settings page, start a bridge the
 * way the MCP server does, and run audits through the extension.
 *
 * Usage:
 *   npm run build:chrome && node scripts/test-agent.js
 *
 * Writes a settings-page screenshot to scripts/output/agent-settings.png.
 */
const path = require('path');
const fs = require('fs');
// Keep the bridge's state file (extension last seen / switched off) away
// from the real ~/.scorly, for this process and the MCP servers it spawns.
process.env.SCORLY_STATE_DIR = path.join(__dirname, 'output', 'agent-state');
const puppeteer = require('puppeteer');
const { serveDemoPage } = require('./lib/serve-demo-page');
const { findExtensionId } = require('./lib/extension-id');
const { Bridge } = require('../agent/bridge');
const { runAudit } = require('../agent/run');
const engine = require('../agent/engine');

const ROOT = path.join(__dirname, '..');
const EXT_PATH = path.join(ROOT, 'dist', 'chrome');
const OUT_DIR = path.join(__dirname, 'output');
const PORT = 47690; // not the default, so a real agent session doesn't interfere

const failures = [];
function check(name, condition, detail) {
  if (condition) console.log(`  ok   ${name}`);
  else {
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
    failures.push(name);
  }
}

const statusText = (page) => page.evaluate(() => ({
  state: document.getElementById('statusBox').dataset.state,
  title: document.getElementById('statusTitle').textContent,
  sub: document.getElementById('statusSub').textContent,
  snippet: document.getElementById('snippet').textContent,
  detected: !document.getElementById('setupDetected').classList.contains('hidden'),
  detectedTitle: document.getElementById('detectedTitle').textContent,
  setupOpen: document.getElementById('setupFold').open,
  steps: Array.from(document.querySelectorAll('[data-step]')).filter((e) => e.offsetParent).map((e) => e.textContent).join(','),
  prompt: document.getElementById('promptExample').textContent,
}));

async function typeInto(page, selector, value) {
  await page.$eval(selector, (el) => { el.value = ''; });
  await page.type(selector, value);
}

// Runs the MCP server the way an agent app does and calls scorly_status.
function mcpStatus(port) {
  const { spawn } = require('child_process');
  const proc = spawn(process.execPath, [path.join(ROOT, 'agent', 'cli.js'), 'mcp'], { env: { ...process.env, SCORLY_PORT: String(port) } });
  const send = (msg) => proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => { proc.kill(); reject(new Error('MCP server did not answer')); }, 15000);
    proc.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (msg.id === 1) {
          send({ method: 'notifications/initialized' });
          // Give the new peer a moment to join the bridge before asking.
          setTimeout(() => send({ id: 2, method: 'tools/call', params: { name: 'scorly_status', arguments: {} } }), 800);
        } else if (msg.id === 2) {
          clearTimeout(timer);
          proc.stdin.end();
          resolve(msg.result.content[0].text);
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'status-test' }, capabilities: {} } });
  });
}

async function waitFor(fn, ms, label) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Timed out: ' + label);
}

async function main() {
  if (!fs.existsSync(EXT_PATH)) {
    console.error(`Missing ${EXT_PATH} — run \`npm run build:chrome\` first.`);
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const server = await serveDemoPage();
  const url = `http://127.0.0.1:${server.address().port}/`;

  const browser = await puppeteer.launch({
    headless: false,
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--window-size=1200,1000'],
  });
  let bridge = null;

  try {
    const extId = await findExtensionId(browser);
    const settings = await browser.newPage();
    await settings.setViewport({ width: 1000, height: 1400 });
    await settings.goto(`chrome-extension://${extId}/settings/agent.html?url=${encodeURIComponent(url)}`, { waitUntil: 'load' });

    console.log('\n[1] settings page, switch off');
    let s = await statusText(settings);
    check('starts off', s.state === 'off', s.state);
    check('setup not detected yet, instructions open', !s.detected && s.setupOpen, JSON.stringify(s));
    check('three numbered steps', s.steps === '1,2,3', s.steps);
    check('install-everywhere command shown', s.snippet === 'npx -y github:dazecoop/scorly install', s.snippet);
    const activeTabs = await settings.evaluate(() => ({
      setup: Array.from(document.querySelectorAll('#clientTabs .ag-tab.active')).map((t) => t.dataset.client),
      use: Array.from(document.querySelectorAll('#useTabs .ag-tab.active')).map((t) => t.dataset.use),
    }));
    check('on load, "Ask your agent" and "All agent apps" are the highlighted tabs',
      activeTabs.use.join() === 'agent' && activeTabs.setup.join() === 'all', JSON.stringify(activeTabs));
    check('page URL from the popup prefilled into the prompt', s.prompt.includes(`Audit ${url}.`) && s.prompt.includes('search your tools for "scorly"') && s.prompt.includes('stop and tell me'), s.prompt);

    console.log('\n[1b] prompt builder');
    await typeInto(settings, '#auditUrl', 'localhost:5173/pricing');
    await typeInto(settings, '#compareUrl', 'example.com/pricing');
    s = await statusText(settings);
    check('URLs normalised into the compare prompt',
      s.prompt.includes('Audit http://localhost:5173/pricing and https://example.com/pricing and compare them') &&
      s.prompt.includes('still differs from https://example.com/pricing'), s.prompt);
    await typeInto(settings, '#compareUrl', ' ');
    s = await statusText(settings);
    check('clearing the comparison falls back to the single-page prompt', !s.prompt.includes('compare them') && s.prompt.includes('http://localhost:5173/pricing'), s.prompt);

    console.log('\n[1c] project folder + fix toggle');
    await typeInto(settings, '#codebasePath', '"/Users/me/Sites/tck-plastering/"');
    s = await statusText(settings);
    check('folder path (quotes, trailing slash stripped) goes in the prompt',
      s.prompt.includes('Fix the issues you can in the codebase at /Users/me/Sites/tck-plastering, most severe first'), s.prompt);
    await typeInto(settings, '#codebasePath', 'tck-plastering');
    s = await statusText(settings);
    check('a folder name alone is described as a name', s.prompt.includes('in the project folder named "tck-plastering"'), s.prompt);
    const nameHint = await settings.$eval('#codebaseSub', (el) => el.textContent);
    check('name-only hint explains how to copy the full path', /Only the folder name is known/.test(nameHint) && /⌥⌘C|Copy as path|pwd/.test(nameHint), nameHint);
    check('Choose… button available in Chrome', await settings.$eval('#chooseFolderBtn', (el) => !el.classList.contains('hidden')));

    await settings.click('.ag-fix-row');
    s = await statusText(settings);
    const folderHidden = await settings.$eval('#codebaseField', (el) => el.classList.contains('hidden'));
    check('fix off hides the project folder', folderHidden);
    check('fix off: audit-and-report prompt only',
      !s.prompt.includes('Fix the issues') && s.prompt.includes("Don't change any files") && s.prompt.includes('Audit http://localhost:5173/pricing and report back'), s.prompt);
    await typeInto(settings, '#compareUrl', 'example.com');
    s = await statusText(settings);
    check('fix off + compare: compares and reports, no fixing',
      s.prompt.includes('Audit http://localhost:5173/pricing and https://example.com and compare them. Report back both scores') && !s.prompt.includes('Fix the issues'), s.prompt);
    await settings.evaluate(() => window.scrollTo(0, 0));
    await new Promise((r) => setTimeout(r, 300)); // let the switch animation finish
    await settings.screenshot({ path: path.join(OUT_DIR, 'agent-settings-audit-only.png'), fullPage: true });
    await typeInto(settings, '#compareUrl', ' ');
    await settings.click('.ag-fix-row');
    s = await statusText(settings);
    check('fix back on restores the folder and fix prompt', s.prompt.includes('Fix the issues you can in the project folder named "tck-plastering"'), s.prompt);


    console.log('\n[1d] How to use: CLI instead of the agent');
    check('setup has no terminal tab any more', await settings.evaluate(() => !document.querySelector('[data-client="cli"]')));
    await settings.evaluate(() => document.querySelector('#useTabs [data-use="cli"]').click());
    const cli = await settings.evaluate(() => ({
      agentHidden: document.getElementById('useAgent').classList.contains('hidden'),
      snippet: document.getElementById('cliSnippet').textContent,
      label: document.getElementById('auditLabel').textContent,
    }));
    check('CLI view replaces the agent prompt', cli.agentHidden, JSON.stringify(cli));
    check('CLI commands use the page URL',
      cli.snippet.includes('audit http://localhost:5173/pricing --save before.json') &&
      cli.snippet.includes('audit http://localhost:5173/pricing --compare before.json'), cli.snippet);
    check('CLI mode labels the field "Page to audit"', cli.label === 'Page to audit', cli.label);
    await typeInto(settings, '#compareUrl', 'example.com');
    const cliCmp = await settings.$eval('#cliSnippet', (el) => el.textContent);
    check('with Compare with: audits both and runs compare',
      cliCmp.includes('audit https://example.com --save compare-with.json') && cliCmp.includes('compare compare-with.json page.json'), cliCmp);
    await settings.evaluate(() => window.scrollTo(0, 0));
    await settings.screenshot({ path: path.join(OUT_DIR, 'agent-settings-cli.png'), fullPage: true });
    await typeInto(settings, '#compareUrl', ' ');
    await settings.evaluate(() => document.querySelector('#useTabs [data-use="agent"]').click());
    check('back to the agent prompt', await settings.$eval('#useCli', (el) => el.classList.contains('hidden')));

    await settings.evaluate(() => window.scrollTo(0, 0));
    await new Promise((r) => setTimeout(r, 300)); // let the switch animation finish
    await settings.screenshot({ path: path.join(OUT_DIR, 'agent-settings-setup.png'), fullPage: true });

    console.log('\n[2] custom port + switch on, no agent yet');
    await settings.$eval('#portInput', (el, p) => { el.value = p; el.dispatchEvent(new Event('change')); }, PORT);
    await settings.evaluate(() => document.getElementById('enabledToggle').click());
    s = await waitFor(async () => { const x = await statusText(settings); return x.state === 'waiting' && x; }, 5000, 'waiting state');
    check('waiting for an agent', s.state === 'waiting', s.title);
    check('snippet carries the custom port', s.snippet.includes(`SCORLY_PORT=${PORT}`), s.snippet);

    console.log('\n[3] agent starts the bridge → extension connects');
    bridge = new Bridge({ port: PORT, client: 'test-agent' });
    await bridge.start();
    check('bridge is the hub', bridge.mode === 'hub', bridge.mode);
    // The retry button is the user-visible way to skip the 30s alarm.
    await settings.evaluate(() => document.getElementById('reconnectBtn').click());
    const connected = await bridge.waitForExtension(40000);
    check('extension connected to the bridge', connected);
    s = await waitFor(async () => { const x = await statusText(settings); return x.state === 'connected' && x.sub.includes('test-agent') && x; }, 5000, 'connected state').catch(() => statusText(settings));
    check('settings shows Connected with the agent name', s.sub.includes('test-agent'), s.sub);
    check('status re-renders keep "Ask your agent" highlighted',
      await settings.evaluate(() => document.querySelector('#useTabs [data-use="agent"]').classList.contains('active')));
    check('setup detected, instructions folded', s.detected && !s.setupOpen && s.detectedTitle.includes('test-agent'), JSON.stringify(s));
    check('setup step drops out of the numbering', s.steps === '1,2', s.steps);

    console.log('\n[3b] the "Test it" prompt: scorly_status over MCP');
    const statusReply = await mcpStatus(PORT);
    check('scorly_status says working + in your browser',
      statusReply.startsWith('Scorly MCP is working') && statusReply.includes("Audits run in the user's browser"), statusReply);

    console.log('\n[4] audit through the browser');
    const r1 = await runAudit(url, { bridge, via: 'browser' });
    const score1 = engine.scoreAudit(r1.audit);
    check('audit ran in the browser', r1.engine === 'browser' && r1.audit.origin === 'background', r1.engine);
    check('audit produced a score', typeof score1.overallScore === 'number', String(score1.overallScore));
    const md = engine.summaryMarkdown(r1.audit);
    check('summary lists issues/warnings', /## (Issues|Warnings)/.test(md));
    s = await waitFor(async () => {
      const t = await settings.$eval('#lastAudit', (el) => el.textContent);
      return t.includes('Last used') && t.includes(url) && t;
    }, 5000, 'last used line');
    check('settings shows when Scorly was last used, by which app, for which page',
      /Last used just now · test-agent audited/.test(s) && s.includes(url), s);

    console.log('\n[5] headless audit of the same page scores the same way');
    const r2 = await runAudit(url, { via: 'headless' });
    const score2 = engine.scoreAudit(r2.audit);
    const nonPerf = (sc) => Object.entries(sc.categoryScores).filter(([k]) => k !== 'perf').map(([k, v]) => `${k}:${v}`).join(' ');
    check('non-performance category scores match', nonPerf(score1) === nonPerf(score2), `${nonPerf(score1)} vs ${nonPerf(score2)}`);
    const diff = engine.diffMarkdown(r1.audit, r2.audit);
    check('diff renders', diff.startsWith('# Scorly comparison'));

    console.log('\n[6] a second agent process shares the bridge as a peer');
    const peer = new Bridge({ port: PORT, client: 'second-agent' });
    await peer.start();
    check('second bridge is a peer', peer.mode === 'peer', peer.mode);
    const r3 = await runAudit(url, { bridge: peer, via: 'browser' });
    check('peer audit relayed through the hub', r3.engine === 'browser' && !!r3.audit.data.title);
    s = await waitFor(async () => { const x = await statusText(settings); return x.sub.includes('second-agent') && x; }, 5000, 'peer listed');
    check('settings lists both agents', s.sub.includes('test-agent') && s.sub.includes('second-agent'), s.sub);
    await peer.close();

    console.log('\n[6b] Stop from the popup closes the bridge');
    const popup = await browser.newPage();
    await popup.setViewport({ width: 500, height: 600 });
    await popup.goto(`chrome-extension://${extId}/popup/popup.html`, { waitUntil: 'load' });
    const strip = await waitFor(() => popup.evaluate(() => {
      const el = document.getElementById('agentStrip');
      return !el.classList.contains('hidden') && document.getElementById('agentStripText').textContent;
    }), 5000, 'agent strip').catch(() => '');
    check('popup shows the agent strip while connected', strip.includes('test-agent'), strip);
    await popup.click('#agentStopBtn');
    const stopped = await waitFor(() => bridge.mode === 'none', 5000, 'bridge stop').catch(() => false);
    check('Stop closed the agent\'s bridge', stopped, bridge.mode);
    check('bridge knows it was stopped by the user', bridge.stopReason === 'stopped', bridge.stopReason);
    const hidden = await waitFor(() => popup.evaluate(() => document.getElementById('agentStrip').classList.contains('hidden')), 5000, 'strip hidden').catch(() => false);
    check('popup strip disappears', hidden);
    s = await statusText(settings);
    check('settings back to On · idle', s.state === 'waiting' && s.title.includes('idle'), s.title);
    await popup.close();

    // The agent's next audit reopens the bridge; Retry now skips the 30s alarm.
    await bridge.use();
    await settings.evaluate(() => document.getElementById('reconnectBtn').click());
    check('next use reopens the bridge and the extension reconnects', await bridge.waitForExtension(10000));

    console.log('\n[7] localhost-only restriction');
    await settings.evaluate(() => document.querySelectorAll('details.ag-fold-card').forEach((d) => { d.open = true; }));
    await settings.click('#localhostOnly');
    await new Promise((r) => setTimeout(r, 1200)); // reconnects with the new setting
    await bridge.waitForExtension(10000);
    let blocked = null;
    try { await bridge.auditViaExtension('https://example.com/'); } catch (e) { blocked = e.message; }
    check('non-localhost URL refused', /localhost/.test(blocked || ''), blocked);
    const r4 = await runAudit(url, { bridge, via: 'browser' });
    check('127.0.0.1 still allowed', r4.engine === 'browser');
    await settings.click('#localhostOnly');

    await settings.screenshot({ path: path.join(OUT_DIR, 'agent-settings.png'), fullPage: true });

    console.log('\n[8] switch off disconnects');
    await settings.evaluate(() => document.getElementById('enabledToggle').click());
    await waitFor(async () => !(await bridge.extensionConnected()), 5000, 'disconnect');
    s = await statusText(settings);
    check('extension disconnected and shows Off', s.state === 'off', s.state);
    check('setup stays detected after switching off', s.detected, JSON.stringify(s));
    const lastUsedOff = await settings.$eval('#lastAudit', (el) => !el.classList.contains('hidden') && el.textContent);
    check('"Last used" still shown with the switch off', /^Last used/.test(lastUsedOff || ''), lastUsedOff);
    console.log('\n[9] an unused bridge closes itself');
    const idle = new Bridge({ port: PORT + 1, client: 'idle-test', idleMs: 1200 });
    await idle.use();
    check('opened on use', idle.mode === 'hub', idle.mode);
    await new Promise((r) => setTimeout(r, 2000));
    check('closed after the idle time', idle.mode === 'none' && idle.stopReason === 'idle', `${idle.mode}/${idle.stopReason}`);
    await idle.close();
  } finally {
    if (bridge) await bridge.close();
    await engine.closeHeadless();
    await browser.close();
    server.close();
  }

  console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed');
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
