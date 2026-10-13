/**
 * nonce.js — the 128-bit CKB header nonce and nonce-range allocation.
 *
 * Three spellings of one number (see docs/PROTOCOL.md §0):
 *   raw      32 hex chars = the 16 bytes appended to pow_hash = nonce.to_le_bytes()
 *   numeric  BigInt
 *   rpc      canonical Uint128 for submit_block: '0x' + big-endian hex, no leading zeros
 *
 * Browser layout of the raw bytes: counter_u64_le (bytes 0..7) || prefix8 (bytes 8..15).
 * All counter math is BigInt; Numbers are refused so nothing silently rounds past 2^53.
 */

export const U64_MAX = (1n << 64n) - 1n;
export const U128_MAX = (1n << 128n) - 1n;

function normalizeRawHex(raw) {
  if (typeof raw !== 'string') throw new TypeError('nonce hex must be a string');
  const h = raw.startsWith('0x') || raw.startsWith('0X') ? raw.slice(2) : raw;
  if (!/^[0-9a-fA-F]{32}$/.test(h)) throw new RangeError('raw nonce must be exactly 32 hex chars (16 bytes)');
  return h.toLowerCase();
}

/** raw LE bytes (32 hex) → numeric value. */
export function rawNonceHexToBigInt(raw) {
  const h = normalizeRawHex(raw);
  let be = '';
  for (let i = 30; i >= 0; i -= 2) be += h.slice(i, i + 2);
  return BigInt('0x' + be);
}

/** numeric value → raw LE bytes (32 hex). */
export function bigIntToRawNonceHex(n) {
  if (typeof n !== 'bigint') throw new TypeError('nonce must be a BigInt');
  if (n < 0n || n > U128_MAX) throw new RangeError('nonce out of u128 range');
  let h = '';
  for (let i = 0; i < 16; i++) h += ((n >> BigInt(8 * i)) & 0xffn).toString(16).padStart(2, '0');
  return h;
}

/** raw LE bytes → canonical JSON-RPC Uint128 ('0x0' for zero, never redundant leading zeros). */
export function rawNonceHexToRpcNonce(raw) {
  return '0x' + rawNonceHexToBigInt(raw).toString(16);
}

/** JSON-RPC Uint128 (any leading-zero spelling) → raw LE bytes. */
export function rpcNonceToRawNonceHex(rpc) {
  if (typeof rpc !== 'string' || !/^0x[0-9a-fA-F]+$/.test(rpc)) throw new RangeError('rpc nonce must be 0x-prefixed hex');
  const n = BigInt(rpc);
  if (n > U128_MAX) throw new RangeError('rpc nonce exceeds 128 bits');
  return bigIntToRawNonceHex(n);
}

/**
 * Assemble the 16 hashed nonce bytes: counter (u64 LE) || prefix8.
 * @param {bigint} counterLo 0..2^64-1
 * @param {Uint8Array} prefix8 exactly 8 bytes
 * @param {Uint8Array} [out] optional 16-byte buffer to fill
 */
export function buildNonce16(counterLo, prefix8, out) {
  if (typeof counterLo !== 'bigint') throw new TypeError('counterLo must be a BigInt');
  if (counterLo < 0n || counterLo > U64_MAX) throw new RangeError('counterLo out of u64 range');
  if (!(prefix8 instanceof Uint8Array) || prefix8.length !== 8) throw new RangeError('prefix8 must be exactly 8 bytes');
  const buf = out && out.length === 16 ? out : new Uint8Array(16);
  let c = counterLo;
  for (let i = 0; i < 8; i++) { buf[i] = Number(c & 0xffn); c >>= 8n; }
  buf.set(prefix8, 8);
  return buf;
}

/** Inverse of buildNonce16. */
export function splitNonce16(nonce16) {
  if (!(nonce16 instanceof Uint8Array) || nonce16.length !== 16) throw new RangeError('nonce must be exactly 16 bytes');
  let counterLo = 0n;
  for (let i = 7; i >= 0; i--) counterLo = (counterLo << 8n) | BigInt(nonce16[i]);
  return { counterLo, prefix8: nonce16.slice(8, 16) };
}

/**
 * createRangeAllocator({ start }) — hands out disjoint contiguous [firstLo, firstLo+count)
 * ranges from a BigInt cursor. Fails closed at 2^64 (truncated last range, then null).
 * The caller owns generation semantics: reset() on a new pow hash / prefix, keep
 * the cursor on a target-only change so no work is repeated.
 */
export function createRangeAllocator({ start = 0n } = {}) {
  if (typeof start !== 'bigint' || start < 0n || start > U64_MAX) throw new RangeError('start must be a BigInt in u64 range');
  let cursor = start;
  let exhausted = false;
  return {
    get cursor() { return cursor; },
    get exhausted() { return exhausted; },
    /** @param {number} count positive integer → {firstLo: bigint, count: number} | null when exhausted */
    next(count) {
      if (!Number.isInteger(count) || count <= 0) throw new RangeError('count must be a positive integer');
      if (exhausted) return null;
      const remaining = U64_MAX - cursor + 1n; // nonces left including cursor
      const take = BigInt(count) < remaining ? BigInt(count) : remaining;
      const firstLo = cursor;
      cursor += take;
      if (cursor > U64_MAX) exhausted = true;
      return { firstLo, count: Number(take) };
    },
    reset(newStart = 0n) {
      if (typeof newStart !== 'bigint' || newStart < 0n || newStart > U64_MAX) throw new RangeError('start must be a BigInt in u64 range');
      cursor = newStart; exhausted = false;
    },
  };
}
