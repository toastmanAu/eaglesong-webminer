/**
 * pass0-source-audit.test.js — PASS 0: pin the endian / target / nonce facts
 * about the EXISTING code before writing any new miner code.
 *
 * These tests run against the vendored upstream sources (vendor/, fetched by
 * scripts/fetch-sources.sh at pinned commits) and against transcripts captured
 * from an unmodified solo-proxy.js (tests/fixtures/stratum-transcripts/).
 *
 * Expected values are hand-derived or come from the official Rust oracle, never
 * from the code under test. Where a test documents a BUG in upstream code, the
 * test name says so and the assertion pins the buggy behaviour, so a future
 * upstream fix turns the test red and prompts a conscious update.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR_PROXY = path.join(ROOT, 'vendor', 'ckb-stratum-proxy');
const haveVendor = existsSync(path.join(VENDOR_PROXY, 'eaglesong.js'));
const require = createRequire(import.meta.url);
const legacy = haveVendor ? {
  eaglesong: require(path.join(VENDOR_PROXY, 'eaglesong.js')),
  target: require(path.join(VENDOR_PROXY, 'ckb-target.js')),
  header: require(path.join(VENDOR_PROXY, 'ckb-header.js')),
} : null;
const vendorTest = haveVendor ? test : test.skip;

const officialVectors = JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/eaglesong-vectors.json'), 'utf8')).vectors;
const pow48 = JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/ckb-pow48-vectors.json'), 'utf8')).vectors;

// ── hand-rolled reference helpers (NOT the code under test) ─────────────────
const u256 = (hexBE) => BigInt('0x' + hexBE);
const beHex = (n) => n.toString(16).padStart(64, '0');
const reverseHex = (hex) => Buffer.from(hex, 'hex').reverse().toString('hex');
/** CKB consensus: hash bytes read as a big-endian U256, must be <= target. */
const consensusMeets = (hashHex, target) => u256(hashHex) <= target;
/** Molecule u128 little-endian serialization of a numeric nonce. */
function u128ToLEHex(n) {
  let h = '';
  for (let i = 0; i < 16; i++) h += ((n >> BigInt(8 * i)) & 0xffn).toString(16).padStart(2, '0');
  return h;
}

// ── 1. the legacy JS Eaglesong matches the official vectors and the oracle ──
vendorTest('legacy eaglesong.js reproduces all official vectors (so it is a valid cross-check for transcripts)', () => {
  for (const v of officialVectors) {
    assert.equal(legacy.eaglesong.eaglesong(Buffer.from(v.inputHex, 'hex')).toString('hex'), v.expectedHex, v.source);
  }
});

vendorTest('legacy eaglesong.js agrees with the Rust oracle on 64 CKB 48-byte inputs', () => {
  for (const v of pow48) {
    assert.equal(legacy.eaglesong.hashCKB(v.powHashHex, v.nonceHex).toString('hex'), v.expectedHex, v.name);
  }
});

// ── 2. legacy meetsTarget() is a little-endian comparison: WRONG for consensus ──
vendorTest('BUG(pitfall 1): legacy eaglesong.js meetsTarget() accepts an MSB-only hash that consensus rejects', () => {
  const target = 1n << 200n;
  const hashMsbOnly = 'ff' + '00'.repeat(31);          // BE value 0xff << 248 — far above 2^200
  assert.equal(consensusMeets(hashMsbOnly, target), false, 'consensus (BE) rejects');
  assert.equal(legacy.target.meetsTargetLE(Buffer.from(hashMsbOnly, 'hex'), reverseHex(beHex(target))), false, 'ckb-target.js agrees with consensus');
  // legacy helper reads byte 31 as the MSB → sees 0x00...ff → accepts.
  assert.equal(legacy.eaglesong.meetsTarget(Buffer.from(hashMsbOnly, 'hex'), reverseHex(beHex(target))), true, 'legacy LE compare wrongly accepts');
});

vendorTest('BUG(pitfall 1): legacy meetsTarget() rejects an LSB-only hash that consensus accepts', () => {
  const target = 1n << 200n;
  const hashLsbOnly = '00'.repeat(31) + 'ff';           // BE value 255 — far below 2^200
  assert.equal(consensusMeets(hashLsbOnly, target), true);
  assert.equal(legacy.target.meetsTargetLE(Buffer.from(hashLsbOnly, 'hex'), reverseHex(beHex(target))), true);
  assert.equal(legacy.eaglesong.meetsTarget(Buffer.from(hashLsbOnly, 'hex'), reverseHex(beHex(target))), false, 'legacy LE compare wrongly rejects');
});

