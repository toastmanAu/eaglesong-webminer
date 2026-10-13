#!/usr/bin/env node
/**
 * demo-screenshot.mjs — bring up fake stratum → bridge → built page in headless
 * Chromium, press Start, wait for an accepted share, and save screenshots as UI
 * evidence (idle + mining, phone viewport). No real chain involved.
 *
 *   node scripts/demo-screenshot.mjs [--out docs/reports/screenshots]
 */
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { validateConfig } from '../src/bridge/config.js';
import { startBridgeServer } from '../src/bridge/server.js';
import { createFakeStratumServer, transcriptJob } from '../tests/helpers/fake-stratum-server.js';
import { buildSingleFile } from './build-single-file.mjs';
import { startStaticServer } from './lib/static-server.mjs';
import { targetToHexLE, targetForExpectedHashes } from '../src/hash/target.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => (a.startsWith('--') ? [a.slice(2), arr[i + 1]] : [])).filter(x => x.length));
const OUT = path.resolve(args.out ?? path.join(ROOT, 'docs', 'reports', 'screenshots'));
mkdirSync(OUT, { recursive: true });
const t = JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/stratum-transcripts/solo-proxy-local.json'), 'utf8'));

// share target ~100k hashes (a few shares/s on a desktop), network target ~1e9 hashes so shares are plain local shares
const base = transcriptJob(t);
const fake = createFakeStratumServer({ ...base, job: { ...base.job, networkTargetLE: targetToHexLE(targetForExpectedHashes(10n ** 9n)) }, shareTargetLE: targetToHexLE(targetForExpectedHashes(100000n)), shareDifficulty: 100000 / 2 ** 32 });
const stratumPort = await fake.start();
const distDir = path.join(process.env.CLAUDE_SCRATCHPAD ?? path.join(ROOT, 'runtime'), 'demo-dist');
mkdirSync(distDir, { recursive: true });
const ui = await startStaticServer({ root: distDir });
const bridge = await startBridgeServer(validateConfig({ bridge: { port: 0, allowedOrigins: [ui.url], perSessionSubmissionsPerMinute: 2000 }, stratum: { port: stratumPort }, payout: { displayAddress: 'ckb1qyqdemo0operator0address0shown0readonly' } }), { logger: () => {} });
await buildSingleFile({ bridgeUrl: `ws://127.0.0.1:${bridge.port}`, out: path.join(distDir, 'index.html') });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
await page.goto(`${ui.url}/index.html`);
await page.screenshot({ path: path.join(OUT, 'idle-mobile.png'), fullPage: true });
await page.click('#btn-start');
await page.waitForFunction(() => document.getElementById('state-label').textContent === 'Mining', null, { timeout: 20000 });
page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
page.on('pageerror', (e) => console.error('[pageerror]', String(e)));
try {
  await page.waitForFunction(() => Number(document.querySelector('#share-counters li[data-cls="local_accepted"] b').textContent) >= 1, null, { timeout: 60000 });
} catch (e) {
  console.error('no accepted share within 60s; page log follows');
  console.error(JSON.stringify(await page.evaluate(() => ({ state: window.__eagle.state.state, stats: window.__eagle.stats.snapshot(), coord: { ...window.__eagle.coord.snapshot(), cursor: window.__eagle.coord.snapshot().cursor.toString() }, log: window.__eagle.logEntries.slice(-15) })), null, 1));
  console.error('fake submits', fake.submits.length, 'bridge sessions', bridge.sessions.size);
  throw e;
}
await page.waitForTimeout(6000); // let the 5 s rate settle
await page.screenshot({ path: path.join(OUT, 'mining-mobile.png'), fullPage: true });
const desktop = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await desktop.goto(`${ui.url}/index.html`);
await desktop.click('#btn-start');
await desktop.waitForFunction(() => Number(document.querySelector('#share-counters li[data-cls="local_accepted"] b').textContent) >= 2, null, { timeout: 120000 });
await desktop.waitForTimeout(6000);
await desktop.screenshot({ path: path.join(OUT, 'mining-desktop.png'), fullPage: true });
const stats = await page.evaluate(() => ({ state: window.__eagle.state.state, total: document.getElementById('st-total').textContent, rate5s: document.getElementById('st-5s').textContent, shares: Object.fromEntries([...document.querySelectorAll('#share-counters li')].map(li => [li.dataset.cls, Number(li.querySelector('b').textContent)])) }));
console.log(JSON.stringify({ screenshots: OUT, mobile: stats, fakeSubmits: fake.submits.length, accepted: fake.submits.filter(s => s.accepted).length }, null, 2));
await page.click('#btn-stop'); await desktop.click('#btn-stop');
await page.waitForTimeout(500);
await browser.close(); await bridge.close(); await ui.close(); await fake.stop();
