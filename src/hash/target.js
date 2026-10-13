/**
 * target.js — CKB PoW target arithmetic with explicit byte orders.
 *
 * Internally every target is a BigInt in [0, 2^256-1]. Hex enters and leaves
 * through functions whose names say the byte order (`...HexBE` / `...HexLE`);
 * nothing here guesses an encoding from the shape of the data.
 *
 * Consensus (RFC 0027): a block is valid when
 *   U256::from_big_endian(eaglesong(pow_hash || nonce_le)) <= compact_to_target(compact_target)
 */

export const MAX_U256 = (1n << 256n) - 1n;
/** CKB stratum convention: difficulty 1 ≙ target 2^224 (≈ 2^32 hashes per share). */
export const DIFF1_TARGET = 1n << 224n;
/** fixed-point scale for difficulty → target so 1e-9..1e9 keep ≥ 1e-3 relative precision */
const DIFF_SCALE = 10n ** 18n;

function clampU256(n) {
  if (n < 0n) throw new RangeError('target cannot be negative');
  return n > MAX_U256 ? MAX_U256 : n;
}

/**
 * compact_target (nBits-style) → target. Accepts number, bigint or 0x-hex string.
 * @param {number|bigint|string} compact
 * @returns {bigint}
 */
export function compactToTarget(compact) {
  let c;
  if (typeof compact === 'bigint') c = compact;
  else if (typeof compact === 'number') { if (!Number.isInteger(compact)) throw new RangeError('compact must be an integer'); c = BigInt(compact); }
  else if (typeof compact === 'string' && /^0x[0-9a-fA-F]{1,8}$/.test(compact)) c = BigInt(compact);
  else throw new RangeError(`invalid compact target: ${String(compact)}`);
  if (c < 0n || c > 0xffffffffn) throw new RangeError('compact target must fit in u32');
  const exp = c >> 24n;
  const man = c & 0xffffffn;
  const n = exp <= 3n ? man >> (8n * (3n - exp)) : man << (8n * (exp - 3n));
  return clampU256(n);
}

function checkHex64(hex, label) {
  if (typeof hex !== 'string') throw new TypeError(`${label} must be a string`);
  const h = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new RangeError(`${label} must be exactly 64 hex chars`);
  return h.toLowerCase();
}

/** 64 hex chars read as a big-endian U256. */
export function targetFromHexBE(hex) { return BigInt('0x' + checkHex64(hex, 'targetBE')); }

/** 64 hex chars whose BYTES are little-endian (solo-proxy / NerdMiner wire format). */
export function targetFromHexLE(hex) {
  const h = checkHex64(hex, 'targetLE');
  let be = '';
  for (let i = 62; i >= 0; i -= 2) be += h.slice(i, i + 2);
  return BigInt('0x' + be);
}

/** @param {bigint} target */
export function targetToHexBE(target) {
  if (typeof target !== 'bigint') throw new TypeError('target must be a BigInt');
  clampU256(target);
  if (target > MAX_U256) throw new RangeError('target exceeds 2^256-1');
  return target.toString(16).padStart(64, '0');
}

/** @param {bigint} target → 64 hex chars in little-endian byte order */
export function targetToHexLE(target) {
  const be = targetToHexBE(target);
  let le = '';
  for (let i = 62; i >= 0; i -= 2) le += be.slice(i, i + 2);
  return le;
}

/** Interpret a 32-byte digest as a big-endian U256 (byte 0 most significant). */
export function hashToBigInt(hash32) {
  if (!(hash32 instanceof Uint8Array) || hash32.length !== 32) throw new RangeError('hash must be exactly 32 bytes');
  let n = 0n;
  for (let i = 0; i < 32; i++) n = (n << 8n) | BigInt(hash32[i]);
  return n;
}

/**
 * meetsTarget(hash32, target) — consensus comparison, no allocation of BigInts
 * when the first differing byte decides.
 * @param {Uint8Array} hash32
 * @param {bigint} target
 */
export function meetsTarget(hash32, target) {
  if (!(hash32 instanceof Uint8Array) || hash32.length !== 32) throw new RangeError('hash must be exactly 32 bytes');
  if (typeof target !== 'bigint') throw new TypeError('target must be a BigInt');
  return hashToBigInt(hash32) <= target;
}

/**
 * Target such that one hash in `expectedHashes` meets it: floor((2^256-1) / expectedHashes).
 * @param {bigint|number} expectedHashes >= 1
 */
export function targetForExpectedHashes(expectedHashes) {
  let h;
  if (typeof expectedHashes === 'bigint') h = expectedHashes;
  else if (typeof expectedHashes === 'number' && Number.isFinite(expectedHashes)) h = BigInt(Math.floor(expectedHashes));
  else throw new RangeError('expectedHashes must be a finite number or BigInt');
  if (h < 1n) throw new RangeError('expectedHashes must be >= 1');
  return MAX_U256 / h;
}

/** floor((2^256-1) / target): mean hashes needed to meet `target`. */
export function expectedHashesForTarget(target) {
  if (typeof target !== 'bigint') throw new TypeError('target must be a BigInt');
  if (target <= 0n) throw new RangeError('target must be > 0');
  return MAX_U256 / target;
}

/**
 * difficulty → target with 18-digit fixed point: target = 2^224 * 1e18 / round(diff * 1e18).
 * Rejects zero, negative, NaN, Infinity and non-numbers instead of silently producing a target.
 * @param {number} diff
 */
export function targetFromDifficulty(diff) {
  if (typeof diff !== 'number' || !Number.isFinite(diff) || diff <= 0) throw new RangeError(`invalid difficulty: ${String(diff)}`);
  // diff.toFixed cannot represent tiny values; scale through a decimal string instead.
  const scaled = BigInt(Math.round(diff * 1e18)) || 1n; // never zero for diff > 0 within sane range
  if (scaled <= 0n) throw new RangeError(`difficulty too small: ${diff}`);
  return clampU256((DIFF1_TARGET * DIFF_SCALE) / scaled);
}

/** Display-only inverse of targetFromDifficulty (Number precision). */
export function difficultyFromTarget(target) {
  if (typeof target !== 'bigint') throw new TypeError('target must be a BigInt');
  if (target <= 0n) throw new RangeError('target must be > 0');
  return Number((DIFF1_TARGET * DIFF_SCALE) / target) / 1e18;
}
