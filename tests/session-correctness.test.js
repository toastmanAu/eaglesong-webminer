import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createSession } from '../src/bridge/session.js';
import { targetForExpectedHashes, targetToHexBE } from '../src/hash/target.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/stratum-transcripts/solo-proxy-local.json', import.meta.url), 'utf8'));
const prefix8 = Uint8Array.from(Buffer.from(fixture.prefix8Hex, 'hex'));

test('a network-target candidate rejected upstream is not reported accepted', async () => {
  const sent = [];
  const conn = Object.assign(new EventEmitter(), {
    state: 'authorized',
    async connect() {
      this.emit('target', { shareTarget: 1n << 242n });
      this.emit('job', { jobId: fixture.job.jobId, powHashHex: fixture.job.powHashHex,
        height: fixture.job.height, networkTarget: 1n << 242n, cleanJobs: false });
      return { prefix8 };
    },
    async submit() { return { accepted: false, errorCode: 21, errorMessage: 'stale job' }; },
    close() {},
  });
  const session = createSession({
    config: { bridge: {}, stratum: { host: '127.0.0.1', port: 3334, profile: 'solo-proxy-v1' }, mining: { mode: 'solo' }, payout: {} },
    send: m => sent.push(m), close: () => {}, connectionFactory: () => conn,
  });
  session.handleMessage(JSON.stringify({ v: 1, type: 'start', requestId: 's' }));
  await new Promise(resolve => setImmediate(resolve));
  const job = sent.find(m => m.type === 'job');
  assert.ok(job, JSON.stringify(sent));
  session.handleMessage(JSON.stringify({ v: 1, type: 'submit', requestId: 'b', jobId: job.jobId,
    generation: job.generation, nonceHex: fixture.nonces.block.nonceHex }));
  await new Promise(resolve => setImmediate(resolve));
  const result = sent.find(m => m.requestId === 'b');
  assert.equal(result.classification, 'block_candidate');
  assert.equal(result.accepted, false);
  session.onClose();
});

test('opt-in web target is harder than proxy target and recalibrates by generation', async () => {
  const sent = [];
  const conn = Object.assign(new EventEmitter(), {
    state: 'authorized',
    async connect() {
      this.emit('target', { shareTarget: targetForExpectedHashes(1000n) });
      this.emit('job', { jobId: fixture.job.jobId, powHashHex: fixture.job.powHashHex,
        height: fixture.job.height, networkTarget: 1n << 242n, cleanJobs: false });
      return { prefix8 };
    },
    close() {},
  });
  const session = createSession({
    config: { bridge: {}, stratum: { host: '127.0.0.1', port: 3334, profile: 'solo-proxy-v1' },
      mining: { mode: 'solo', webProfileEnabled: true, targetShareSeconds: 30 }, payout: {} },
    send: m => sent.push(m), close: () => {}, connectionFactory: () => conn,
  });
  assert.equal(sent[0].webProfile, true);
  session.handleMessage(JSON.stringify({ v: 1, type: 'start' }));
  await new Promise(resolve => setImmediate(resolve));
  const job = sent.find(m => m.type === 'job');
  assert.equal(job.shareTargetBE, targetToHexBE(targetForExpectedHashes(100000n)));
  session.handleMessage(JSON.stringify({ v: 1, type: 'calibrate', hashes: 5000, elapsedMs: 5000 }));
  const update = sent.find(m => m.type === 'target');
  assert.equal(update.generation, job.generation + 1);
  assert.equal(update.shareTargetBE, targetToHexBE(targetForExpectedHashes(30000n)));
  session.onClose();
});

test('an ordinary old-job share is rejected despite an upstream that would blindly ACK it', async () => {
  const sent = [];
  let forwarded = 0;
  const conn = Object.assign(new EventEmitter(), {
    state: 'authorized',
    async connect() {
      this.emit('target', { shareTarget: targetForExpectedHashes(1000n) });
      this.emit('job', { jobId: fixture.job.jobId, powHashHex: fixture.job.powHashHex,
        height: fixture.job.height, networkTarget: 1n, cleanJobs: false });
      return { prefix8 };
    },
    async submit() { forwarded++; return { accepted: true }; },
    close() {},
  });
  const session = createSession({
    config: { bridge: {}, stratum: { host: '127.0.0.1', port: 3334, profile: 'solo-proxy-v1' }, mining: { mode: 'solo' }, payout: {} },
    send: m => sent.push(m), close: () => {}, connectionFactory: () => conn,
  });
  session.handleMessage(JSON.stringify({ v: 1, type: 'start' }));
  await new Promise(resolve => setImmediate(resolve));
  const old = sent.find(m => m.type === 'job');
  conn.emit('job', { jobId: 'new', powHashHex: 'ab'.repeat(32), height: fixture.job.height + 1, networkTarget: 1n, cleanJobs: true });
  session.handleMessage(JSON.stringify({ v: 1, type: 'submit', requestId: 'old', jobId: old.jobId,
    generation: old.generation, nonceHex: fixture.nonces.share.nonceHex }));
  await new Promise(resolve => setImmediate(resolve));
  const result = sent.find(m => m.requestId === 'old');
  assert.equal(result.classification, 'rejected_stale');
  assert.equal(result.accepted, false);
  assert.equal(forwarded, 0);
  session.onClose();
});

