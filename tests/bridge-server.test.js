/**
 * bridge-server.test.js — config validation and the WebSocket server: origin
 * allowlist, connection cap, frame limit, and a full browser-protocol round trip
 * (hello → start → job → submit → share_result) over a real ws client against
 * the fake proxy.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { validateConfig } from '../src/bridge/config.js';
import { startBridgeServer } from '../src/bridge/server.js';
import { createFakeStratumServer, transcriptJob } from './helpers/fake-stratum-server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const t = JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/stratum-transcripts/solo-proxy-local.json'), 'utf8'));

const baseConfig = (stratumPort, over = {}) => ({
  bridge: { listenHost: '127.0.0.1', port: 0, allowedOrigins: ['http://localhost:5173', 'null'], maxConnections: 2, maxInboundFrameBytes: 16384, perSessionSubmissionsPerMinute: 120, maxJobsPerSession: 8, submitTimeoutMs: 2000, statusIntervalMs: 200, ...over.bridge },
  stratum: { host: '127.0.0.1', port: stratumPort, profile: 'solo-proxy-v1', ...over.stratum },
  mining: { mode: 'solo', targetShareSeconds: 30, webProfileEnabled: false, ...over.mining },
  payout: { displayConfiguredAddressOnly: true, displayAddress: 'ckb1qyq...', ...over.payout },
});

// ── config ──────────────────────────────────────────────────────────────────
test('validateConfig accepts the example config and fills documented defaults', () => {
  const example = JSON.parse(readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
  const cfg = validateConfig(example);
  assert.equal(cfg.bridge.listenHost, '127.0.0.1');
  assert.equal(cfg.bridge.port, 8788);
  assert.equal(cfg.stratum.port, 3334);
  assert.equal(cfg.stratum.profile, 'solo-proxy-v1');
  assert.equal(cfg.bridge.maxInboundFrameBytes, 16384);
  assert.equal(cfg.mining.mode, 'solo');
  assert.equal(cfg.mining.webProfileEnabled, false, 'unfinished proxy web profile stays opt-in');
  assert.ok(cfg.bridge.maxJobsPerSession >= 8);
});

test('validateConfig fails closed with the offending path', () => {
  const ok = baseConfig(3334);
  const bad = [
    [{ ...ok, bridge: { ...ok.bridge, port: 70000 } }, /bridge\.port/],
    [{ ...ok, bridge: { ...ok.bridge, allowedOrigins: 'http://x' } }, /allowedOrigins/],
    [{ ...ok, bridge: { ...ok.bridge, allowedOrigins: ['http://x', 5] } }, /allowedOrigins/],
    [{ ...ok, bridge: { ...ok.bridge, listenHost: '0.0.0.0', allowedOrigins: [] } }, /allowedOrigins.*non-loopback|non-loopback.*allowedOrigins/i],
    [{ ...ok, stratum: { ...ok.stratum, profile: 'godminer-v1' } }, /stratum\.profile/],
    [{ ...ok, stratum: { ...ok.stratum, host: '' } }, /stratum\.host/],
    [{ ...ok, mining: { ...ok.mining, mode: 'pool' } }, /mining\.mode/],
    [{ ...ok, bridge: { ...ok.bridge, perSessionSubmissionsPerMinute: 0 } }, /perSessionSubmissionsPerMinute/],
    [{ ...ok, bridge: { ...ok.bridge, maxInboundFrameBytes: 100000 } }, /maxInboundFrameBytes/],
    [{ ...ok, payout: { ...ok.payout, displayAddress: 'bc1qnotckb' } }, /payout\.displayAddress/],
    [{ ...ok, extra: 1 }, /unknown.*extra/i],
    [null, /object/],
  ];
  for (const [cfg, re] of bad) assert.throws(() => validateConfig(cfg), re, JSON.stringify(cfg)?.slice(0, 80));
});

// ── server ──────────────────────────────────────────────────────────────────
async function withBridge(fn, over = {}) {
  const fake = createFakeStratumServer(transcriptJob(t));
  const stratumPort = await fake.start();
  const bridge = await startBridgeServer(validateConfig(baseConfig(stratumPort, over)), { logger: () => {} });
  const sockets = [];
  const connect = (origin = 'http://localhost:5173') => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`, { headers: origin === null ? {} : { Origin: origin } });
    const inbox = [];
    ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve({ ws, inbox }));
    ws.on('error', reject);
    ws.on('unexpected-response', (_, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { statusCode: res.statusCode })));
    sockets.push(ws);
  });
  const waitFor = async (inbox, pred, ms = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const m = inbox.find(pred); if (m) return m; await new Promise(r => setTimeout(r, 10)); }
    throw new Error(`timeout waiting for ${pred}`);
  };
  try { await fn({ fake, bridge, connect, waitFor }); }
  finally { for (const s of sockets) s.terminate(); await bridge.close(); await fake.stop(); }
}

test('a connection from an allowed Origin receives hello; a disallowed or missing Origin is refused with 403', async () => {
  await withBridge(async ({ connect, waitFor }) => {
    const { inbox } = await connect('http://localhost:5173');
    const hello = await waitFor(inbox, m => m.type === 'hello');
    assert.equal(hello.protocol, 'ckb-128nonce-v1');
    assert.equal(hello.payout.address, 'ckb1qyq...');
    await assert.rejects(connect('https://evil.example'), (e) => e.statusCode === 403);
    await assert.rejects(connect(null), (e) => e.statusCode === 403);
    // file:// pages send Origin: null — allowed only when the operator lists "null"
    const n = await connect('null');
    await waitFor(n.inbox, m => m.type === 'hello');
  });
});

test('maxConnections is enforced: the third concurrent connection is refused with 503', async () => {
  await withBridge(async ({ connect, waitFor }) => {
    const a = await connect(); await waitFor(a.inbox, m => m.type === 'hello');
    const b = await connect(); await waitFor(b.inbox, m => m.type === 'hello');
    await assert.rejects(connect(), (e) => e.statusCode === 503);
    a.ws.close();
    await new Promise(r => setTimeout(r, 100));
    const c = await connect(); await waitFor(c.inbox, m => m.type === 'hello');
  });
});

test('full round trip over WebSocket: start → job → real share nonce → local_accepted; stop → connected:false; close → upstream torn down', async () => {
  await withBridge(async ({ fake, connect, waitFor }) => {
    const { ws, inbox } = await connect();
    await waitFor(inbox, m => m.type === 'hello');
    ws.send(JSON.stringify({ v: 1, type: 'hello', client: 'EagleWebMiner/1.0', capabilities: ['cpu-js'] }));
    ws.send(JSON.stringify({ v: 1, type: 'start', requestId: 's1', workerLabel: 'web-01' }));
    const job = await waitFor(inbox, m => m.type === 'job');
    assert.equal(job.generation, 1);
    assert.equal(job.prefix8Hex, t.prefix8Hex);
    ws.send(JSON.stringify({ v: 1, type: 'submit', requestId: 'sh1', jobId: job.jobId, generation: job.generation, nonceHex: t.nonces.share.nonceHex, hashHex: t.nonces.share.hashHex }));
    const res = await waitFor(inbox, m => m.type === 'share_result' && m.requestId === 'sh1');
    assert.equal(res.classification, 'local_accepted');
    assert.equal(res.accepted, true);
    assert.equal(fake.submits.length, 1);
    const st = await waitFor(inbox, m => m.type === 'status' && m.connected === true && typeof m.jobAgeMs === 'number');
    assert.ok(st.jobAgeMs >= 0, 'periodic status carries job age once a job exists');
    ws.send(JSON.stringify({ v: 1, type: 'stop', requestId: 'st1' }));
    await waitFor(inbox, m => m.type === 'status' && m.connected === false && m.requestId === 'st1');
    assert.equal(fake.connections.size, 0);
    ws.send(JSON.stringify({ v: 1, type: 'start', requestId: 's2' }));
    await waitFor(inbox, m => m.type === 'job' && m.generation > 1);
    assert.equal(fake.connections.size, 1);
    ws.close();
    await new Promise(r => setTimeout(r, 150));
    assert.equal(fake.connections.size, 0, 'WS close tears down the TCP session');
  });
});

test('an oversized inbound frame gets an error and the socket is closed with 1009', async () => {
  await withBridge(async ({ connect, waitFor }) => {
    const { ws, inbox } = await connect();
    await waitFor(inbox, m => m.type === 'hello');
    const closed = new Promise(r => ws.on('close', (code) => r(code)));
    ws.send(JSON.stringify({ v: 1, type: 'ping', requestId: 'x'.repeat(20000) }));
    assert.equal(await closed, 1009);
  });
});

test('a binary frame or malformed JSON yields an error message but keeps the connection', async () => {
  await withBridge(async ({ connect, waitFor }) => {
    const { ws, inbox } = await connect();
    await waitFor(inbox, m => m.type === 'hello');
    ws.send('not json');
    const err = await waitFor(inbox, m => m.type === 'error');
    assert.equal(err.code, 'BAD_JSON');
    ws.send(JSON.stringify({ v: 1, type: 'ping', requestId: 'still-alive' }));
    await waitFor(inbox, m => m.type === 'pong' && m.requestId === 'still-alive');
  });
});

test('the bridge never exposes stratum host/port or node RPC to the browser in any message', async () => {
  await withBridge(async ({ connect, waitFor, fake }) => {
    const { ws, inbox } = await connect();
    await waitFor(inbox, m => m.type === 'hello');
    ws.send(JSON.stringify({ v: 1, type: 'start' }));
    await waitFor(inbox, m => m.type === 'job');
    await waitFor(inbox, m => m.type === 'status');
    const text = JSON.stringify(inbox);
    assert.ok(!text.includes(String(fake.port)), 'stratum port leaked');
    assert.ok(!/get_block_template|submit_block|8114/.test(text));
  });
});

test('GET /healthz answers with bridge health JSON and no secrets', async () => {
  await withBridge(async ({ bridge }) => {
    const res = await fetch(`http://127.0.0.1:${bridge.port}/healthz`);
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.ok, true);
    assert.equal(typeof j.sessions, 'number');
    assert.equal(j.protocol, 'ckb-128nonce-v1');
    assert.ok(!('stratum' in j));
  });
});
