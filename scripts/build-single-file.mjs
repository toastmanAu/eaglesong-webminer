#!/usr/bin/env node
/**
 * build-single-file.mjs — bundle the UI and the CPU worker with esbuild and
 * inline everything (CSS, worker source, app, runtime config, CSP) into ONE
 * self-contained HTML file. No third-party runtime assets.
 *
 *   node scripts/build-single-file.mjs [--bridge-url ws://127.0.0.1:8788] [--out dist/index.html] [--explorer https://explorer.nervos.org]
 *
 * Exported `buildSingleFile(opts)` is used by the e2e tests.
 */
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

export async function buildSingleFile({ bridgeUrl = 'ws://127.0.0.1:8788', out = path.join(ROOT, 'dist', 'index.html'), explorerBase = null, minify = false, devnetNotice = false } = {}) {
  if (!/^wss?:\/\/[^/\s]+$/.test(bridgeUrl)) throw new Error(`bridge url must be ws(s)://host[:port] with no path: ${bridgeUrl}`);
  const common = { bundle: true, write: false, format: 'iife', platform: 'browser', target: ['es2020', 'chrome96', 'safari15'], minify, legalComments: 'inline', logLevel: 'silent' };
  const [app, worker] = await Promise.all([
    build({ ...common, entryPoints: [path.join(ROOT, 'src/ui/app.js')] }),
    build({ ...common, entryPoints: [path.join(ROOT, 'src/hash/cpu-worker.js')] }),
  ]);
  const appJs = app.outputFiles[0].text;
  const workerJs = worker.outputFiles[0].text;
  if (/<\/script/i.test(appJs) || /<\/script/i.test(workerJs)) throw new Error('bundle contains </script>; refusing to inline');
  const css = readFileSync(path.join(ROOT, 'src/ui/styles.css'), 'utf8');
  const buildHash = createHash('sha256').update(appJs).update(workerJs).update(css).digest('hex');
  const config = { bridgeUrl, explorerBase, version: pkg.version, buildHash, builtAt: new Date().toISOString() };
  const csp = [
    "default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'", 'worker-src blob:',
    `connect-src ${bridgeUrl.startsWith('wss:') ? 'wss:' : 'ws: wss:'}`, "img-src data:", "base-uri 'none'", "form-action 'none'", // frame-ancestors is header-only (ignored in <meta>): set it in the static host's HTTP headers (see docs/SECURITY.md)
  ].join('; ');
  let html = readFileSync(path.join(ROOT, 'src/ui/index.html'), 'utf8');
  const put = (marker, value) => { if (!html.includes(marker)) throw new Error(`template marker missing: ${marker}`); html = html.split(marker).join(value); };
  put('<!-- NETWORK_NOTICE -->', devnetNotice ? '<p class="lottery-note"><strong>Development chain demo. Blocks found here have no monetary value.</strong> This page connects to a private CKB development network, not CKB mainnet.</p>' : '');
  put('<!-- INLINE_CSP -->', `<meta http-equiv="Content-Security-Policy" content="${csp}">`);
  put('/* INLINE_CSS */', css);
  put('/* INLINE_WORKER */', workerJs);
  put('/* INLINE_CONFIG */', JSON.stringify(config));
  put('/* INLINE_APP */', appJs);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, html);
  return { out, bytes: Buffer.byteLength(html), buildHash, config, appBytes: appJs.length, workerBytes: workerJs.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => (a.startsWith('--') ? [a.slice(2), arr[i + 1]] : [])).filter(x => x.length));
  const r = await buildSingleFile({ bridgeUrl: args['bridge-url'], out: args.out ? path.resolve(args.out) : undefined, explorerBase: args.explorer ?? null, minify: 'minify' in args });
  process.stdout.write(`built ${r.out}\n  ${r.bytes} bytes (app ${r.appBytes}, worker ${r.workerBytes})\n  bridge ${r.config.bridgeUrl}\n  sha256 ${r.buildHash}\n`);
}