test('a replacement that reuses the same job ID still rejects an old ordinary share', async () => {
  const sent = [];
  let forwarded = 0;
  const conn = Object.assign(new EventEmitter(), {
    state: 'authorized',
    async connect() {
      this.emit('target', { shareTarget: (1n << 256n) - 1n });
      this.emit('job', { jobId: fixture.job.jobId, powHashHex: fixture.job.powHashHex,
        height: fixture.job.height, networkTarget: 1n, cleanJobs: false });
      return { prefix8 };
    },
    async submit() { forwarded++; return { accepted: true }; },
    close() {},
  });
  const session = createSession({
    config: { bridge: {}, stratum: { host: '127.0.0.1', port: 3334, profile: 'solo-proxy-v1' }, mining: { mode: 'solo' }, payout: {} },
    send: m => sent.push(m), close: () => {}, connectionFactory: () => conn,
  });
  session.handleMessage(JSON.stringify({ v: 1, type: 'start' }));
  await new Promise(resolve => setImmediate(resolve));
  const old = sent.find(m => m.type === 'job');
  conn.emit('job', { jobId: old.jobId, powHashHex: 'ab'.repeat(32),
    height: fixture.job.height + 1, networkTarget: 1n, cleanJobs: true });
  session.handleMessage(JSON.stringify({ v: 1, type: 'submit', requestId: 'old-reused-id', jobId: old.jobId,
    generation: old.generation, nonceHex: fixture.nonces.share.nonceHex }));
  await new Promise(resolve => setImmediate(resolve));
  const result = sent.find(m => m.requestId === 'old-reused-id');
  assert.equal(result.classification, 'rejected_stale');
  assert.equal(forwarded, 0);
  session.onClose();
});

test('a retained old-job network candidate is independently checked and forwarded', async () => {
  const sent = [];
  const forwarded = [];
  const conn = Object.assign(new EventEmitter(), {
    state: 'authorized',
    async connect() {
      this.emit('target', { shareTarget: targetForExpectedHashes(1000n) });
      this.emit('job', { jobId: fixture.job.jobId, powHashHex: fixture.job.powHashHex,
        height: fixture.job.height, networkTarget: 1n << 242n, cleanJobs: false });
      return { prefix8 };
    },
    async submit(jobId, nonceHex) { forwarded.push({ jobId, nonceHex }); return { accepted: true }; },
    close() {},
  });
  const session = createSession({
    config: { bridge: {}, stratum: { host: '127.0.0.1', port: 3334, profile: 'solo-proxy-v1' }, mining: { mode: 'solo' }, payout: {} },
    send: m => sent.push(m), close: () => {}, connectionFactory: () => conn,
  });
  session.handleMessage(JSON.stringify({ v: 1, type: 'start' }));
  await new Promise(resolve => setImmediate(resolve));
  const old = sent.find(m => m.type === 'job');
  conn.emit('job', { jobId: 'new', powHashHex: 'ab'.repeat(32), height: fixture.job.height + 1, networkTarget: 1n << 242n, cleanJobs: true });
  session.handleMessage(JSON.stringify({ v: 1, type: 'submit', requestId: 'old-block', jobId: old.jobId,
    generation: old.generation, nonceHex: fixture.nonces.block.nonceHex }));
  await new Promise(resolve => setImmediate(resolve));
  const result = sent.find(m => m.requestId === 'old-block');
  assert.equal(result.classification, 'block_candidate');
  assert.deepEqual(forwarded, [{ jobId: old.jobId, nonceHex: fixture.nonces.block.nonceHex }]);
  session.onClose();
});

test('a network candidate from a stopped upstream session cannot enter a new upstream session', async () => {
  const sent = [];
  let forwarded = 0;
  const factory = () => Object.assign(new EventEmitter(), {
    state: 'authorized',
    async connect() {
      this.emit('target', { shareTarget: 1n << 242n });
      this.emit('job', { jobId: fixture.job.jobId, powHashHex: fixture.job.powHashHex,
        height: fixture.job.height, networkTarget: 1n << 242n, cleanJobs: false });
      return { prefix8 };
    },
    async submit() { forwarded++; return { accepted: true }; },
    close() {},
  });
  const session = createSession({
    config: { bridge: {}, stratum: { host: '127.0.0.1', port: 3334, profile: 'solo-proxy-v1' }, mining: { mode: 'solo' }, payout: {} },
    send: m => sent.push(m), close: () => {}, connectionFactory: factory,
  });
  session.handleMessage(JSON.stringify({ v: 1, type: 'start' }));
  await new Promise(resolve => setImmediate(resolve));
  const old = sent.find(m => m.type === 'job');
  session.handleMessage(JSON.stringify({ v: 1, type: 'stop' }));
  session.handleMessage(JSON.stringify({ v: 1, type: 'start' }));
  await new Promise(resolve => setImmediate(resolve));
  session.handleMessage(JSON.stringify({ v: 1, type: 'submit', requestId: 'cross-session', jobId: old.jobId,
    generation: old.generation, nonceHex: fixture.nonces.block.nonceHex }));
  await new Promise(resolve => setImmediate(resolve));
  const result = sent.find(m => m.requestId === 'cross-session');
  assert.equal(result.classification, 'rejected_stale');
  assert.equal(forwarded, 0);
  session.onClose();
});
