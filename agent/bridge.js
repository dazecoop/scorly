// Local bridge between AI-agent processes and the Scorly extension.
//
// One process on the machine owns ws://127.0.0.1:<port> (the "hub"). The
// extension's background worker connects to it when the user has turned on
// "Let AI agents use Scorly"; every other agent process (a second MCP
// session, a one-off CLI run) connects as a peer and has its audits relayed
// through the hub. If the hub exits, a peer takes its place.
//
// Only two kinds of client are accepted:
//   - the extension, whose Origin is chrome-extension:// or moz-extension://
//   - local processes, which send no Origin at all
// A web page always sends its own http(s) Origin, so no site the user visits
// can talk to the bridge or pose as the extension.
//
// Messages are JSON:
//   extension → hub   {type:'hello', role:'extension', version, browser, localhostOnly}
//   agent → hub       {type:'hello', role:'agent', client}
//   hub → extension   {type:'agents', clients} · {type:'audit', id, url} · {type:'ping'}
//   extension → hub   {type:'result', id, data, origin} · {type:'error', id, message} · {type:'pong'}
//   agent ⇄ hub       {type:'audit', id, url} → {type:'result'|'error', id, …}
//                     {type:'status', id} → {type:'status', id, extension, agents}

const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const DEFAULT_PORT = 47615;
const AUDIT_TIMEOUT_MS = 90000;
const STATE_FILE = path.join(os.homedir(), '.scorly', 'bridge.json');

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return {}; }
}

function writeState(patch) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...readState(), ...patch }, null, 2));
  } catch (e) { /* best effort only */ }
}

let nextId = 1;
const newId = () => 'r' + (nextId++) + '-' + process.pid;

class Bridge {
  constructor({ port = DEFAULT_PORT, client = 'scorly-cli' } = {}) {
    this.port = port;
    this.client = client;
    this.mode = 'none';          // 'hub' | 'peer' | 'none'
    this.server = null;
    this.extension = null;       // hub: { ws, info }
    this.agents = new Map();     // hub: ws → client name
    this.upstream = null;        // peer: ws to the hub
    this.pending = new Map();    // id → { resolve, reject, timer }
    this.extensionWaiters = [];
    this.closed = false;
  }

  // Becomes the hub if the port is free, otherwise a peer of the existing one.
  async start() {
    if (this.closed) return;
    try {
      await this.listen();
      this.mode = 'hub';
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
      await this.connectPeer();
      this.mode = 'peer';
    }
  }

  listen() {
    return new Promise((resolve, reject) => {
      const server = new WebSocketServer({
        host: '127.0.0.1',
        port: this.port,
        verifyClient: ({ origin }) => !origin || /^(chrome|moz)-extension:\/\//.test(origin),
      });
      server.once('error', reject);
      server.once('listening', () => {
        server.off('error', reject);
        server.on('error', () => { /* keep serving */ });
        this.server = server;
        server.on('connection', (ws, req) => this.onHubConnection(ws, req));
        this.pingTimer = setInterval(() => this.send(this.extension && this.extension.ws, { type: 'ping' }), 20000);
        resolve();
      });
    });
  }

