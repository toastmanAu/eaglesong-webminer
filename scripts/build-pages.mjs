#!/usr/bin/env node
/** Fail closed for a public Pages build: no localhost or plaintext bridge. */
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSingleFile } from './build-single-file.mjs';

export async function buildPages({ bridgeUrl = process.env.PAGES_BRIDGE_URL, out = 'dist/index.html' } = {}) {
  if (!bridgeUrl) throw new Error('PAGES_BRIDGE_URL is required for a public Pages build');
  let parsed;
  try { parsed = new URL(bridgeUrl); } catch { throw new Error('PAGES_BRIDGE_URL must be a valid wss:// URL'); }
  if (parsed.protocol !== 'wss:') throw new Error('PAGES_BRIDGE_URL must use wss://');
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw new Error('PAGES_BRIDGE_URL must contain only a host and optional port');
  }
  if (parsed.hostname.includes(':') || net.isIP(parsed.hostname) || parsed.hostname === 'localhost' || !parsed.hostname.includes('.')) {
    throw new Error('PAGES_BRIDGE_URL must use a public hostname');
  }
  const result = await buildSingleFile({ bridgeUrl: parsed.origin, out: path.resolve(out), minify: true });
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await buildPages();
  process.stdout.write(`Pages HTML: ${result.out} (${result.bytes} bytes), bridge ${result.config.bridgeUrl}\n`);
}
