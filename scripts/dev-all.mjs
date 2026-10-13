#!/usr/bin/env node
/**
 * dev-all.mjs — one-command local stack:
 *   build dist/index.html → serve it on http://127.0.0.1:5173 → start the bridge.
 *
 *   node scripts/dev-all.mjs                 # uses ./config.json (or config.example.json)
 *   node scripts/dev-all.mjs --fake-stratum  # ALSO runs the deterministic fake proxy on the configured stratum port
 *                                            # (no CKB node needed; shares are local test shares, not real work)
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSingleFile } from './build-single-file.mjs';
import { startStaticServer } from './lib/static-server.mjs';
import { loadConfig } from '../src/bridge/config.js';
import { startBridgeServer } from '../src/bridge/server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const configPath = [...args].find(a => a.endsWith('.json')) ?? (existsSync(path.join(ROOT, 'config.json')) ? path.join(ROOT, 'config.json') : path.join(ROOT, 'config.example.json'));
const config = loadConfig(configPath);
const UI_PORT = Number(process.env.UI_PORT ?? 5173);

let fake = null;
if (args.has('--fake-stratum')) {
  const { createFakeStratumServer } = await import('../tests/helpers/fake-stratum-server.js');
  const { readFileSync } = await import('node:fs');
  const { targetToHexLE, targetForExpectedHashes } = await import('../src/hash/target.js');
  const t = JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/stratum-transcripts/solo-proxy-local.json'), 'utf8'));
  fake = createFakeStratumServer({
    job: { jobId: t.job.jobId, powHashHex: t.job.powHashHex, height: t.job.height, networkTargetLE: t.job.networkTargetLE },
    shareTargetLE: targetToHexLE(targetForExpectedHashes(20000n)), shareDifficulty: 20000 / 2 ** 32,
  });
  await fake.start({ host: config.stratum.host, port: config.stratum.port });
  console.log(`[dev] FAKE stratum (transcript job, ~20k hashes/share) on ${config.stratum.host}:${config.stratum.port} — not real chain work`);
}

const bridgeUrl = `ws://${config.bridge.listenHost}:${config.bridge.port}`;
const built = await buildSingleFile({ bridgeUrl });
console.log(`[dev] built ${built.out} (${built.bytes} bytes, sha256 ${built.buildHash.slice(0, 12)}…)`);
const ui = await startStaticServer({ root: path.dirname(built.out), port: UI_PORT });
console.log(`[dev] UI      → ${ui.url}/index.html`);
const bridge = await startBridgeServer(config);
console.log(`[dev] bridge  → ${bridgeUrl} (allowed origins: ${config.bridge.allowedOrigins.join(', ')})`);
console.log(`[dev] stratum → ${config.stratum.host}:${config.stratum.port} (${config.stratum.profile})`);

const shutdown = async () => { console.log('\n[dev] shutting down'); await bridge.close(); await ui.close(); if (fake) await fake.stop(); process.exit(0); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
