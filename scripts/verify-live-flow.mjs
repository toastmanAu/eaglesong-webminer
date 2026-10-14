#!/usr/bin/env node
/** Bounded public WSS → bridge → solo proxy share check for the Pages release. */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import WebSocket from 'ws';
import { mineRange } from '../src/hash/mine-batch.js';
import { hexToBytes } from '../src/hash/eaglesong-core.js';
import { targetFromHexBE } from '../src/hash/target.js';

const PROTOCOL = 'ckb-128nonce-v1';

export async function verifyLiveFlow({
  bridgeUrl, origin, fetchImpl = fetch, WebSocketImpl = WebSocket,
  timeoutMs = 15000, maxHashes = 4_000_000,
} = {}) {
  if (!bridgeUrl || !origin) throw new Error('bridgeUrl and Pages origin are required');
  const bridge = new URL(bridgeUrl);
  const page = new URL(origin);
  if (bridge.protocol !== 'wss:' || page.protocol !== 'https:' || page.pathname !== '/' || page.search || page.hash) {
    throw new Error('live gate requires a wss:// bridge and an https:// Pages origin');
  }
  const healthUrl = new URL('/healthz', bridgeUrl.replace(/^wss:/, 'https:'));
  const response = await fetchImpl(healthUrl, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`bridge health HTTP ${response.status}`);
  const health = await response.json();
  if (health?.ok !== true || health.protocol !== PROTOCOL) throw new Error('bridge health protocol mismatch');

  const ws = new WebSocketImpl(bridgeUrl, { headers: { Origin: page.origin }, handshakeTimeout: timeoutMs });
  const frames = [];
  const waiters = new Set();
  let socketError = null;
  const notify = () => {
    for (const waiter of [...waiters]) {
      if (socketError) { waiter.reject(socketError); continue; }
      const i = frames.findIndex(waiter.predicate);
      if (i >= 0) waiter.resolve(frames.splice(i, 1)[0]);
    }
  };
  ws.on('message', (raw) => {
    try { frames.push(JSON.parse(raw.toString())); }
    catch { socketError = new Error('bridge sent non-JSON'); }
    notify();
  });
  ws.on('error', (e) => { socketError = e; notify(); });
  ws.on('close', () => { socketError ??= new Error('bridge closed during live gate'); notify(); });
  const waitFor = (predicate, label) => new Promise((resolve, reject) => {
    let timer;
    const waiter = {
      predicate,
      resolve(value) { clearTimeout(timer); waiters.delete(waiter); resolve(value); },
      reject(error) { clearTimeout(timer); waiters.delete(waiter); reject(error); },
    };
    waiters.add(waiter);
    timer = setTimeout(() => waiter.reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
    notify();
  });
  const send = (m) => ws.send(JSON.stringify({ v: 1, ...m }));
  const decodeJob = (m) => {
    if (!Number.isSafeInteger(m.generation) || typeof m.jobId !== 'string' ||
        !/^[0-9a-f]{64}$/.test(m.powHashHex) || !/^[0-9a-f]{16}$/.test(m.prefix8Hex) ||
        !/^[0-9a-f]{64}$/.test(m.shareTargetBE)) throw new Error('live bridge sent invalid job');
    return { generation: m.generation, jobId: m.jobId, powHash: hexToBytes(m.powHashHex),
      prefix8: hexToBytes(m.prefix8Hex), shareTarget: targetFromHexBE(m.shareTargetBE),
      networkTarget: m.networkTargetBE === null ? null : targetFromHexBE(m.networkTargetBE) };
  };
  try {
    await new Promise((resolve, reject) => {
      if (ws.readyState === WebSocketImpl.OPEN) return resolve();
      const timer = setTimeout(() => reject(new Error('timed out waiting for WebSocket open')), timeoutMs);
      ws.once('open', () => { clearTimeout(timer); resolve(); });
      ws.once('error', (e) => { clearTimeout(timer); reject(e); });
    });
    const hello = await waitFor(m => m.type === 'hello', 'hello');
    if (hello.protocol !== PROTOCOL || hello.mode !== 'solo' ||
        hello.payout?.verified !== true || !/^ck[bt]1[0-9a-z.]+$/.test(hello.payout.address ?? '')) {
      throw new Error('bridge does not report a verified node-defined solo payout');
    }
    send({ type: 'hello', client: 'EagleWebMiner/live-gate', capabilities: ['cpu-js'] });
    send({ type: 'start', requestId: 'live-start' });
    const start = await waitFor(m => (m.type === 'status' || m.type === 'error') && m.requestId === 'live-start', 'Start ACK');
    if (start.type !== 'status' || start.connected !== true || start.nodeHealthy !== true || start.payoutVerified !== true) {
      throw new Error(`live Start did not reach a healthy verified node: ${start.message ?? JSON.stringify(start)}`);
    }
    let job = decodeJob(await waitFor(m => m.type === 'job', 'real Stratum job'));
    let cursor = 0n;
    let hashes = 0;
    let candidate = null;
    while (hashes < maxHashes && !candidate) {
      // A new block template supersedes earlier work; a target-only update keeps the nonce cursor.
      for (let i = 0; i < frames.length;) {
        const m = frames[i];
        if (m.type === 'job') { job = decodeJob(m); cursor = 0n; frames.splice(i, 1); }
        else if (m.type === 'target') {
          if (m.jobId !== job.jobId || !Number.isSafeInteger(m.generation) || m.generation <= job.generation) throw new Error('invalid live target update');
          job = { ...job, generation: m.generation, shareTarget: targetFromHexBE(m.shareTargetBE),
            networkTarget: m.networkTargetBE === null ? null : targetFromHexBE(m.networkTargetBE) };
          frames.splice(i, 1);
        } else i++;
      }
      const range = mineRange(job, { firstLo: cursor, count: Math.min(5000, maxHashes - hashes) });
      hashes += range.hashes;
      cursor = range.nextLo;
      candidate = range.candidates[0] ?? null;
      if (!candidate) await new Promise(resolve => setImmediate(resolve));
    }
    if (!candidate) throw new Error(`no candidate within ${maxHashes} genuine Eaglesong hashes`);
    send({ type: 'submit', requestId: 'live-share', generation: candidate.generation,
      jobId: candidate.jobId, nonceHex: candidate.nonceHex, hashHex: candidate.hashHex });
    const share = await waitFor(m => (m.type === 'share_result' || m.type === 'error') && m.requestId === 'live-share', 'validated share');
    if (share.type !== 'share_result' || share.accepted !== true ||
        !['local_accepted', 'block_candidate'].includes(share.classification) || share.hashHex !== candidate.hashHex) {
      throw new Error(`live share was not independently validated and ACKed: ${share.message ?? JSON.stringify(share)}`);
    }
    send({ type: 'stop', requestId: 'live-stop' });
    const stop = await waitFor(m => m.type === 'status' && m.requestId === 'live-stop', 'Stop ACK');
    if (stop.connected !== false) throw new Error('Stop did not close the upstream session');
    return { hashes, classification: share.classification, accepted: share.accepted,
      payoutAddress: hello.payout.address, jobId: candidate.jobId, generation: candidate.generation,
      nonceHex: candidate.nonceHex };
  } finally {
    ws.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await verifyLiveFlow({ bridgeUrl: process.env.PAGES_BRIDGE_URL, origin: process.env.PAGES_ORIGIN });
  process.stdout.write(`Live flow passed: ${result.hashes} hashes, ${result.classification}, proxy ACK, nonce ${result.nonceHex}, verified payout ${result.payoutAddress}. No block confirmation claimed.\n`);
}
