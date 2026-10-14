/**
 * config.js — schema-validated bridge configuration (server-side only).
 * Explicit validators, defaults filled, unknown keys rejected, offending path
 * named in every error. Nothing from the browser ever reaches this.
 */
import { readFileSync } from 'node:fs';
import { PROFILE_NAMES } from './protocol-adapter.js';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

class ConfigError extends Error { constructor(path, msg) { super(`config ${path}: ${msg}`); this.name = 'ConfigError'; this.path = path; } }

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function int(v, path, { min, max, def }) {
  if (v === undefined) { if (def === undefined) throw new ConfigError(path, 'is required'); return def; }
  if (!Number.isInteger(v) || v < min || v > max) throw new ConfigError(path, `must be an integer in [${min}, ${max}]`);
  return v;
}
function str(v, path, { def, pattern, allowNull = false } = {}) {
  if (v === undefined) { if (def === undefined) throw new ConfigError(path, 'is required'); return def; }
  if (v === null && allowNull) return null;
  if (typeof v !== 'string' || v.length === 0) throw new ConfigError(path, 'must be a non-empty string');
  if (pattern && !pattern.test(v)) throw new ConfigError(path, `must match ${pattern}`);
  return v;
}
function bool(v, path, def) {
  if (v === undefined) return def;
  if (typeof v !== 'boolean') throw new ConfigError(path, 'must be a boolean');
  return v;
}
function onlyKeys(obj, path, allowed) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) throw new ConfigError(`${path}.${k}`, `unknown key "${k}"`);
}

