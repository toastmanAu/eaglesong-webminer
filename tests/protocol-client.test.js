/**
 * protocol-client.test.js — the browser's bridge client (WebSocket JSON v1):
 * normalization of job/target into BigInt/Uint8Array, request correlation,
 * strict inbound validation, and reconnect without auto-start.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { createProtocolClient } from '../src/ui/protocol-client.js';
import { bytesToHex } from '../src/hash/eaglesong-core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const t = JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/stratum-transcripts/solo-proxy-local.json'), 'utf8'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const HELLO = { v: 1, type: 'hello', sessionId: 'abc123abc123abc123', mode: 'solo', payout: { kind: 'node_block_assembler', address: 'ckb1qyq...', verified: false }, protocol: 'ckb-128nonce-v1', bridgeVersion: '0.1.0' };
const JOB = { v: 1, type: 'job', jobId: t.job.jobId, generation: 1, powHashHex: t.job.powHashHex, height: t.job.height, cleanJobs: false, prefix8Hex: t.prefix8Hex, shareTargetBE: ((1n << 224n) * 1000000n).toString(16).padStart(64, '0'), networkTargetBE: (1n << 242n).toString(16).padStart(64, '0'), issuedAt: 1700000000000, shareDifficulty: 0.000001 };

/** scripted fake bridge: `script(ws, msg)` decides replies */
async function withFakeBridge(script, fn) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(r => wss.once('listening', r));
  const sockets = [];
  wss.on('connection', (ws) => {
    sockets.push(ws);
    ws.send(JSON.stringify(HELLO));
    ws.on('message', (d) => script(ws, JSON.parse(d.toString()), sockets.length));
  });
  const url = `ws://127.0.0.1:${wss.address().port}`;
  const clients = [];
  const make = (extra = {}) => { const c = createProtocolClient({ url, WebSocketImpl: WebSocket, requestTimeoutMs: 500, reconnect: { baseMs: 50, maxMs: 200 }, ...extra }); clients.push(c); return c; };
  try { await fn({ make, wss, sockets, url }); }
  finally { for (const c of clients) c.disconnect(); for (const s of sockets) s.terminate(); await new Promise(r => wss.close(r)); }
}
const once = (c, ev, ms = 3000) => new Promise((res, rej) => { const tm = setTimeout(() => rej(new Error(`timeout ${ev}`)), ms); c.on(ev, (v) => { clearTimeout(tm); res(v); }); });

const defaultScript = (ws, msg) => {
  if (msg.type === 'start') { ws.send(JSON.stringify({ v: 1, type: 'status', connected: true, nodeHealthy: null, jobAgeMs: null, payoutVerified: false, stratumState: 'authorized', requestId: msg.requestId })); ws.send(JSON.stringify(JOB)); }
  if (msg.type === 'submit') ws.send(JSON.stringify({ v: 1, type: 'share_result', requestId: msg.requestId, jobId: msg.jobId, generation: msg.generation, nonceHex: msg.nonceHex, hashHex: t.nonces.share.hashHex, classification: msg.nonceHex === t.nonces.share.nonceHex ? 'local_accepted' : 'rejected_low_diff', accepted: msg.nonceHex === t.nonces.share.nonceHex, reason: null, upstream: null }));
  if (msg.type === 'stop') ws.send(JSON.stringify({ v: 1, type: 'status', connected: false, requestId: msg.requestId }));
  if (msg.type === 'ping') ws.send(JSON.stringify({ v: 1, type: 'pong', requestId: msg.requestId }));
};

test('endpoint can change while disconnected and cannot change during a session', async () => {
  await withFakeBridge(defaultScript, async ({ make, url }) => {
    const c = make({ url: 'ws://127.0.0.1:1' });
    c.setEndpoint(url);
    c.connect(); await once(c, 'hello');
    assert.throws(() => c.setEndpoint('ws://127.0.0.1:2'), /disconnect|session/i);
    c.disconnect();
    assert.equal(c.hello, null);
    c.setEndpoint('ws://127.0.0.1:2');
  });
});

