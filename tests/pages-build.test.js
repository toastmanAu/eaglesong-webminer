import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildPages } from '../scripts/build-pages.mjs';

test('Pages build requires an explicit secure public bridge URL', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'eagle-pages-'));
  try {
    await assert.rejects(buildPages({ bridgeUrl: '', out: path.join(dir, 'index.html') }), /PAGES_BRIDGE_URL/);
    await assert.rejects(buildPages({ bridgeUrl: 'ws://example.org', out: path.join(dir, 'index.html') }), /wss:\/\//);
    await assert.rejects(buildPages({ bridgeUrl: 'wss://127.0.0.1:8788', out: path.join(dir, 'index.html') }), /public hostname/);
    await assert.rejects(buildPages({ bridgeUrl: 'wss://[::ffff:127.0.0.1]', out: path.join(dir, 'index.html') }), /public hostname/);
    const out = path.join(dir, 'index.html');
    await buildPages({ bridgeUrl: 'wss://bridge.example.org', out });
    const html = readFileSync(out, 'utf8');
    assert.match(html, /wss:\/\/bridge\.example\.org/);
    assert.match(html, /Development chain demo\. Blocks found here have no monetary value/);
    assert.doesNotMatch(html, /ws:\/\/127\.0\.0\.1:8788/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
