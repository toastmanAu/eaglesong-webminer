/**
 * real-proxy.test.js — PASS 1 gate against the REAL, UNMODIFIED solo-proxy.js
 * (operator copy at /home/phill/proxy-server when present, else the pinned
 * GitHub checkout in vendor/). Only the CKB node is faked (one real-mainnet
 * block reshaped as a template with an easy compact_target).
 *
 *   browser (headless Chromium, built dist) → bridge → REAL solo-proxy → fake node
 *
 * Proves: the share the browser computed is recomputed and ACKed by the real
 * proxy; a network-target nonce makes the real proxy call submit_block; and —
 * on the fixed operator copy — the header nonce it submits LE-serializes to
 * exactly the bytes the browser hashed (the spec's pitfall 11, closed).
 * Skips cleanly when no proxy checkout is available.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { validateConfig } from '../../src/bridge/config.js';
import { startBridgeServer } from '../../src/bridge/server.js';
import { findProxyDir, startRealSoloProxy } from '../helpers/real-proxy-harness.js';
import { buildSingleFile } from '../../scripts/build-single-file.mjs';
import { startStaticServer } from '../../scripts/lib/static-server.mjs';
import { eaglesong, hexToBytes, bytesToHex } from '../../src/hash/eaglesong-core.js';
import { compactToTarget, meetsTarget } from '../../src/hash/target.js';
import { rpcNonceToRawNonceHex } from '../../src/hash/nonce.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = path.join(process.env.CLAUDE_SCRATCHPAD ?? path.join(ROOT, 'runtime'), 'real-proxy-dist');
const PROXY_DIR = findProxyDir();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const num = (s) => Number(String(s).replace(/[^\d]/g, ''));

(PROXY_DIR ? test : test.skip)(`browser share accepted by the REAL solo proxy (${PROXY_DIR})`, async () => {
  const proxy = await startRealSoloProxy({ proxyDir: PROXY_DIR });
  mkdirSync(OUT_DIR, { recursive: true });
  const ui = await startStaticServer({ root: OUT_DIR });
  const bridge = await startBridgeServer(validateConfig({
    bridge: { listenHost: '127.0.0.1', port: 0, allowedOrigins: [ui.url], statusIntervalMs: 500, perSessionSubmissionsPerMinute: 600 },
    stratum: { host: '127.0.0.1', port: proxy.stratumPort, profile: 'solo-proxy-v1' }, mining: { mode: 'solo' }, payout: { displayAddress: 'ckb1qyq...' },
  }), { logger: () => {} });
  await buildSingleFile({ bridgeUrl: `ws://127.0.0.1:${bridge.port}`, out: path.join(OUT_DIR, 'index.html') });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const shareLog = [];
  try {
    await page.goto(`${ui.url}/index.html`);
    assert.equal(await page.textContent('#state-label'), 'Idle');
    await page.click('#btn-start');
    await page.waitForFunction(() => document.getElementById('state-label').textContent === 'Mining', null, { timeout: 20000 });
    const jobId = await page.textContent('#job-id');
    assert.match(jobId, /^[0-9a-f]+$/, 'job id issued by the real proxy');
    assert.equal(num(await page.textContent('#job-height')), parseInt(proxy.node.template.number, 16), 'height from the real template');
    // ~4k hashes per share at diff 1e-6 and ~16k per "block" at compact 0x1f040000: wait for both
    await page.waitForFunction(() => Number(document.querySelector('#share-counters li[data-cls="local_accepted"] b').textContent) >= 1, null, { timeout: 120000 });
    await page.waitForFunction(() => Number(document.querySelector('#share-counters li[data-cls="block_candidate"] b').textContent) >= 1, null, { timeout: 180000 });
    await page.click('#btn-stop');
    await page.waitForFunction(() => document.getElementById('state-label').textContent === 'Stopped', null, { timeout: 10000 });
    await sleep(500);

    // the REAL proxy's own log is the evidence
    const accepted = proxy.log.filter(l => /share accepted/.test(l));
    const blocks = proxy.log.filter(l => /BLOCK SOLUTION/.test(l));
    const rejected = proxy.log.filter(l => /below local diff/.test(l));
    shareLog.push(...accepted, ...blocks);
    assert.ok(accepted.length >= 1, `real proxy logged accepted shares: ${accepted.length}`);
    assert.ok(blocks.length >= 1, 'real proxy logged a network-target solution');
    assert.equal(rejected.length, 0, 'the browser never submitted a below-target share to the real proxy');
    assert.ok(proxy.log.some(l => /subscribed \(ua=EagleWebMiner\/1\.0/.test(l)), 'pinned UA on the real proxy');

    // submit_block was called on the (fake) node by the REAL proxy code
    const subs = proxy.node.rpcLog.filter(r => r.method === 'submit_block');
    assert.ok(subs.length >= 1, 'real proxy called submit_block');
    const block = subs[0].params[1];
    assert.equal(subs[0].params[0], '0x1', 'work_id from the template');
    assert.match(block.header.nonce, /^0x([1-9a-f][0-9a-f]*|0)$/, 'canonical Uint128 nonce');
    const nonceLE = rpcNonceToRawNonceHex(block.header.nonce);
    const notifyLine = proxy.log.find(l => /\[JOB/.test(l));
    assert.ok(notifyLine, 'proxy logged its job');
    // the pow_hash the proxy mined is what it put on the wire; get it from the bridge's registry via the stats endpoint is not exposed → recompute from the template with the proxy's own header code
    const { createRequire } = await import('node:module');
    const req = createRequire(path.join(proxy.dir, 'package.json'));
    const { templateToHeaderFields } = req(path.join(proxy.dir, 'ckb-merkle.js'));
    const { computePowHash } = req(path.join(proxy.dir, 'ckb-header.js'));
    const powHash = computePowHash(templateToHeaderFields(proxy.node.template));
    const input = new Uint8Array(48); input.set(hexToBytes(powHash), 0); input.set(hexToBytes(nonceLE), 32);
    const digest = eaglesong(input);
    const target = compactToTarget(proxy.node.template.compact_target);
    const isFixedProxy = proxy.log.length > 0 && !/vendor\/ckb-stratum-proxy$/.test(PROXY_DIR);
    if (isFixedProxy) {
      assert.equal(meetsTarget(digest, target), true, 'FIXED proxy: u128-LE(header.nonce) hashes to a digest that meets the network target — the submitted block carries the nonce that was actually solved');
    } else {
      assert.equal(meetsTarget(digest, target), false, 'GitHub main: the byte-reversed header nonce does NOT verify (pitfall 11 reproduced end to end)');
    }
    assert.ok(hexToBytes(powHash).length === 32 && bytesToHex(digest).length === 64);
    console.log(`\n[real-proxy] ${PROXY_DIR} @ ${proxy.proxyGitHead}\n` + shareLog.map(l => '  ' + l).join('\n') + `\n  submit_block header.nonce=${block.header.nonce} → le=${nonceLE} meetsTarget=${meetsTarget(digest, target)}\n`);
  } finally {
    await browser.close(); await bridge.close(); await ui.close(); await proxy.stop();
  }
});
