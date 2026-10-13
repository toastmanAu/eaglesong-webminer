/**
 * hash-vectors.test.js — the browser Eaglesong core (Uint8Array, no Buffer)
 * against the official vectors and the Rust-oracle 48-byte CKB vectors.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eaglesong, createCkbHasher, hexToBytes, bytesToHex } from '../src/hash/eaglesong-core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const official = JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/eaglesong-vectors.json'), 'utf8')).vectors;
const pow48 = JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/ckb-pow48-vectors.json'), 'utf8')).vectors;

test('eaglesong() reproduces every official vector (empty, ASCII, multi-block)', () => {
  for (const v of official) {
    assert.equal(bytesToHex(eaglesong(hexToBytes(v.inputHex))), v.expectedHex, v.source);
  }
});

test('eaglesong() over powHash||nonce agrees with the Rust oracle on all 64 CKB vectors', () => {
  for (const v of pow48) {
    assert.equal(bytesToHex(eaglesong(hexToBytes(v.inputHex))), v.expectedHex, v.name);
  }
});

test('eaglesong() returns a fresh 32-byte Uint8Array, never a Node Buffer', () => {
  const out = eaglesong(new Uint8Array(0));
  assert.equal(out.constructor, Uint8Array);
  assert.equal(out.length, 32);
});

test('eaglesong() does not mutate its input', () => {
  const input = hexToBytes(pow48[0].inputHex);
  const copy = Uint8Array.from(input);
  eaglesong(input);
  assert.deepEqual(input, copy);
});

test('createCkbHasher(powHash) with precomputed first-block state matches the generic sponge on all 64 vectors', () => {
  for (const v of pow48) {
    const hasher = createCkbHasher(hexToBytes(v.powHashHex));
    assert.equal(bytesToHex(hasher.hash(hexToBytes(v.nonceHex))), v.expectedHex, v.name);
  }
});

test('createCkbHasher().hash() reuses its output buffer only when asked, so results are independent by default', () => {
  const v0 = pow48[0], v1 = pow48[1];
  const hasher = createCkbHasher(hexToBytes(v0.powHashHex));
  const a = hasher.hash(hexToBytes(v0.nonceHex));
  const b = hasher.hash(hexToBytes(pow48[2].nonceHex)); // different nonce, same powHash
  assert.equal(bytesToHex(a), v0.expectedHex, 'first result still intact after second call');
  assert.notEqual(bytesToHex(b), v0.expectedHex);
  // and a different powHash gives the oracle's digest for that vector
  assert.equal(bytesToHex(createCkbHasher(hexToBytes(v1.powHashHex)).hash(hexToBytes(v1.nonceHex))), v1.expectedHex);
});

test('createCkbHasher rejects a powHash that is not exactly 32 bytes', () => {
  assert.throws(() => createCkbHasher(new Uint8Array(31)), /32/);
  assert.throws(() => createCkbHasher(new Uint8Array(33)), /32/);
});

test('hexToBytes/bytesToHex round-trip and reject odd or non-hex input', () => {
  assert.equal(bytesToHex(hexToBytes('00ff10')), '00ff10');
  assert.equal(bytesToHex(hexToBytes('0xABCD')), 'abcd', 'accepts 0x prefix and uppercase, emits lowercase');
  assert.throws(() => hexToBytes('abc'), /odd/i);
  assert.throws(() => hexToBytes('zz'), /hex/i);
});
