/**
 * real-proxy-harness.js — run an UNMODIFIED copy of solo-proxy.js (from a
 * given checkout) against the fake CKB node, on loopback ports that do not
 * collide with anything else on this machine (3333 is a live pool edge here).
 *
 * The proxy's own code is copied verbatim; only config.json is ours.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeCkbNode, templateFromBlockFixture } from './fake-ckb-node.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** candidate proxy checkouts, first existing wins (override with SOLO_PROXY_DIR) */
export function findProxyDir() {
  const candidates = [process.env.SOLO_PROXY_DIR, '/home/phill/proxy-server', path.join(ROOT, 'vendor', 'ckb-stratum-proxy')].filter(Boolean);
  return candidates.find(d => fs.existsSync(path.join(d, 'solo-proxy.js')) && fs.existsSync(path.join(d, 'test', 'fixtures', 'mainnet-block-raw.json'))) ?? null;
}

function waitForPort(port, ms = 8000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function tryOnce() {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => { s.destroy(); resolve(); });
      s.once('error', () => { s.destroy(); if (Date.now() - t0 > ms) reject(new Error(`port ${port} not open`)); else setTimeout(tryOnce, 100); });
    })();
  });
}
function freePort() {
  return new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

/**
 * @param {object} o
 * @param {string} o.proxyDir
 * @param {number} [o.initialDiff]   share difficulty the proxy assigns (1e-6 ≈ 4k hashes/share)
 * @param {string} [o.compactTarget] fake template compact_target
 */
export async function startRealSoloProxy({ proxyDir, initialDiff = 0.000001, compactTarget, scratch } = {}) {
  if (!proxyDir) throw new Error('proxyDir required');
  const node = await startFakeCkbNode({ template: templateFromBlockFixture(proxyDir, compactTarget ? { compactTarget } : {}) });
  const stratumPort = await freePort();
  const statsPort = await freePort();
  const wsPort = await freePort(); // nothing listens: the proxy logs a WS error and polls instead
  const dir = scratch ?? path.join(process.env.CLAUDE_SCRATCHPAD ?? path.join(ROOT, 'runtime'), `real-proxy-${stratumPort}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(proxyDir)) {
    if (f.endsWith('.js') || f === 'dashboard.html' || f === 'package.json') fs.copyFileSync(path.join(proxyDir, f), path.join(dir, f));
  }
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    node: { host: '127.0.0.1', port: node.port, wsPort, pollMs: 200, coinbase: 'ckb1qyq...' },
    local: { host: '127.0.0.1', port: stratumPort, statsPort },
    mode: 'solo',
    vardiff: { targetShareSec: 30, retargetSec: 3600, variancePercent: 30, minDiff: initialDiff, maxDiff: 1e9, initialDiff },
  }, null, 2));
  const child = spawn(process.execPath, ['solo-proxy.js'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = [];
  child.stdout.on('data', d => log.push(...d.toString().split('\n').filter(Boolean)));
  child.stderr.on('data', d => log.push(...d.toString().split('\n').filter(Boolean)));
  await waitForPort(stratumPort);
  // wait until the proxy has fetched a template (it logs "[JOB ] #1")
  const t0 = Date.now();
  while (!log.some(l => /\[JOB/.test(l)) && Date.now() - t0 < 8000) await new Promise(r => setTimeout(r, 50));
  let head = null;
  try { head = (await import('node:child_process')).execFileSync('git', ['rev-parse', 'HEAD'], { cwd: proxyDir, encoding: 'utf8' }).trim(); } catch { /* not a git checkout */ }
  return {
    proxyDir, proxyGitHead: head, stratumPort, statsPort, node, log, dir,
    async stop() {
      child.kill('SIGTERM');
      await new Promise(r => { child.once('exit', r); setTimeout(r, 1500); });
      await node.close();
    },
  };
}
