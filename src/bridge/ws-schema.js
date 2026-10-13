/**
 * ws-schema.js — strict validation of browser → bridge WebSocket messages (v1).
 *
 * Explicit validators (no schema library): every type has a closed set of
 * fields, bounded lengths, lowercase-normalized hex, and no field may name a
 * host/port/url/upstream — endpoint selection never comes from the browser.
 * Never throws; returns {ok:true, msg} or {ok:false, code, message}.
 */

export const MAX_INBOUND_FRAME_BYTES = 16384;
const HEX32 = /^[0-9a-fA-F]{32}$/;
const HEX64 = /^[0-9a-fA-F]{64}$/;
const JOB_ID = /^[0-9a-zA-Z_.-]{1,64}$/;
const LABEL = /^[A-Za-z0-9._-]{1,32}$/;
const FORBIDDEN_FIELD = /host|port|url|upstream|rpc|stratum|endpoint|pool|address/i;

const COMMON = new Set(['v', 'type', 'requestId']);
const SCHEMAS = {
  hello: { fields: new Set(['client', 'capabilities']), required: ['client', 'capabilities'] },
  start: { fields: new Set(['workerLabel']), required: [] },
  submit: { fields: new Set(['jobId', 'generation', 'nonceHex', 'hashHex']), required: ['jobId', 'generation', 'nonceHex'] },
  calibrate: { fields: new Set(['hashes', 'elapsedMs']), required: ['hashes', 'elapsedMs'] },
  stop: { fields: new Set(), required: [] },
  ping: { fields: new Set(), required: [] },
};

const fail = (code, message) => ({ ok: false, code, message });

/**
 * @param {string|Buffer|ArrayBuffer|Uint8Array} raw one WebSocket text frame
 */
export function validateClientMessage(raw) {
  let text;
  try {
    if (typeof raw === 'string') text = raw;
    else if (raw instanceof Uint8Array) text = new TextDecoder().decode(raw);
    else if (raw instanceof ArrayBuffer) text = new TextDecoder().decode(new Uint8Array(raw));
    else return fail('BAD_FRAME', 'frame must be text');
  } catch { return fail('BAD_FRAME', 'undecodable frame'); }

  if (byteLength(text) > MAX_INBOUND_FRAME_BYTES) return fail('FRAME_TOO_LARGE', `frame exceeds ${MAX_INBOUND_FRAME_BYTES} bytes`);

  let msg;
  try { msg = JSON.parse(text); } catch { return fail('BAD_JSON', 'frame is not valid JSON'); }
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return fail('BAD_SHAPE', 'frame must be a JSON object');
  if (msg.v !== 1) return fail('BAD_VERSION', 'v must be 1');
  if (typeof msg.type !== 'string' || !Object.hasOwn(SCHEMAS, msg.type)) return fail('UNKNOWN_TYPE', 'unknown message type');

  const schema = SCHEMAS[msg.type];
  for (const key of Object.keys(msg)) {
    if (FORBIDDEN_FIELD.test(key) && !COMMON.has(key) && !schema.fields.has(key)) return fail('UNKNOWN_FIELD', `field "${key}" is not allowed`);
    if (!COMMON.has(key) && !schema.fields.has(key)) return fail('UNKNOWN_FIELD', `field "${key}" is not allowed for ${msg.type}`);
  }
  for (const key of schema.required) if (!(key in msg)) return fail(fieldCode(key), `missing field "${key}"`);

  if ('requestId' in msg && !(typeof msg.requestId === 'string' && msg.requestId.length >= 1 && msg.requestId.length <= 64)) {
    return fail('INVALID_REQUEST_ID', 'requestId must be a string of 1..64 chars');
  }

  const out = { v: 1, type: msg.type };
  if ('requestId' in msg) out.requestId = msg.requestId;

  switch (msg.type) {
    case 'hello': {
      if (typeof msg.client !== 'string' || msg.client.length < 1 || msg.client.length > 64) return fail('INVALID_FIELD', 'client must be 1..64 chars');
      if (!Array.isArray(msg.capabilities) || msg.capabilities.length > 16 || !msg.capabilities.every(c => typeof c === 'string' && /^[a-z0-9-]{1,32}$/.test(c))) {
        return fail('INVALID_FIELD', 'capabilities must be a short list of short lowercase tokens');
      }
      out.client = msg.client; out.capabilities = [...msg.capabilities];
      break;
    }
    case 'start': {
      if ('workerLabel' in msg) {
        if (typeof msg.workerLabel !== 'string' || !LABEL.test(msg.workerLabel)) return fail('INVALID_FIELD', 'workerLabel must match [A-Za-z0-9._-]{1,32}');
        out.workerLabel = msg.workerLabel;
      }
      break;
    }
    case 'submit': {
      if (typeof msg.jobId !== 'string' || !JOB_ID.test(msg.jobId)) return fail('INVALID_JOB_ID', 'jobId must match [0-9a-zA-Z_.-]{1,64}');
      if (!Number.isSafeInteger(msg.generation) || msg.generation < 0 || msg.generation >= 2 ** 53) return fail('INVALID_GENERATION', 'generation must be a non-negative safe integer');
      if (typeof msg.nonceHex !== 'string' || !HEX32.test(msg.nonceHex)) return fail('INVALID_NONCE', 'nonceHex must be exactly 32 hex chars (16 bytes), no 0x prefix');
      if ('hashHex' in msg && (typeof msg.hashHex !== 'string' || !HEX64.test(msg.hashHex))) return fail('INVALID_HASH', 'hashHex must be exactly 64 hex chars');
      out.jobId = msg.jobId; out.generation = msg.generation; out.nonceHex = msg.nonceHex.toLowerCase();
      if ('hashHex' in msg) out.hashHex = msg.hashHex.toLowerCase();
      break;
    }
    case 'calibrate': {
      if (!Number.isSafeInteger(msg.hashes) || msg.hashes < 0 || msg.hashes > 2_000_000_000) return fail('INVALID_FIELD', 'hashes must be an integer in [0, 2000000000]');
      if (!Number.isSafeInteger(msg.elapsedMs) || msg.elapsedMs < 1000 || msg.elapsedMs > 60000) return fail('INVALID_FIELD', 'elapsedMs must be an integer in [1000, 60000]');
      out.hashes = msg.hashes; out.elapsedMs = msg.elapsedMs;
      break;
    }
    default: break; // stop, ping: no fields
  }
  return { ok: true, msg: out };
}

function fieldCode(key) {
  return { jobId: 'INVALID_JOB_ID', generation: 'INVALID_GENERATION', nonceHex: 'INVALID_NONCE', hashHex: 'INVALID_HASH' }[key] || 'INVALID_FIELD';
}

function byteLength(s) {
  // fast path for ASCII; TextEncoder for the rest
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) return new TextEncoder().encode(s).length;
  return s.length;
}
