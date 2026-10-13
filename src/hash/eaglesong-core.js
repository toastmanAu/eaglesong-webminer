/**
 * eaglesong-core.js — Eaglesong (CKB PoW hash) for browsers and Node.
 *
 * Pure Uint8Array / Uint32Array; no Node Buffer. Algorithm per RFC 0010 and the
 * official nervosnetwork/eaglesong implementation (MIT). Port lineage:
 * NerdMiner_CKB `eaglesong.cpp` (MIT, Bitmaker) → ckb-stratum-proxy `eaglesong.js`
 * → this module. Constants come straight from the official `const_vars.rs`.
 *
 *   state   16 × u32 (512 bits), rate 256 bits (8 words), 43 rounds, delimiter 0x06
 *   absorb  big-endian byte → word packing (input[0] is the MSB of state[0])
 *   squeeze little-endian word → byte unpacking (state[0] LSB is output[0])
 *
 * For CKB mining the 48-byte input powHash(32) || nonce(16) spans exactly two
 * rate blocks; the first block is the pow hash alone, so `createCkbHasher`
 * absorbs it once and only re-runs the second absorption + permutation per nonce.
 */
import { COEFFICIENTS, INJECTION_CONSTANTS, NUM_ROUNDS, DELIMITER } from './eaglesong-constants.js';

const RATE_BYTES = 32;
const RATE_WORDS = 8;

/** @param {string} hex */
export function hexToBytes(hex) {
  if (typeof hex !== 'string') throw new TypeError('hex must be a string');
  const h = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) throw new RangeError(`odd hex length ${h.length}`);
  if (!/^[0-9a-fA-F]*$/.test(h)) throw new RangeError('not a hex string');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
/** @param {Uint8Array} bytes */
export function bytesToHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += HEX[bytes[i]];
  return s;
}

/**
 * One Eaglesong permutation (43 rounds) in place.
 * @param {Uint32Array} s  state (16 words)
 * @param {Uint32Array} n  scratch (16 words)
 */
function permutation(s, n) {
  for (let round = 0; round < NUM_ROUNDS; round++) {
    // Step 1: bit-matrix multiply (fixed XOR pattern of the official BIT_MATRIX)
    n[0]  = s[0] ^ s[4] ^ s[5] ^ s[6] ^ s[7] ^ s[12] ^ s[15];
    n[1]  = s[0] ^ s[1] ^ s[4] ^ s[8] ^ s[12] ^ s[13] ^ s[15];
    n[2]  = s[0] ^ s[1] ^ s[2] ^ s[4] ^ s[6] ^ s[7] ^ s[9] ^ s[12] ^ s[13] ^ s[14] ^ s[15];
    n[3]  = s[0] ^ s[1] ^ s[2] ^ s[3] ^ s[4] ^ s[6] ^ s[8] ^ s[10] ^ s[12] ^ s[13] ^ s[14];
    n[4]  = s[1] ^ s[2] ^ s[3] ^ s[4] ^ s[5] ^ s[7] ^ s[9] ^ s[11] ^ s[13] ^ s[14] ^ s[15];
    n[5]  = s[0] ^ s[2] ^ s[3] ^ s[7] ^ s[8] ^ s[10] ^ s[14];
    n[6]  = s[1] ^ s[3] ^ s[4] ^ s[8] ^ s[9] ^ s[11] ^ s[15];
    n[7]  = s[0] ^ s[2] ^ s[6] ^ s[7] ^ s[9] ^ s[10] ^ s[15];
    n[8]  = s[0] ^ s[1] ^ s[3] ^ s[4] ^ s[5] ^ s[6] ^ s[8] ^ s[10] ^ s[11] ^ s[12] ^ s[15];
    n[9]  = s[0] ^ s[1] ^ s[2] ^ s[9] ^ s[11] ^ s[13] ^ s[15];
    n[10] = s[0] ^ s[1] ^ s[2] ^ s[3] ^ s[4] ^ s[5] ^ s[6] ^ s[7] ^ s[10] ^ s[14] ^ s[15];
    n[11] = s[0] ^ s[1] ^ s[2] ^ s[3] ^ s[8] ^ s[11] ^ s[12];
    n[12] = s[1] ^ s[2] ^ s[3] ^ s[4] ^ s[9] ^ s[12] ^ s[13];
    n[13] = s[2] ^ s[3] ^ s[4] ^ s[5] ^ s[10] ^ s[13] ^ s[14];
    n[14] = s[3] ^ s[4] ^ s[5] ^ s[6] ^ s[11] ^ s[14] ^ s[15];
    n[15] = s[0] ^ s[1] ^ s[2] ^ s[3] ^ s[5] ^ s[7] ^ s[8] ^ s[9] ^ s[10] ^ s[11] ^ s[15];

    // Step 2: circulant multiplication (xor with two rotations), Step 3: constant injection
    const ic = round * 16;
    for (let j = 0; j < 16; j++) {
      const w = n[j];
      const r1 = COEFFICIENTS[3 * j + 1];
      const r2 = COEFFICIENTS[3 * j + 2];
      s[j] = (w ^ ((w << r1) | (w >>> (32 - r1))) ^ ((w << r2) | (w >>> (32 - r2)))) ^ INJECTION_CONSTANTS[ic + j];
    }

    // Step 4: addition / rotation / addition on pairs (s[p+1] uses the updated s[p])
    for (let p = 0; p < 16; p += 2) {
      const b = s[p + 1];
      const sum = (s[p] + b) >>> 0;
      const a = (sum << 8) | (sum >>> 24);
      s[p] = a;
      s[p + 1] = a + ((b << 24) | (b >>> 8));
    }
  }
}

