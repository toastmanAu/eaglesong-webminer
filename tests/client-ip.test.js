import test from 'node:test';
import assert from 'node:assert/strict';
import { clientIpFromRequest, connectionCountForIp } from '../src/bridge/client-ip.js';
import { validateConfig } from '../src/bridge/config.js';

test('direct clients use the socket address; forwarded headers are ignored by default', () => {
  const req = { socket: { remoteAddress: '203.0.113.9' }, headers: { 'cf-connecting-ip': '198.51.100.2' } };
  assert.equal(clientIpFromRequest(req, null), '203.0.113.9');
  assert.equal(clientIpFromRequest(req, 'cf-connecting-ip'), null, 'trusted header requires a loopback tunnel peer');
});

test('a loopback tunnel may supply a validated Cloudflare client IP', () => {
  const req = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'cf-connecting-ip': '198.51.100.2' } };
  assert.equal(clientIpFromRequest(req, 'cf-connecting-ip'), '198.51.100.2');
  req.headers['cf-connecting-ip'] = 'not an IP';
  assert.equal(clientIpFromRequest(req, 'cf-connecting-ip'), null);
});

test('per-IP counting only sees live sessions', () => {
  const sessions = new Map([[1, { clientIp: 'a' }], [2, { clientIp: 'b' }], [3, { clientIp: 'a' }]]);
  assert.equal(connectionCountForIp(sessions, 'a'), 2);
  sessions.delete(3);
  assert.equal(connectionCountForIp(sessions, 'a'), 1);
});

test('trusted forwarding is explicit and only valid on loopback', () => {
  assert.equal(validateConfig({ stratum: {}, bridge: {} }).bridge.maxConnectionsPerIp, 4);
  assert.throws(() => validateConfig({ stratum: {}, bridge: { trustedClientIpHeader: 'x-forwarded-for' } }), /trustedClientIpHeader/);
  assert.throws(() => validateConfig({ stratum: {}, bridge: { listenHost: '0.0.0.0', allowedOrigins: ['https://example.org'], trustedClientIpHeader: 'cf-connecting-ip' } }), /loopback/);
});
