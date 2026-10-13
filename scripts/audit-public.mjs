#!/usr/bin/env node
/** Check every file that would enter the public repository before a push. */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const forbiddenPaths = /^(?:\.aws|\.claude|\.codex|\.agents|\.remember|node_modules|runtime|dist|vendor)\//;
const forbiddenNames = /(?:^|\/)(?:config\.json|\.env(?:\..*)?|[^/]+\.(?:pem|key|p12|pfx))$/i;
const patterns = {
  privateKey: /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
  githubToken: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  awsAccessKey: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  openaiKey: /\bsk-[A-Za-z0-9_-]{20,}\b/,
  privateIP: /\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.(?:\d{1,3}\.)\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.(?:\d{1,3}\.)\d{1,3})\b/,
};

function filesToAudit() {
  try {
    const raw = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] });
    const files = [...new Set(raw.toString('utf8').split('\0').filter(Boolean))];
    if (files.length) return files;
  } catch { /* project has not been initialized yet */ }
  const excluded = new Set(['.git', '.aws', '.claude', '.codex', '.agents', '.remember', 'node_modules', 'runtime', 'dist', 'vendor']);
  const found = [];
  function walk(dir) {
    for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (excluded.has(entry.name)) continue;
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (entry.isFile() && !forbiddenNames.test(rel) && !rel.endsWith('.log')) found.push(rel);
    }
  }
  walk('');
  return found;
}

const findings = [];
const files = filesToAudit();
for (const rel of files) {
  if (forbiddenPaths.test(rel) || forbiddenNames.test(rel)) { findings.push(`${rel}: forbidden public path`); continue; }
  const full = path.join(ROOT, rel);
  if (statSync(full).size > 5_000_000) { findings.push(`${rel}: file too large to audit`); continue; }
  const bytes = readFileSync(full);
  const contents = bytes.toString('latin1'); // ASCII credentials remain visible even inside binary files
  for (const [kind, regex] of Object.entries(patterns)) {
    if (regex.test(contents)) findings.push(`${rel}: ${kind}`);
  }
}

if (findings.length) {
  process.stderr.write(`Public source audit failed (${findings.length} finding(s)):\n${findings.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Public source audit passed: ${files.length} candidate files; no matched secrets or LAN addresses.\n`);
}
