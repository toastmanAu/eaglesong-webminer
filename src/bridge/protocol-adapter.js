/**
 * protocol-adapter.js — upstream Stratum profiles, pinned to shapes captured
 * from real traffic (tests/fixtures/stratum-transcripts). Anything that does not
 * match the selected profile exactly is a ProtocolError: we never guess byte
 * orders or field positions from the data.
 *
 * Profiles:
 *   solo-proxy-v1  ckb-stratum-proxy `solo-proxy.js`, non-GodMiner path (the only one implemented)
 */
import { targetFromHexLE } from '../hash/target.js';
import { hexToBytes } from '../hash/eaglesong-core.js';

export class ProtocolError extends Error {
  constructor(message, frame) {
    super(message);
    this.name = 'ProtocolError';
    this.frame = frame === undefined ? undefined : safeFrame(frame);
  }
}
function safeFrame(frame) { try { return JSON.stringify(frame).slice(0, 400); } catch { return '[unserializable]'; } }

const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const JOB_ID = /^[0-9a-zA-Z_.-]{1,64}$/;

function expect(cond, message, frame) { if (!cond) throw new ProtocolError(message, frame); }

const soloProxyV1 = {
  name: 'solo-proxy-v1',
  userAgent: 'EagleWebMiner/1.0',

  buildSubscribe(id, userAgent = 'EagleWebMiner/1.0') {
    return { id, method: 'mining.subscribe', params: [userAgent] };
  },
  buildAuthorize(id, worker, password = 'x') {
    return { id, method: 'mining.authorize', params: [worker, password] };
  },
  /** Three-field submit; the proxy reads the LAST param as the full 16-byte nonce. */
  buildSubmit(id, worker, jobId, nonceHex) {
    expect(typeof jobId === 'string' && JOB_ID.test(jobId), 'buildSubmit: bad jobId');
    expect(typeof nonceHex === 'string' && HEX32.test(nonceHex), 'buildSubmit: nonceHex must be 32 lowercase hex chars');
    return { id, method: 'mining.submit', params: [worker, jobId, nonceHex] };
  },

  /**
   * Non-GodMiner subscribe result:
   *   [[["mining.set_difficulty",SID],["mining.notify",SID]], SID, 4]
   */
  parseSubscribeResult(msg) {
    const r = msg?.result;
    expect(Array.isArray(r) && r.length === 3, 'subscribe: result must be a 3-tuple', msg);
    const [subs, en1, en2Size] = r;
    expect(Array.isArray(subs) && subs.length >= 1 && subs.every(s => Array.isArray(s) && s.length === 2 && typeof s[0] === 'string'),
      'subscribe: result[0] must be the nested subscription list (GodMiner flat tuple is a different profile)', msg);
    expect(typeof en1 === 'string' && /^[0-9a-f]{2,16}$/.test(en1) && en1.length % 2 === 0, 'subscribe: extranonce1 must be 1..8 bytes of lowercase hex', msg);
    expect(Number.isInteger(en2Size) && en2Size >= 0 && en2Size <= 8, 'subscribe: extranonce2_size must be an integer 0..8', msg);
    return { sessionId: en1, extranonce1Hex: en1, extranonce2Size: en2Size };
  },

  /** NerdMiner contract: extranonce1 bytes at nonce[8..], zero-padded to 8 bytes. */
  prefix8FromExtranonce1(en1Hex) {
    expect(typeof en1Hex === 'string' && /^[0-9a-f]+$/.test(en1Hex) && en1Hex.length % 2 === 0 && en1Hex.length >= 2 && en1Hex.length <= 16,
      'extranonce1 must be 1..8 bytes of lowercase hex');
    return hexToBytes(en1Hex.padEnd(16, '0'));
  },

  /** Five fields: [job_id, pow_hash_hex, height(number), network_target_le_hex, clean_jobs(bool)] */
  parseNotify(msg) {
    const p = msg?.params;
    expect(msg?.method === 'mining.notify', 'notify: wrong method', msg);
    expect(Array.isArray(p) && p.length === 5, `notify: solo-proxy-v1 has 5 params, got ${Array.isArray(p) ? p.length : 'none'}`, msg);
    const [jobId, powHashHex, height, targetLE, cleanJobs] = p;
    expect(typeof jobId === 'string' && JOB_ID.test(jobId), 'notify: job_id must be a short string', msg);
    expect(typeof powHashHex === 'string' && HEX64.test(powHashHex), 'notify: pow_hash must be 64 lowercase hex chars', msg);
    expect(Number.isInteger(height) && height >= 0, 'notify: params[2] must be the height as a JSON integer', msg);
    expect(typeof targetLE === 'string' && HEX64.test(targetLE), 'notify: params[3] must be the 64-hex LE network target', msg);
    expect(typeof cleanJobs === 'boolean', 'notify: clean_jobs must be a boolean', msg);
    return { jobId, powHashHex, height, networkTarget: targetFromHexLE(targetLE), networkTargetLE: targetLE, cleanJobs };
  },

  /** mining.set_target params: [target_le_hex] */
  parseSetTarget(msg) {
    const p = msg?.params;
    expect(Array.isArray(p) && p.length >= 1 && typeof p[0] === 'string' && HEX64.test(p[0]), 'set_target: params[0] must be 64-hex LE target', msg);
    return { shareTarget: targetFromHexLE(p[0]), shareTargetLE: p[0] };
  },

  /** mining.set_difficulty params: [number > 0] — informational (set_target is authoritative) */
  parseSetDifficulty(msg) {
    const d = msg?.params?.[0];
    expect(typeof d === 'number' && Number.isFinite(d) && d > 0, 'set_difficulty: params[0] must be a positive finite number', msg);
    return { difficulty: d };
  },

  /** {result:true} | {result:false, error:[code, message, ...]} */
  parseSubmitResult(msg) {
    if (msg?.result === true) return { accepted: true, errorCode: null, errorMessage: null };
    if (Array.isArray(msg?.error) && msg.error.length >= 2) {
      return { accepted: false, errorCode: Number.isInteger(msg.error[0]) ? msg.error[0] : null, errorMessage: String(msg.error[1]) };
    }
    if (msg?.result === false) return { accepted: false, errorCode: null, errorMessage: 'rejected without reason' };
    throw new ProtocolError('submit result: neither result nor error present', msg);
  },
};

const PROFILES = { 'solo-proxy-v1': soloProxyV1 };
export const PROFILE_NAMES = Object.keys(PROFILES);

/** @param {string} name */
export function createStratumProfile(name) {
  const p = PROFILES[name];
  if (!p) throw new ProtocolError(`unknown/unsupported stratum profile "${name}" (supported: ${PROFILE_NAMES.join(', ')})`);
  return p;
}