/** @param {unknown} raw parsed JSON */
export function validateConfig(raw) {
  if (!isObj(raw)) throw new ConfigError('', 'must be a JSON object');
  onlyKeys(raw, '', ['bridge', 'stratum', 'mining', 'payout']);
  const b = isObj(raw.bridge) ? raw.bridge : (raw.bridge === undefined ? {} : (() => { throw new ConfigError('bridge', 'must be an object'); })());
  onlyKeys(b, 'bridge', ['listenHost', 'port', 'allowedOrigins', 'maxConnections', 'maxConnectionsPerIp', 'trustedClientIpHeader', 'maxInboundFrameBytes', 'perSessionSubmissionsPerMinute', 'maxConcurrentSubmissions', 'maxJobsPerSession', 'submitTimeoutMs', 'statusIntervalMs', 'heartbeatIntervalMs']);
  const listenHost = str(b.listenHost, 'bridge.listenHost', { def: '127.0.0.1' });
  if (b.allowedOrigins !== undefined && (!Array.isArray(b.allowedOrigins) || !b.allowedOrigins.every(o => typeof o === 'string' && o.length > 0 && o.length <= 253))) {
    throw new ConfigError('bridge.allowedOrigins', 'must be an array of non-empty origin strings');
  }
  const allowedOrigins = (b.allowedOrigins ?? ['http://localhost:5173', 'http://127.0.0.1:5173']).map(o => o.toLowerCase());
  if (!LOOPBACK.has(listenHost) && allowedOrigins.length === 0) {
    throw new ConfigError('bridge.allowedOrigins', 'must be non-empty when listenHost is non-loopback (public exposure requires a strict Origin allowlist)');
  }
  const bridge = {
    listenHost,
    port: int(b.port, 'bridge.port', { min: 0, max: 65535, def: 8788 }),
    allowedOrigins,
    maxConnections: int(b.maxConnections, 'bridge.maxConnections', { min: 1, max: 10000, def: 50 }),
    maxConnectionsPerIp: int(b.maxConnectionsPerIp, 'bridge.maxConnectionsPerIp', { min: 1, max: 10000, def: 4 }),
    trustedClientIpHeader: b.trustedClientIpHeader === undefined ? null : str(b.trustedClientIpHeader, 'bridge.trustedClientIpHeader', { allowNull: true }),
    maxInboundFrameBytes: int(b.maxInboundFrameBytes, 'bridge.maxInboundFrameBytes', { min: 1024, max: 65536, def: 16384 }),
    perSessionSubmissionsPerMinute: int(b.perSessionSubmissionsPerMinute, 'bridge.perSessionSubmissionsPerMinute', { min: 1, max: 100000, def: 120 }),
    maxConcurrentSubmissions: int(b.maxConcurrentSubmissions, 'bridge.maxConcurrentSubmissions', { min: 1, max: 64, def: 8 }),
    maxJobsPerSession: int(b.maxJobsPerSession, 'bridge.maxJobsPerSession', { min: 8, max: 1024, def: 32 }),
    submitTimeoutMs: int(b.submitTimeoutMs, 'bridge.submitTimeoutMs', { min: 100, max: 120000, def: 10000 }),
    statusIntervalMs: int(b.statusIntervalMs, 'bridge.statusIntervalMs', { min: 100, max: 60000, def: 1000 }),
    heartbeatIntervalMs: int(b.heartbeatIntervalMs, 'bridge.heartbeatIntervalMs', { min: 1000, max: 300000, def: 30000 }),
  };
  if (bridge.trustedClientIpHeader !== null && bridge.trustedClientIpHeader !== 'cf-connecting-ip') throw new ConfigError('bridge.trustedClientIpHeader', 'only cf-connecting-ip is supported');
  if (bridge.trustedClientIpHeader !== null && !LOOPBACK.has(bridge.listenHost)) throw new ConfigError('bridge.listenHost', 'must be loopback when trustedClientIpHeader is enabled');

  const s = isObj(raw.stratum) ? raw.stratum : (() => { throw new ConfigError('stratum', 'must be an object'); })();
  onlyKeys(s, 'stratum', ['host', 'port', 'profile', 'statsPort']);
  const profile = str(s.profile, 'stratum.profile', { def: 'solo-proxy-v1' });
  if (!PROFILE_NAMES.includes(profile)) throw new ConfigError('stratum.profile', `must be one of ${PROFILE_NAMES.join(', ')}`);
  const stratum = { host: str(s.host, 'stratum.host', { def: '127.0.0.1' }), port: int(s.port, 'stratum.port', { min: 1, max: 65535, def: 3334 }), profile,
    statsPort: s.statsPort === undefined ? null : int(s.statsPort, 'stratum.statsPort', { min: 1, max: 65535 }) };
  if (stratum.statsPort !== null && !LOOPBACK.has(stratum.host)) throw new ConfigError('stratum.host', 'must be loopback when statsPort is enabled');

  const m = isObj(raw.mining) ? raw.mining : (raw.mining === undefined ? {} : (() => { throw new ConfigError('mining', 'must be an object'); })());
  onlyKeys(m, 'mining', ['mode', 'targetShareSeconds', 'webProfileEnabled']);
  const mode = str(m.mode, 'mining.mode', { def: 'solo' });
  if (mode !== 'solo') throw new ConfigError('mining.mode', 'only "solo" is implemented (pool relay is a gated later pass)');
  const mining = { mode, targetShareSeconds: int(m.targetShareSeconds, 'mining.targetShareSeconds', { min: 1, max: 3600, def: 30 }), webProfileEnabled: bool(m.webProfileEnabled, 'mining.webProfileEnabled', false) };

  const p = isObj(raw.payout) ? raw.payout : (raw.payout === undefined ? {} : (() => { throw new ConfigError('payout', 'must be an object'); })());
  onlyKeys(p, 'payout', ['displayConfiguredAddressOnly', 'displayAddress']);
  const payout = {
    displayConfiguredAddressOnly: bool(p.displayConfiguredAddressOnly, 'payout.displayConfiguredAddressOnly', true),
    displayAddress: p.displayAddress === undefined ? null : str(p.displayAddress, 'payout.displayAddress', { allowNull: true, pattern: /^ck[bt]1[0-9a-z.]{3,}$/ }),
  };
  return Object.freeze({ bridge: Object.freeze(bridge), stratum: Object.freeze(stratum), mining: Object.freeze(mining), payout: Object.freeze(payout) });
}

/** @param {string} filePath */
export function loadConfig(filePath) {
  let raw;
  try { raw = JSON.parse(readFileSync(filePath, 'utf8')); }
  catch (e) { throw new ConfigError(filePath, `cannot read/parse: ${e.message}`); }
  return validateConfig(raw);
}
