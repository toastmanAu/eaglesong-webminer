#!/usr/bin/env node
/** Check the exact HTML that GitHub Pages will publish. */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const file = path.resolve(process.argv[2] ?? 'dist/index.html');
const html = readFileSync(file, 'utf8');
const match = html.match(/<script id="eagle-config" type="application\/json">([^<]+)<\/script>/);
if (!match) throw new Error('built page has no runtime configuration');
const config = JSON.parse(match[1]);
const bridge = new URL(config.bridgeUrl);
if (bridge.protocol !== 'wss:' || bridge.hostname === 'localhost' || /^(?:127\.|10\.|192\.168\.|172\.)/.test(bridge.hostname)) {
  throw new Error('Pages artifact has an insecure or local bridge URL');
}
for (const [name, pattern] of Object.entries({
  privateKey: /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
  token: /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b/,
  lanAddress: /\b(?:192\.168\.(?:\d{1,3}\.){2}|10\.(?:\d{1,3}\.){3})\b/,
})) if (pattern.test(html)) throw new Error(`Pages artifact contains ${name}`);
process.stdout.write(`Pages artifact audit passed: ${path.basename(file)}, bridge ${bridge.origin}.\n`);
