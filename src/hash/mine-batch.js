/**
 * mine-batch.js — pure CPU Eaglesong mining kernel (no Worker, no DOM, no I/O).
 *
 * mineRange(job, range, opts) hashes counter values [firstLo, firstLo+count) for
 * one job and returns only counts plus the rare candidates — never per-hash data.
 * The CPU worker wraps this; the Node integration tests call it directly.
 */
import { createCkbHasher, bytesToHex } from './eaglesong-core.js';
import { U64_MAX, buildNonce16 } from './nonce.js';

/**
 * @typedef {object} MineJob
 * @property {string} jobId
 * @property {number} generation
 * @property {Uint8Array} powHash      32 bytes
 * @property {Uint8Array} prefix8      8 bytes
 * @property {bigint} shareTarget
 * @property {bigint|null} networkTarget
 */

/**
 * @param {MineJob} job
 * @param {{firstLo: bigint, count: number}} range
 * @param {{maxCandidates?: number}} [opts]
 * @returns {{hashes:number, candidates:Array, bestHashHex:string|null, nextLo:bigint, truncated:boolean}}
 */
export function mineRange(job, range, opts = {}) {
  const { jobId, generation, powHash, prefix8, shareTarget, networkTarget } = job;
  const { firstLo, count } = range;
  const maxCandidates = opts.maxCandidates ?? 64;
  if (typeof firstLo !== 'bigint') throw new TypeError('firstLo must be a BigInt');
  if (!Number.isInteger(count) || count <= 0) throw new RangeError('count must be a positive integer');
  if (firstLo < 0n || firstLo + BigInt(count) - 1n > U64_MAX) throw new RangeError('range runs past 2^64 (u64 counter)');
  if (typeof shareTarget !== 'bigint') throw new TypeError('shareTarget must be a BigInt');
  if (networkTarget !== null && typeof networkTarget !== 'bigint') throw new TypeError('networkTarget must be a BigInt or null');
  if (!(prefix8 instanceof Uint8Array) || prefix8.length !== 8) throw new RangeError('prefix8 must be exactly 8 bytes');

  const hasher = createCkbHasher(powHash); // validates 32 bytes
  const nonce = buildNonce16(firstLo, prefix8);
  const out = new Uint8Array(32);
  // Compare against the share target byte-wise (BE) without allocating a BigInt
  // per hash: precompute the target's 32 big-endian bytes once.
  const shareBytes = targetToBytesBE(shareTarget);
  const networkBytes = networkTarget === null ? null : targetToBytesBE(networkTarget);
  const best = new Uint8Array(32).fill(0xff);
  let haveBest = false;
  const candidates = [];
  let hashes = 0;
  let truncated = false;

  for (let i = 0; i < count; i++) {
    if (i > 0) incrementCounterLE(nonce);
    hasher.hash(nonce, out);
    hashes++;
    if (compareBE(out, best) < 0) { best.set(out); haveBest = true; }
    const meetsNetwork = networkBytes !== null && compareBE(out, networkBytes) <= 0;
    if (compareBE(out, shareBytes) <= 0 || meetsNetwork) {
      const hashHex = bytesToHex(out);
      candidates.push({
        generation, jobId,
        nonceHex: bytesToHex(nonce),
        hashHex,
        meetsNetwork,
      });
      if (candidates.length >= maxCandidates && i + 1 < count) { truncated = true; break; }
    }
  }
  return {
    hashes,
    candidates,
    bestHashHex: haveBest ? bytesToHex(best) : null,
    nextLo: firstLo + BigInt(hashes),
    truncated,
  };
}

/** 32 big-endian bytes of a U256 (clamped at 2^256-1). */
export function targetToBytesBE(target) {
  const b = new Uint8Array(32);
  let n = target > (1n << 256n) - 1n ? (1n << 256n) - 1n : target;
  for (let i = 31; i >= 0; i--) { b[i] = Number(n & 0xffn); n >>= 8n; }
  return b;
}

/** Lexicographic compare of two 32-byte big-endian numbers: <0, 0, >0. */
export function compareBE(a, b) {
  for (let i = 0; i < 32; i++) { if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; }
  return 0;
}

/** Add 1 to the little-endian u64 in bytes 0..7 with carry (caller guards 2^64). */
export function incrementCounterLE(nonce16) {
  for (let i = 0; i < 8; i++) {
    if (nonce16[i] === 0xff) { nonce16[i] = 0; continue; }
    nonce16[i]++;
    return;
  }
}
