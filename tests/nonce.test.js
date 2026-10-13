/**
 * nonce.test.js — the 128-bit CKB nonce: raw LE bytes, numeric value, canonical
 * RPC spelling, counter||prefix assembly, and disjoint range allocation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  U64_MAX, rawNonceHexToBigInt, bigIntToRawNonceHex, rawNonceHexToRpcNonce, rpcNonceToRawNonceHex,
  buildNonce16, splitNonce16, createRangeAllocator,
} from '../src/hash/nonce.js';
import { hexToBytes, bytesToHex } from '../src/hash/eaglesong-core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pow48 = JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/ckb-pow48-vectors.json'), 'utf8')).vectors;

test('MANDATORY regression: raw 01000000000000001122334400000000 → numeric 0x…443322110000000000000001 → canonical RPC 0x443322110000000000000001 → same raw bytes', () => {
  const raw = '01000000000000001122334400000000';
  assert.equal(rawNonceHexToBigInt(raw), 0x00000000443322110000000000000001n);
  assert.equal(rawNonceHexToRpcNonce(raw), '0x443322110000000000000001', 'no redundant leading zeros');
  assert.equal(rpcNonceToRawNonceHex('0x443322110000000000000001'), raw);
  assert.equal(rpcNonceToRawNonceHex('0x00000000443322110000000000000001'), raw, 'the padded spelling is the same number');
});

test('real mainnet block 0x12f7887: append-order bytes ↔ canonical header nonce', () => {
  assert.equal(rawNonceHexToRpcNonce('0d010deb04000000a75a193f89b08217'), '0x1782b0893f195aa700000004eb0d010d');
  assert.equal(rpcNonceToRawNonceHex('0x1782b0893f195aa700000004eb0d010d'), '0d010deb04000000a75a193f89b08217');
});

test('all-zero nonce is 0x0, never empty; leading zero bytes in the raw string are preserved on the way back', () => {
  assert.equal(rawNonceHexToRpcNonce('00'.repeat(16)), '0x0');
  assert.equal(rpcNonceToRawNonceHex('0x0'), '00'.repeat(16));
  assert.equal(rawNonceHexToRpcNonce('112233445566778899aabbccddeeff00'), '0xffeeddccbbaa998877665544332211');
  assert.equal(rpcNonceToRawNonceHex('0xffeeddccbbaa998877665544332211'), '112233445566778899aabbccddeeff00');
});

test('raw nonce helpers reject anything but exactly 32 lowercase-normalizable hex chars', () => {
  for (const bad of ['', '01', '0'.repeat(31), '0'.repeat(33), 'g'.repeat(32), '0x' + '0'.repeat(30)]) {
    assert.throws(() => rawNonceHexToBigInt(bad), bad || '(empty)');
    assert.throws(() => rawNonceHexToRpcNonce(bad), bad || '(empty)');
  }
  assert.equal(rawNonceHexToRpcNonce('0X' + 'AB'.repeat(16)), '0x' + 'ab'.repeat(16), 'accepts 0x/uppercase, emits lowercase');
  assert.throws(() => rpcNonceToRawNonceHex('0x1' + '0'.repeat(32)), /128/);
  assert.throws(() => rpcNonceToRawNonceHex('12'), /0x/);
});

test('buildNonce16 places counter_u64_le at bytes 0..7 and prefix at 8..15 for 0, 1, 2^32-1, 2^32, 2^64-1', () => {
  const prefix = hexToBytes('1122334455667788');
  assert.equal(bytesToHex(buildNonce16(0n, prefix)), '0000000000000000' + '1122334455667788');
  assert.equal(bytesToHex(buildNonce16(1n, prefix)), '0100000000000000' + '1122334455667788');
  assert.equal(bytesToHex(buildNonce16((1n << 32n) - 1n, prefix)), 'ffffffff00000000' + '1122334455667788');
  assert.equal(bytesToHex(buildNonce16(1n << 32n, prefix)), '0000000001000000' + '1122334455667788');
  assert.equal(bytesToHex(buildNonce16(U64_MAX, prefix)), 'ffffffffffffffff' + '1122334455667788');
});

test('buildNonce16 matches the oracle fixtures byte-for-byte and splitNonce16 inverts it', () => {
  for (const v of pow48) {
    const n = buildNonce16(BigInt(v.counterLo), hexToBytes(v.prefix8Hex));
    assert.equal(bytesToHex(n), v.nonceHex, v.name);
    const { counterLo, prefix8 } = splitNonce16(n);
    assert.equal(counterLo, BigInt(v.counterLo));
    assert.equal(bytesToHex(prefix8), v.prefix8Hex);
    assert.equal(rawNonceHexToBigInt(v.nonceHex) & U64_MAX, BigInt(v.counterLo), 'counter is the low 64 bits of the number');
  }
});

test('buildNonce16 fails closed on out-of-range counter or wrong prefix length', () => {
  const prefix = new Uint8Array(8);
  assert.throws(() => buildNonce16(-1n, prefix));
  assert.throws(() => buildNonce16(1n << 64n, prefix));
  assert.throws(() => buildNonce16(5, prefix), /BigInt/i, 'Number counters are refused (2^53 trap)');
  assert.throws(() => buildNonce16(1n, new Uint8Array(7)));
  assert.throws(() => buildNonce16(1n, new Uint8Array(9)));
});

test('buildNonce16 can write into a caller-provided 16-byte buffer', () => {
  const out = new Uint8Array(16);
  const r = buildNonce16(258n, hexToBytes('00'.repeat(8)), out);
  assert.equal(r, out);
  assert.equal(bytesToHex(out), '0201000000000000' + '00'.repeat(8));
});

test('range allocator hands out >1M disjoint, contiguous nonces across 1..16 consumers', () => {
  for (const workers of [1, 2, 3, 8, 16]) {
    const alloc = createRangeAllocator();
    const ranges = [];
    let total = 0n;
    // interleave requests of varying sizes, like workers finishing at different times
    for (let i = 0; total < 1_100_000n; i++) {
      const count = 1000 + ((i * 7919) % 5000);
      const r = alloc.next(count);
      assert.equal(typeof r.firstLo, 'bigint');
      assert.equal(r.count, count);
      ranges.push(r); total += BigInt(count);
    }
    ranges.sort((a, b) => (a.firstLo < b.firstLo ? -1 : 1));
    for (let i = 1; i < ranges.length; i++) {
      assert.equal(ranges[i].firstLo, ranges[i - 1].firstLo + BigInt(ranges[i - 1].count), `workers=${workers}: gap or overlap at range ${i}`);
    }
    assert.equal(ranges[0].firstLo, 0n);
    assert.equal(alloc.cursor, total);
  }
});

test('range allocator survives the 2^53 boundary without losing precision', () => {
  const alloc = createRangeAllocator({ start: (1n << 53n) - 500n });
  const a = alloc.next(1000);
  const b = alloc.next(1000);
  assert.equal(b.firstLo, a.firstLo + 1000n);
  assert.equal(b.firstLo, (1n << 53n) + 500n);
});

test('range allocator fails closed at 2^64: last range is truncated, then exhausted, never wraps', () => {
  const alloc = createRangeAllocator({ start: U64_MAX - 10n });
  const r = alloc.next(1000);
  assert.equal(r.count, 11, 'only the remaining nonces are handed out');
  assert.equal(r.firstLo + BigInt(r.count) - 1n, U64_MAX);
  assert.equal(alloc.next(1), null, 'exhausted');
  assert.equal(alloc.exhausted, true);
});

test('range allocator: reset() returns to 0 (new powHash/prefix) and cursor is readable for target-only updates', () => {
  const alloc = createRangeAllocator();
  alloc.next(5000);
  assert.equal(alloc.cursor, 5000n, 'a target-only change keeps mining from here');
  alloc.reset();
  assert.equal(alloc.cursor, 0n);
  assert.equal(alloc.exhausted, false);
});

test('range allocator rejects a non-positive or non-integer count', () => {
  const alloc = createRangeAllocator();
  assert.throws(() => alloc.next(0));
  assert.throws(() => alloc.next(-1));
  assert.throws(() => alloc.next(1.5));
});

test('bigIntToRawNonceHex inverts rawNonceHexToBigInt and refuses out-of-range values', () => {
  for (const v of pow48) assert.equal(bigIntToRawNonceHex(rawNonceHexToBigInt(v.nonceHex)), v.nonceHex);
  assert.throws(() => bigIntToRawNonceHex(1n << 128n));
  assert.throws(() => bigIntToRawNonceHex(-1n));
});
