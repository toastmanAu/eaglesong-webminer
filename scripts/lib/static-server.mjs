/** static-server.mjs — tiny loopback static file server for dev and tests (no deps). */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png' };

export function startStaticServer({ root, host = '127.0.0.1', port = 0 }) {
  const base = path.resolve(root);
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      let p = path.normalize(decodeURIComponent(url.pathname));
      if (p.endsWith('/')) p += 'index.html';
      const file = path.join(base, p);
      if (!file.startsWith(base)) { res.writeHead(403); return res.end(); }
      const st = await stat(file).catch(() => null);
      if (!st?.isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(await readFile(file));
    } catch { res.writeHead(500); res.end(); }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve({ port: server.address().port, url: `http://${host}:${server.address().port}`, close: () => new Promise(r => server.close(() => r())) }));
  });
}
