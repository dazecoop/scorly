#!/usr/bin/env node
// Scorly command line: audit pages, diff audits, or run the MCP server.
//
//   scorly audit <url> [--detail summary|full|json] [--via auto|browser|headless]
//                      [--save audit.json] [--compare earlier.json]
//   scorly compare <before.json> <after.json>
//   scorly status
//   scorly mcp
//   scorly install [app] [--local]  ·  scorly uninstall [app]

const fs = require('fs');
const { Bridge, DEFAULT_PORT } = require('./bridge');
const { runAudit, ENGINE_LABEL } = require('./run');
const engine = require('./engine');
const installer = require('./install');
const term = require('./terminal');

const HELP = `Scorly — local SEO / content / performance audits for AI agents and scripts.

Usage:
  scorly audit <url> [options]     Audit a page (live site or http://localhost:…)
    --detail summary|full|json     summary (default): scores, issues, warnings
    --via auto|browser|headless    auto (default): your browser via the extension
                                   if connected, otherwise headless Chrome
    --save <file.json>             Keep the audit to compare against later
    --compare <file.json>          Show what changed since a saved audit
    --markdown                     Plain Markdown even in a terminal (piped output
                                   is always Markdown; NO_COLOR also turns colour off)
  scorly compare <before.json> <after.json>
  scorly status                    Which agent apps have Scorly, and is the extension connected?
  scorly mcp                       Run as an MCP server over stdio

  scorly install [app] [--local]   Add Scorly to every agent app on this computer
                                   (or one: claude-code, claude-desktop, cursor,
                                   vscode, or claude for both Claude apps)
                                   and check it starts
  scorly uninstall [app]           Remove it again (everywhere by default) and check it is gone
      --local: run this checkout instead of the GitHub copy

Environment:
  SCORLY_PORT    bridge port (default ${DEFAULT_PORT}; match it in the extension)
  SCORLY_CHROME  Chrome/Chromium binary for headless audits
`;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      out[k] = v !== undefined ? v : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true);
    } else out._.push(a);
  }
  return out;
}

function loadAudit(file) {
  const audit = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!audit || !audit.data || !audit.url) throw new Error(`${file} is not a saved Scorly audit.`);
  return audit;
}

function makeBridge() {
  return new Bridge({ port: Number(process.env.SCORLY_PORT) || DEFAULT_PORT, client: 'scorly-cli' });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];

  if (cmd === 'mcp') {
    require('./mcp').serve();
    return; // stays running
  }

  if (cmd === 'audit') {
    const url = args._[1];
    if (!url) throw new Error('Usage: scorly audit <url>');
    const bridge = makeBridge();
    const log = (m) => console.error(m);
    try {
      const progress = term.terminalProgress(process.stderr);
      const { audit, engine: used, note } = await runAudit(url, { bridge, via: args.via || 'auto', log, progress });
      const detail = args.detail || 'summary';
      const pretty = !args.markdown && term.useColor();
      if (detail === 'json') console.log(JSON.stringify(engine.jsonReport(audit), null, 2));
      else if (detail === 'full') console.log(pretty ? term.renderMarkdown(engine.fullMarkdown(audit)) : engine.fullMarkdown(audit));
      else if (pretty) process.stdout.write(term.renderSummary(engine.summaryModel(audit), { engine: ENGINE_LABEL[used] }));
      else console.log(engine.summaryMarkdown(audit, { engine: ENGINE_LABEL[used] }));
      if (note) console.error(note);
      if (args.compare) {
        const before = loadAudit(args.compare);
        if (pretty) process.stdout.write(term.renderDelta(engine.deltaModel(before, audit), { beforeLabel: args.compare }));
        else console.log('\n' + engine.deltaMarkdown(before, audit));
      }
      if (args.save) {
        fs.writeFileSync(args.save, JSON.stringify(audit));
        console.error(`Saved audit to ${args.save}`);
      }
    } finally {
      await Promise.allSettled([bridge.close(), engine.closeHeadless()]);
    }
    return;
  }

  if (cmd === 'install' || cmd === 'uninstall') {
    const done = cmd === 'install'
      ? await installer.install(args._[1], { local: !!args.local })
      : await installer.uninstall(args._[1]);
    if (!done) process.exitCode = 1;
    return;
  }

  if (cmd === 'compare') {
    const [, before, after] = args._;
    if (!before || !after) throw new Error('Usage: scorly compare <before.json> <after.json>');
    const a = loadAudit(before);
    const b = loadAudit(after);
    const md = engine.diffMarkdown(a, b);
    if (!args.markdown && term.useColor()) process.stdout.write(term.renderCompare(engine.diffAudits(a, b), md));
    else console.log(md);
    return;
  }

  if (cmd === 'status') {
    console.log('Agent apps:');
    (await installer.checkAll()).forEach((l) => console.log('  ' + l));
    console.log('');
    const bridge = makeBridge();
    try {
      await bridge.use();
      // A bridge this command just opened only hears from the extension on
      // its next retry, so give it one retry interval.
      if (bridge.mode === 'hub' && !(await bridge.extensionConnected())) {
        const ms = Number(args.wait) || 35000;
        const waited = term.terminalProgress(process.stderr).waiting(ms);
        waited(await bridge.waitForExtension(ms));
      }
      const s = await bridge.status();
      if (s.extension) {
        console.log(`Extension connected: Scorly ${s.extension.version || ''} in ${s.extension.browser || 'your browser'}` +
          (s.extension.localhostOnly ? ' (localhost URLs only)' : ''));
      } else {
        console.log('Extension not connected — audits will use headless Chrome.');
        console.log('Turn on "Let AI agents use Scorly" in the extension (Agent settings) to use your browser.');
      }
      console.log(`Bridge port ${s.port}; agents: ${s.agents.join(', ')}`);
    } finally {
      await bridge.close();
    }
    return;
  }

  process.stdout.write(HELP);
  if (cmd && cmd !== 'help' && cmd !== '--help') process.exitCode = 1;
}

main().then(() => {
  if (process.argv[2] !== 'mcp') process.exit(process.exitCode || 0);
}).catch((err) => {
  console.error('scorly: ' + err.message);
  process.exit(1);
});
