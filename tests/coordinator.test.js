/**
 * coordinator.test.js — the browser miner coordinator against REAL worker code:
 * `attachWorker` (the CPU worker's message handler) runs in-process on a
 * MessageChannel, so the worker protocol, nonce allocation, generation
 * handling, intensity duty cycle, watchdog and exhaustion are all exercised
 * with genuine Eaglesong hashing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachWorker } from '../src/hash/cpu-worker-core.js';
import { createMinerCoordinator } from '../src/ui/miner-coordinator.js';
import { hexToBytes } from '../src/hash/eaglesong-core.js';
import { splitNonce16 } from '../src/hash/nonce.js';
import { MAX_U256, targetFromHexLE } from '../src/hash/target.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const t = JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/stratum-transcripts/solo-proxy-local.json'), 'utf8'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** a Worker-like object whose other end is the real CPU worker code */
function inProcWorker() {
  const { port1, port2 } = new MessageChannel();
  attachWorker(port2);
  return {
    postMessage: (m) => port1.postMessage(m),
    addEventListener: (ev, fn) => port1.addEventListener(ev, fn),
    terminate: () => { port1.close(); port2.close(); },
  };
}
/** a worker that never answers anything (crash/hang simulation) */
function deadWorker() { return { postMessage() {}, addEventListener() {}, terminate() {} }; }

const job = (over = {}) => ({
  jobId: t.job.jobId, generation: 1, powHash: hexToBytes(t.job.powHashHex), prefix8: hexToBytes(t.prefix8Hex),
  shareTarget: MAX_U256, networkTarget: targetFromHexLE(t.job.networkTargetLE), height: t.job.height, cleanJobs: false, receivedAtMs: Date.now(),
  ...over,
});

async function run(opts, fn) {
  const events = [], candidates = [], batches = [];
  const coord = createMinerCoordinator({
    createWorker: inProcWorker, workerCount: 1, intensity: 100, batchTargetMs: 10, initialBatchCount: 64, watchdogMs: 400,
    onCandidate: (c) => candidates.push(c), onBatch: (b) => batches.push(b), onEvent: (type, data) => events.push({ type, ...data }),
    ...opts,
  });
  try { await fn({ coord, events, candidates, batches }); } finally { await coord.dispose(); }
}
const until = async (pred, ms = 3000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(5); } };

test('worker protocol: init → ready with a passing Eaglesong self-test; job+mine → batch with real hashes and candidates', async () => {
  const w = inProcWorker();
  const inbox = [];
  w.addEventListener('message', (e) => inbox.push(e.data));
  w.postMessage({ type: 'init' });
  await until(() => inbox.some(m => m.type === 'ready'));
  assert.equal(inbox[0].selftest, true);
  w.postMessage({ type: 'job', generation: 3, jobId: t.job.jobId, powHashHex: t.job.powHashHex, prefix8Hex: t.prefix8Hex, shareTargetBE: 'f'.repeat(64), networkTargetBE: null });
  w.postMessage({ type: 'mine', generation: 3, firstLo: '974', count: 1 });
  await until(() => inbox.some(m => m.type === 'batch'));
  const b = inbox.find(m => m.type === 'batch');
  assert.equal(b.hashes, 1);
  assert.equal(b.generation, 3);
  assert.equal(b.nextLo, '975');
  assert.equal(b.candidates[0].nonceHex, t.nonces.share.nonceHex);
  assert.equal(b.candidates[0].hashHex, t.nonces.share.hashHex, 'genuine Eaglesong in the worker path');
  assert.equal(typeof b.durationMs, 'number');
  // a mine for a generation the worker does not hold is answered as stale with zero hashes
  w.postMessage({ type: 'mine', generation: 2, firstLo: '0', count: 10 });
  await until(() => inbox.filter(m => m.type === 'batch').length === 2);
  const stale = inbox.filter(m => m.type === 'batch')[1];
  assert.equal(stale.stale, true); assert.equal(stale.hashes, 0);
  w.terminate();
});

test('worker protocol: malformed job/mine messages produce error messages, never crash the worker', async () => {
  const w = inProcWorker();
  const inbox = [];
  w.addEventListener('message', (e) => inbox.push(e.data));
  w.postMessage({ type: 'job', generation: 1, jobId: 'a', powHashHex: 'zz', prefix8Hex: t.prefix8Hex, shareTargetBE: 'f'.repeat(64), networkTargetBE: null });
  await until(() => inbox.some(m => m.type === 'error'));
  w.postMessage({ type: 'mine', generation: 1, firstLo: 'abc', count: 1 });
  await until(() => inbox.filter(m => m.type === 'error').length === 2);
  w.postMessage({ type: 'init' });
  await until(() => inbox.some(m => m.type === 'ready'), 2000);
  w.terminate();
});

