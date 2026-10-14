/**
 * browser-mining.test.js — the spec's deterministic integration fixture, in a
 * real headless Chromium:
 *
 *   fake TCP Stratum → real bridge → built dist/index.html (served over http)
 *
 * 1. page loads Idle, shows the server-defined payout, nothing hashes
 * 2. Start → state Mining, measured hashes increase, main thread stays responsive
 * 3. a genuinely computed share is recomputed by the bridge AND the fake proxy → "local accepted"
 * 4. a job change mid-mining leaves no result bound to the wrong job
 * 5. Stop → no further hashes, upstream TCP closed; page close → session gone; reload → still Idle
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { validateConfig } from '../../src/bridge/config.js';
import { startBridgeServer } from '../../src/bridge/server.js';
import { createFakeStratumServer, transcriptJob } from '../helpers/fake-stratum-server.js';
import { buildSingleFile } from '../../scripts/build-single-file.mjs';
import { startStaticServer } from '../../scripts/lib/static-server.mjs';
import { eaglesong, hexToBytes, bytesToHex } from '../../src/hash/eaglesong-core.js';
import { targetToHexLE, targetForExpectedHashes } from '../../src/hash/target.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const t = JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/stratum-transcripts/solo-proxy-local.json'), 'utf8'));
const EASY_SHARE_LE = targetToHexLE(targetForExpectedHashes(2000n)); // ~2k hashes per share: renders, validates, and still takes real work
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const OUT_DIR = path.join(process.env.CLAUDE_SCRATCHPAD ?? path.join(ROOT, 'runtime'), 'e2e-dist');

async function stack(fn) {
  const fake = createFakeStratumServer({ ...transcriptJob(t), shareTargetLE: EASY_SHARE_LE });
  const stratumPort = await fake.start();
  const ui = await startStaticServer({ root: OUT_DIR, port: 0 }).catch(async () => { mkdirSync(OUT_DIR, { recursive: true }); return startStaticServer({ root: OUT_DIR, port: 0 }); });
  const bridge = await startBridgeServer(validateConfig({
    bridge: { listenHost: '127.0.0.1', port: 0, allowedOrigins: [ui.url], statusIntervalMs: 500, perSessionSubmissionsPerMinute: 600 },
    stratum: { host: '127.0.0.1', port: stratumPort, profile: 'solo-proxy-v1' }, mining: { mode: 'solo' }, payout: { displayAddress: 'ckb1qyqtestpayoutaddress' },
  }), { logger: () => {} });
  mkdirSync(OUT_DIR, { recursive: true });
  const built = await buildSingleFile({ bridgeUrl: `ws://127.0.0.1:${bridge.port}`, out: path.join(OUT_DIR, 'index.html') });
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  try { await fn({ fake, bridge, page, context, browser, ui, built, consoleErrors }); }
  finally { await browser.close(); await bridge.close(); await ui.close(); await fake.stop(); }
}
const num = (s) => Number(String(s).replace(/[^\d]/g, ''));

test('browser e2e: idle → start → genuine server-validated share → job churn → stop → teardown', async () => {
  await stack(async ({ fake, bridge, page, context, ui, built, consoleErrors }) => {
    await page.goto(`${ui.url}/index.html`);
    // 1. idle, nothing running
    assert.equal(await page.textContent('#state-label'), 'Idle');
    assert.equal(await page.isDisabled('#btn-stop'), true);
    assert.equal(num(await page.textContent('#st-total')), 0);
    assert.equal((await page.textContent('#diag-build')).includes(built.buildHash.slice(0, 12)), true, 'page shows the build hash');
    await sleep(1500);
    assert.equal(num(await page.textContent('#st-total')), 0, 'no covert hashing while idle');
    assert.equal(fake.connections.size, 0, 'no upstream session before Start');
    assert.equal(bridge.sessions.size, 0, 'the page does not even open the bridge socket before Start');

    // main-thread responsiveness probe
    await page.evaluate(() => { window.__lt = []; try { new PerformanceObserver(l => l.getEntries().forEach(e => window.__lt.push(e.duration))).observe({ type: 'longtask', buffered: true }); } catch {} });

    // 2. start
    await page.click('#btn-start');
    await page.waitForFunction(() => document.getElementById('state-label').textContent === 'Mining', null, { timeout: 15000 });
    assert.equal(await page.textContent('#payout-address'), 'ckb1qyqtestpayoutaddress', 'server-defined payout is displayed');
    assert.match(await page.textContent('#payout-verified'), /unverified/);
    assert.equal(await page.textContent('#job-id'), t.job.jobId);
    assert.equal(num(await page.textContent('#job-height')), t.job.height);
    await page.waitForFunction(() => Number(document.getElementById('st-total').textContent.replace(/[^\d]/g, '')) > 0, null, { timeout: 15000 });
    const h1 = num(await page.textContent('#st-total'));
    await sleep(1500);
    const h2 = num(await page.textContent('#st-total'));
    assert.ok(h2 > h1, `hashes increase while mining (${h1} → ${h2})`);
    assert.equal(fake.connections.size, 1, 'exactly one upstream TCP session for this browser');

    // 3. a genuinely computed share accepted by the bridge AND the fake proxy
    await page.waitForFunction(() => Number(document.querySelector('#share-counters li[data-cls="local_accepted"] b').textContent) >= 1, null, { timeout: 60000 });
    const accepted = fake.submits.filter(s => s.accepted);
    assert.ok(accepted.length >= 1);
    for (const s of accepted) {
      const input = new Uint8Array(48); input.set(hexToBytes(t.job.powHashHex), 0); input.set(hexToBytes(s.nonceHex), 32);
      assert.equal(bytesToHex(eaglesong(input)), s.hashHex, 'test-side recomputation of the browser nonce matches the proxy');
      assert.equal(s.nonceHex.slice(16), t.prefix8Hex, 'nonce carries the session prefix');
    }
    const lastNonce = await page.textContent('#st-last-nonce');
    assert.match(lastNonce, /^[0-9a-f]{32}$/);
    const longTasks = await page.evaluate(() => window.__lt ?? []);
    assert.ok(longTasks.every(d => d < 100), `no main-thread block ≥100ms (long tasks: ${longTasks.join(',')})`);

    // 4. job change mid-batch: nothing is bound to the wrong job
    fake.setJob({ jobId: 'e2e-b2', powHashHex: 'cd'.repeat(32), height: t.job.height + 1 }, true);
    await page.waitForFunction(() => document.getElementById('job-id').textContent === 'e2e-b2', null, { timeout: 10000 });
    await page.waitForFunction(() => Number(document.querySelector('#share-counters li[data-cls="local_accepted"] b').textContent) >= 2, null, { timeout: 60000 });
    for (const s of fake.submits) {
      if (s.unknownJob) continue; // stale job the proxy blind-ACKs: bridge judged it against its own snapshot
      const pow = s.jobId === 'e2e-b2' ? 'cd'.repeat(32) : t.job.powHashHex;
      const input = new Uint8Array(48); input.set(hexToBytes(pow), 0); input.set(hexToBytes(s.nonceHex), 32);
      assert.equal(bytesToHex(eaglesong(input)), s.hashHex, `submission for job ${s.jobId} hashes against that job's pow_hash`);
    }
    assert.equal(num(await page.textContent('#share-counters li[data-cls="rejected_invalid"] b')), 0, 'no invalid submissions');

    // 5. stop
    await page.click('#btn-stop');
    await page.waitForFunction(() => document.getElementById('state-label').textContent === 'Stopped', null, { timeout: 10000 });
    const frozen = await page.evaluate(() => window.__eagle.stats.snapshot().totalHashes);
    assert.equal(num(await page.textContent('#st-total')), frozen, 'Stop renders the final hash count immediately');
    await sleep(1500);
    assert.equal(num(await page.textContent('#st-total')), frozen, 'no hashes after Stop');
    assert.equal(await page.evaluate(() => window.__eagle.stats.snapshot().totalHashes), frozen);
    assert.equal(fake.connections.size, 0, 'upstream TCP session closed on Stop');
    assert.equal(await page.isDisabled('#btn-start'), false, 'can start again');
    assert.deepEqual(consoleErrors, [], 'no page errors: ' + JSON.stringify(consoleErrors));

    // reload never auto-starts
    await page.reload();
    await sleep(800);
    assert.equal(await page.textContent('#state-label'), 'Idle');
    assert.equal(num(await page.textContent('#st-total')), 0);

    // close page → bridge session + any TCP gone
    await page.close(); await context.close();
    await sleep(300);
    assert.equal(bridge.sessions.size, 0, 'closing the page releases the bridge session');
    assert.equal(fake.connections.size, 0);
  });
});

test('browser e2e: hiding the tab pauses hashing by default and resumes when visible', async () => {
  await stack(async ({ page, ui }) => {
    await page.goto(`${ui.url}/index.html`);
    await page.click('#btn-start');
    await page.waitForFunction(() => document.getElementById('state-label').textContent === 'Mining', null, { timeout: 15000 });
    await page.waitForFunction(() => Number(document.getElementById('st-total').textContent.replace(/[^\d]/g, '')) > 0, null, { timeout: 15000 });
    // simulate the tab being hidden (the app reads document.hidden on visibilitychange)
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForFunction(() => document.getElementById('state-label').textContent === 'Paused (tab hidden)', null, { timeout: 5000 });
    await sleep(1200);
    const frozen = num(await page.textContent('#st-total'));
    await sleep(1500);
    assert.equal(num(await page.textContent('#st-total')), frozen, 'no hashing while hidden');
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForFunction(() => document.getElementById('state-label').textContent === 'Mining', null, { timeout: 5000 });
    await page.waitForFunction((f) => Number(document.getElementById('st-total').textContent.replace(/[^\d]/g, '')) > f, frozen, { timeout: 10000 });
    await page.click('#btn-stop');
    await page.waitForFunction(() => document.getElementById('state-label').textContent === 'Stopped', null, { timeout: 10000 });
  });
});