vendorTest('ckb-target.js meetsTargetLE matches BigInt big-endian semantics on edge vectors', () => {
  const cases = [
    ['00'.repeat(32), (1n << 256n) - 1n, true],   // zero vs max
    ['ff'.repeat(32), (1n << 256n) - 1n, true],   // max vs max (equality)
    ['ff'.repeat(32), (1n << 256n) - 2n, false],  // max vs max-1
    [beHex(1n << 200n), 1n << 200n, true],        // exact equality at 2^200
    [beHex((1n << 200n) + 1n), 1n << 200n, false],
    ['ff' + '00'.repeat(31), 1n << 200n, false],
    ['00'.repeat(31) + 'ff', 1n << 200n, true],
  ];
  for (const [hashHex, target, expected] of cases) {
    assert.equal(legacy.target.meetsTargetLE(Buffer.from(hashHex, 'hex'), reverseHex(beHex(target))), expected, `${hashHex.slice(0, 8)}… vs 2^${target.toString(2).length - 1}`);
    assert.equal(consensusMeets(hashHex, target), expected);
  }
});

vendorTest('a target handed to meetsTargetLE in the wrong (BE) byte order gives the wrong verdict', () => {
  // The proxy's convention is LE on the wire. Feeding a BE-encoded 2^200 makes
  // it look like 2^48: a hash of 2^100 must then be rejected although consensus accepts it.
  const target = 1n << 200n;
  const hash = beHex(1n << 100n);
  assert.equal(consensusMeets(hash, target), true);
  assert.equal(legacy.target.meetsTargetLE(Buffer.from(hash, 'hex'), reverseHex(beHex(target))), true, 'correct LE encoding');
  assert.equal(legacy.target.meetsTargetLE(Buffer.from(hash, 'hex'), beHex(target)), false, 'BE encoding must fail — no endianness heuristics');
});

// ── 3. nonce: raw LE bytes vs numeric RPC Uint128 ───────────────────────────
test('mandatory regression: raw LE nonce 01000000000000001122334400000000 is numeric 0x443322110000000000000001', () => {
  const raw = '01000000000000001122334400000000';
  const numeric = BigInt('0x' + reverseHex(raw));
  assert.equal(numeric, 0x00000000443322110000000000000001n, 'numeric value (spec example)');
  // CKB JSON-RPC Uint128 is canonical: no redundant leading zeros. The spec's
  // literal "0x00000000443322110000000000000001" is the SAME number but a real
  // node rejects that spelling ("with redundant leading zeros").
  assert.equal('0x' + numeric.toString(16), '0x443322110000000000000001');
  assert.equal(u128ToLEHex(numeric), raw, 'u128-le serialization restores the hashed bytes');
});

test('nonce 0, 1, 2^32-1, 2^32, 2^64-1 and varied prefixes round-trip raw LE -> numeric -> raw LE', () => {
  for (const v of pow48) {
    const numeric = BigInt('0x' + reverseHex(v.nonceHex));
    assert.equal(u128ToLEHex(numeric), v.nonceHex, v.name);
    // the low 8 bytes are the counter, the high 8 bytes the prefix
    assert.equal(numeric & ((1n << 64n) - 1n), BigInt(v.counterLo), `${v.name}: counter in low 64 bits`);
    assert.equal(numeric >> 64n, BigInt('0x' + reverseHex(v.prefix8Hex)), `${v.name}: prefix in high 64 bits`);
  }
});