test('worker candidate cap returns the unsearched nonce tail', async () => {
  const w = inProcWorker();
  const inbox = [];
  w.addEventListener('message', (e) => inbox.push(e.data));
  try {
    w.postMessage({ type: 'job', generation: 1, jobId: t.job.jobId, powHashHex: t.job.powHashHex,
      prefix8Hex: t.prefix8Hex, shareTargetBE: 'f'.repeat(64), networkTargetBE: null });
    w.postMessage({ type: 'mine', generation: 1, firstLo: '0', count: 16, maxCandidates: 1 });
    await until(() => inbox.some(m => m.type === 'batch'));
    const batch = inbox.find(m => m.type === 'batch');
    assert.equal(batch.hashes, 1);
    assert.equal(batch.candidates.length, 1);
    assert.equal(batch.truncated, true);
    assert.equal(batch.nextLo, '1');
  } finally { w.terminate(); }
});

test('coordinator waits for candidate submission before mining the next range on that worker', async () => {
  let release;
  const candidates = [];
  await run({ workerCount: 1, initialBatchCount: 16, maxCandidatesPerBatch: 1,
    onCandidate: (c) => { candidates.push(c); return new Promise(resolve => { release = resolve; }); } }, async ({ coord }) => {
    await coord.init();
    coord.setJob(job({ shareTarget: MAX_U256, networkTarget: null }));
    coord.start();
    await until(() => candidates.length === 1);
    await sleep(50);
    assert.equal(candidates.length, 1, 'submission backlog must not grow while the first request is pending');
    release();
    await until(() => candidates.length === 2);
    assert.equal(splitNonce16(hexToBytes(candidates[1].nonceHex)).counterLo, 1n);
    await coord.stop();
  });
});

test('coordinator: init spawns N workers (all self-tested), start mines, hashes are reported, candidates carry the session prefix and disjoint counters', async () => {
  await run({ workerCount: 2 }, async ({ coord, candidates, batches }) => {
    const info = await coord.init();
    assert.equal(info.workers, 2);
    assert.equal(info.selftest, true);
    coord.setJob(job());
    coord.start();
    await until(() => candidates.length >= 300);
    await coord.stop();
    const counters = candidates.map(c => splitNonce16(hexToBytes(c.nonceHex)).counterLo);
    assert.equal(new Set(counters.map(String)).size, counters.length, 'no nonce mined twice across workers');
    assert.ok(candidates.every(c => c.nonceHex.slice(16) === t.prefix8Hex));
    assert.ok(candidates.every(c => c.generation === 1 && c.jobId === t.job.jobId));
    const total = batches.reduce((s, b) => s + b.hashes, 0);
    assert.ok(total >= candidates.length);
    assert.equal(coord.snapshot().running, false);
  });
});

test('coordinator: a candidate-capped batch resumes its unsearched tail without skipping nonces', async () => {
  await run({ initialBatchCount: 128 }, async ({ coord, candidates, batches }) => {
    await coord.init();
    coord.setJob(job({ shareTarget: MAX_U256 }));
    coord.start();
    await until(() => candidates.length >= 192);
    await coord.stop();
    assert.ok(batches.some(b => b.truncated), 'worker exercised its 64-candidate cap');
    const counters = candidates.map(c => splitNonce16(hexToBytes(c.nonceHex)).counterLo);
    for (let i = 0; i < counters.length; i++) assert.equal(counters[i], BigInt(i), `counter ${i} was neither skipped nor repeated`);
  });
});

test('coordinator: a target-only generation bump keeps the nonce cursor; a new powHash resets it to 0', async () => {
  await run({}, async ({ coord, candidates }) => {
    await coord.init();
    coord.setJob(job({ shareTarget: 0n })); // no candidates, just advance
    coord.start();
    await until(() => coord.snapshot().cursor > 500n);
    const before = coord.snapshot().cursor;
    coord.setJob(job({ generation: 2, shareTarget: MAX_U256 })); // same powHash+prefix → target-only
    await until(() => candidates.some(c => c.generation === 2));
    const firstGen2 = candidates.filter(c => c.generation === 2).map(c => splitNonce16(hexToBytes(c.nonceHex)).counterLo).sort((a, b) => (a < b ? -1 : 1))[0];
    assert.ok(firstGen2 >= before, `gen2 continues from ${before}, first counter ${firstGen2}`);
    coord.setJob(job({ generation: 3, powHash: hexToBytes('ab'.repeat(32)) })); // new pow hash → reset
    await until(() => candidates.some(c => c.generation === 3));
    const firstGen3 = candidates.filter(c => c.generation === 3).map(c => splitNonce16(hexToBytes(c.nonceHex)).counterLo).sort((a, b) => (a < b ? -1 : 1))[0];
    assert.equal(firstGen3, 0n);
    await coord.stop();
  });
});

test('coordinator: stop() resolves only when no batch is in flight and nothing is dispatched afterwards', async () => {
  await run({ workerCount: 2 }, async ({ coord, batches }) => {
    await coord.init();
    coord.setJob(job({ shareTarget: 0n }));
    coord.start();
    await until(() => batches.length >= 5);
    await coord.stop();
    assert.equal(coord.snapshot().inflight, 0);
    const n = batches.length;
    await sleep(150);
    assert.equal(batches.length, n, 'no batches after stop');
    assert.equal(coord.snapshot().running, false);
  });
});

