/**
 * protocol.test.js — (a) the pinned upstream Stratum profile parser against the
 * REAL frames captured in PASS 0, failing closed on foreign shapes; (b) the
 * browser→bridge WebSocket message validator.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStratumProfile, ProtocolError } from '../src/bridge/protocol-adapter.js';
import { validateClientMessage, MAX_INBOUND_FRAME_BYTES } from '../src/bridge/ws-schema.js';
import { bytesToHex } from '../src/hash/eaglesong-core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const transcript = JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/stratum-transcripts/solo-proxy-local.json'), 'utf8'));
const frames = transcript.frames.map(f => ({ ...f, msg: JSON.parse(f.line) }));
const fromProxy = (pred) => frames.find(f => f.dir === 'proxy->client' && pred(f.msg)).msg;

// ── (a) solo-proxy-v1 ───────────────────────────────────────────────────────
test('createStratumProfile rejects unknown profile names', () => {
  assert.throws(() => createStratumProfile('pool-relay-v1'), /unknown|unsupported/i);
  assert.throws(() => createStratumProfile(''), /unknown|unsupported/i);
});

test('solo-proxy-v1: parses the real nested subscribe result into sessionId / extranonce1 / extranonce2Size', () => {
  const p = createStratumProfile('solo-proxy-v1');
  const r = p.parseSubscribeResult(fromProxy(m => m.id === 1 && m.result));
  assert.equal(r.extranonce1Hex, transcript.extranonce1);
  assert.equal(r.sessionId, transcript.extranonce1, 'solo-proxy uses the session id as extranonce1');
  assert.equal(r.extranonce2Size, 4);
});

test('solo-proxy-v1: the GodMiner flat subscribe tuple is a DIFFERENT profile and is rejected', () => {
  const p = createStratumProfile('solo-proxy-v1');
  assert.throws(() => p.parseSubscribeResult({ id: 1, result: [null, '0011223344556677', 8], error: null }), ProtocolError);
});

test('solo-proxy-v1: prefix8 = extranonce1 bytes zero-padded on the right to 8 bytes (NerdMiner contract); >8 bytes fails closed', () => {
  const p = createStratumProfile('solo-proxy-v1');
  assert.equal(bytesToHex(p.prefix8FromExtranonce1('1a69d75b')), '1a69d75b00000000');
  assert.equal(bytesToHex(p.prefix8FromExtranonce1('0011223344556677')), '0011223344556677');
  assert.throws(() => p.prefix8FromExtranonce1('001122334455667788'), ProtocolError);
  assert.throws(() => p.prefix8FromExtranonce1(''), ProtocolError);
  assert.throws(() => p.prefix8FromExtranonce1('zz'), ProtocolError);
});

test('solo-proxy-v1: parses the real five-field notify; height is params[2], network target is LE', () => {
  const p = createStratumProfile('solo-proxy-v1');
  const n = p.parseNotify(fromProxy(m => m.method === 'mining.notify'));
  assert.equal(n.jobId, transcript.job.jobId);
  assert.equal(n.powHashHex, transcript.job.powHashHex);
  assert.equal(n.height, transcript.job.height);
  assert.equal(n.networkTarget, 1n << 242n, 'LE 64-hex decodes to compact 0x1f040000');
  assert.equal(n.cleanJobs, false);
});

test('solo-proxy-v1: a NerdMiner-style FOUR-field notify is rejected, not misread', () => {
  const p = createStratumProfile('solo-proxy-v1');
  const real = fromProxy(m => m.method === 'mining.notify');
  const fourField = { ...real, params: [real.params[0], real.params[1], real.params[3], real.params[4]] };
  assert.throws(() => p.parseNotify(fourField), ProtocolError);
});

test('solo-proxy-v1: notify with malformed pow_hash / target / height / clean fails closed with a reason', () => {
  const p = createStratumProfile('solo-proxy-v1');
  const real = fromProxy(m => m.method === 'mining.notify');
  const mutate = (i, v) => { const params = [...real.params]; params[i] = v; return { ...real, params }; };
  for (const [i, v, label] of [[1, 'abc', 'short pow_hash'], [1, 'g'.repeat(64), 'non-hex pow_hash'], [2, '0x1', 'height as string'], [3, 'f'.repeat(63), 'short target'], [4, 'true', 'clean as string'], [0, 7, 'job id not a string']]) {
    assert.throws(() => p.parseNotify(mutate(i, v)), ProtocolError, label);
  }
});

test('solo-proxy-v1: parses set_target (LE) and set_difficulty from real frames', () => {
  const p = createStratumProfile('solo-proxy-v1');
  const st = p.parseSetTarget(fromProxy(m => m.method === 'mining.set_target'));
  assert.equal(st.shareTarget, (1n << 224n) * 1000000n, 'diff 1e-6 under the proxy\'s six-decimal rounding');
  const sd = p.parseSetDifficulty(fromProxy(m => m.method === 'mining.set_difficulty'));
  assert.equal(sd.difficulty, 0.000001);
  assert.throws(() => p.parseSetTarget({ method: 'mining.set_target', params: ['ff'] }), ProtocolError);
  assert.throws(() => p.parseSetDifficulty({ method: 'mining.set_difficulty', params: [0] }), ProtocolError);
  assert.throws(() => p.parseSetDifficulty({ method: 'mining.set_difficulty', params: ['1'] }), ProtocolError);
});

test('solo-proxy-v1: builds the exact subscribe / authorize / submit frames the transcript shows', () => {
  const p = createStratumProfile('solo-proxy-v1');
  assert.deepEqual(p.buildSubscribe(1, 'EagleWebMiner/1.0'), { id: 1, method: 'mining.subscribe', params: ['EagleWebMiner/1.0'] });
  assert.deepEqual(p.buildAuthorize(2, 'web-01', 'x'), { id: 2, method: 'mining.authorize', params: ['web-01', 'x'] });
  const submitFrame = frames.find(f => f.dir === 'client->proxy' && f.msg.method === 'mining.submit').msg;
  assert.deepEqual(p.buildSubmit(submitFrame.id, 'web-01', transcript.job.jobId, transcript.nonces.low.nonceHex), submitFrame);
  assert.throws(() => p.buildSubmit(9, 'web-01', 'a', 'abcd'), ProtocolError, 'nonce must be the full 32 hex chars');
  assert.throws(() => p.buildSubmit(9, 'web-01', 'a', transcript.nonces.low.nonceHex.toUpperCase()), ProtocolError, 'lowercase only — no silent normalization on the wire');
});

test('solo-proxy-v1: classifies submit results: result:true → accepted, error [23,...] → low difficulty', () => {
  const p = createStratumProfile('solo-proxy-v1');
  assert.deepEqual(p.parseSubmitResult(transcript.results.share), { accepted: true, errorCode: null, errorMessage: null });
  assert.deepEqual(p.parseSubmitResult(transcript.results.low), { accepted: false, errorCode: 23, errorMessage: 'Low difficulty share' });
  assert.throws(() => p.parseSubmitResult({ id: 1 }), ProtocolError, 'neither result nor error');
});

// ── (b) browser → bridge messages ───────────────────────────────────────────
const NONCE = '01000000000000001122334400000000';
const HASH = 'ab'.repeat(32);

test('validateClientMessage accepts each well-formed message type and normalizes hex to lowercase', () => {
  assert.deepEqual(validateClientMessage(JSON.stringify({ v: 1, type: 'hello', client: 'EagleWebMiner/1.0', capabilities: ['cpu-js'] })),
    { ok: true, msg: { v: 1, type: 'hello', client: 'EagleWebMiner/1.0', capabilities: ['cpu-js'] } });
  assert.deepEqual(validateClientMessage(JSON.stringify({ v: 1, type: 'start', requestId: 'start-1', workerLabel: 'web-01' })),
    { ok: true, msg: { v: 1, type: 'start', requestId: 'start-1', workerLabel: 'web-01' } });
  const sub = validateClientMessage(JSON.stringify({ v: 1, type: 'submit', requestId: 'share-42', jobId: 'a1', generation: 7, nonceHex: NONCE.toUpperCase(), hashHex: HASH.toUpperCase() }));
  assert.equal(sub.ok, true);
  assert.equal(sub.msg.nonceHex, NONCE);
  assert.equal(sub.msg.hashHex, HASH);
  assert.equal(validateClientMessage(JSON.stringify({ v: 1, type: 'stop', requestId: 'stop-1' })).ok, true);
  assert.equal(validateClientMessage(JSON.stringify({ v: 1, type: 'ping', requestId: 'p' })).ok, true);
  assert.equal(validateClientMessage(JSON.stringify({ v: 1, type: 'submit', jobId: 'a1', generation: 0, nonceHex: NONCE })).ok, true, 'hashHex and requestId are optional');
});

test('validateClientMessage rejects frames over the size limit before parsing', () => {
  const big = JSON.stringify({ v: 1, type: 'ping', requestId: 'x'.repeat(MAX_INBOUND_FRAME_BYTES) });
  const r = validateClientMessage(big);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'FRAME_TOO_LARGE');
  assert.equal(MAX_INBOUND_FRAME_BYTES, 16384);
});

test('validateClientMessage rejects non-JSON, non-object, wrong version, unknown type', () => {
  for (const [text, code] of [
    ['not json', 'BAD_JSON'],
    ['[1,2]', 'BAD_SHAPE'],
    ['"str"', 'BAD_SHAPE'],
    ['null', 'BAD_SHAPE'],
    [JSON.stringify({ v: 2, type: 'ping' }), 'BAD_VERSION'],
    [JSON.stringify({ type: 'ping' }), 'BAD_VERSION'],
    [JSON.stringify({ v: 1, type: 'mine_harder' }), 'UNKNOWN_TYPE'],
    [JSON.stringify({ v: 1 }), 'UNKNOWN_TYPE'],
  ]) {
    const r = validateClientMessage(text);
    assert.equal(r.ok, false, text);
    assert.equal(r.code, code, text);
  }
});

test('validateClientMessage rejects unknown fields and any host/port/url-like field (no endpoint selection from the browser)', () => {
  for (const extra of [{ host: 'evil' }, { port: 1 }, { url: 'ws://x' }, { rpcUrl: 'http://x' }, { stratumHost: 'x' }, { upstream: 'x' }, { surprise: true }]) {
    const r = validateClientMessage(JSON.stringify({ v: 1, type: 'ping', requestId: 'p', ...extra }));
    assert.equal(r.ok, false, JSON.stringify(extra));
    assert.equal(r.code, 'UNKNOWN_FIELD', JSON.stringify(extra));
  }
});

test('validateClientMessage: submit field fuzz — wrong hex lengths, non-hex, bad generation, bad jobId', () => {
  const base = { v: 1, type: 'submit', requestId: 'r', jobId: 'a1', generation: 7, nonceHex: NONCE, hashHex: HASH };
  const bad = [
    [{ nonceHex: NONCE.slice(2) }, 'INVALID_NONCE'],
    [{ nonceHex: NONCE + '00' }, 'INVALID_NONCE'],
    [{ nonceHex: 'zz' + NONCE.slice(2) }, 'INVALID_NONCE'],
    [{ nonceHex: '0x' + NONCE.slice(2) }, 'INVALID_NONCE'],
    [{ nonceHex: 12 }, 'INVALID_NONCE'],
    [{ nonceHex: undefined }, 'INVALID_NONCE'],
    [{ hashHex: HASH.slice(1) }, 'INVALID_HASH'],
    [{ hashHex: 'g'.repeat(64) }, 'INVALID_HASH'],
    [{ generation: -1 }, 'INVALID_GENERATION'],
    [{ generation: 1.5 }, 'INVALID_GENERATION'],
    [{ generation: '7' }, 'INVALID_GENERATION'],
    [{ generation: 2 ** 53 }, 'INVALID_GENERATION'],
    [{ jobId: '' }, 'INVALID_JOB_ID'],
    [{ jobId: 'x'.repeat(65) }, 'INVALID_JOB_ID'],
    [{ jobId: 'a b' }, 'INVALID_JOB_ID'],
    [{ jobId: 5 }, 'INVALID_JOB_ID'],
    [{ requestId: 'x'.repeat(65) }, 'INVALID_REQUEST_ID'],
    [{ requestId: 5 }, 'INVALID_REQUEST_ID'],
  ];
  for (const [patch, code] of bad) {
    const m = { ...base, ...patch };
    for (const k of Object.keys(patch)) if (patch[k] === undefined) delete m[k];
    const r = validateClientMessage(JSON.stringify(m));
    assert.equal(r.ok, false, JSON.stringify(patch));
    assert.equal(r.code, code, JSON.stringify(patch));
  }
});

test('validateClientMessage: hello/start field limits', () => {
  assert.equal(validateClientMessage(JSON.stringify({ v: 1, type: 'hello', client: 'x'.repeat(65), capabilities: [] })).code, 'INVALID_FIELD');
  assert.equal(validateClientMessage(JSON.stringify({ v: 1, type: 'hello', client: 'ok', capabilities: 'cpu-js' })).code, 'INVALID_FIELD');
  assert.equal(validateClientMessage(JSON.stringify({ v: 1, type: 'hello', client: 'ok', capabilities: ['a'.repeat(33)] })).code, 'INVALID_FIELD');
  assert.equal(validateClientMessage(JSON.stringify({ v: 1, type: 'start', workerLabel: 'has space' })).code, 'INVALID_FIELD');
  assert.equal(validateClientMessage(JSON.stringify({ v: 1, type: 'start', workerLabel: 'x'.repeat(33) })).code, 'INVALID_FIELD');
  assert.equal(validateClientMessage(JSON.stringify({ v: 1, type: 'start' })).ok, true, 'workerLabel optional');
});

test('validateClientMessage never throws on hostile input (random fuzz)', () => {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const alphabet = '{}[]":,0123456789abcdefxyz \\\n\u0000';
  for (let i = 0; i < 2000; i++) {
    let s = '';
    const len = Math.floor(rnd() * 80);
    for (let j = 0; j < len; j++) s += alphabet[Math.floor(rnd() * alphabet.length)];
    const r = validateClientMessage(s);
    assert.equal(typeof r.ok, 'boolean');
    if (!r.ok) assert.equal(typeof r.code, 'string');
  }
});
