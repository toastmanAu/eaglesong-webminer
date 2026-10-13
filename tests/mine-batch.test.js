/**
 * mine-batch.test.js — the pure CPU mining kernel shared by the JS worker and
 * the Node integration tests. Verified against oracle vectors AND against the
 * nonces the real solo proxy accepted in the PASS 0 transcript.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mineRange } from '../src/hash/mine-batch.js';
import { hexToBytes } from '../src/hash/eaglesong-core.js';
import { MAX_U256, targetFromHexLE } from '../src/hash/target.js';
import { U64_MAX } from '../src/hash/nonce.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pow48 = JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/ckb-pow48-vectors.json'), 'utf8')).vectors;
const transcript = JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/stratum-transcripts/solo-proxy-local.json'), 'utf8'));

const jobFromVector = (v, shareTarget, networkTarget = null) => ({
  jobId: 'j1', generation: 1, powHash: hexToBytes(v.powHashHex), prefix8: hexToBytes(v.prefix8Hex), shareTarget, networkTarget,
});

test('with an all-permissive share target every nonce in the range is a candidate carrying the oracle digest', () => {
  for (const v of pow48.slice(0, 8)) {
    const r = mineRange(jobFromVector(v, MAX_U256), { firstLo: BigInt(v.counterLo), count: 1 });
    assert.equal(r.hashes, 1);
    assert.equal(r.candidates.length, 1);
    assert.equal(r.candidates[0].nonceHex, v.nonceHex, v.name);
    assert.equal(r.candidates[0].hashHex, v.expectedHex, v.name);
    assert.equal(r.candidates[0].jobId, 'j1');
    assert.equal(r.candidates[0].generation, 1);
    assert.equal(r.candidates[0].meetsNetwork, false, 'networkTarget null → never a block candidate');
  }
});

test('with a zero share target nothing is a candidate but every hash is counted', () => {
  const r = mineRange(jobFromVector(pow48[0], 0n), { firstLo: 0n, count: 300 });
  assert.equal(r.hashes, 300);
  assert.equal(r.candidates.length, 0);
  assert.equal(r.nextLo, 300n);
});

test('a network-target solution is emitted even when it misses a harder share target', () => {
  const r = mineRange(jobFromVector(pow48[0], 0n, MAX_U256), { firstLo: 0n, count: 1 });
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].meetsNetwork, true);
  assert.equal(r.candidates[0].nonceHex.length, 32);
});

test('reproduces the exact share and block nonces the REAL solo proxy accepted (transcript solo-proxy-local)', () => {
  const t = transcript;
  const job = {
    jobId: t.job.jobId, generation: 3,
    powHash: hexToBytes(t.job.powHashHex), prefix8: hexToBytes(t.prefix8Hex),
    shareTarget: targetFromHexLE(t.job.shareTargetLE), networkTarget: targetFromHexLE(t.job.networkTargetLE),
  };
  const r = mineRange(job, { firstLo: 1n, count: 24000 });
  assert.equal(r.hashes, 24000);
  const first = r.candidates[0];
  assert.equal(first.nonceHex, t.nonces.share.nonceHex, 'first candidate is the proxy-accepted share (counter 974)');
  assert.equal(first.hashHex, t.nonces.share.hashHex);
  assert.equal(first.meetsNetwork, false);
  const block = r.candidates.find(c => c.meetsNetwork);
  assert.ok(block, 'a network-target candidate was found in range');
  assert.equal(block.nonceHex, t.nonces.block.nonceHex, 'it is the nonce that triggered submit_block');
  assert.equal(block.hashHex, t.nonces.block.hashHex);
  assert.ok(!r.candidates.some(c => c.nonceHex === t.nonces.low.nonceHex), 'the rejected low-diff nonce is not a candidate');
  assert.equal(r.bestHashHex <= t.nonces.block.hashHex, true, 'bestHash is at least as good as the block hash');
});

test('web target overlay retains the captured block candidate even when it is below local share difficulty', () => {
  const job = {
    jobId: transcript.job.jobId, generation: 1,
    powHash: hexToBytes(transcript.job.powHashHex), prefix8: hexToBytes(transcript.prefix8Hex),
    shareTarget: ((1n << 256n) - 1n) / 100000n,
    networkTarget: targetFromHexLE(transcript.job.networkTargetLE),
  };
  const r = mineRange(job, { firstLo: 1n, count: 24000 });
  const block = r.candidates.find(c => c.nonceHex === transcript.nonces.block.nonceHex);
  assert.ok(block, 'captured network solution is still sent to the bridge');
  assert.equal(block.hashHex, transcript.nonces.block.hashHex);
  assert.equal(block.meetsNetwork, true);
});

test('a candidate cap stops the batch early and reports nextLo so no nonce is skipped or repeated', () => {
  const v = pow48[3];
  const r = mineRange(jobFromVector(v, MAX_U256), { firstLo: 100n, count: 1000 }, { maxCandidates: 5 });
  assert.equal(r.candidates.length, 5);
  assert.equal(r.hashes, 5);
  assert.equal(r.nextLo, 105n);
  assert.equal(r.truncated, true);
  // resuming from nextLo yields the 6th nonce next
  const r2 = mineRange(jobFromVector(v, MAX_U256), { firstLo: r.nextLo, count: 1 });
  assert.equal(r2.candidates[0].nonceHex.slice(0, 16), '6900000000000000', 'counter 105 = 0x69 LE');
});

test('bestHashHex tracks the numerically smallest digest seen in the batch', () => {
  const v = pow48[5];
  const r = mineRange(jobFromVector(v, 0n), { firstLo: 0n, count: 64 });
  assert.match(r.bestHashHex, /^[0-9a-f]{64}$/);
  // brute-force the same range independently
  const all = [];
  for (let c = 0n; c < 64n; c++) all.push(mineRange(jobFromVector(v, MAX_U256), { firstLo: c, count: 1 }).candidates[0].hashHex);
  assert.equal(r.bestHashHex, all.sort()[0]);
});

test('refuses a range that would run past 2^64 (the allocator must truncate first)', () => {
  assert.throws(() => mineRange(jobFromVector(pow48[0], 0n), { firstLo: U64_MAX, count: 2 }), /2\^64|u64/);
  const ok = mineRange(jobFromVector(pow48[0], 0n), { firstLo: U64_MAX, count: 1 });
  assert.equal(ok.hashes, 1);
  assert.equal(ok.nextLo, U64_MAX + 1n);
});

test('validates its inputs: non-BigInt firstLo, bad count, wrong-length prefix/powHash', () => {
  const v = pow48[0];
  assert.throws(() => mineRange(jobFromVector(v, 0n), { firstLo: 5, count: 1 }), /BigInt/);
  assert.throws(() => mineRange(jobFromVector(v, 0n), { firstLo: 0n, count: 0 }));
  assert.throws(() => mineRange({ ...jobFromVector(v, 0n), prefix8: new Uint8Array(7) }, { firstLo: 0n, count: 1 }));
  assert.throws(() => mineRange({ ...jobFromVector(v, 0n), powHash: new Uint8Array(31) }, { firstLo: 0n, count: 1 }));
  assert.throws(() => mineRange({ ...jobFromVector(v, 0n), shareTarget: 5 }, { firstLo: 0n, count: 1 }), /BigInt/);
});