/**
 * Absorb one 32-byte rate block starting at `offset` of `input` (length `len`),
 * applying the delimiter and zero padding exactly like the reference sponge.
 */
function absorbBlock(s, input, offset, len) {
  for (let j = 0; j < RATE_WORDS; j++) {
    let word = 0;
    for (let k = 0; k < 4; k++) {
      const idx = offset + j * 4 + k;
      if (idx < len) word = (word << 8) ^ input[idx];
      else if (idx === len) word = (word << 8) ^ DELIMITER;
      // idx > len: no shift, word unchanged
    }
    s[j] ^= word;
  }
}

function squeeze32(s, out) {
  for (let j = 0; j < RATE_WORDS; j++) {
    const w = s[j];
    out[j * 4] = w & 0xff;
    out[j * 4 + 1] = (w >>> 8) & 0xff;
    out[j * 4 + 2] = (w >>> 16) & 0xff;
    out[j * 4 + 3] = (w >>> 24) & 0xff;
  }
  return out;
}

/**
 * eaglesong(input) → 32-byte digest.
 * @param {Uint8Array} input
 * @param {Uint8Array} [out] optional 32-byte output buffer
 * @returns {Uint8Array}
 */
export function eaglesong(input, out) {
  if (!(input instanceof Uint8Array)) throw new TypeError('input must be a Uint8Array');
  const s = new Uint32Array(16);
  const n = new Uint32Array(16);
  const len = input.length;
  const numBlocks = Math.ceil(((len + 1) * 8) / 256);
  for (let blk = 0; blk < numBlocks; blk++) {
    absorbBlock(s, input, blk * RATE_BYTES, len);
    permutation(s, n);
  }
  return squeeze32(s, out && out.length === 32 ? out : new Uint8Array(32));
}

/**
 * createCkbHasher(powHash32) → { hash(nonce16, out?) }
 * Precomputes the sponge state after absorbing the 32-byte pow hash (block 0).
 * Each hash() copies that state, absorbs nonce16 || 0x06 || zero padding as
 * block 1, permutes once and squeezes 32 bytes. Bit-identical to eaglesong().
 * @param {Uint8Array} powHash32
 */
export function createCkbHasher(powHash32) {
  if (!(powHash32 instanceof Uint8Array) || powHash32.length !== 32) throw new RangeError('powHash must be exactly 32 bytes');
  const base = new Uint32Array(16);
  const scratch = new Uint32Array(16);
  absorbBlock(base, powHash32, 0, 32); // len=32: all 32 bytes consumed, no delimiter in block 0
  permutation(base, scratch);
  const state = new Uint32Array(16);
  const block = new Uint8Array(48); // only [32..48) is read; indices 32..47 hold the nonce
  return {
    /**
     * @param {Uint8Array} nonce16
     * @param {Uint8Array} [out] optional 32-byte buffer (reused only when provided)
     */
    hash(nonce16, out) {
      if (nonce16.length !== 16) throw new RangeError('nonce must be exactly 16 bytes');
      state.set(base);
      block.set(nonce16, 32);
      absorbBlock(state, block, 32, 48); // delimiter lands at idx 48 → word 4 of block 1
      permutation(state, scratch);
      return squeeze32(state, out && out.length === 32 ? out : new Uint8Array(32));
    },
  };
}