  onHubConnection(ws, req) {
    const fromExtension = !!req.headers.origin;
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch (e) { return; }
      if (fromExtension) this.onExtensionMessage(ws, msg);
      else this.onAgentMessage(ws, msg);
    });
    ws.on('close', () => {
      if (this.extension && this.extension.ws === ws) {
        this.extension = null;
        this.failPending('The Scorly extension disconnected.', (p) => !p.peer);
      }
      if (this.agents.delete(ws)) this.broadcastAgents();
    });
    ws.on('error', () => { /* close follows */ });
  }

  onExtensionMessage(ws, msg) {
    if (msg.type === 'hello' && msg.role === 'extension') {
      if (this.extension && this.extension.ws !== ws) {
        try { this.extension.ws.close(4000, 'Another browser connected'); } catch (e) { /* ignore */ }
      }
      this.extension = { ws, info: { version: msg.version, browser: msg.browser, localhostOnly: !!msg.localhostOnly } };
      writeState({ extensionLastSeen: new Date().toISOString() });
      this.broadcastAgents();
      this.extensionWaiters.splice(0).forEach((fn) => fn());
      return;
    }
    if (msg.type === 'result' || msg.type === 'error') this.settle(msg);
  }

  onAgentMessage(ws, msg) {
    if (msg.type === 'hello') {
      this.agents.set(ws, String(msg.client || 'agent').slice(0, 60));
      this.broadcastAgents();
    } else if (msg.type === 'status') {
      this.send(ws, { type: 'status', id: msg.id, ...this.localStatus() });
    } else if (msg.type === 'audit') {
      this.auditViaExtension(msg.url, { peer: true })
        .then((r) => this.send(ws, { type: 'result', id: msg.id, ...r }))
        .catch((err) => this.send(ws, { type: 'error', id: msg.id, message: err.message }));
    }
  }

  broadcastAgents() {
    const clients = [this.client].concat(Array.from(this.agents.values()));
    this.send(this.extension && this.extension.ws, { type: 'agents', clients });
  }

  connectPeer() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
      ws.once('open', () => {
        this.upstream = ws;
        this.send(ws, { type: 'hello', role: 'agent', client: this.client });
        resolve();
      });
      ws.once('error', reject);
      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch (e) { return; }
        this.settle(msg);
      });
      ws.on('close', () => {
        if (this.upstream !== ws) return;
        this.upstream = null;
        this.mode = 'none';
        this.failPending('Lost the connection to the Scorly bridge.');
        // The hub went away: take over (or rejoin whoever did).
        if (!this.closed) setTimeout(() => this.start().catch(() => {}), 500 + Math.random() * 500);
      });
    });
  }

  send(ws, msg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  request(ws, msg, { timeoutMs = AUDIT_TIMEOUT_MS, peer = false } = {}) {
    const id = newId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Timed out waiting for the Scorly extension.'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, peer });
      this.send(ws, { ...msg, id });
    });
  }

  settle(msg) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.type === 'error') p.reject(new Error(msg.message || 'Audit failed in the extension.'));
    else p.resolve(msg);
  }

  failPending(message, filter = () => true) {
    for (const [id, p] of this.pending) {
      if (!filter(p)) continue;
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.reject(new Error(message));
    }
  }

  localStatus() {
    return {
      extension: this.extension ? this.extension.info : null,
      agents: [this.client].concat(Array.from(this.agents.values())),
    };
  }

  async status() {
    if (this.mode === 'hub') return { mode: 'hub', port: this.port, ...this.localStatus() };
    if (this.mode === 'peer') {
      const r = await this.request(this.upstream, { type: 'status' }, { timeoutMs: 3000 });
      return { mode: 'peer', port: this.port, extension: r.extension, agents: r.agents };
    }
    return { mode: 'none', port: this.port, extension: null, agents: [] };
  }

  async extensionConnected() {
    try { return !!(await this.status()).extension; } catch (e) { return false; }
  }

  // Resolves true once the extension is connected, false after `ms`. The
  // extension retries every ~30s while waiting, so a fresh hub may need that
  // long before the first connection lands.
  async waitForExtension(ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await this.extensionConnected()) return true;
      if (this.mode === 'hub') {
        await new Promise((resolve) => {
          const t = setTimeout(resolve, Math.max(0, deadline - Date.now()));
          this.extensionWaiters.push(() => { clearTimeout(t); resolve(); });
        });
      } else {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    return this.extensionConnected();
  }

  // Resolves { data, origin } with the raw analyzer result from the browser.
  async auditViaExtension(url, { peer = false } = {}) {
    if (this.mode === 'peer') {
      const r = await this.request(this.upstream, { type: 'audit', url });
      return { data: r.data, origin: r.origin };
    }
    if (!this.extension) throw new Error('The Scorly extension is not connected.');
    const r = await this.request(this.extension.ws, { type: 'audit', url }, { peer });
    return { data: r.data, origin: r.origin };
  }

  async close() {
    this.closed = true;
    clearInterval(this.pingTimer);
    this.failPending('Bridge closed.');
    if (this.upstream) { try { this.upstream.close(); } catch (e) { /* ignore */ } }
    if (this.server) {
      for (const ws of this.server.clients) { try { ws.terminate(); } catch (e) { /* ignore */ } }
      await new Promise((r) => this.server.close(() => r()));
    }
  }
}

// Was the extension seen recently enough that waiting for it is worthwhile?
function extensionRecentlySeen(days = 14) {
  const seen = Date.parse(readState().extensionLastSeen || '');
  return Number.isFinite(seen) && Date.now() - seen < days * 86400000;
}

module.exports = { Bridge, DEFAULT_PORT, extensionRecentlySeen };
