/**
 * ui-core.test.js — the browser's pure logic modules: the start/stop state
 * machine, rolling hash statistics, and lottery odds. No DOM.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMinerState, STATES } from '../src/ui/miner-state.js';
import { createMiningStats } from '../src/ui/mining-stats.js';
import { oddsForTarget, formatHashrate, formatDuration } from '../src/ui/odds.js';
import { MAX_U256 } from '../src/hash/target.js';

// ── state machine ───────────────────────────────────────────────────────────
test('miner state starts idle and only Start (not a WebSocket open) moves it toward mining', () => {
  const s = createMinerState();
  assert.equal(s.state, 'idle');
  s.dispatch('ws_open');
  assert.equal(s.state, 'idle', 'connected is not mining');
  s.dispatch('hello');
  assert.equal(s.state, 'idle');
  s.dispatch('start_clicked');
  assert.equal(s.state, 'connecting');
  s.dispatch('session_active');
  assert.equal(s.state, 'waiting_for_job');
  s.dispatch('job');
  assert.equal(s.state, 'mining');
});

test('stop from mining goes through stopping to stopped; a later start reconnects', () => {
  const s = createMinerState();
  s.dispatch('start_clicked'); s.dispatch('session_active'); s.dispatch('job');
  s.dispatch('stop_clicked');
  assert.equal(s.state, 'stopping');
  s.dispatch('workers_drained');
  assert.equal(s.state, 'stopped');
  s.dispatch('start_clicked');
  assert.equal(s.state, 'connecting');
});

test('upstream/socket loss while mining → error state with reason; start again is allowed; job while idle is ignored', () => {
  const s = createMinerState();
  s.dispatch('start_clicked'); s.dispatch('session_active'); s.dispatch('job');
  s.dispatch('upstream_closed', { reason: 'socket_closed' });
  assert.equal(s.state, 'error');
  assert.equal(s.reason, 'socket_closed');
  s.dispatch('start_clicked');
  assert.equal(s.state, 'connecting');
  const idle = createMinerState();
  idle.dispatch('job');
  assert.equal(idle.state, 'idle', 'a job never starts hashing by itself');
});

test('ws_closed while mining → error; while idle/stopped → stays (no covert reconnect-and-mine)', () => {
  const s = createMinerState();
  s.dispatch('start_clicked'); s.dispatch('session_active'); s.dispatch('job');
  s.dispatch('ws_closed');
  assert.equal(s.state, 'error');
  const s2 = createMinerState();
  s2.dispatch('ws_closed');
  assert.equal(s2.state, 'idle');
});

test('state machine notifies subscribers on every transition with from/to/event and exposes the state list', () => {
  const s = createMinerState();
  const seen = [];
  s.subscribe((t) => seen.push(t));
  s.dispatch('start_clicked');
  s.dispatch('start_clicked'); // no-op
  assert.deepEqual(seen, [{ from: 'idle', to: 'connecting', event: 'start_clicked', reason: null }]);
  assert.deepEqual([...STATES].sort(), ['connecting', 'error', 'idle', 'mining', 'stopped', 'stopping', 'waiting_for_job'].sort());
});

// ── stats ───────────────────────────────────────────────────────────────────
test('mining stats: total hashes, overall rate, rolling 5s/30s windows and peak, with an injected clock', () => {
  let t = 1_000_000;
  const st = createMiningStats({ now: () => t });
  st.start();
  for (let i = 0; i < 10; i++) { t += 1000; st.addHashes(500, 'cpu'); } // 500 H/s for 10 s
  const snap = st.snapshot();
  assert.equal(snap.totalHashes, 5000);
  assert.ok(Math.abs(snap.rateOverall - 500) < 1, `overall ${snap.rateOverall}`);
  assert.ok(Math.abs(snap.rate5s - 500) < 60, `5s ${snap.rate5s}`);
  assert.ok(Math.abs(snap.rate30s - 500) < 60, `30s ${snap.rate30s}`);
  assert.equal(snap.uptimeMs, 10_000);
  assert.ok(snap.peakRate >= 450);
  assert.equal(snap.byBackend.cpu, 5000);
  // burst then idle: 5s window drops toward 0, 30s stays positive
  t += 10_000;
  st.addHashes(0, 'cpu');
  const after = st.snapshot();
  assert.ok(after.rate5s < 50, `5s after idle ${after.rate5s}`);
  assert.ok(after.rate30s > 100, `30s after idle ${after.rate30s}`);
});

test('mining stats: best hash keeps the numerically smallest digest; share counters are per classification', () => {
  const st = createMiningStats({ now: () => 0 });
  st.recordBestHash('ff'.repeat(32));
  st.recordBestHash('00000000ff' + '00'.repeat(27));
  st.recordBestHash('0000ff' + '00'.repeat(29));
  assert.equal(st.snapshot().bestHashHex, '00000000ff' + '00'.repeat(27));
  assert.ok(st.snapshot().bestDifficulty > 2 ** 32 - 1, 'leading 4 zero bytes ≈ 2^32 work');
  st.recordShare('local_accepted'); st.recordShare('local_accepted'); st.recordShare('rejected_low_diff'); st.recordShare('block_candidate');
  assert.deepEqual(st.snapshot().shares, { local_accepted: 2, rejected_low_diff: 1, block_candidate: 1 });
});

test('mining stats: stop freezes uptime and rates do not grow while stopped', () => {
  let t = 0;
  const st = createMiningStats({ now: () => t });
  st.start(); t = 2000; st.addHashes(1000, 'cpu'); st.stop();
  t = 50_000;
  const s = st.snapshot();
  assert.equal(s.uptimeMs, 2000);
  assert.equal(s.totalHashes, 1000);
});

// ── odds ────────────────────────────────────────────────────────────────────
test('odds: p = (target+1)/2^256, mean interval 1/(H p), P(day) = -expm1(-H p 86400)', () => {
  const target = (1n << 242n) - 1n;          // p = 2^-14
  const o = oddsForTarget(target, 1000);     // 1 kH/s
  assert.ok(Math.abs(o.pPerHash - 2 ** -14) / 2 ** -14 < 1e-9);
  assert.ok(Math.abs(o.meanSecondsPerBlock - 16.384) < 1e-6);
  assert.ok(Math.abs(o.pNextDay - 1) < 1e-9, 'certain within a day at this toy target');
  const hard = oddsForTarget(1n << 200n, 1000); // p = 2^-56
  assert.ok(hard.meanSecondsPerBlock > 1e12);
  assert.ok(hard.pNextDay > 0 && hard.pNextDay < 1e-6);
  assert.equal(oddsForTarget(null, 1000), null, 'unknown target → N/A');
  assert.equal(oddsForTarget(MAX_U256, 0), null, 'zero hashrate → N/A');
  assert.equal(oddsForTarget(MAX_U256, 10).pPerHash, 1);
});

test('formatHashrate / formatDuration produce readable units', () => {
  assert.equal(formatHashrate(0), '0 H/s');
  assert.equal(formatHashrate(950), '950 H/s');
  assert.equal(formatHashrate(12_345), '12.3 kH/s');
  assert.equal(formatHashrate(2_500_000), '2.50 MH/s');
  assert.equal(formatDuration(45), '45 s');
  assert.equal(formatDuration(3600 * 5), '5.0 h');
  assert.equal(formatDuration(86400 * 400), '1.1 years');
  assert.equal(formatDuration(1e15), '> 1 million years');
  assert.equal(formatDuration(Infinity), 'N/A');
});
