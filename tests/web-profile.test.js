import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebProfile } from '../src/bridge/web-profile.js';
import { targetForExpectedHashes } from '../src/hash/target.js';
import { validateClientMessage } from '../src/bridge/ws-schema.js';
import { createProtocolClient } from '../src/ui/protocol-client.js';

test('calibration frame has a closed bounded schema', () => {
  const parse = obj => validateClientMessage(JSON.stringify({ v: 1, type: 'calibrate', ...obj }));
  assert.deepEqual(parse({ hashes: 5000, elapsedMs: 5000 }), { ok: true, msg: { v: 1, type: 'calibrate', hashes: 5000, elapsedMs: 5000 } });
  for (const bad of [
    { hashes: -1, elapsedMs: 5000 }, { hashes: 5000.5, elapsedMs: 5000 },
    { hashes: 5000, elapsedMs: 999 }, { hashes: 5000, elapsedMs: 5000, target: 'ff' },
  ]) assert.equal(parse(bad).ok, false);
});

test('web target starts bounded and never exceeds the upstream acceptance target', () => {
  const profile = createWebProfile({ targetShareSeconds: 30 });
  const easyUpstream = targetForExpectedHashes(1000n);
  const hardUpstream = targetForExpectedHashes(1000000n);
  assert.equal(profile.targetFor(easyUpstream), targetForExpectedHashes(100000n));
  assert.equal(profile.targetFor(hardUpstream), hardUpstream);
});

test('calibration is bounded, throttled, and cannot relax the upstream target', () => {
  let clock = 10000;
  const profile = createWebProfile({ targetShareSeconds: 30, now: () => clock });
  const upstream = targetForExpectedHashes(1000n);
  assert.equal(profile.calibrate({ hashes: 5000, elapsedMs: 5000 }), true); // 1000 H/s → 30k hashes/share
  assert.equal(profile.targetFor(upstream), targetForExpectedHashes(30000n));
  assert.equal(profile.calibrate({ hashes: 1, elapsedMs: 1000 }), false, 'rapid update ignored');
  clock += 5000;
  assert.equal(profile.calibrate({ hashes: 10_000_000, elapsedMs: 1000 }), true);
  assert.equal(profile.targetFor(upstream), targetForExpectedHashes(60_000_000n), '2M H/s cap');
  clock += 5000;
  assert.equal(profile.calibrate({ hashes: 100, elapsedMs: 1000 }), true);
  assert.equal(profile.targetFor(targetForExpectedHashes(100000n)), targetForExpectedHashes(100000n), 'upstream still authoritative');
});

test('invalid counts are rejected without changing target', () => {
  const profile = createWebProfile({ targetShareSeconds: 30, now: () => 10000 });
  const before = profile.targetFor(targetForExpectedHashes(1000n));
  for (const bad of [{ hashes: -1, elapsedMs: 1000 }, { hashes: 1, elapsedMs: 0 }, { hashes: 1e20, elapsedMs: 1000 }]) {
    assert.throws(() => profile.calibrate(bad), /calibration/);
  }
  assert.equal(profile.targetFor(targetForExpectedHashes(1000n)), before);
});

test('a burst of independently valid shares hardens the target despite a low client report', () => {
  let clock = 10000;
  const profile = createWebProfile({ targetShareSeconds: 30, now: () => clock });
  const upstream = targetForExpectedHashes(1000n);
  profile.calibrate({ hashes: 100, elapsedMs: 1000 }); // bounded to 100 H/s → 3k hashes/share
  assert.equal(profile.targetFor(upstream), targetForExpectedHashes(3000n));
  for (let i = 0; i < 3; i++) assert.equal(profile.recordValidShare(), false);
  assert.equal(profile.recordValidShare(), true);
  assert.equal(profile.targetFor(upstream), targetForExpectedHashes(12000n));
  clock += 5000;
  profile.calibrate({ hashes: 100, elapsedMs: 1000 });
  assert.equal(profile.targetFor(upstream), targetForExpectedHashes(12000n), 'untrusted low report cannot undo observed hardening');
});

test('browser only reports calibration after the bridge advertises the opt-in profile', async () => {
  const frames = [];
  let socket;
  class FakeWebSocket {
    constructor() { this.readyState = 0; socket = this; queueMicrotask(() => { this.readyState = 1; this.onopen?.(); }); }
    send(raw) { frames.push(JSON.parse(raw)); }
    close() { this.readyState = 3; }
  }
  const client = createProtocolClient({ url: 'ws://example.org', WebSocketImpl: FakeWebSocket });
  client.connect();
  await new Promise(resolve => queueMicrotask(resolve));
  const hello = enabled => socket.onmessage({ data: JSON.stringify({ v: 1, type: 'hello', sessionId: 'session-1',
    protocol: 'ckb-128nonce-v1', mode: 'solo', webProfile: enabled }) });
  hello(false);
  assert.equal(client.calibrate(5000, 5000), false);
  hello(true);
  assert.equal(client.calibrate(5000, 5000), true);
  assert.deepEqual(frames.at(-1), { v: 1, type: 'calibrate', hashes: 5000, elapsedMs: 5000 });
  client.disconnect();
});
