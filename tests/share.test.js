/**
 * share.test.js — bridge-side job registry (generation snapshots + duplicate
 * set) and share validator (independent Eaglesong recomputation). Driven by the
 * job/nonces the REAL solo proxy issued and accepted in the PASS 0 transcript.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSessionJobRegistry } from '../src/bridge/job-registry.js';
import { evaluateSubmit } from '../src/bridge/share-validator.js';
import { hexToBytes } from '../src/hash/eaglesong-core.js';
import { targetFromHexLE, MAX_U256 } from '../src/hash/target.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const t = JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/stratum-transcripts/solo-proxy-local.json'), 'utf8'));

function snapshotFromTranscript(overrides = {}) {
  return {
    jobId: t.job.jobId,
    powHash: hexToBytes(t.job.powHashHex),
    prefix8: hexToBytes(t.prefix8Hex),
    shareTarget: targetFromHexLE(t.job.shareTargetLE),
    networkTarget: targetFromHexLE(t.job.networkTargetLE),
    height: t.job.height,
    cleanJobs: false,
    receivedAt: 1_700_000_000_000,
    ...overrides,
  };
}
function registryWithJob(overrides) {
  const reg = createSessionJobRegistry({ maxJobs: 4 });
  const snap = reg.add(snapshotFromTranscript(overrides));
  return { reg, snap };
}
const submitFor = (snap, nonceHex, extra = {}) => ({ jobId: snap.jobId, generation: snap.generation, nonceHex, ...extra });

// ── registry ────────────────────────────────────────────────────────────────
test('registry assigns strictly increasing generations starting at 1 and exposes current', () => {
  const reg = createSessionJobRegistry({ maxJobs: 4 });
  const a = reg.add(snapshotFromTranscript());
  const b = reg.add(snapshotFromTranscript());
  assert.equal(a.generation, 1);
  assert.equal(b.generation, 2);
  assert.equal(reg.current.generation, 2);
  assert.equal(reg.get(1).generation, 1);
  assert.equal(reg.get(99), undefined);
});

test('registry evicts the oldest generation past maxJobs (bounded grace window)', () => {
  const reg = createSessionJobRegistry({ maxJobs: 3 });
  for (let i = 0; i < 5; i++) reg.add(snapshotFromTranscript());
  assert.equal(reg.size, 3);
  assert.equal(reg.get(1), undefined);
  assert.equal(reg.get(2), undefined);
  assert.ok(reg.get(3) && reg.get(4) && reg.get(5));
});

test('registry snapshots are frozen copies: later mutation of the input does not change the stored job', () => {
  const reg = createSessionJobRegistry({ maxJobs: 3 });
  const input = snapshotFromTranscript();
  const snap = reg.add(input);
  input.jobId = 'tampered';
  input.powHash[0] ^= 0xff;
  assert.equal(reg.get(snap.generation).jobId, t.job.jobId);
  assert.equal(reg.get(snap.generation).powHash[0], hexToBytes(t.job.powHashHex)[0]);
  assert.ok(Object.isFrozen(snap));
});

test('registry duplicate set is keyed by {jobId, nonceHex} across generations and dropped with the job', () => {
  const reg = createSessionJobRegistry({ maxJobs: 2 });
  const a = reg.add(snapshotFromTranscript());
  assert.equal(reg.markSubmitted(a.jobId, t.nonces.share.nonceHex), true, 'first time');
  assert.equal(reg.markSubmitted(a.jobId, t.nonces.share.nonceHex), false, 'duplicate');
  const b = reg.add(snapshotFromTranscript()); // same jobId, new generation (target-only bump)
  assert.equal(reg.markSubmitted(b.jobId, t.nonces.share.nonceHex), false, 'same jobId+nonce is still a duplicate');
  assert.equal(reg.markSubmitted('other-job', t.nonces.share.nonceHex), true, 'different job, same nonce is fine');
  reg.add(snapshotFromTranscript({ jobId: 'x' })); reg.add(snapshotFromTranscript({ jobId: 'y' })); // evict a and b
  assert.equal(reg.markSubmitted(a.jobId, t.nonces.share.nonceHex), true, 'duplicate memory is bounded with the job window');
});

// ── validator ───────────────────────────────────────────────────────────────
test('share nonce from the transcript → share_ok with the recomputed digest equal to what the proxy accepted', () => {
  const { reg, snap } = registryWithJob();
  const r = evaluateSubmit(reg, submitFor(snap, t.nonces.share.nonceHex));
  assert.equal(r.classification, 'share_ok');
  assert.equal(r.hashHex, t.nonces.share.hashHex);
  assert.equal(r.meetsShare, true);
  assert.equal(r.meetsNetwork, false);
  assert.equal(r.snapshot.generation, snap.generation);
});

test('block nonce from the transcript → block_candidate (meets network target), even below the share target', () => {
  const { reg, snap } = registryWithJob();
  const r = evaluateSubmit(reg, submitFor(snap, t.nonces.block.nonceHex));
  assert.equal(r.classification, 'block_candidate');
  assert.equal(r.hashHex, t.nonces.block.hashHex);
  assert.equal(r.meetsNetwork, true);
  // same nonce with an impossibly hard share target is STILL a block candidate
  const { reg: reg2, snap: snap2 } = registryWithJob({ shareTarget: 0n });
  assert.equal(evaluateSubmit(reg2, submitFor(snap2, t.nonces.block.nonceHex)).classification, 'block_candidate');
});

test('low nonce from the transcript → rejected_low_diff with the recomputed hash reported', () => {
  const { reg, snap } = registryWithJob();
  const r = evaluateSubmit(reg, submitFor(snap, t.nonces.low.nonceHex));
  assert.equal(r.classification, 'rejected_low_diff');
  assert.equal(r.hashHex, t.nonces.low.hashHex);
});

test('the same nonce submitted twice → rejected_duplicate the second time (even for a block candidate)', () => {
  const { reg, snap } = registryWithJob();
  assert.equal(evaluateSubmit(reg, submitFor(snap, t.nonces.share.nonceHex)).classification, 'share_ok');
  assert.equal(evaluateSubmit(reg, submitFor(snap, t.nonces.share.nonceHex)).classification, 'rejected_duplicate');
  assert.equal(evaluateSubmit(reg, submitFor(snap, t.nonces.block.nonceHex)).classification, 'block_candidate');
  assert.equal(evaluateSubmit(reg, submitFor(snap, t.nonces.block.nonceHex)).classification, 'rejected_duplicate');
});

test('unknown generation (never issued or evicted) → rejected_stale, never accepted', () => {
  const { reg, snap } = registryWithJob();
  assert.equal(evaluateSubmit(reg, { ...submitFor(snap, t.nonces.block.nonceHex), generation: 42 }).classification, 'rejected_stale');
  const reg2 = createSessionJobRegistry({ maxJobs: 1 });
  const old = reg2.add(snapshotFromTranscript());
  reg2.add(snapshotFromTranscript({ jobId: 'next' }));
  assert.equal(evaluateSubmit(reg2, submitFor(old, t.nonces.block.nonceHex)).classification, 'rejected_stale', 'evicted');
});

test('jobId that does not match the generation snapshot → rejected_invalid', () => {
  const { reg, snap } = registryWithJob();
  const r = evaluateSubmit(reg, { ...submitFor(snap, t.nonces.share.nonceHex), jobId: 'zz' });
  assert.equal(r.classification, 'rejected_invalid');
  assert.match(r.reason, /job/i);
});

test('nonce whose high 8 bytes are not this session prefix → rejected_invalid (never forwarded)', () => {
  const { reg, snap } = registryWithJob();
  const foreign = t.nonces.share.nonceHex.slice(0, 16) + 'deadbeef00000000';
  const r = evaluateSubmit(reg, submitFor(snap, foreign));
  assert.equal(r.classification, 'rejected_invalid');
  assert.match(r.reason, /prefix/i);
});

test('a late share is judged against the target in effect for ITS generation, not the current one', () => {
  const reg = createSessionJobRegistry({ maxJobs: 4 });
  const easy = reg.add(snapshotFromTranscript());                       // gen 1: proxy share target
  reg.add(snapshotFromTranscript({ shareTarget: 1n }));                  // gen 2: target-only bump, impossibly hard
  assert.equal(evaluateSubmit(reg, submitFor(easy, t.nonces.share.nonceHex)).classification, 'share_ok');
  const hardSnap = reg.get(2);
  assert.equal(evaluateSubmit(reg, submitFor(hardSnap, t.nonces.low.nonceHex)).classification, 'rejected_low_diff');
});

test('a client-asserted hashHex is diagnostic only: a mismatch is flagged but the verdict comes from recomputation', () => {
  const { reg, snap } = registryWithJob();
  const r = evaluateSubmit(reg, submitFor(snap, t.nonces.share.nonceHex, { hashHex: 'ff'.repeat(32) }));
  assert.equal(r.classification, 'share_ok');
  assert.equal(r.clientHashMismatch, true);
  const { reg: reg2, snap: snap2 } = registryWithJob();
  const ok = evaluateSubmit(reg2, submitFor(snap2, t.nonces.share.nonceHex, { hashHex: t.nonces.share.hashHex }));
  assert.equal(ok.clientHashMismatch, false);
  // and a correct-looking client hash cannot promote a low-diff nonce
  const { reg: reg3, snap: snap3 } = registryWithJob();
  assert.equal(evaluateSubmit(reg3, submitFor(snap3, t.nonces.low.nonceHex, { hashHex: '00'.repeat(32) })).classification, 'rejected_low_diff');
});

test('with networkTarget unknown (pool mode) nothing can be a block candidate', () => {
  const { reg, snap } = registryWithJob({ networkTarget: null, shareTarget: MAX_U256 });
  const r = evaluateSubmit(reg, submitFor(snap, t.nonces.block.nonceHex));
  assert.equal(r.classification, 'share_ok');
  assert.equal(r.meetsNetwork, false);
});

test('duplicate check happens before any upstream-visible state: a stale or invalid submit does not poison the duplicate set', () => {
  const { reg, snap } = registryWithJob();
  evaluateSubmit(reg, { ...submitFor(snap, t.nonces.share.nonceHex), jobId: 'zz' }); // invalid
  assert.equal(evaluateSubmit(reg, submitFor(snap, t.nonces.share.nonceHex)).classification, 'share_ok', 'still first legit submission');
});
