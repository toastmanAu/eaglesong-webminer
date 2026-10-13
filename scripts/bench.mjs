#!/usr/bin/env node
/**
 * bench.mjs — reproducible Node-side benchmark of the JS Eaglesong mining kernel.
 * Measures ACTUAL hashes over wall time (no estimates). Browser numbers differ;
 * the UI reports those from measured worker batches.
 *
 *   node scripts/bench.mjs [--seconds 5] [--json out.json]
 */
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { mineRange } from '../src/hash/mine-batch.js';
import { hexToBytes } from '../src/hash/eaglesong-core.js';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => (a.startsWith('--') ? [a.slice(2), arr[i + 1]] : [])).filter(x => x.length));
const seconds = Number(args.seconds ?? 5);

const job = { jobId: 'bench', generation: 1, powHash: hexToBytes('0f1e2d3c4b5a69788796a5b4c3d2e1f0ffeeddccbbaa99887766554433221100'), prefix8: hexToBytes('1122334400000000'), shareTarget: 0n, networkTarget: null };
let lo = 0n, hashes = 0, batches = 0;
const t0 = performance.now();
// warm-up
mineRange(job, { firstLo: lo, count: 5000 }); lo += 5000n;
const t1 = performance.now();
while (performance.now() - t1 < seconds * 1000) { const r = mineRange(job, { firstLo: lo, count: 20000 }); lo += BigInt(r.hashes); hashes += r.hashes; batches++; }
const elapsed = (performance.now() - t1) / 1000;
const result = {
  kernel: 'cpu-js (src/hash/mine-batch.js, precomputed first-block state)', threads: 1,
  node: process.version, platform: `${os.platform()} ${os.arch()}`, cpu: os.cpus()[0]?.model ?? 'unknown',
  seconds: Number(elapsed.toFixed(3)), hashes, batches, hashesPerSecond: Math.round(hashes / elapsed), warmupMs: Number((t1 - t0).toFixed(1)),
  measuredAt: new Date().toISOString(),
};
console.log(JSON.stringify(result, null, 2));
if (args.json) writeFileSync(args.json, JSON.stringify(result, null, 2) + '\n');
