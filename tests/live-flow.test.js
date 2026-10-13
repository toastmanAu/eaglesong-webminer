import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { verifyLiveFlow } from '../scripts/verify-live-flow.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/stratum-transcripts/solo-proxy-local.json', import.meta.url), 'utf8'));

function mockBridge({ verified = true, accepted = true } = {}) {
  const sent = [];
  class Socket extends EventEmitter {
    static OPEN = 1;
    readyState = 0;
    constructor(url, options) {
      super();
      assert.equal(url, 'wss://bridge.wyltekindustries.com');
      assert.equal(options.headers.Origin, 'https://toastmanau.github.io');
      setImmediate(() => {
        this.readyState = Socket.OPEN;
        this.emit('open');
        this.frame({ type: 'hello', protocol: 'ckb-128nonce-v1', mode: 'solo',
          payout: { verified, address: 'ckt1qexamplepayout' } });
      });
    }
    frame(m) { this.emit('message', Buffer.from(JSON.stringify({ v: 1, ...m }))); }
    send(raw) {
      const m = JSON.parse(raw);
      sent.push(m);
      if (m.type === 'start') setImmediate(() => {
        this.frame({ type: 'status', requestId: m.requestId, connected: true, nodeHealthy: true, payoutVerified: true });
        this.frame({ type: 'job', generation: 1, jobId: fixture.job.jobId,
          powHashHex: fixture.job.powHashHex, prefix8Hex: fixture.prefix8Hex,
          shareTargetBE: 'f'.repeat(64), networkTargetBE: null });
      });
      if (m.type === 'submit') setImmediate(() => this.frame({ type: 'share_result', requestId: m.requestId,
        accepted, classification: accepted ? 'local_accepted' : 'rejected_low_diff', hashHex: m.hashHex }));
      if (m.type === 'stop') setImmediate(() => this.frame({ type: 'status', requestId: m.requestId, connected: false }));
    }
    close() { this.readyState = 3; }
  }
  return { Socket, sent };
}

const fetchImpl = async () => ({ ok: true, json: async () => ({ ok: true, protocol: 'ckb-128nonce-v1' }) });
const input = { bridgeUrl: 'wss://bridge.wyltekindustries.com', origin: 'https://toastmanau.github.io', fetchImpl, timeoutMs: 1000 };

test('live gate requires verified payout, real Start/job/hash/share ACK, then Stop', async () => {
  const { Socket, sent } = mockBridge();
  const result = await verifyLiveFlow({ ...input, WebSocketImpl: Socket });
  assert.equal(result.hashes, 64);
  assert.equal(result.classification, 'local_accepted');
  assert.deepEqual(sent.map(m => m.type), ['hello', 'start', 'submit', 'stop']);
  assert.equal(sent[2].nonceHex.length, 32);
});

test('live gate fails closed on unverified payout or rejected share', async () => {
  const badPayout = mockBridge({ verified: false });
  await assert.rejects(verifyLiveFlow({ ...input, WebSocketImpl: badPayout.Socket }), /verified node-defined solo payout/);
  assert.ok(!badPayout.sent.some(m => m.type === 'start'));
  const rejected = mockBridge({ accepted: false });
  await assert.rejects(verifyLiveFlow({ ...input, WebSocketImpl: rejected.Socket }), /not independently validated and ACKed/);
  assert.ok(rejected.sent.some(m => m.type === 'submit'));
});

test('live gate refuses bad health before it opens a mining session', async () => {
  const { Socket, sent } = mockBridge();
  await assert.rejects(verifyLiveFlow({ ...input, WebSocketImpl: Socket,
    fetchImpl: async () => ({ ok: false, status: 503 }) }), /health HTTP 503/);
  assert.equal(sent.length, 0);
});
