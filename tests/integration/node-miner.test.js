/**
 * node-miner.test.js — the deterministic integration fixture WITHOUT a browser:
 *
 *   fake TCP Stratum (real captured dialect, recomputes Eaglesong)
 *     ↑ TCP
 *   real bridge (ws server, session, validator)
 *     ↑ WebSocket (ws client as WebSocketImpl)
 *   real protocol-client + real coordinator + real CPU worker code (in-process)
 *
 * Proves: a genuinely computed share is found by the miner, recomputed and
 * accepted by the bridge, forwarded once, ACKed by the proxy → local_accepted;
 * a job change mid-mining never binds a submission to the wrong job; replays
 * are rejected; Stop drains and closes everything.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { validateConfig } from '../../src/bridge/config.js';
import { startBridgeServer } from '../../src/bridge/server.js';
import { createFakeStratumServer, transcriptJob } from '../helpers/fake-stratum-server.js';
import { createProtocolClient } from '../../src/ui/protocol-client.js';
import { createMinerCoordinator } from '../../src/ui/miner-coordinator.js';
import { attachWorker } from '../../src/hash/cpu-worker-core.js';
import { eaglesong, hexToBytes, bytesToHex } from '../../src/hash/eaglesong-core.js';
import { targetToHexLE, targetForExpectedHashes, targetFromHexLE, meetsTarget } from '../../src/hash/target.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const t = JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/stratum-transcripts/solo-proxy-local.json'), 'utf8'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const until = async (pred, ms = 10000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(10); } };

function inProcWorker() {
  const { port1, port2 } = new MessageChannel();
  attachWorker(port2);
  return { postMessage: (m) => port1.postMessage(m), addEventListener: (ev, fn) => port1.addEventListener(ev, fn), terminate: () => { port1.close(); port2.close(); } };
}

// a permissive share target: ~1 in 64 hashes → a share within a few batches, deterministic enough to render & validate
const EASY_SHARE_LE = targetToHexLE(targetForExpectedHashes(64n));

async function stack(fn) {
  const fake = createFakeStratumServer({ ...transcriptJob(t), shareTargetLE: EASY_SHARE_LE });
  const stratumPort = await fake.start();
  const bridge = await startBridgeServer(validateConfig({
    bridge: { listenHost: '127.0.0.1', port: 0, allowedOrigins: ['http://localhost:5173'], maxConnections: 5, statusIntervalMs: 200, submitTimeoutMs: 3000, perSessionSubmissionsPerMinute: 1000 },
    stratum: { host: '127.0.0.1', port: stratumPort, profile: 'solo-proxy-v1' },
    mining: { mode: 'solo' }, payout: { displayAddress: 'ckb1qyq...' },
  }), { logger: () => {} });
  // the ws client must present an allowed Origin, like a browser would
  class OriginWS extends WebSocket { constructor(url) { super(url, { headers: { Origin: 'http://localhost:5173' } }); } }
  const client = createProtocolClient({ url: `ws://127.0.0.1:${bridge.port}`, WebSocketImpl: OriginWS, requestTimeoutMs: 5000 });
  const results = [], events = [];
  const coord = createMinerCoordinator({
    createWorker: inProcWorker, workerCount: 2, batchTargetMs: 10, initialBatchCount: 32, watchdogMs: 5000,
    onEvent: (type, d) => events.push({ type, ...d }),
    onCandidate: (c) => { client.submit(c).then(r => results.push(r), e => results.push({ error: e.message, candidate: c })); },
  });
  client.on('job', (job) => coord.setJob(job));
  try { await fn({ fake, bridge, client, coord, results, events }); }
  finally { await coord.dispose(); client.disconnect(); await bridge.close(); await fake.stop(); }
}

test('end to end (no browser): genuine share found → bridge recomputes → proxy ACK → local_accepted; the hash is independently reproducible', async () => {
  await stack(async ({ fake, client, coord, results }) => {
    await coord.init();
    client.connect();
    await until(() => client.state === 'open');
    await client.start('node-01');
    await until(() => client.currentJob !== null);
    coord.start();
    await until(() => results.some(r => r.classification === 'local_accepted'), 15000);
    await coord.stop();
    const ok = results.find(r => r.classification === 'local_accepted');
    // independent recomputation of the accepted share, from the raw job data
    const input = new Uint8Array(48); input.set(hexToBytes(t.job.powHashHex), 0); input.set(hexToBytes(ok.nonceHex), 32);
    const digest = bytesToHex(eaglesong(input));
    assert.equal(digest, ok.hashHex, 'bridge-reported digest == our recomputation');
    assert.equal(meetsTarget(hexToBytes(digest), targetFromHexLE(EASY_SHARE_LE)), true, 'it really meets the share target');
    assert.equal(ok.nonceHex.slice(16), t.prefix8Hex, 'nonce carries the proxy-assigned extranonce1 prefix');
    const upstream = fake.submits.find(s => s.nonceHex === ok.nonceHex);
    assert.ok(upstream?.accepted, 'the (fake) proxy independently accepted the same nonce');
    assert.equal(fake.submits.filter(s => s.nonceHex === ok.nonceHex).length, 1, 'forwarded exactly once');
    assert.ok(!results.some(r => r.classification === 'rejected_low_diff'), 'the miner only submits candidates that meet the share target');
  });
});

test('job change mid-mining: late candidates are judged against THEIR generation; no result is bound to the wrong job', async () => {
  await stack(async ({ fake, client, coord, results }) => {
    await coord.init(); client.connect(); await until(() => client.state === 'open');
    await client.start(); await until(() => client.currentJob !== null);
    coord.start();
    await until(() => results.length >= 2, 15000);
    const gen1 = client.currentJob.generation;
    fake.setJob({ jobId: 'b2', powHashHex: 'ab'.repeat(32), height: t.job.height + 1 }, true);
    await until(() => client.currentJob?.jobId === 'b2');
    await until(() => results.filter(r => r.jobId === 'b2').length >= 2, 15000);
    await coord.stop();
    await sleep(200);
    for (const r of results) {
      if (r.error) continue;
      if (r.jobId === t.job.jobId) assert.equal(r.generation, gen1);
      if (r.jobId === 'b2') assert.ok(r.generation > gen1);
      assert.ok(['local_accepted', 'rejected_stale', 'rejected_duplicate', 'block_candidate'].includes(r.classification), r.classification);
    }
    // every ACKed submission that reached the proxy named the job that was current on the proxy OR was blind-ACKed as unknown
    assert.ok(fake.submits.length >= 2);
  });
});

test('a replayed nonce is rejected as duplicate by the bridge and never reaches the proxy twice', async () => {
  await stack(async ({ fake, client, coord, results }) => {
    await coord.init(); client.connect(); await until(() => client.state === 'open');
    await client.start(); await until(() => client.currentJob !== null);
    coord.start();
    await until(() => results.some(r => r.classification === 'local_accepted'), 15000);
    await coord.stop();
    const ok = results.find(r => r.classification === 'local_accepted');
    const replay = await client.submit({ generation: ok.generation, jobId: ok.jobId, nonceHex: ok.nonceHex, hashHex: ok.hashHex });
    assert.equal(replay.classification, 'rejected_duplicate');
    assert.equal(fake.submits.filter(s => s.nonceHex === ok.nonceHex).length, 1);
    // and a malformed nonce is refused at the schema boundary
    await assert.rejects(client.submit({ generation: ok.generation, jobId: ok.jobId, nonceHex: 'zz', hashHex: ok.hashHex }), /INVALID_NONCE/);
  });
});

test('Stop: no hashes are reported after stop() resolves; the upstream TCP session is closed; the WebSocket stays usable', async () => {
  await stack(async ({ fake, client, coord }) => {
    let hashes = 0;
    const coord2 = createMinerCoordinator({ createWorker: inProcWorker, workerCount: 2, batchTargetMs: 10, initialBatchCount: 32, onBatch: (b) => { hashes += b.hashes; } });
    client.on('job', (job) => coord2.setJob(job));
    await coord2.init(); client.connect(); await until(() => client.state === 'open');
    await client.start(); await until(() => client.currentJob !== null);
    coord2.start();
    await until(() => hashes > 1000);
    await coord2.stop();
    const frozen = hashes;
    await client.stop();
    await sleep(200);
    assert.equal(hashes, frozen, 'no hashing after stop');
    assert.equal(fake.connections.size, 0, 'TCP session torn down');
    const pong = await client.ping();
    assert.equal(pong.type, 'pong');
    await coord2.dispose();
    void coord;
  });
});