test('connect → hello is parsed and the client sends its own hello with capabilities; state becomes open', async () => {
  const seen = [];
  await withFakeBridge((ws, msg) => { seen.push(msg); defaultScript(ws, msg); }, async ({ make }) => {
    const c = make({ capabilities: ['cpu-js'] });
    c.connect();
    const hello = await once(c, 'hello');
    assert.equal(hello.sessionId, HELLO.sessionId);
    assert.deepEqual(hello.payout, HELLO.payout);
    assert.equal(c.state, 'open');
    await sleep(50);
    assert.deepEqual(seen[0], { v: 1, type: 'hello', client: 'EagleWebMiner/1.0', capabilities: ['cpu-js'] });
  });
});

test('start() resolves on the status ack; the job is normalized to Uint8Array/BigInt with the right byte orders', async () => {
  await withFakeBridge(defaultScript, async ({ make }) => {
    const c = make(); c.connect(); await once(c, 'hello');
    const jobP = once(c, 'job');
    await c.start('web-01');
    const job = await jobP;
    assert.equal(job.change, 'job');
    assert.equal(job.generation, 1);
    assert.equal(job.jobId, t.job.jobId);
    assert.equal(bytesToHex(job.powHash), t.job.powHashHex);
    assert.equal(bytesToHex(job.prefix8), t.prefix8Hex);
    assert.equal(job.shareTarget, (1n << 224n) * 1000000n);
    assert.equal(job.networkTarget, 1n << 242n);
    assert.equal(job.height, t.job.height);
    assert.equal(job.cleanJobs, false);
    assert.equal(typeof job.receivedAtMs, 'number');
    assert.equal(c.currentJob, job);
  });
});

test('a target message yields a job event with change:"target", same powHash/prefix, new generation and share target', async () => {
  await withFakeBridge((ws, msg) => { defaultScript(ws, msg); if (msg.type === 'ping' && msg.requestId === 'go') ws.send(JSON.stringify({ v: 1, type: 'target', generation: 2, jobId: JOB.jobId, shareTargetBE: 'f'.repeat(64), networkTargetBE: JOB.networkTargetBE, shareDifficulty: 1 })); }, async ({ make }) => {
    const c = make(); c.connect(); await once(c, 'hello');
    const j1 = once(c, 'job'); await c.start(); await j1;
    const j2 = once(c, 'job');
    c.ping('go');
    const job = await j2;
    assert.equal(job.change, 'target');
    assert.equal(job.generation, 2);
    assert.equal(job.shareTarget, (1n << 256n) - 1n);
    assert.equal(bytesToHex(job.powHash), t.job.powHashHex);
    assert.equal(job.networkTarget, 1n << 242n);
  });
});

test('a target message before any job is a protocol_error and is ignored (never mine with half a job)', async () => {
  await withFakeBridge((ws, msg) => { if (msg.type === 'ping') ws.send(JSON.stringify({ v: 1, type: 'target', generation: 1, jobId: 'x', shareTargetBE: 'f'.repeat(64), networkTargetBE: null })); }, async ({ make }) => {
    const c = make(); c.connect(); await once(c, 'hello');
    const jobs = []; c.on('job', j => jobs.push(j));
    const errP = once(c, 'protocol_error');
    c.ping('x').catch(() => {}); // the fake never answers this ping
    await errP;
    assert.equal(jobs.length, 0);
  });
});

test('submit() sends the candidate with a unique requestId and resolves with the correlated share_result', async () => {
  const seen = [];
  await withFakeBridge((ws, msg) => { seen.push(msg); defaultScript(ws, msg); }, async ({ make }) => {
    const c = make(); c.connect(); await once(c, 'hello');
    const jobP = once(c, 'job'); await c.start(); await jobP;
    const [ok, low] = await Promise.all([
      c.submit({ generation: 1, jobId: t.job.jobId, nonceHex: t.nonces.share.nonceHex, hashHex: t.nonces.share.hashHex }),
      c.submit({ generation: 1, jobId: t.job.jobId, nonceHex: t.nonces.low.nonceHex, hashHex: t.nonces.low.hashHex }),
    ]);
    assert.equal(ok.classification, 'local_accepted'); assert.equal(ok.accepted, true);
    assert.equal(low.classification, 'rejected_low_diff'); assert.equal(low.accepted, false);
    const submits = seen.filter(m => m.type === 'submit');
    assert.equal(submits.length, 2);
    assert.notEqual(submits[0].requestId, submits[1].requestId);
    assert.deepEqual(Object.keys(submits[0]).sort(), ['generation', 'hashHex', 'jobId', 'nonceHex', 'requestId', 'type', 'v']);
  });
});

