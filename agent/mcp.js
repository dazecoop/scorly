// Scorly MCP server (stdio). Gives an AI agent three tools:
//   scorly_audit    audit a URL (live site or localhost) and get the issues
//   scorly_compare  diff two audits from this session
//   scorly_status   which engine audits will run on
//
// MCP over stdio is newline-delimited JSON-RPC 2.0. The handful of methods a
// tools-only server needs are implemented directly, which keeps the install
// to two small dependencies. stdout carries protocol only; logs go to stderr.

const readline = require('readline');
const { Bridge, DEFAULT_PORT } = require('./bridge');
const { runAudit, bridgeStatus, ENGINE_LABEL } = require('./run');
const engine = require('./engine');

const VERSION = require('../package.json').version;
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_AUDITS = 50;

const INSTRUCTIONS = [
  'Scorly audits a web page for SEO, content, performance, structured data, security, mobile, accessibility, AI visibility and E-E-A-T, all locally.',
  'Typical loop: scorly_audit the URL (a dev server on localhost works) → fix the issues in the codebase, most severe first → scorly_audit the same URL again.',
  'A re-audit of a URL already audited in this session ends with a "Change since previous audit" section; use scorly_compare for the full field-by-field diff.',
  'Report the before/after overall score and what you changed. Some checks (HTTP/2, security headers, analytics) depend on hosting and cannot be fixed on localhost: say so rather than faking them.',
].join(' ');

const TOOLS = [
  {
    name: 'scorly_audit',
    description: 'Audit a web page with Scorly and return its score, every failing check and every warning (with the reason). Works on live sites and local dev servers (http://localhost:3000 etc.). Runs in the user\'s browser through the Scorly extension when it is connected, otherwise in headless Chrome. Returns an audit id for scorly_compare.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL of the page to audit.' },
        detail: {
          type: 'string', enum: ['summary', 'full', 'json'], default: 'summary',
          description: 'summary: scores + issues + warnings (best for fixing). full: the complete Markdown report (every section, link and image). json: the raw export payload.',
        },
        via: {
          type: 'string', enum: ['auto', 'browser', 'headless'], default: 'auto',
          description: 'auto: the extension if connected, else headless. browser: require the extension (uses the user\'s logins). headless: never use the browser.',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'scorly_compare',
    description: 'Compare two Scorly audits from this session (e.g. before and after your fixes, or localhost against production) and return a Markdown diff of scores, check verdicts and page content.',
    inputSchema: {
      type: 'object',
      properties: {
        before: { type: 'string', description: 'Audit id of the earlier / reference audit.' },
        after: { type: 'string', description: 'Audit id of the later / changed audit.' },
      },
      required: ['before', 'after'],
    },
  },
  {
    name: 'scorly_status',
    description: 'Show whether Scorly audits will run in the user\'s browser (extension connected) or in headless Chrome, and list this session\'s audits.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const audits = new Map(); // id → audit, oldest first
let bridge = null;

function log(...args) { console.error('[scorly-mcp]', ...args); }

function remember(audit) {
  audits.set(audit.id, audit);
  while (audits.size > MAX_AUDITS) audits.delete(audits.keys().next().value);
}

function previousAuditOf(url, exceptId) {
  let prev = null;
  for (const a of audits.values()) if (a.url === url && a.id !== exceptId) prev = a;
  return prev;
}

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const toolError = (t) => ({ content: [{ type: 'text', text: t }], isError: true });

async function callTool(name, args = {}) {
  if (name === 'scorly_audit') {
    const { audit, engine: used, note } = await runAudit(String(args.url || ''), { bridge, via: args.via || 'auto', log });
    const prev = previousAuditOf(audit.url, audit.id);
    remember(audit);
    const detail = args.detail || 'summary';
    if (detail === 'json') return text(JSON.stringify(engine.jsonReport(audit), null, 1));
    const parts = [detail === 'full'
      ? `Audit id: \`${audit.id}\` · via ${ENGINE_LABEL[used]}\n\n` + engine.fullMarkdown(audit)
      : engine.summaryMarkdown(audit, { engine: ENGINE_LABEL[used] })];
    if (note) parts.push('_' + note + '_');
    if (prev) parts.push(engine.deltaMarkdown(prev, audit));
    return text(parts.join('\n\n'));
  }

  if (name === 'scorly_compare') {
    const a = audits.get(args.before);
    const b = audits.get(args.after);
    if (!a || !b) {
      const known = Array.from(audits.values()).map((x) => `${x.id} (${x.url})`).join(', ') || 'none yet';
      return toolError(`Unknown audit id. Audits in this session: ${known}`);
    }
    return text(engine.diffMarkdown(a, b));
  }

  if (name === 'scorly_status') {
    const s = await bridgeStatus(bridge);
    // First line is fixed so the settings page's "Test it" step can tell the
    // user exactly what a working setup replies.
    const lines = [`Scorly MCP is working (v${VERSION}).`];
    lines.push(s.extension
      ? `Audits run in the user's browser via the Scorly extension (v${s.extension.version || '?'}, ${s.extension.browser || 'browser'})` +
        (s.extension.localhostOnly ? ' — restricted to localhost URLs; other URLs fall back to headless Chrome.' : '.')
      : 'The Scorly extension is not connected — audits run in headless Chrome. (The user can turn on "Let AI agents use Scorly" in the extension.)');
    lines.push(`Bridge: ws://127.0.0.1:${s.port || DEFAULT_PORT} (${s.mode === 'hub' ? 'hosted by this session' : s.mode === 'peer' ? 'shared with another session' : 'not running'}` +
      `${s.mode !== 'none' ? '; opens on demand and closes after 10 idle minutes' : ''})`);
    if (audits.size) {
      lines.push('', 'Audits this session:');
      for (const a of audits.values()) lines.push(`- \`${a.id}\` ${a.url} — ${engine.scoreAudit(a).overallScore}/100 (${a.capturedAt})`);
    }
    return text(lines.join('\n'));
  }

  return toolError(`Unknown tool: ${name}`);
}

async function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize': {
      const client = (params && params.clientInfo && params.clientInfo.name) || 'mcp-client';
      if (!bridge) {
        // Not opened here: the bridge opens on the first audit that needs the
        // browser and closes itself after 10 idle minutes.
        bridge = new Bridge({ port: Number(process.env.SCORLY_PORT) || DEFAULT_PORT, client });
      }
      const requested = params && params.protocolVersion;
      return {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'scorly', version: VERSION },
        instructions: INSTRUCTIONS,
      };
    }
    case 'ping': return {};
    case 'tools/list': return { tools: TOOLS };
    case 'tools/call':
      try {
        return await callTool(params.name, params.arguments);
      } catch (err) {
        return toolError(err.message);
      }
    default:
      if (id === undefined) return undefined; // notification
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }
}

function write(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

function serve() {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch (e) {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    if (msg.id === undefined) { handle(msg).catch(() => {}); return; }
    try {
      const result = await handle(msg);
      write({ jsonrpc: '2.0', id: msg.id, result });
    } catch (err) {
      write({ jsonrpc: '2.0', id: msg.id, error: { code: err.code || -32603, message: err.message } });
    }
  });

  const shutdown = async () => {
    await Promise.allSettled([bridge && bridge.close(), engine.closeHeadless()]);
    process.exit(0);
  };
  rl.on('close', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { serve };