test('coordinator: intensity below 100 inserts rest periods proportional to batch duration; 100 does not', async () => {
  await run({ intensity: 50 }, async ({ coord, batches }) => {
    await coord.init();
    coord.setJob(job({ shareTarget: 0n }));
    coord.start();
    await until(() => batches.length >= 4);
    await coord.stop();
    const snap = coord.snapshot();
    assert.ok(snap.rests.count >= 3, 'rest periods were scheduled');
    const last = batches[batches.length - 1];
    // at 50% duty the rest equals the batch duration (rounded, min 1ms)
    assert.ok(Math.abs(snap.rests.lastMs - Math.max(1, Math.round(last.durationMs))) <= 1, `rest ${snap.rests.lastMs} vs duration ${last.durationMs}`);
  });
  await run({ intensity: 100 }, async ({ coord, batches }) => {
    await coord.init(); coord.setJob(job({ shareTarget: 0n })); coord.start();
    await until(() => batches.length >= 4); await coord.stop();
    assert.equal(coord.snapshot().rests.count, 0);
  });
});

test('coordinator: adaptive batch size grows when batches finish far below the target duration', async () => {
  await run({ batchTargetMs: 20, initialBatchCount: 16 }, async ({ coord, batches }) => {
    await coord.init(); coord.setJob(job({ shareTarget: 0n })); coord.start();
    await until(() => batches.length >= 8);
    await coord.stop();
    assert.ok(batches[batches.length - 1].count > batches[0].count * 2, `count grew: ${batches[0].count} → ${batches[batches.length - 1].count}`);
  });
});

test('coordinator: a hung worker is detected by the watchdog, reported, and replaced; mining continues', async () => {
  let spawned = 0;
  const factory = () => (spawned++ === 0 ? deadWorker() : inProcWorker());
  await run({ createWorker: factory, watchdogMs: 200 }, async ({ coord, events, batches }) => {
    const info = await coord.init();
    assert.equal(info.workers, 1);
    assert.ok(events.some(e => e.type === 'worker_crash'), 'the watchdog fired during init');
    assert.equal(info.selftest, true, 'the REPLACEMENT worker self-tested before init resolved');
    coord.setJob(job({ shareTarget: 0n }));
    coord.start();
    await until(() => batches.length >= 2, 3000);
    await coord.stop();
    assert.equal(spawned, 2);
  });
});

test('coordinator: reaching 2^64 fails closed — stops and reports exhaustion, never wraps', async () => {
  await run({ initialBatchCount: 1000 }, async ({ coord, events, batches }) => {
    await coord.init();
    coord.setJob(job({ shareTarget: 0n }));
    coord.start({ startLo: (1n << 64n) - 1500n });
    await until(() => events.some(e => e.type === 'exhausted'), 3000);
    await sleep(50);
    assert.equal(coord.snapshot().running, false);
    const total = batches.reduce((s, b) => s + b.hashes, 0);
    assert.equal(total, 1500);
  });
});

test('coordinator: a capped final range is fully mined before exhaustion', async () => {
  await run({ initialBatchCount: 200 }, async ({ coord, events, candidates }) => {
    await coord.init();
    coord.setJob(job({ shareTarget: MAX_U256 }));
    coord.start({ startLo: (1n << 64n) - 130n });
    await until(() => events.some(e => e.type === 'exhausted'));
    assert.equal(candidates.length, 130);
    assert.equal(splitNonce16(hexToBytes(candidates[0].nonceHex)).counterLo, (1n << 64n) - 130n);
    assert.equal(splitNonce16(hexToBytes(candidates.at(-1).nonceHex)).counterLo, (1n << 64n) - 1n);
  });
});

test('coordinator: stale-generation batches still count hashes and still forward their candidates (bridge decides staleness)', async () => {
  await run({ initialBatchCount: 3000 }, async ({ coord, candidates, batches }) => {
    await coord.init();
    coord.setJob(job()); coord.start();
    await until(() => batches.length >= 1);
    coord.setJob(job({ generation: 2, shareTarget: 0n })); // target-only; in-flight gen-1 batches will land after this
    await until(() => batches.length >= 3);
    await coord.stop();
    assert.ok(candidates.some(c => c.generation === 1));
    assert.ok(batches.every(b => b.hashes >= 0));
  });
});

test('coordinator: setWorkerCount adds/removes workers while idle; zero or absurd counts are clamped', async () => {
  await run({ workerCount: 1 }, async ({ coord }) => {
    await coord.init();
    await coord.setWorkerCount(3);
    assert.equal(coord.snapshot().workers, 3);
    await coord.setWorkerCount(0);
    assert.equal(coord.snapshot().workers, 1, 'at least one worker');
    await coord.setWorkerCount(99);
    assert.equal(coord.snapshot().workers, 16, 'hard cap');
  });
});