vendorTest('BUG(pitfall 11, GitHub main): submitBlock passes raw nonce bytes as the numeric header nonce → header carries a byte-reversed nonce', () => {
  const raw = '01000000000000001122334400000000';
  const fields = { version: '0x0', compact_target: '0x1d08c0c8', timestamp: '0x1', number: '0x1', epoch: '0x1',
    parent_hash: '0x' + '00'.repeat(32), transactions_root: '0x' + '00'.repeat(32), proposals_hash: '0x' + '00'.repeat(32),
    extra_hash: '0x' + '00'.repeat(32), dao: '0x' + '00'.repeat(32) };
  // GitHub main: nonceHex = '0x' + nonce.padStart(32,'0')  (solo-proxy.js submitBlock)
  const headerBytes = legacy.header.serializeFullHeader(fields, '0x' + raw);
  const serializedNonce = headerBytes.subarray(192, 208).toString('hex');
  assert.notEqual(serializedNonce, raw, 'header nonce bytes differ from the bytes that were hashed');
  assert.equal(serializedNonce, reverseHex(raw), 'the difference is exactly a byte reversal');
  // and the correct conversion fixes it:
  const canonical = '0x' + BigInt('0x' + reverseHex(raw)).toString(16);
  assert.equal(legacy.header.serializeFullHeader(fields, canonical).subarray(192, 208).toString('hex'), raw);
});

// ── 4. difficulty precision (pitfall 6) ─────────────────────────────────────
vendorTest('BUG(pitfall 6): diffToTargetLE six-decimal rounding collapses 1e-6 and 1.4e-6 to the same target', () => {
  assert.equal(legacy.target.diffToTargetLE(0.000001), legacy.target.diffToTargetLE(0.0000014));
});

vendorTest('BUG(pitfall 6): diffToTargetLE(4e-7) throws (division by zero) instead of returning a target or rejecting cleanly', () => {
  assert.throws(() => legacy.target.diffToTargetLE(0.0000004), RangeError);
});

vendorTest('diffToTargetLE(1e-6) is ~2^243.9: a browser-class share needs ~4,000 hashes', () => {
  const t = BigInt('0x' + reverseHex(legacy.target.diffToTargetLE(0.000001)));
  const expectedHashes = ((1n << 256n) - 1n) / t;
  assert.ok(expectedHashes >= 4000n && expectedHashes <= 4400n, `expected hashes/share = ${expectedHashes}`);
});