test('submit() rejects after the request timeout when the bridge never answers; an error with the requestId rejects immediately', async () => {
  await withFakeBridge((ws, msg) => { if (msg.type === 'submit' && msg.nonceHex.startsWith('ff')) ws.send(JSON.stringify({ v: 1, type: 'error', code: 'RATE_LIMITED', message: 'slow down', requestId: msg.requestId })); defaultScript(ws, { ...msg, type: msg.type === 'submit' ? 'noop' : msg.type }); }, async ({ make }) => {
    const c = make(); c.connect(); await once(c, 'hello');
    const jobP = once(c, 'job'); await c.start(); await jobP;
    await assert.rejects(c.submit({ generation: 1, jobId: t.job.jobId, nonceHex: t.nonces.share.nonceHex, hashHex: t.nonces.share.hashHex }), /timeout/i);
    await assert.rejects(c.submit({ generation: 1, jobId: t.job.jobId, nonceHex: 'ff'.repeat(16), hashHex: 'ff'.repeat(32) }), /RATE_LIMITED/);
  });
});

test('malformed bridge frames (bad hex lengths, wrong version, non-JSON) → protocol_error, connection kept, no job emitted', async () => {
  await withFakeBridge((ws, msg) => { if (msg.type === 'ping') { ws.send('{nope'); ws.send(JSON.stringify({ ...JOB, v: 2 })); ws.send(JSON.stringify({ ...JOB, powHashHex: 'abc' })); ws.send(JSON.stringify({ ...JOB, prefix8Hex: '00' })); ws.send(JSON.stringify({ ...JOB, shareTargetBE: 'zz' })); ws.send(JSON.stringify({ v: 1, type: 'pong', requestId: msg.requestId })); } }, async ({ make }) => {
    const c = make(); c.connect(); await once(c, 'hello');
    const errors = []; c.on('protocol_error', e => errors.push(e));
    const jobs = []; c.on('job', j => jobs.push(j));
    await c.ping('p');
    assert.equal(errors.length, 5, errors.map(e => e.message).join(' | '));
    assert.equal(jobs.length, 0);
    assert.equal(c.state, 'open');
  });
});

test('on close the client reconnects with backoff but does NOT re-send start by itself; stop() ends the session', async () => {
  const starts = [];
  await withFakeBridge((ws, msg) => { if (msg.type === 'start') starts.push(1); defaultScript(ws, msg); }, async ({ make, sockets }) => {
    const c = make(); c.connect(); await once(c, 'hello');
    const jobP = once(c, 'job'); await c.start(); await jobP;
    const closeP = once(c, 'close');
    const reconnP = once(c, 'reconnecting');
    const helloP = once(c, 'hello');
    sockets[0].terminate();
    await closeP; const r = await reconnP; await helloP;
    assert.ok(r.delayMs >= 50 && r.delayMs <= 200);
    assert.equal(c.state, 'open');
    await sleep(100);
    assert.equal(starts.length, 1, 'no covert restart after reconnect');
    await c.stop();
    c.disconnect();
    assert.equal(c.state, 'disconnected');
  });
});

test('disconnect() stops reconnecting; a connection refused reports error and schedules a bounded retry', async () => {
  const c = createProtocolClient({ url: 'ws://127.0.0.1:1', WebSocketImpl: WebSocket, reconnect: { baseMs: 20, maxMs: 40 } });
  const delays = [];
  c.on('reconnecting', (r) => delays.push(r.delayMs));
  c.connect();
  await sleep(300);
  assert.ok(delays.length >= 3, `retries happened: ${delays}`);
  assert.ok(delays.every(d => d <= 40));
  c.disconnect();
  const n = delays.length;
  await sleep(150);
  assert.equal(delays.length, n, 'no retries after disconnect');
});
