/**
 * stratum-tcp.test.js — the bridge's one-TCP-session-per-browser Stratum client
 * against the deterministic fake proxy (which replays the real captured dialect).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStratumConnection } from '../src/bridge/stratum-tcp.js';
import { createFakeStratumServer, transcriptJob } from './helpers/fake-stratum-server.js';
import { bytesToHex } from '../src/hash/eaglesong-core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const t = JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/stratum-transcripts/solo-proxy-local.json'), 'utf8'));

const once = (emitter, event, ms = 3000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
  emitter.once(event, (v) => { clearTimeout(timer); resolve(v); });
});

async function withServer(fn, overrides = {}) {
  const server = createFakeStratumServer({ ...transcriptJob(t), ...overrides });
  const port = await server.start();
  const conns = [];
  const make = (extra = {}) => {
    const c = createStratumConnection({ host: '127.0.0.1', port, profile: 'solo-proxy-v1', worker: 'web-01', requestTimeoutMs: 500, connectTimeoutMs: 1000, logger: () => {}, ...extra });
    conns.push(c);
    return c;
  };
  try { await fn({ server, make, port }); }
  finally { for (const c of conns) c.close(); await server.stop(); }
}

test('connect() subscribes then authorizes with the exact frames the real transcript shows, and yields the session prefix', async () => {
  await withServer(async ({ server, make }) => {
    const c = make();
    const info = await c.connect();
    assert.equal(info.extranonce1Hex, t.extranonce1);
    assert.equal(bytesToHex(info.prefix8), t.prefix8Hex);
    const c2s = server.frames.filter(f => f.dir === 'c2s').map(f => JSON.parse(f.line));
    assert.deepEqual(c2s[0], { id: 1, method: 'mining.subscribe', params: ['EagleWebMiner/1.0'] });
    assert.deepEqual(c2s[1], { id: 2, method: 'mining.authorize', params: ['web-01', 'x'] });
    assert.equal(c.state, 'authorized');
  });
});

test('after authorize the client emits target then job with decoded BigInt targets', async () => {
  await withServer(async ({ make }) => {
    const c = make();
    const events = [];
    c.on('target', e => events.push(['target', e]));
    c.on('job', e => events.push(['job', e]));
    await c.connect();
    await once(c, 'job');
    const target = events.find(e => e[0] === 'target')[1];
    const job = events.find(e => e[0] === 'job')[1];
    assert.equal(target.shareTarget, (1n << 224n) * 1000000n);
    assert.equal(job.jobId, t.job.jobId);
    assert.equal(job.powHashHex, t.job.powHashHex);
    assert.equal(job.height, t.job.height);
    assert.equal(job.networkTarget, 1n << 242n);
    assert.equal(job.cleanJobs, false);
    assert.ok(events.findIndex(e => e[0] === 'target') < events.findIndex(e => e[0] === 'job'), 'target precedes job, as on the wire');
  });
});

test('submit() correlates the response by id: real share nonce accepted, low nonce rejected with code 23', async () => {
  await withServer(async ({ make, server }) => {
    const c = make();
    await c.connect(); await once(c, 'job');
    const ok = await c.submit(t.job.jobId, t.nonces.share.nonceHex);
    assert.deepEqual(ok, { accepted: true, errorCode: null, errorMessage: null });
    const low = await c.submit(t.job.jobId, t.nonces.low.nonceHex);
    assert.deepEqual(low, { accepted: false, errorCode: 23, errorMessage: 'Low difficulty share' });
    assert.equal(server.submits.length, 2);
    assert.equal(server.submits[0].hashHex, t.nonces.share.hashHex, 'the fake recomputed the same digest');
    const submitFrames = server.frames.filter(f => f.dir === 'c2s').map(f => JSON.parse(f.line)).filter(m => m.method === 'mining.submit');
    assert.deepEqual(submitFrames[0].params, ['web-01', t.job.jobId, t.nonces.share.nonceHex], 'three-field submit with the full 16-byte nonce');
  });
});

test('concurrent submits each get their own response (ids never cross)', async () => {
  await withServer(async ({ make }) => {
    const c = make();
    await c.connect(); await once(c, 'job');
    const [a, b, d] = await Promise.all([
      c.submit(t.job.jobId, t.nonces.low.nonceHex),
      c.submit(t.job.jobId, t.nonces.share.nonceHex),
      c.submit(t.job.jobId, t.nonces.block.nonceHex),
    ]);
    assert.equal(a.accepted, false); assert.equal(b.accepted, true); assert.equal(d.accepted, true);
  });
});

test('submit() rejects with a timeout error when the upstream never answers', async () => {
  await withServer(async ({ make, server }) => {
    const c = make();
    await c.connect(); await once(c, 'job');
    server.state.faults.dropSubmitResponses = true;
    const t0 = Date.now();
    await assert.rejects(c.submit(t.job.jobId, t.nonces.share.nonceHex), /timeout/i);
    assert.ok(Date.now() - t0 >= 450 && Date.now() - t0 < 2000);
  });
});

test('a job update pushed by the proxy is emitted as a new job event; a target-only update as a target event', async () => {
  await withServer(async ({ make, server }) => {
    const c = make();
    await c.connect(); await once(c, 'job');
    const jobP = once(c, 'job');
    server.setJob({ jobId: 'b2', powHashHex: 'ab'.repeat(32), height: t.job.height + 1 }, true);
    const job = await jobP;
    assert.equal(job.jobId, 'b2'); assert.equal(job.cleanJobs, true); assert.equal(job.powHashHex, 'ab'.repeat(32));
    const targetP = once(c, 'target');
    server.setShareTarget('ff'.repeat(32), 0.5);
    const tg = await targetP;
    assert.equal(tg.shareTarget, (1n << 256n) - 1n);
  });
});

test('a foreign notify shape (4 fields) fails closed: protocol_error + close, no job event', async () => {
  await withServer(async ({ make, server }) => {
    const c = make();
    const jobs = [];
    c.on('job', j => jobs.push(j));
    await c.connect(); await once(c, 'job');
    server.state.faults.notifyParamCount = 4;
    const errP = once(c, 'protocol_error');
    const closeP = once(c, 'close');
    server.setJob({ jobId: 'c3' });
    const err = await errP;
    assert.match(err.message, /5 params/);
    await closeP;
    assert.equal(jobs.length, 1, 'the malformed job was not emitted');
    assert.equal(c.state, 'closed');
  });
});

test('an oversized line closes the connection instead of buffering without bound', async () => {
  await withServer(async ({ make, server }) => {
    const c = make({ maxLineBytes: 4096 });
    await c.connect(); await once(c, 'job');
    const closeP = once(c, 'close');
    server.sendRaw('x'.repeat(5000));
    const reason = await closeP;
    assert.match(String(reason?.reason ?? reason), /line|oversize|too long/i);
  });
});

test('when the proxy drops the socket, close is emitted and in-flight submits reject', async () => {
  await withServer(async ({ make, server }) => {
    const c = make();
    await c.connect(); await once(c, 'job');
    server.state.faults.dropSubmitResponses = true;
    const pending = c.submit(t.job.jobId, t.nonces.share.nonceHex);
    const closeP = once(c, 'close');
    server.closeAllConnections();
    await closeP;
    await assert.rejects(pending, /closed/i);
    assert.equal(c.state, 'closed');
    await assert.rejects(c.submit(t.job.jobId, t.nonces.share.nonceHex), /closed/i, 'no submits after close');
  });
});

test('connect() rejects when nothing listens, and when the server never answers subscribe', async () => {
  const c = createStratumConnection({ host: '127.0.0.1', port: 1, profile: 'solo-proxy-v1', worker: 'w', connectTimeoutMs: 1000, requestTimeoutMs: 300, logger: () => {} });
  await assert.rejects(c.connect());
  assert.equal(c.state, 'closed');
  // silent server
  const net = await import('node:net');
  const accepted = [];
  const silent = net.createServer((s) => accepted.push(s));
  await new Promise(r => silent.listen(0, '127.0.0.1', r));
  const c2 = createStratumConnection({ host: '127.0.0.1', port: silent.address().port, profile: 'solo-proxy-v1', worker: 'w', connectTimeoutMs: 1000, requestTimeoutMs: 300, logger: () => {} });
  await assert.rejects(c2.connect(), /timeout/i);
  c2.close();
  for (const s of accepted) s.destroy();
  await new Promise(r => silent.close(r));
});

test('unknown profile is refused before any socket is opened', () => {
  assert.throws(() => createStratumConnection({ host: '127.0.0.1', port: 1, profile: 'godminer-v1', worker: 'w' }), /unknown|unsupported/i);
});
