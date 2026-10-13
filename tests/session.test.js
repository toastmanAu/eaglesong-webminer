/**
 * session.test.js — one browser session on the bridge: hello/start/job/target/
 * submit/stop lifecycle, generation bumps, share classification with upstream
 * forwarding, and teardown. The WebSocket is replaced by a captured `send`;
 * the upstream is the fake proxy replaying the real dialect.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSession } from '../src/bridge/session.js';
import { createFakeStratumServer, transcriptJob } from './helpers/fake-stratum-server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const t = JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/stratum-transcripts/solo-proxy-local.json'), 'utf8'));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function harness(fn, { serverOverrides = {}, config = {} } = {}) {
  const server = createFakeStratumServer({ ...transcriptJob(t), ...serverOverrides });
  const port = await server.start();
  const sent = [];
  let closed = null;
  const cfg = {
    bridge: { perSessionSubmissionsPerMinute: 120, maxJobsPerSession: 8, submitTimeoutMs: 1000 },
    stratum: { host: '127.0.0.1', port, profile: 'solo-proxy-v1' },
    mining: { mode: 'solo' },
    payout: { displayAddress: 'ckb1qyq...', displayConfiguredAddressOnly: true },
    ...config,
  };
  const session = createSession({
    send: (obj) => sent.push(obj),
    close: (code, reason) => { closed = { code, reason }; },
    config: cfg,
    logger: () => {},
    remoteAddress: '127.0.0.1',
  });
  const waitFor = async (pred, ms = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const m = sent.find(pred); if (m) return m; await sleep(10); }
    throw new Error(`timeout waiting for ${pred.toString()}`);
  };
  const msg = (o) => session.handleMessage(JSON.stringify({ v: 1, ...o }));
  const start = async () => { msg({ type: 'hello', client: 'EagleWebMiner/1.0', capabilities: ['cpu-js'] }); msg({ type: 'start', requestId: 's1', workerLabel: 'web-01' }); return waitFor(m => m.type === 'job'); };
  try { await fn({ server, session, sent, msg, waitFor, start, getClosed: () => closed, port }); }
  finally { session.onClose(); await server.stop(); }
}

test('on creation the bridge sends hello with sessionId, solo mode, server-defined payout and the protocol name', async () => {
  await harness(async ({ sent, session }) => {
    const hello = sent[0];
    assert.equal(hello.type, 'hello');
    assert.equal(hello.v, 1);
    assert.match(hello.sessionId, /^[0-9a-f]{16,}$/);
    assert.equal(hello.sessionId, session.sessionId);
    assert.equal(hello.mode, 'solo');
    assert.deepEqual(hello.payout, { kind: 'node_block_assembler', address: 'ckb1qyq...', verified: false });
    assert.equal(hello.protocol, 'ckb-128nonce-v1');
    assert.equal(session.state, 'idle');
  });
});

test('proxy stats update payout only when node-derived data is fresh; loss revokes verification', async () => {
  await harness(async ({ session, sent }) => {
    const address = 'ckt1qyq' + 'q'.repeat(40);
    session.applyProxyStats({ address, verified: true, nodeHealthy: true, templateAgeSec: 2 });
    const verified = sent.at(-1);
    assert.equal(verified.type, 'status');
    assert.equal(verified.payout.address, address);
    assert.equal(verified.payout.verified, true);
    assert.equal(verified.nodeHealthy, true);
    session.applyProxyStats(null);
    const lost = sent.at(-1);
    assert.equal(lost.payout.verified, false);
    assert.equal(lost.nodeHealthy, null);
  });
});

test('no job is forwarded until start; start opens ONE TCP session and forwards the normalized job with generation 1 and the session prefix', async () => {
  await harness(async ({ server, sent, start, session }) => {
    await sleep(100);
    assert.equal(sent.filter(m => m.type === 'job').length, 0);
    assert.equal(server.connections.size, 0, 'no upstream socket before start');
    const job = await start();
    assert.equal(server.connections.size, 1);
    assert.equal(job.generation, 1);
    assert.equal(job.jobId, t.job.jobId);
    assert.equal(job.powHashHex, t.job.powHashHex);
    assert.equal(job.height, t.job.height);
    assert.equal(job.prefix8Hex, t.prefix8Hex);
    assert.equal(job.shareTargetBE, ((1n << 224n) * 1000000n).toString(16).padStart(64, '0'));
    assert.equal(job.networkTargetBE, (1n << 242n).toString(16).padStart(64, '0'));
    assert.equal(job.cleanJobs, false);
    assert.equal(typeof job.issuedAt, 'number');
    assert.equal(session.state, 'active');
    const ua = JSON.parse(server.frames.find(f => f.dir === 'c2s').line).params[0];
    assert.equal(ua, 'EagleWebMiner/1.0', 'pinned non-GodMiner UA');
  });
});

test('a second start while active is refused with ALREADY_STARTED and opens no second TCP session', async () => {
  await harness(async ({ server, start, msg, waitFor }) => {
    await start();
    msg({ type: 'start', requestId: 's2' });
    const err = await waitFor(m => m.type === 'error' && m.requestId === 's2');
    assert.equal(err.code, 'ALREADY_STARTED');
    assert.equal(server.connections.size, 1);
  });
});

test('submit before start → error NOT_STARTED; malformed frame → error with the schema code', async () => {
  await harness(async ({ msg, waitFor }) => {
    msg({ type: 'submit', requestId: 'x1', jobId: 'a', generation: 1, nonceHex: '00'.repeat(16) });
    assert.equal((await waitFor(m => m.type === 'error' && m.requestId === 'x1')).code, 'NOT_STARTED');
    msg({ type: 'submit', requestId: 'x2', jobId: 'a', generation: 1, nonceHex: 'zz' });
    assert.equal((await waitFor(m => m.type === 'error' && m.requestId === 'x2')).code, 'INVALID_NONCE');
  });
});

test('the real share nonce → bridge recomputation share_ok → forwarded ONCE → proxy ACK → local_accepted', async () => {
  await harness(async ({ server, start, msg, waitFor }) => {
    const job = await start();
    msg({ type: 'submit', requestId: 'share-1', jobId: job.jobId, generation: job.generation, nonceHex: t.nonces.share.nonceHex, hashHex: t.nonces.share.hashHex });
    const r = await waitFor(m => m.type === 'share_result' && m.requestId === 'share-1');
    assert.equal(r.classification, 'local_accepted');
    assert.equal(r.accepted, true);
    assert.equal(r.hashHex, t.nonces.share.hashHex, 'bridge reports ITS recomputed digest');
    assert.equal(server.submits.length, 1, 'exactly one upstream mining.submit');
    assert.equal(server.submits[0].nonceHex, t.nonces.share.nonceHex, 'the same 16 bytes travel upstream');
    assert.equal(r.upstream.accepted, true);
  });
});

test('a low-diff nonce is rejected by the bridge itself and NOT forwarded upstream', async () => {
  await harness(async ({ server, start, msg, waitFor }) => {
    const job = await start();
    msg({ type: 'submit', requestId: 'low-1', jobId: job.jobId, generation: job.generation, nonceHex: t.nonces.low.nonceHex });
    const r = await waitFor(m => m.type === 'share_result' && m.requestId === 'low-1');
    assert.equal(r.classification, 'rejected_low_diff');
    assert.equal(r.accepted, false);
    assert.equal(server.submits.length, 0);
  });
});

test('a replayed nonce → rejected_duplicate (second one never reaches the proxy); bad prefix → rejected_invalid; unknown generation → rejected_stale', async () => {
  await harness(async ({ server, start, msg, waitFor }) => {
    const job = await start();
    const submit = (id, extra) => msg({ type: 'submit', requestId: id, jobId: job.jobId, generation: job.generation, nonceHex: t.nonces.share.nonceHex, ...extra });
    submit('d1'); await waitFor(m => m.type === 'share_result' && m.requestId === 'd1');
    submit('d2'); const dup = await waitFor(m => m.type === 'share_result' && m.requestId === 'd2');
    assert.equal(dup.classification, 'rejected_duplicate');
    assert.equal(server.submits.length, 1);
    submit('d3', { nonceHex: t.nonces.share.nonceHex.slice(0, 16) + 'deadbeef00000000' });
    assert.equal((await waitFor(m => m.type === 'share_result' && m.requestId === 'd3')).classification, 'rejected_invalid');
    submit('d4', { generation: 77 });
    assert.equal((await waitFor(m => m.type === 'share_result' && m.requestId === 'd4')).classification, 'rejected_stale');
    assert.equal(server.submits.length, 1, 'nothing else forwarded');
  });
});

test('a network-target nonce → block_candidate, forwarded regardless of share target, ACK recorded — never labelled a block', async () => {
  await harness(async ({ server, start, msg, waitFor }) => {
    const job = await start();
    msg({ type: 'submit', requestId: 'b1', jobId: job.jobId, generation: job.generation, nonceHex: t.nonces.block.nonceHex });
    const r = await waitFor(m => m.type === 'share_result' && m.requestId === 'b1');
    assert.equal(r.classification, 'block_candidate');
    assert.equal(r.accepted, true);
    assert.equal(r.upstream.accepted, true);
    assert.equal(server.blocks.length, 1, 'the (fake) proxy saw a network-target solution');
    assert.ok(!['node_accepted', 'block_confirmed'].includes(r.classification));
  });
});

test('a target-only update bumps generation, keeps jobId/powHash, and is sent as a target message', async () => {
  await harness(async ({ server, start, waitFor }) => {
    const job = await start();
    server.setShareTarget('ff'.repeat(32), 1);
    const tg = await waitFor(m => m.type === 'target' && m.generation === job.generation + 1);
    assert.equal(tg.shareTargetBE, 'f'.repeat(64));
    assert.equal(tg.networkTargetBE, job.networkTargetBE);
    assert.equal(tg.jobId, job.jobId);
  });
});

test('a new job bumps generation and carries cleanJobs; a non-block share for the OLD job is rejected', async () => {
  await harness(async ({ server, start, msg, waitFor }) => {
    const job1 = await start();
    server.setJob({ jobId: 'b2', powHashHex: 'ab'.repeat(32), height: t.job.height + 1 }, true);
    const job2 = await waitFor(m => m.type === 'job' && m.jobId === 'b2');
    assert.equal(job2.generation, job1.generation + 1);
    assert.equal(job2.cleanJobs, true);
    // The fake proxy blind-ACKs unknown jobs. The bridge must not treat that ACK as validated work.
    msg({ type: 'submit', requestId: 'late', jobId: job1.jobId, generation: job1.generation, nonceHex: t.nonces.share.nonceHex });
    const r = await waitFor(m => m.type === 'share_result' && m.requestId === 'late');
    assert.equal(r.hashHex, t.nonces.share.hashHex);
    assert.equal(r.classification, 'rejected_stale');
    assert.equal(server.submits.length, 0);
  });
});

test('stop closes the TCP session, reports stopped, and a later start gets a NEW session (fresh generation continues increasing)', async () => {
  await harness(async ({ server, start, msg, waitFor, session, sent }) => {
    const job1 = await start();
    msg({ type: 'stop', requestId: 'stop-1' });
    await waitFor(m => m.type === 'status' && m.connected === false);
    await sleep(50);
    assert.equal(server.connections.size, 0);
    assert.equal(session.state, 'stopped');
    const before = sent.length;
    msg({ type: 'start', requestId: 's2' });
    const job2 = await waitFor((m) => m.type === 'job' && sent.indexOf(m) >= before);
    assert.ok(job2.generation > job1.generation, 'generations never restart within a session');
    assert.equal(server.connections.size, 1);
  });
});

test('upstream socket loss → status connected:false + error UPSTREAM_CLOSED; in-flight submit → upstream_error', async () => {
  await harness(async ({ server, start, msg, waitFor, session }) => {
    const job = await start();
    server.state.faults.dropSubmitResponses = true;
    msg({ type: 'submit', requestId: 'inflight', jobId: job.jobId, generation: job.generation, nonceHex: t.nonces.share.nonceHex });
    await sleep(50);
    server.closeAllConnections();
    const r = await waitFor(m => m.type === 'share_result' && m.requestId === 'inflight');
    assert.equal(r.classification, 'upstream_error');
    assert.equal(r.accepted, false);
    const err = await waitFor(m => m.type === 'error' && m.code === 'UPSTREAM_CLOSED');
    assert.ok(err.message);
    await waitFor(m => m.type === 'status' && m.connected === false);
    assert.equal(session.state, 'stopped');
  });
});

test('upstream submit timeout → upstream_error (the share is not silently lost nor counted accepted)', async () => {
  await harness(async ({ server, start, msg, waitFor }) => {
    const job = await start();
    server.state.faults.dropSubmitResponses = true;
    msg({ type: 'submit', requestId: 'to', jobId: job.jobId, generation: job.generation, nonceHex: t.nonces.share.nonceHex });
    const r = await waitFor(m => m.type === 'share_result' && m.requestId === 'to', 4000);
    assert.equal(r.classification, 'upstream_error');
    assert.match(r.reason, /timeout/i);
  }, { config: { bridge: { perSessionSubmissionsPerMinute: 120, maxJobsPerSession: 8, submitTimeoutMs: 300 } } });
});

test('submit rate limit: the (N+1)th non-block submit in a minute is RATE_LIMITED, but a block candidate still passes', async () => {
  await harness(async ({ server, start, msg, waitFor }) => {
    const job = await start();
    // 3 distinct low-diff nonces: each is evaluated (rejected_low_diff) and counts toward the limit
    const nonces = ['02', '03', '04'].map(b => b + '00000000000000' + t.prefix8Hex);
    for (let i = 0; i < 3; i++) {
      msg({ type: 'submit', requestId: `r${i}`, jobId: job.jobId, generation: job.generation, nonceHex: nonces[i] });
      await waitFor(m => m.type === 'share_result' && m.requestId === `r${i}`);
    }
    msg({ type: 'submit', requestId: 'r3', jobId: job.jobId, generation: job.generation, nonceHex: '05' + '00000000000000' + t.prefix8Hex });
    const limited = await waitFor(m => m.type === 'error' && m.requestId === 'r3');
    assert.equal(limited.code, 'RATE_LIMITED');
    msg({ type: 'submit', requestId: 'blk', jobId: job.jobId, generation: job.generation, nonceHex: t.nonces.block.nonceHex });
    const blk = await waitFor(m => m.type === 'share_result' && m.requestId === 'blk');
    assert.equal(blk.classification, 'block_candidate');
    assert.equal(server.submits.length, 1, 'only the block candidate reached the proxy');
  }, { config: { bridge: { perSessionSubmissionsPerMinute: 3, maxJobsPerSession: 8, submitTimeoutMs: 1000 } } });
});

test('onClose (WebSocket gone) tears down the TCP session and all allocations', async () => {
  await harness(async ({ server, start, session }) => {
    await start();
    assert.equal(server.connections.size, 1);
    session.onClose();
    await sleep(50);
    assert.equal(server.connections.size, 0);
    assert.equal(session.state, 'closed');
  });
});

test('ping → pong with the same requestId', async () => {
  await harness(async ({ msg, waitFor }) => {
    msg({ type: 'ping', requestId: 'p1' });
    assert.equal((await waitFor(m => m.type === 'pong')).requestId, 'p1');
  });
});

test('stats count each classification separately', async () => {
  await harness(async ({ start, msg, waitFor, session }) => {
    const job = await start();
    const submit = (id, nonceHex) => { msg({ type: 'submit', requestId: id, jobId: job.jobId, generation: job.generation, nonceHex }); return waitFor(m => m.type === 'share_result' && m.requestId === id); };
    await submit('a', t.nonces.share.nonceHex);
    await submit('b', t.nonces.share.nonceHex);
    await submit('c', t.nonces.low.nonceHex);
    await submit('d', t.nonces.block.nonceHex);
    assert.deepEqual(session.stats.byClassification, { local_accepted: 1, rejected_duplicate: 1, rejected_low_diff: 1, block_candidate: 1 });
    assert.equal(session.stats.submits, 4);
  });
});