// ── 5. captured transcripts from the UNMODIFIED proxies ─────────────────────
const TRANSCRIPTS = path.join(ROOT, 'tests/fixtures/stratum-transcripts');
function loadTranscript(name) {
  const p = path.join(TRANSCRIPTS, `${name}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}
const frame = (t, pred) => t.frames.map(f => ({ ...f, msg: JSON.parse(f.line) })).find(f => pred(f.msg));

for (const profile of ['ckb-stratum-proxy-main', 'solo-proxy-local']) {
  const t = loadTranscript(profile);
  const tt = t ? test : test.skip;

  tt(`[${profile}] subscribe for a non-GodMiner UA returns the nested 3-tuple with a 4-byte extranonce1`, () => {
    const sub = frame(t, m => m.id === 1 && m.result).msg;
    assert.equal(Array.isArray(sub.result[0]), true, 'nested subscription list');
    assert.equal(sub.result[0][0][0], 'mining.set_difficulty');
    assert.equal(sub.result[0][1][0], 'mining.notify');
    assert.match(sub.result[1], /^[0-9a-f]{8}$/, 'extranonce1 is 4 bytes (8 hex)');
    assert.equal(sub.result[2], 4, 'extranonce2_size');
  });

  tt(`[${profile}] solo notify is FIVE fields and params[2] is the HEIGHT (not a target, unlike NerdMiner's 4-field reading)`, () => {
    const n = frame(t, m => m.method === 'mining.notify').msg;
    assert.equal(n.params.length, 5);
    assert.equal(typeof n.params[2], 'number', 'height is a JSON number');
    assert.match(n.params[1], /^[0-9a-f]{64}$/, 'pow_hash');
    assert.match(n.params[3], /^[0-9a-f]{64}$/, 'network target (LE)');
    assert.equal(typeof n.params[4], 'boolean', 'clean_jobs');
    // A NerdMiner-style parser reading params[2] as the 64-hex target would fail hex_to_bytes:
    assert.notEqual(String(n.params[2]).length, 64);
  });

  tt(`[${profile}] set_target is LE and decodes to the diff=1e-6 target; notify target decodes compact 0x1f040000 = 2^242`, () => {
    const st = frame(t, m => m.method === 'mining.set_target').msg;
    const n = frame(t, m => m.method === 'mining.notify').msg;
    const share = BigInt('0x' + reverseHex(st.params[0]));
    const network = BigInt('0x' + reverseHex(n.params[3]));
    assert.equal(network, 1n << 242n, 'compact 0x1f040000 → 0x040000 << 224');
    assert.equal(share, ((1n << 224n) * 1000000n) / 1n, 'diff 1e-6 under six-decimal rounding');
  });

  tt(`[${profile}] every submitted nonce is 32 hex chars = exactly the 16 bytes hashed, with the 4-byte extranonce1 at bytes 8..11`, () => {
    for (const f of t.frames.filter(f => f.dir === 'client->proxy')) {
      const m = JSON.parse(f.line);
      if (m.method !== 'mining.submit') continue;
      assert.equal(m.params.length, 3, 'three-field submit [worker, job_id, nonce]');
      assert.match(m.params[2], /^[0-9a-f]{32}$/);
      assert.equal(m.params[2].slice(16, 24), t.extranonce1);
    }
  });

  tt(`[${profile}] proxy recomputes Eaglesong: low-diff nonce rejected with code 23, share and block accepted`, () => {
    assert.equal(t.results.low.result, false);
    assert.equal(t.results.low.error[0], 23);
    assert.equal(t.results.share.result, true);
    assert.equal(t.results.block.result, true);
  });

  vendorTest(`[${profile}] independent recomputation: share nonce meets share target but not network target; block nonce meets both`, () => {
    const share = BigInt('0x' + reverseHex(t.job.shareTargetLE));
    const network = BigInt('0x' + reverseHex(t.job.networkTargetLE));
    const h = (nonceHex) => BigInt('0x' + legacy.eaglesong.hashCKB(t.job.powHashHex, nonceHex).toString('hex'));
    assert.equal(h(t.nonces.low.nonceHex) <= share, false);
    assert.equal(h(t.nonces.share.nonceHex) <= share, true);
    assert.equal(h(t.nonces.share.nonceHex) <= network, false);
    assert.equal(h(t.nonces.block.nonceHex) <= network, true);
  });

  tt(`[${profile}] FINDING: a replayed (duplicate) share is accepted again — no duplicate detection`, () => {
    assert.equal(t.results.duplicate.result, true);
  });

  tt(`[${profile}] FINDING(pitfall 8): a share for an unknown job id is ACKed result:true without validation`, () => {
    assert.equal(t.results.unknownJob.result, true);
  });

  tt(`[${profile}] the block share triggered exactly one submit_block RPC with a canonical Uint128 nonce`, () => {
    const subs = t.rpc.filter(r => r.method === 'submit_block');
    assert.equal(subs.length, 1);
    const [workId, block] = subs[0].params;
    assert.equal(workId, '0x1');
    assert.match(block.header.nonce, /^0x([1-9a-f][0-9a-f]*|0)$/, 'canonical: no redundant leading zeros');
  });
}

{
  const t = loadTranscript('solo-proxy-local');
  (t ? test : test.skip)('[solo-proxy-local] submit_block header.nonce serializes (u128 LE) to EXACTLY the nonce bytes Eaglesong hashed (fix verified on the real code path)', () => {
    const block = t.rpc.find(r => r.method === 'submit_block').params[1];
    assert.equal(u128ToLEHex(BigInt(block.header.nonce)), t.nonces.block.nonceHex);
  });
}
{
  const t = loadTranscript('ckb-stratum-proxy-main');
  (t ? test : test.skip)('BUG(pitfall 11) REPRODUCED on the real code path: [ckb-stratum-proxy-main] submit_block header.nonce is the byte-reversed nonce, whose Eaglesong does NOT meet the target', () => {
    const block = t.rpc.find(r => r.method === 'submit_block').params[1];
    const headerNonceLE = u128ToLEHex(BigInt(block.header.nonce));
    assert.notEqual(headerNonceLE, t.nonces.block.nonceHex, 'header nonce != hashed nonce');
    assert.equal(headerNonceLE, reverseHex(t.nonces.block.nonceHex), 'off by exactly a byte reversal');
    if (haveVendor) {
      const network = BigInt('0x' + reverseHex(t.job.networkTargetLE));
      const h = BigInt('0x' + legacy.eaglesong.hashCKB(t.job.powHashHex, headerNonceLE).toString('hex'));
      assert.equal(h <= network, false, 'the node would reject this block: PoW does not verify');
    }
  });
}
