import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEndpoint, normalizeMiningAddress, assertExpectedPayout } from '../src/ui/connection-settings.js';

test('custom endpoint accepts secure WebSocket URLs and local development only', () => {
  assert.equal(normalizeEndpoint(' wss://miner.example.org/bridge ', 'https:'), 'wss://miner.example.org/bridge');
  assert.equal(normalizeEndpoint('ws://127.0.0.1:8788', 'http:'), 'ws://127.0.0.1:8788/');
  for (const value of ['https://miner.example.org', 'ws://miner.example.org', 'wss://user:pass@miner.example.org', 'wss://miner.example.org/?token=secret', 'wss://miner.example.org/#frag']) {
    assert.throws(() => normalizeEndpoint(value, 'https:'));
  }
});

test('entered address must have CKB form and match verified solo payout', () => {
  const address = 'ckt1qyqtestpayoutaddress';
  assert.equal(normalizeMiningAddress(` ${address} `), address);
  assert.equal(normalizeMiningAddress(''), '');
  assert.throws(() => normalizeMiningAddress('ckb1bad!'));
  assert.throws(() => assertExpectedPayout(address, null, 'solo'), /verif/i);
  assert.throws(() => assertExpectedPayout(address, { address, verified: false }, 'solo'), /verif/i);
  assert.throws(() => assertExpectedPayout(address, { address: 'ckt1qyqotherpayoutaddress', verified: true }, 'solo'), /does not match/i);
  assert.throws(() => assertExpectedPayout(address, { address, verified: true }, 'pool'), /solo/i);
  assert.doesNotThrow(() => assertExpectedPayout(address, { address, verified: true }, 'solo'));
});
