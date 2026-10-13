#!/usr/bin/env node
/**
 * gen-fixtures.mjs — regenerate the hash fixtures from the OFFICIAL sources.
 *
 *   tests/fixtures/eaglesong-vectors.json  official vectors (nervosnetwork/eaglesong)
 *   tests/fixtures/ckb-pow48-vectors.json  48-byte CKB PoW inputs hashed by the
 *                                          Rust oracle (tools/eaglesong-oracle)
 *
 * The oracle wraps the official Rust crate, so none of our JS/WASM/WGSL code is
 * involved in producing an expected digest. Deterministic: running twice
 * produces byte-identical files.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR_EAGLESONG = path.join(ROOT, 'vendor', 'eaglesong');
const ORACLE = path.join(ROOT, 'tools', 'eaglesong-oracle', 'target', 'release', 'eaglesong-oracle');
const OUT_DIR = path.join(ROOT, 'tests', 'fixtures');

function gitHead(dir) {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git rev-parse failed in ${dir}: ${r.stderr}`);
  return r.stdout.trim();
}

function oracleHash(hexInputs) {
  if (!existsSync(ORACLE)) {
    throw new Error(`oracle binary missing: ${ORACLE}\nbuild it: (cd tools/eaglesong-oracle && cargo build --release)`);
  }
  const r = spawnSync(ORACLE, [], { input: hexInputs.join('\n') + '\n', encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`oracle failed: ${r.stderr}`);
  const out = r.stdout.trim().split('\n');
  if (out.length !== hexInputs.length) throw new Error(`oracle returned ${out.length} lines for ${hexInputs.length} inputs`);
  return out;
}

// ── 1. official vectors ─────────────────────────────────────────────────────
function officialVectors() {
  const txt = readFileSync(path.join(VENDOR_EAGLESONG, 'src', 'test_vectors.txt'), 'utf8');
  const lines = txt.split('\n');
  const vectors = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('Input = ')) {
      const inputHex = lines[i].slice(8).trim().toLowerCase();
      const outLine = lines[i + 1];
      if (!outLine?.startsWith('Output = ')) throw new Error(`vector at line ${i + 1} has no Output`);
      vectors.push({ source: 'src/test_vectors.txt', inputHex, expectedHex: outLine.slice(9).trim().toLowerCase() });
    }
  }
  // lib.rs unit-test constants (empty input, 34×'1'+'\n', 32×'1'+"22\n")
  vectors.push({ source: 'src/lib.rs BLANK_HASH', inputHex: '', expectedHex: '9e4452fc7aed93d7240b7b55263792befd1be09252b456401122ba71a56f62a0' });
  vectors.push({ source: 'src/lib.rs HASH_34_1', inputHex: Buffer.from('1'.repeat(34) + '\n').toString('hex'), expectedHex: 'a50a3310f78cbaeadcffe2d46262119eeeda9d6568b4df1b636399742c867aca' });
  vectors.push({ source: 'src/lib.rs HASH_32_1_2_2', inputHex: Buffer.from('1'.repeat(32) + '22\n').toString('hex'), expectedHex: 'd7b68a8ba4cfc606e86ed7e2ca3244ff27b28bb24c28ee09af4b1f47af9b9236' });

  // Cross-check: the oracle must agree with every published vector, otherwise
  // the oracle build itself is broken and nothing downstream can be trusted.
  const got = oracleHash(vectors.map(v => v.inputHex));
  vectors.forEach((v, i) => {
    if (got[i] !== v.expectedHex) throw new Error(`ORACLE DISAGREES with official vector ${i} (${v.source}): ${got[i]} != ${v.expectedHex}`);
  });
  return vectors;
}

// ── 2. CKB 48-byte PoW vectors ──────────────────────────────────────────────
// Two fixed, hand-chosen vectors with nonzero high and low nonce bytes, plus a
// deterministic pseudo-random set (xorshift64*, fixed seed). Nonce bytes are
// the raw 16 bytes appended to pow_hash: counter_u64_le || prefix8.
function xorshift64star(seed) {
  let s = BigInt(seed) & ((1n << 64n) - 1n);
  if (s === 0n) s = 1n;
  return () => {
    s ^= s >> 12n; s ^= (s << 25n) & ((1n << 64n) - 1n); s ^= s >> 27n;
    return (s * 0x2545F4914F6CDD1Dn) & ((1n << 64n) - 1n);
  };
}
function u64ToHexBE(n) { return n.toString(16).padStart(16, '0'); }
function leHex8(n) { // u64 → 8 little-endian bytes as hex
  let h = '';
  for (let i = 0; i < 8; i++) { h += ((n >> BigInt(8 * i)) & 0xffn).toString(16).padStart(2, '0'); }
  return h;
}

function pow48Vectors() {
  const fixed = [
    {
      name: 'fixed-1: counter=1, prefix=1122334400000000 (spec regression nonce)',
      powHashHex: '0f1e2d3c4b5a69788796a5b4c3d2e1f0ffeeddccbbaa99887766554433221100',
      counterLo: 1n,
      prefix8Hex: '1122334400000000',
    },
    {
      name: 'fixed-2: counter=2^64-1, prefix with high bit set',
      powHashHex: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
      counterLo: (1n << 64n) - 1n,
      prefix8Hex: '80000000000000ff',
    },
    { name: 'edge: counter=0 prefix=0 (all-zero nonce)', powHashHex: 'ff'.repeat(32), counterLo: 0n, prefix8Hex: '0000000000000000' },
    { name: 'edge: counter=2^32-1', powHashHex: 'a5'.repeat(32), counterLo: (1n << 32n) - 1n, prefix8Hex: 'deadbeefcafef00d' },
    { name: 'edge: counter=2^32', powHashHex: '5a'.repeat(32), counterLo: 1n << 32n, prefix8Hex: 'deadbeefcafef00d' },
  ];
  const rnd = xorshift64star(0x4542574d2d434b42n); // "EBWM-CKB"
  for (let i = 0; i < 59; i++) {
    const ph = [rnd(), rnd(), rnd(), rnd()].map(u64ToHexBE).join('');
    fixed.push({ name: `random-${i}`, powHashHex: ph, counterLo: rnd(), prefix8Hex: u64ToHexBE(rnd()) });
  }
  const vectors = fixed.map(v => {
    const nonceHex = leHex8(v.counterLo) + v.prefix8Hex;
    return { ...v, counterLo: v.counterLo.toString(), nonceHex, inputHex: v.powHashHex + nonceHex };
  });
  const got = oracleHash(vectors.map(v => v.inputHex));
  return vectors.map((v, i) => ({ ...v, expectedHex: got[i] }));
}

// ── write ───────────────────────────────────────────────────────────────────
mkdirSync(OUT_DIR, { recursive: true });
const selfSha = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
const meta = {
  generatedBy: 'scripts/gen-fixtures.mjs',
  generatorSha256: selfSha,
  oracle: { repo: 'nervosnetwork/eaglesong', commit: gitHead(VENDOR_EAGLESONG), wrapper: 'tools/eaglesong-oracle' },
};
writeFileSync(path.join(OUT_DIR, 'eaglesong-vectors.json'), JSON.stringify({ ...meta, vectors: officialVectors() }, null, 2) + '\n');
writeFileSync(path.join(OUT_DIR, 'ckb-pow48-vectors.json'), JSON.stringify({
  ...meta,
  layout: 'inputHex = powHashHex(32 bytes) || nonceHex(16 bytes) where nonceHex = counter_u64_le(8) || prefix8(8)',
  vectors: pow48Vectors(),
}, null, 2) + '\n');
console.log('fixtures written to', OUT_DIR, 'generator sha256', selfSha);
