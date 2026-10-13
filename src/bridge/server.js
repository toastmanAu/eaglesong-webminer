#!/usr/bin/env node
/**
 * server.js — the WebSocket bridge: one browser WebSocket ↔ one private TCP
 * Stratum session on the solo proxy. Loopback by default; for public exposure
 * put it behind an HTTPS/WSS reverse proxy and keep the Origin allowlist strict.
 *
 *   node src/bridge/server.js [config.json]      (default ./config.json, env BRIDGE_CONFIG)
 */
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { loadConfig } from './config.js';
import { createSession, PROTOCOL_NAME, BRIDGE_VERSION } from './session.js';
import { fetchProxyStats } from './proxy-stats.js';
import { clientIpFromRequest, connectionCountForIp } from './client-ip.js';

/**
 * @param {ReturnType<import('./config.js').validateConfig>} config
 * @param {{logger?: Function}} [deps]
 */
export async function startBridgeServer(config, deps = {}) {
  const log = deps.logger ?? defaultLogger;
  const sessions = new Map(); // ws → session
  const startedAt = Date.now();
  let proxyStats = null;
  let statsRefreshing = false;
  async function refreshProxyStats() {
    if (config.stratum.statsPort === null || statsRefreshing) return;
    statsRefreshing = true;
    try { proxyStats = await fetchProxyStats({ host: config.stratum.host, port: config.stratum.statsPort }); }
    catch (e) { proxyStats = null; log('warn', `proxy stats unavailable: ${e.message}`); }
    finally { statsRefreshing = false; }
    for (const session of sessions.values()) session.applyProxyStats(proxyStats);
  }
  await refreshProxyStats();

  const httpServer = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, sessions: sessions.size, protocol: PROTOCOL_NAME, version: BRIDGE_VERSION, uptimeSec: Math.floor((Date.now() - startedAt) / 1000) }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('eaglesong-webminer bridge: WebSocket endpoint\n');
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: config.bridge.maxInboundFrameBytes, clientTracking: false });

  httpServer.on('upgrade', (req, socket, head) => {
    const clientIp = clientIpFromRequest(req, config.bridge.trustedClientIpHeader ?? null);
    if (clientIp === null) return refuse(socket, 403, 'Forbidden: client address unavailable');
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin.toLowerCase() : null;
    if (origin === null || !config.bridge.allowedOrigins.includes(origin)) {
      log('warn', 'upgrade refused: origin not allowed', { origin, ip: req.socket.remoteAddress });
      return refuse(socket, 403, 'Forbidden: origin not allowed');
    }
    if (sessions.size >= config.bridge.maxConnections) {
      log('warn', 'upgrade refused: connection cap', { ip: req.socket.remoteAddress });
      return refuse(socket, 503, 'Service Unavailable: connection limit reached');
    }
    if (connectionCountForIp(sessions, clientIp) >= config.bridge.maxConnectionsPerIp) {
      log('warn', 'upgrade refused: per-IP connection cap', { ip: clientIp });
      return refuse(socket, 503, 'Service Unavailable: per-IP connection limit reached');
    }
    req.clientIp = clientIp;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    const session = createSession({
      send: (obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); },
      close: (code, reason) => { try { ws.close(code, reason); } catch { /* already closed */ } },
      config, logger: log, remoteAddress: req.socket.remoteAddress, proxyStats,
    });
    session.clientIp = req.clientIp;
    sessions.set(ws, session);
    log('info', 'session opened', { sessionId: session.sessionId, ip: req.socket.remoteAddress, sessions: sessions.size });
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data, isBinary) => {
      if (isBinary) { session.handleMessage(Buffer.from([0])); return; } // yields BAD_JSON/BAD_FRAME error via the validator
      session.handleMessage(data.toString('utf8'));
    });
    ws.on('error', (e) => log('warn', `ws error: ${e.message}`, { sessionId: session.sessionId }));
    ws.on('close', (code) => {
      session.onClose();
      sessions.delete(ws);
      log('info', 'session closed', { sessionId: session.sessionId, code, stats: session.stats, sessions: sessions.size });
    });
  });

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.bridge.port, config.bridge.listenHost, resolve);
  });
  const port = httpServer.address().port;

  const statusTimer = setInterval(() => { for (const s of sessions.values()) if (s.state === 'active') s.sendStatus(); }, config.bridge.statusIntervalMs);
  const proxyStatsTimer = config.stratum.statsPort === null ? null : setInterval(refreshProxyStats, 5000);
  const heartbeatTimer = setInterval(() => {
    for (const ws of sessions.keys()) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* closing */ }
    }
  }, config.bridge.heartbeatIntervalMs);

  log('info', `bridge listening on ws://${config.bridge.listenHost}:${port} → stratum ${config.stratum.profile}`, { allowedOrigins: config.bridge.allowedOrigins });

  return {
    port, sessions, wss, httpServer,
    async close() {
      clearInterval(statusTimer); clearInterval(heartbeatTimer);
      if (proxyStatsTimer) clearInterval(proxyStatsTimer);
      for (const [ws, s] of sessions) { s.onClose(); ws.terminate(); }
      sessions.clear();
      await new Promise(r => wss.close(() => r()));
      await new Promise(r => httpServer.close(() => r()));
    },
  };
}

function refuse(socket, status, text) {
  const reason = { 403: 'Forbidden', 503: 'Service Unavailable' }[status] ?? 'Error';
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(text)}\r\nConnection: close\r\n\r\n${text}`);
  socket.destroy();
}

function defaultLogger(level, msg, data) {
  const line = { ts: new Date().toISOString(), level, msg, ...(data ? { data: sanitize(data) } : {}) };
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(JSON.stringify(line) + '\n');
}
/** log redaction: never print full IPs of browsers in the default log */
function sanitize(data) {
  if (data && typeof data.ip === 'string') return { ...data, ip: data.ip.includes(':') ? '[ipv6]' : data.ip.replace(/^(\d+\.\d+)\.\d+\.\d+$/, '$1.x.x') };
  return data;
}

// ── CLI entry ───────────────────────────────────────────────────────────────
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const file = process.argv[2] ?? process.env.BRIDGE_CONFIG ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'config.json');
  let config;
  try { config = loadConfig(file); }
  catch (e) { process.stderr.write(`${e.message}\n(copy config.example.json to config.json or pass a path)\n`); process.exit(2); }
  const bridge = await startBridgeServer(config);
  const shutdown = async () => { await bridge.close(); process.exit(0); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
