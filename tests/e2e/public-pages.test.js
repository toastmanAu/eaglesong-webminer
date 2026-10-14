/** Post-deploy gate: exercise the actual GitHub Pages URL in Chromium. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const pageUrl = process.env.PAGES_URL;
const bridgeUrl = process.env.PAGES_BRIDGE_URL;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const count = text => Number(String(text).replace(/[^\d]/g, ''));

test('published Pages site: idle → real share → stop → reload idle', { skip: !pageUrl && process.env.REQUIRE_PUBLIC_PAGE !== '1' }, async () => {
  assert.ok(pageUrl, 'PAGES_URL is required for the post-deploy browser gate');
  assert.ok(bridgeUrl, 'PAGES_BRIDGE_URL is required for the public browser gate');
  assert.equal(new URL(pageUrl).protocol, 'https:');
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(String(error)));
  try {
    let loaded = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      const response = await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      if (response?.ok() && await page.locator('#eagle-config').count() === 1) { loaded = true; break; }
      await sleep(2000);
    }
    assert.equal(loaded, true, 'published page and its runtime configuration must be reachable');
    const embeddedBridge = await page.locator('#eagle-config').textContent();
    assert.equal(JSON.parse(embeddedBridge).bridgeUrl, new URL(bridgeUrl).origin, 'deployed page uses the intended public bridge');
    assert.equal(await page.locator('#state-label').textContent(), 'Idle');
    assert.equal(count(await page.locator('#st-total').textContent()), 0);
    await sleep(1200);
    assert.equal(count(await page.locator('#st-total').textContent()), 0, 'nothing hashes before Start');
    assert.equal(await page.evaluate(() => window.__eagle?.client.state), 'disconnected', 'no bridge session before Start');

    await page.evaluate(() => {
      window.__publicShareResults = [];
      window.__eagle.client.on('share_result', result => window.__publicShareResults.push(result));
    });
    await page.locator('#btn-start').click();
    await page.waitForFunction(() => document.querySelector('#state-label')?.textContent === 'Mining', null, { timeout: 30000 });
    assert.match(await page.locator('#payout-verified').textContent(), /verified from node template/);
    assert.match(await page.locator('#payout-address').textContent(), /^ck[bt]1[0-9a-z.]+$/);
    assert.ok((await page.locator('#job-id').textContent()).length > 0);
    await page.waitForFunction(() => Number(document.querySelector('#st-total')?.textContent.replace(/[^\d]/g, '')) > 0, null, { timeout: 30000 });
    await page.waitForFunction(() => window.__publicShareResults?.some(r => r.accepted === true &&
      ['local_accepted', 'block_candidate'].includes(r.classification) && /^[0-9a-f]{64}$/.test(r.hashHex)), null, { timeout: 120000 });
    const accepted = await page.evaluate(() => window.__publicShareResults.find(r => r.accepted === true &&
      ['local_accepted', 'block_candidate'].includes(r.classification)));
    assert.ok(accepted, 'the browser received an independently validated, proxy ACKed share');

    await page.locator('#btn-stop').click();
    await page.waitForFunction(() => document.querySelector('#state-label')?.textContent === 'Stopped', null, { timeout: 15000 });
    const frozen = count(await page.locator('#st-total').textContent());
    await sleep(1500);
    assert.equal(count(await page.locator('#st-total').textContent()), frozen, 'Stop leaves no residual hashing');
    await page.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('#state-label').textContent(), 'Idle');
    await sleep(1000);
    assert.equal(count(await page.locator('#st-total').textContent()), 0, 'reload does not auto-start mining');
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
  }
});

test('published Pages site: sustained mining stays within submission capacity and Stop remains prompt', { skip: !pageUrl && process.env.REQUIRE_PUBLIC_PAGE !== '1' }, async () => {
  assert.ok(pageUrl && bridgeUrl, 'public page and bridge are required');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));
  try {
    const response = await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    assert.equal(response?.ok(), true);
    await page.locator('#workers').evaluate(el => {
      el.value = el.max;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.locator('#btn-start').click();
    await page.waitForFunction(() => document.querySelector('#state-label')?.textContent === 'Mining', null, { timeout: 30000 });
    await sleep(30000);
    const beforeStop = await page.evaluate(() => window.__eagle.stats.snapshot());
    assert.ok(beforeStop.totalHashes > 100000, 'sustained run performed real hashing');
    assert.equal(beforeStop.shares.upstream_error ?? 0, 0, 'no submission timeouts or upstream errors');
    assert.ok((beforeStop.shares.block_candidate ?? 0) < 100, 'development-chain target must not flood block submissions');
    await page.locator('#btn-stop').click();
    await page.waitForFunction(() => document.querySelector('#state-label')?.textContent === 'Stopped', null, { timeout: 10000 });
    const frozen = count(await page.locator('#st-total').textContent());
    await sleep(1000);
    assert.equal(count(await page.locator('#st-total').textContent()), frozen, 'no hashing after Stop');
    assert.deepEqual(pageErrors, []);
  } finally { await browser.close(); }
});
