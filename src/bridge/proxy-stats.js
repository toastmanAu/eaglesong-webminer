/** Read the operator proxy's node-derived payout from its loopback stats API. */
import http from 'node:http';

const MAX_BYTES = 1024 * 1024; // the root stats response also contains bounded timeseries data
const MAX_TEMPLATE_AGE_SEC = 120;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const ADDRESS = /^ck[bt]1[023456789acdefghjklmnpqrstuvwxyz]{10,1024}$/;

export function validateProxyStats(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('proxy stats must be an object');
  const address = typeof raw.payoutAddress === 'string' && ADDRESS.test(raw.payoutAddress) ? raw.payoutAddress : null;
  const nodeHealthy = raw.nodeHealthy === true;
  const templateAgeSec = Number.isInteger(raw.templateAge) && raw.templateAge >= 0 ? raw.templateAge : null;
  const verified = address !== null && nodeHealthy && raw.payoutDrift === false &&
    templateAgeSec !== null && templateAgeSec <= MAX_TEMPLATE_AGE_SEC;
  return { address, verified, nodeHealthy, templateAgeSec };
}

export function fetchProxyStats({ host, port, timeoutMs = 1500 }) {
  if (!LOOPBACK.has(host)) return Promise.reject(new Error('proxy stats host must be loopback'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.reject(new RangeError('proxy stats port invalid'));
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: host, port, path: '/', timeout: timeoutMs, headers: { accept: 'application/json' } }, res => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`proxy stats HTTP ${res.statusCode}`)); return; }
      let size = 0;
      const chunks = [];
      res.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BYTES) { req.destroy(new Error('proxy stats response too large')); return; }
        chunks.push(chunk);
      });
      res.on('end', () => {
        try { resolve(validateProxyStats(JSON.parse(Buffer.concat(chunks).toString('utf8')))); }
        catch (e) { reject(e); }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('proxy stats timeout')));
    req.on('error', reject);
  });
}
