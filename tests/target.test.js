/**
 * target.test.js — explicit BE/LE target handling and CKB compact_target decode.
 * Expected values are hand-derived powers of two or taken from a real header.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_U256, compactToTarget, targetFromHexBE, targetFromHexLE, targetToHexBE,
  hashToBigInt, meetsTarget, targetForExpectedHashes, expectedHashesForTarget,
  targetFromDifficulty, difficultyFromTarget,
} from '../src/hash/target.js';
import { hexToBytes } from '../src/hash/eaglesong-core.js';

const hexBE = (n) => n.toString(16).padStart(64, '0');
const hexLE = (n) => Buffer.from(hexBE(n), 'hex').reverse().toString('hex');

test('compactToTarget decodes real and synthetic compact targets', () => {
  // real testnet tip header 2026-10-13: compact 0x1d08c0c8 → 0x08c0c8 << 8*(0x1d-3)
  assert.equal(compactToTarget('0x1d08c0c8'), 0x08c0c8n << (8n * 26n));
  assert.equal(compactToTarget(0x1f040000), 1n << 242n, '0x040000 << 224');
  assert.equal(compactToTarget(0x20010000), 1n << 248n, 'ckb dev-chain genesis: 0x010000 << 8*(0x20-3) = 2^(16+232)');
  assert.equal(compactToTarget(0x03ffffff), 0xffffffn, 'exponent 3: mantissa as-is');
  assert.equal(compactToTarget(0x01ff0000), 0xffn, 'exponent 1: mantissa >> 16');
  assert.equal(compactToTarget(0x2100ffff), 0xffffn << 240n, '0xffff << 240 still fits: no clamp');
  assert.equal(compactToTarget(0x22ffffff), MAX_U256, '0xffffff << 248 = 2^272 → clamps to 2^256-1');
});

test('compactToTarget rejects garbage', () => {
  assert.throws(() => compactToTarget('xyz'));
  assert.throws(() => compactToTarget(-1));
  assert.throws(() => compactToTarget(2 ** 32));
});

test('targetFromHexBE / targetFromHexLE are explicit inverses and never guess', () => {
  const t = 1n << 200n;
  assert.equal(targetFromHexBE(hexBE(t)), t);
  assert.equal(targetFromHexLE(hexLE(t)), t);
  assert.notEqual(targetFromHexBE(hexLE(t)), t, 'feeding LE bytes to the BE decoder gives a different number');
  assert.equal(targetFromHexBE(hexLE(t)), 1n << 48n, 'specifically 2^48 — byte 25 from the other end');
  assert.equal(targetToHexBE(t), hexBE(t));
  assert.equal(targetFromHexBE('0x' + hexBE(t)), t, 'tolerates 0x prefix');
});

test('targetFromHex* reject wrong lengths and non-hex', () => {
  for (const bad of ['', '00', 'f'.repeat(63), 'f'.repeat(65), 'g'.repeat(64)]) {
    assert.throws(() => targetFromHexBE(bad), bad || '(empty)');
    assert.throws(() => targetFromHexLE(bad), bad || '(empty)');
  }
});

test('meetsTarget: zero vs max, equality, max vs max-1', () => {
  assert.equal(meetsTarget(hexToBytes('00'.repeat(32)), MAX_U256), true);
  assert.equal(meetsTarget(hexToBytes('ff'.repeat(32)), MAX_U256), true, 'equal counts as meeting');
  assert.equal(meetsTarget(hexToBytes('ff'.repeat(32)), MAX_U256 - 1n), false);
  assert.equal(meetsTarget(hexToBytes(hexBE(1n << 200n)), 1n << 200n), true, 'exact equality at 2^200');
  assert.equal(meetsTarget(hexToBytes(hexBE((1n << 200n) + 1n)), 1n << 200n), false);
  assert.equal(meetsTarget(hexToBytes('ff'.repeat(32)), 0n), false, 'nothing meets a zero target except zero');
  assert.equal(meetsTarget(hexToBytes('00'.repeat(32)), 0n), true);
});

test('meetsTarget reads the hash big-endian: MSB-only hash fails 2^200, LSB-only passes', () => {
  assert.equal(meetsTarget(hexToBytes('ff' + '00'.repeat(31)), 1n << 200n), false);
  assert.equal(meetsTarget(hexToBytes('00'.repeat(31) + 'ff'), 1n << 200n), true);
  assert.equal(hashToBigInt(hexToBytes('ff' + '00'.repeat(31))), 0xffn << 248n);
  assert.equal(hashToBigInt(hexToBytes('00'.repeat(31) + 'ff')), 0xffn);
});

test('a target decoded with the wrong endianness flips the verdict (must fail, no heuristics)', () => {
  const hash = hexToBytes(hexBE(1n << 100n));
  assert.equal(meetsTarget(hash, targetFromHexLE(hexLE(1n << 200n))), true);
  assert.equal(meetsTarget(hash, targetFromHexLE(hexBE(1n << 200n))), false, 'BE string fed to LE decoder → 2^48 → rejects 2^100');
});

test('meetsTarget rejects hashes that are not 32 bytes', () => {
  assert.throws(() => meetsTarget(new Uint8Array(31), MAX_U256));
});

test('targetForExpectedHashes / expectedHashesForTarget are floor inverses with guards', () => {
  assert.equal(targetForExpectedHashes(1n), MAX_U256);
  assert.equal(targetForExpectedHashes(1n << 32n), (MAX_U256) >> 32n);
  assert.equal(expectedHashesForTarget(1n << 242n), MAX_U256 / (1n << 242n));
  assert.equal(expectedHashesForTarget(1n << 242n), (1n << 14n) - 1n, 'floor((2^256-1)/2^242) = 2^14-1');
  assert.equal(targetForExpectedHashes(30 * 1000), MAX_U256 / 30000n, 'accepts a Number count');
  assert.throws(() => targetForExpectedHashes(0n));
  assert.throws(() => targetForExpectedHashes(-5));
  assert.throws(() => targetForExpectedHashes(NaN));
  assert.throws(() => expectedHashesForTarget(0n));
});

test('targetFromDifficulty keeps precision for browser-class difficulties and rejects invalid ones', () => {
  // diff 1 → 2^224 (CKB stratum convention)
  assert.equal(targetFromDifficulty(1), 1n << 224n);
  // 1e-6 and 1.4e-6 must NOT collapse (pitfall 6)
  assert.notEqual(targetFromDifficulty(1e-6), targetFromDifficulty(1.4e-6));
  // 4e-7 must give a finite target, not throw / divide by zero
  const t = targetFromDifficulty(4e-7);
  assert.ok(t > (1n << 224n) && t <= MAX_U256);
  // monotonic: smaller diff → larger target
  assert.ok(targetFromDifficulty(1e-7) > targetFromDifficulty(2e-7));
  // exact for a decimal difficulty: target(1e-6) = 2^224 * 1e6 (within 1e-9 relative)
  const t6 = targetFromDifficulty(1e-6), ref6 = (1n << 224n) * 1000000n;
  assert.ok((t6 > ref6 ? t6 - ref6 : ref6 - t6) * 10n ** 9n < ref6, `target(1e-6)=${t6} vs ${ref6}`);
  // and the expected-hash model: ≈ d * 2^32 hashes per share (floor → within 1e-3)
  assert.ok(Math.abs(Number(expectedHashesForTarget(t6)) / (1e-6 * 2 ** 32) - 1) < 1e-3);
  for (const bad of [0, -1, NaN, Infinity, -Infinity, '1', null, undefined]) {
    assert.throws(() => targetFromDifficulty(bad), `diff=${String(bad)}`);
  }
});

test('difficultyFromTarget is the display inverse of targetFromDifficulty', () => {
  assert.equal(difficultyFromTarget(1n << 224n), 1);
  assert.ok(Math.abs(difficultyFromTarget(targetFromDifficulty(0.00008)) / 0.00008 - 1) < 1e-9);
  assert.throws(() => difficultyFromTarget(0n));
});
