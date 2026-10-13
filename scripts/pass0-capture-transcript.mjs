#!/usr/bin/env node
/**
 * pass0-capture-transcript.mjs — drive an UNMODIFIED copy of solo-proxy.js
 * against a fake CKB node and record the exact wire traffic.
 *
 *   node scripts/pass0-capture-transcript.mjs --proxy-dir <dir> --profile <name>
 *
 * What it does
 *   1. Starts a fake CKB JSON-RPC node on 127.0.0.1:18114 that serves one
 *      get_block_template (a real mainnet block reshaped to template form, with
 *      an easy compact_target so a CPU can solve it) and records submit_block.
 *   2. Copies the proxy's .js files to a scratch dir with a test config
 *      (127.0.0.1:3334 — NOT 3333, which belongs to another service) and spawns it.
 *   3. Connects as "EagleWebMiner/1.0", subscribes, authorizes, waits for the
 *      job, brute-forces three nonces (below local target / share / block),
 *      submits them plus a duplicate and an unknown job id, and records every
 *      line in both directions and every RPC the proxy made to the fake node.
 *   4. Writes tests/fixtures/stratum-transcripts/<profile>.json.
 *
 * Nothing here touches a real node or a real network.
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1]] : []).filter(Boolean));
const PROXY_DIR = path.resolve(args['proxy-dir'] || path.join(ROOT, 'vendor', 'ckb-stratum-proxy'));
const PROFILE = args.profile || 'ckb-stratum-proxy-main';
const NODE_MODULES = args['node-modules'] || path.join(ROOT, 'node_modules');
const FAKE_NODE_PORT = 18114;
const STRATUM_PORT = 3334;
const STATS_PORT = 8089;
const EASY_COMPACT = '0x1f040000'; // target = 0x040000 << 8*(31-3) = 2^242 → ~16k hashes per block
const SCRATCH = path.join(process.env.CLAUDE_SCRATCHPAD || path.join(ROOT, 'runtime'), `pass0-${PROFILE}`);
const OUT = path.join(ROOT, 'tests', 'fixtures', 'stratum-transcripts', `${PROFILE}.json`);

const require = createRequire(path.join(PROXY_DIR, 'package.json'));
const { eaglesong } = require(path.join(PROXY_DIR, 'eaglesong.js'));

const log = (...a) => console.error('[capture]', ...a);

// ── independent helpers (no proxy code) ─────────────────────────────────────
const MASK256 = (1n << 256n) - 1n;
function hexLEToBigInt(hex) { return BigInt('0x' + Buffer.from(hex, 'hex').reverse().toString('hex')); }
function hashToBigIntBE(buf) { return BigInt('0x' + Buffer.from(buf).toString('hex')); }
function compactToTarget(compactHex) {
  const c = BigInt(compactHex); const exp = c >> 24n; const man = c & 0xffffffn;
  let n = exp <= 3n ? man >> (8n * (3n - exp)) : man << (8n * (exp - 3n));
  return n > MASK256 ? MASK256 : n;
}

// ── template from the proxy's own real-mainnet fixture ──────────────────────
function loadTemplate() {
  const block = JSON.parse(fs.readFileSync(path.join(PROXY_DIR, 'test', 'fixtures', 'mainnet-block-raw.json'), 'utf8'));
  const h = block.header;
  return {
    version: h.version, compact_target: EASY_COMPACT, current_time: h.timestamp, number: h.number, epoch: h.epoch,
    parent_hash: h.parent_hash, dao: h.dao, work_id: '0x1',
    cycles_limit: '0x0', bytes_limit: '0x0', uncles_count_limit: '0x0',
    cellbase: { hash: block.transactions[0].hash, data: block.transactions[0] },
    transactions: block.transactions.slice(1).map(tx => ({ hash: tx.hash, data: tx })),
    proposals: block.proposals,
    uncles: block.uncles.map(u => ({ hash: u.header.hash, header: u.header, proposals: u.proposals })),
    extension: block.extension,
  };
}

// ── fake node ───────────────────────────────────────────────────────────────
const rpcLog = [];
function startFakeNode(template) {
  return new Promise(resolve => {
    const srv = createServer((req, res) => {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        let msg; try { msg = JSON.parse(body); } catch { res.writeHead(400); return res.end(); }
        let result = null, error = null;
        if (msg.method === 'get_block_template') result = template;
        else if (msg.method === 'submit_block') result = '0x' + '11'.repeat(32); // fake block hash
        else error = { code: -32601, message: `fake node: unsupported ${msg.method}` };
        if (msg.method !== 'get_block_template') rpcLog.push({ ts: Date.now(), method: msg.method, params: msg.params, response: { result, error } });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result, error }));
      });
    });
    srv.listen(FAKE_NODE_PORT, '127.0.0.1', () => resolve(srv));
  });
}

// ── proxy copy + spawn ──────────────────────────────────────────────────────
function prepareProxyCopy() {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH, { recursive: true });
  for (const f of fs.readdirSync(PROXY_DIR)) {
    if (f.endsWith('.js') || f === 'dashboard.html' || f === 'package.json') fs.copyFileSync(path.join(PROXY_DIR, f), path.join(SCRATCH, f));
  }
  fs.symlinkSync(NODE_MODULES, path.join(SCRATCH, 'node_modules'));
  fs.writeFileSync(path.join(SCRATCH, 'config.json'), JSON.stringify({
    node: { host: '127.0.0.1', port: FAKE_NODE_PORT, wsPort: 18115, pollMs: 200, coinbase: 'ckb1qyq...' },
    local: { host: '127.0.0.1', port: STRATUM_PORT, statsPort: STATS_PORT },
    mode: 'solo',
    vardiff: { targetShareSec: 30, retargetSec: 3600, variancePercent: 30, minDiff: 0.000001, maxDiff: 1e9, initialDiff: 0.000001 },
  }, null, 2));
}

function spawnProxy() {
  const child = spawn(process.execPath, ['solo-proxy.js'], { cwd: SCRATCH, stdio: ['ignore', 'pipe', 'pipe'] });
  const proxyLog = [];
  child.stdout.on('data', d => proxyLog.push(...d.toString().split('\n').filter(Boolean)));
  child.stderr.on('data', d => proxyLog.push(...d.toString().split('\n').filter(Boolean)));
  return { child, proxyLog };
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

// ── stratum client that records everything ──────────────────────────────────
function stratumClient() {
  const frames = [];
  const sock = net.connect(STRATUM_PORT, '127.0.0.1');
  const waiters = [];
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', d => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      frames.push({ dir: 'proxy->client', ts: Date.now(), line });
      for (const w of [...waiters]) if (w.pred(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
    }
  });
  const send = obj => { const line = JSON.stringify(obj); frames.push({ dir: 'client->proxy', ts: Date.now(), line }); sock.write(line + '\n'); };
  const waitFor = (pred, ms = 10000) => new Promise((resolve, reject) => {
    const w = { pred, resolve };
    waiters.push(w);
    setTimeout(() => { if (waiters.includes(w)) { waiters.splice(waiters.indexOf(w), 1); reject(new Error('timeout waiting for frame')); } }, ms);
  });
  return { sock, frames, send, waitFor, ready: new Promise((r, j) => { sock.once('connect', r); sock.once('error', j); }) };
}

// ── nonce search (mirrors NerdMiner: counter_u64_le || extranonce1 zero-padded to 8) ──
function findNonces(powHashHex, prefix8Hex, localTarget, networkTarget) {
  const input = Buffer.alloc(48);
  Buffer.from(powHashHex, 'hex').copy(input, 0);
  Buffer.from(prefix8Hex, 'hex').copy(input, 40);
  const found = {};
  for (let c = 1n; c < (1n << 24n); c++) {
    for (let i = 0; i < 8; i++) input[32 + i] = Number((c >> BigInt(8 * i)) & 0xffn);
    const h = hashToBigIntBE(eaglesong(input));
    const nonceHex = input.subarray(32, 48).toString('hex');
    const key = h <= networkTarget ? 'block' : h <= localTarget ? 'share' : 'low';
    if (!found[key]) found[key] = { counter: c.toString(), nonceHex, hashHex: h.toString(16).padStart(64, '0') };
    if (found.block && found.share && found.low) return found;
  }
  throw new Error('nonce search exhausted');
}

// ── main ────────────────────────────────────────────────────────────────────
const template = loadTemplate();
const fakeNode = await startFakeNode(template);
prepareProxyCopy();
const { child, proxyLog } = spawnProxy();
let exitCode = 1;
try {
  await waitForPort(STRATUM_PORT);
  const cli = stratumClient();
  await cli.ready;

  cli.send({ id: 1, method: 'mining.subscribe', params: ['EagleWebMiner/1.0'] });
  const sub = await cli.waitFor(m => m.id === 1);
  const extranonce1 = sub.result[1];
  const prefix8Hex = extranonce1.padEnd(16, '0').slice(0, 16);

  cli.send({ id: 2, method: 'mining.authorize', params: ['web-01', 'x'] });
  await cli.waitFor(m => m.id === 2);
  const notify = await cli.waitFor(m => m.method === 'mining.notify');
  const setTarget = cli.frames.map(f => JSON.parse(f.line)).find(m => m.method === 'mining.set_target');
  if (!setTarget) throw new Error('no mining.set_target received');

  const [jobId, powHashHex, , networkTargetLE] = notify.params;
  const localTarget = hexLEToBigInt(setTarget.params[0]);
  const networkTarget = hexLEToBigInt(networkTargetLE);
  if (networkTarget !== compactToTarget(EASY_COMPACT)) throw new Error('proxy network target != compact_target decode');
  log('job', jobId, 'localTarget 2^' + localTarget.toString(2).length, 'networkTarget 2^' + networkTarget.toString(2).length);

  const nonces = findNonces(powHashHex, prefix8Hex, localTarget, networkTarget);
  log('nonces found', nonces);

  const submit = async (id, job, nonceHex) => { cli.send({ id, method: 'mining.submit', params: ['web-01', job, nonceHex] }); return cli.waitFor(m => m.id === id); };
  const results = {};
  results.low       = await submit(3, jobId, nonces.low.nonceHex);
  results.share     = await submit(4, jobId, nonces.share.nonceHex);
  results.duplicate = await submit(5, jobId, nonces.share.nonceHex);
  results.block     = await submit(6, jobId, nonces.block.nonceHex);
  results.unknownJob = await submit(7, 'ff', nonces.share.nonceHex);
  await new Promise(r => setTimeout(r, 1500)); // let submit_block RPC land
  cli.sock.end();

  const proxyGitHead = (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PROXY_DIR, encoding: 'utf8' }).trim(); } catch { return null; } })();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    profile: PROFILE, capturedAt: new Date().toISOString(), proxyDir: PROXY_DIR, proxyGitHead,
    note: 'Captured from an UNMODIFIED solo-proxy.js against a fake node (no real chain). compact_target lowered so a CPU solves the block target; everything else is a real mainnet block reshaped as get_block_template output.',
    fakeNode: { port: FAKE_NODE_PORT, template: { ...template, transactions: `[${template.transactions.length} txs omitted]`, cellbase: '[omitted]' } },
    clientUA: 'EagleWebMiner/1.0', extranonce1, prefix8Hex,
    job: { jobId, powHashHex, height: notify.params[2], networkTargetLE, shareTargetLE: setTarget.params[0], cleanJobs: notify.params[4], notifyParamCount: notify.params.length },
    nonces, results, frames: cli.frames, rpc: rpcLog, proxyLog,
  }, null, 2) + '\n');
  log('wrote', OUT);
  exitCode = 0;
} catch (e) {
  log('FAILED', e.message);
  log('proxy log tail:\n' + proxyLog.slice(-20).join('\n'));
} finally {
  child.kill('SIGTERM');
  fakeNode.close();
  setTimeout(() => process.exit(exitCode), 300);
}
