import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { validateProxyStats, fetchProxyStats } from '../src/bridge/proxy-stats.js';
import { validateConfig } from '../src/bridge/config.js';
import { createSession } from '../src/bridge/session.js';

const address = 'ckt1qyq' + 'q'.repeat(40);

test('only a fresh healthy node-derived payout with no drift is verified', () => {
  assert.deepEqual(validateProxyStats({ payoutAddress: address, nodeHealthy: true, payoutDrift: false, templateAge: 2 }),
    { address, verified: true, nodeHealthy: true, templateAgeSec: 2 });
  for (const change of [
    { payoutAddress: null }, { payoutAddress: 'https://foreign' }, { nodeHealthy: false },
    { payoutDrift: true }, { templateAge: 121 }, { templateAge: null },
  ]) {
    const result = validateProxyStats({ payoutAddress: address, nodeHealthy: true, payoutDrift: false, templateAge: 2, ...change });
    assert.equal(result.verified, false);
  }
  assert.throws(() => validateProxyStats(null), /object/);
});

test('fetchProxyStats refuses remote hosts and invalid ports before any connection', async () => {
  await assert.rejects(fetchProxyStats({ host: 'example.com', port: 8081 }), /loopback/);
  await assert.rejects(fetchProxyStats({ host: '127.0.0.1', port: 0 }), /port invalid/);
});

test('fetchProxyStats accepts bounded JSON and rejects HTTP errors and oversized data', async t => {
  let status = 200;
  let body = JSON.stringify({ payoutAddress: address, nodeHealthy: true, payoutDrift: false, templateAge: 1 });
  t.mock.method(http, 'get', (_options, onResponse) => {
    const req = new EventEmitter();
    req.destroy = error => req.emit('error', error);
    queueMicrotask(() => {
      const res = Readable.from([Buffer.from(body)]);
      res.statusCode = status;
      onResponse(res);
    });
    return req;
  });
  assert.equal((await fetchProxyStats({ host: '127.0.0.1', port: 8082 })).verified, true);
  status = 500;
  await assert.rejects(fetchProxyStats({ host: '127.0.0.1', port: 8082 }), /HTTP 500/);
  status = 200;
  body = 'x'.repeat(1024 * 1024 + 1);
  await assert.rejects(fetchProxyStats({ host: '127.0.0.1', port: 8082 }), /too large/);
});

test('stats configuration is loopback-only and a session revokes stale payout state', () => {
  const cfg = validateConfig({ stratum: { host: '127.0.0.1', statsPort: 8082 } });
  assert.equal(cfg.stratum.statsPort, 8082);
  assert.throws(() => validateConfig({ stratum: { host: 'example.com', statsPort: 8082 } }), /loopback/);
  const sent = [];
  const session = createSession({ config: cfg, send: m => sent.push(m), close: () => {} });
  session.applyProxyStats({ address, verified: true, nodeHealthy: true, templateAgeSec: 1 });
  assert.equal(sent.at(-1).payout.verified, true);
  assert.equal(sent.at(-1).payout.address, address);
  session.applyProxyStats(null);
  assert.equal(sent.at(-1).payout.verified, false);
  assert.equal(sent.at(-1).nodeHealthy, null);
  session.onClose();
});
