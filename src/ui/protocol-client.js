/**
 * protocol-client.js — browser side of the bridge protocol (WebSocket JSON v1).
 *
 * Strictly validates every inbound frame, normalizes jobs into the coordinator's
 * NormalizedJob shape (Uint8Array hashes, BigInt targets), correlates
 * request/response by requestId, and reconnects with bounded backoff — but it
 * NEVER re-sends `start` on its own: mining resumes only when the user's intent
 * is re-applied by the app.
 *
 * Events: open, hello, job ({...NormalizedJob, change:'job'|'target'}), share_result,
 *         status, error, protocol_error, reconnecting, close
 */
import { hexToBytes } from '../hash/eaglesong-core.js';
import { targetFromHexBE } from '../hash/target.js';

const HEX64 = /^[0-9a-f]{64}$/, HEX16 = /^[0-9a-f]{16}$/, HEX32 = /^[0-9a-f]{32}$/;

function createEmitter() {
  const map = new Map();
  return {
    on(ev, fn) { if (!map.has(ev)) map.set(ev, new Set()); map.get(ev).add(fn); return () => map.get(ev)?.delete(fn); },
    off(ev, fn) { map.get(ev)?.delete(fn); },
    emit(ev, data) { for (const fn of [...(map.get(ev) ?? [])]) { try { fn(data); } catch (e) { setTimeout(() => { throw e; }, 0); } } },
  };
}

class BridgeProtocolError extends Error { constructor(msg, frame) { super(msg); this.name = 'BridgeProtocolError'; this.frame = frame; } }

export function createProtocolClient(opts) {
  const {
    url, WebSocketImpl = globalThis.WebSocket, clientName = 'EagleWebMiner/1.0', capabilities = ['cpu-js'],
    requestTimeoutMs = 15000, reconnect = { baseMs: 1000, maxMs: 30000 }, now = Date.now,
  } = opts;
  if (typeof url !== 'string' || !/^wss?:\/\//.test(url)) throw new RangeError('bridge url must be ws:// or wss://');
  let endpoint = url;
  const em = createEmitter();
  let ws = null;
  let state = 'disconnected';
  let wantConnected = false;
  let attempt = 0;
  let reconnectTimer = null;
  let reqCounter = 0;
  const pending = new Map(); // requestId → {resolve, reject, timer, kind}
  let hello = null;
  let currentJob = null;

  const send = (obj) => {
    if (!ws || ws.readyState !== 1) throw new Error('bridge not connected');
    ws.send(JSON.stringify(obj));
  };
  const request = (obj, kind, timeoutMs = requestTimeoutMs) => new Promise((resolve, reject) => {
    const requestId = `${kind}-${++reqCounter}`;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`${kind} request timeout after ${timeoutMs}ms`)); }, timeoutMs);
    pending.set(requestId, { resolve, reject, timer, kind });
    try { send({ ...obj, requestId }); } catch (e) { clearTimeout(timer); pending.delete(requestId); reject(e); }
  });
  const settle = (requestId, fn) => {
    const p = requestId !== undefined && requestId !== null ? pending.get(requestId) : undefined;
    if (!p) return false;
    clearTimeout(p.timer); pending.delete(requestId); fn(p);
    return true;
  };
  const failAllPending = (why) => { for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error(why)); } pending.clear(); };

  function normalizeJob(m) {
    if (!Number.isSafeInteger(m.generation) || m.generation < 0) throw new BridgeProtocolError('job.generation invalid', m);
    if (typeof m.jobId !== 'string' || m.jobId.length < 1 || m.jobId.length > 64) throw new BridgeProtocolError('job.jobId invalid', m);
    if (typeof m.powHashHex !== 'string' || !HEX64.test(m.powHashHex)) throw new BridgeProtocolError('job.powHashHex must be 64 lowercase hex', m);
    if (typeof m.prefix8Hex !== 'string' || !HEX16.test(m.prefix8Hex)) throw new BridgeProtocolError('job.prefix8Hex must be 16 lowercase hex', m);
    if (typeof m.shareTargetBE !== 'string' || !HEX64.test(m.shareTargetBE)) throw new BridgeProtocolError('job.shareTargetBE must be 64 lowercase hex', m);
    if (m.networkTargetBE !== null && (typeof m.networkTargetBE !== 'string' || !HEX64.test(m.networkTargetBE))) throw new BridgeProtocolError('job.networkTargetBE must be 64 hex or null', m);
    if (m.height !== null && m.height !== undefined && !Number.isSafeInteger(m.height)) throw new BridgeProtocolError('job.height invalid', m);
    if (typeof m.cleanJobs !== 'boolean') throw new BridgeProtocolError('job.cleanJobs must be boolean', m);
    return {
      change: 'job', jobId: m.jobId, generation: m.generation,
      powHash: hexToBytes(m.powHashHex), prefix8: hexToBytes(m.prefix8Hex),
      shareTarget: targetFromHexBE(m.shareTargetBE), networkTarget: m.networkTargetBE === null ? null : targetFromHexBE(m.networkTargetBE),
      shareDifficulty: typeof m.shareDifficulty === 'number' ? m.shareDifficulty : null,
      cleanJobs: m.cleanJobs, height: m.height ?? null, issuedAt: typeof m.issuedAt === 'number' ? m.issuedAt : null, receivedAtMs: now(),
    };
  }
  function normalizeTarget(m) {
    if (!currentJob) throw new BridgeProtocolError('target received before any job', m);
    if (!Number.isSafeInteger(m.generation) || m.generation <= currentJob.generation) throw new BridgeProtocolError('target.generation must increase', m);
    if (typeof m.shareTargetBE !== 'string' || !HEX64.test(m.shareTargetBE)) throw new BridgeProtocolError('target.shareTargetBE must be 64 lowercase hex', m);
    if (m.networkTargetBE !== null && (typeof m.networkTargetBE !== 'string' || !HEX64.test(m.networkTargetBE))) throw new BridgeProtocolError('target.networkTargetBE invalid', m);
    if (m.jobId !== undefined && m.jobId !== currentJob.jobId) throw new BridgeProtocolError('target.jobId does not match the current job', m);
    return {
      ...currentJob, change: 'target', generation: m.generation,
      shareTarget: targetFromHexBE(m.shareTargetBE), networkTarget: m.networkTargetBE === null ? null : targetFromHexBE(m.networkTargetBE),
      shareDifficulty: typeof m.shareDifficulty === 'number' ? m.shareDifficulty : null, receivedAtMs: now(),
    };
  }

  function onFrame(text) {
    let m;
    try { m = JSON.parse(text); } catch { return em.emit('protocol_error', new BridgeProtocolError('bridge sent non-JSON', String(text).slice(0, 100))); }
    if (!m || typeof m !== 'object' || m.v !== 1 || typeof m.type !== 'string') return em.emit('protocol_error', new BridgeProtocolError('bridge frame has no v:1/type', m));
    try {
      switch (m.type) {
        case 'hello':
          if (typeof m.sessionId !== 'string' || typeof m.protocol !== 'string') throw new BridgeProtocolError('hello invalid', m);
          hello = { sessionId: m.sessionId, mode: m.mode, payout: m.payout ?? null, protocol: m.protocol, bridgeVersion: m.bridgeVersion ?? null,
            webProfile: m.webProfile === true };
          em.emit('hello', hello);
          return;
        case 'job': currentJob = normalizeJob(m); em.emit('job', currentJob); return;
        case 'target': currentJob = normalizeTarget(m); em.emit('job', currentJob); return;
        case 'share_result': {
          if (typeof m.classification !== 'string' || typeof m.accepted !== 'boolean') throw new BridgeProtocolError('share_result invalid', m);
          if (m.nonceHex !== undefined && m.nonceHex !== null && !HEX32.test(m.nonceHex)) throw new BridgeProtocolError('share_result.nonceHex invalid', m);
          settle(m.requestId, (p) => p.resolve(m));
          em.emit('share_result', m);
          return;
        }
        case 'status':
          settle(m.requestId, (p) => p.resolve(m));
          em.emit('status', m);
          return;
        case 'pong': settle(m.requestId, (p) => p.resolve(m)); em.emit('pong', m); return;
        case 'error':
          if (!settle(m.requestId, (p) => p.reject(new Error(`${m.code}: ${m.message}`)))) em.emit('error', m);
          else em.emit('request_error', m);
          return;
        default: throw new BridgeProtocolError(`unknown bridge message type ${m.type}`, m);
      }
    } catch (e) {
      if (e instanceof BridgeProtocolError) em.emit('protocol_error', e); else throw e;
    }
  }

  function scheduleReconnect(reason) {
    if (!wantConnected || reconnectTimer) return;
    const delayMs = Math.min(reconnect.maxMs, reconnect.baseMs * 2 ** Math.min(attempt, 10));
    attempt++;
    em.emit('reconnecting', { attempt, delayMs, reason });
    reconnectTimer = setTimeout(() => { reconnectTimer = null; open(); }, delayMs);
  }

  function open() {
    if (!wantConnected || ws) return;
    state = 'connecting';
    let sock;
    try { sock = new WebSocketImpl(endpoint); } catch (e) { em.emit('error', { code: 'WS_CONSTRUCT', message: e.message }); scheduleReconnect('construct'); return; }
    ws = sock;
    sock.onopen = () => { if (ws !== sock) return; state = 'open'; attempt = 0; em.emit('open'); try { send({ v: 1, type: 'hello', client: clientName, capabilities: [...capabilities] }); } catch { /* closing */ } };
    sock.onmessage = (ev) => { if (ws === sock) onFrame(typeof ev.data === 'string' ? ev.data : String(ev.data)); };
    sock.onerror = () => { if (ws === sock) em.emit('error', { code: 'WS_ERROR', message: 'websocket error' }); };
    sock.onclose = (ev) => {
      if (ws !== sock) return;
      ws = null; state = wantConnected ? 'reconnecting' : 'disconnected';
      currentJob = null; hello = null;
      failAllPending(`bridge connection closed (${ev?.code ?? 'n/a'})`);
      em.emit('close', { code: ev?.code ?? null, reason: ev?.reason ?? '' });
      scheduleReconnect('close');
    };
  }

  return {
    on: em.on, off: em.off,
    get state() { return state; },
    get hello() { return hello; },
    get currentJob() { return currentJob; },
    get endpoint() { return endpoint; },
    setEndpoint(next) {
      if (wantConnected || ws || state !== 'disconnected') throw new Error('Disconnect the current session before changing endpoint');
      if (typeof next !== 'string' || !/^wss?:\/\//.test(next)) throw new RangeError('bridge url must be ws:// or wss://');
      endpoint = next; hello = null; currentJob = null;
    },
    connect() { wantConnected = true; open(); },
    disconnect() {
      wantConnected = false;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      const s = ws; ws = null; state = 'disconnected';
      hello = null; currentJob = null;
      failAllPending('disconnected');
      if (s) { try { s.onclose = null; s.close(1000, 'client disconnect'); } catch { /* ignore */ } }
    },
    /** start mining session on the bridge; resolves on the status ack */
    start(workerLabel) { return request({ v: 1, type: 'start', ...(workerLabel ? { workerLabel } : {}) }, 'start'); },
    stop() { return request({ v: 1, type: 'stop' }, 'stop'); },
    ping(id) { return id ? new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(new Error('ping timeout')); }, requestTimeoutMs); pending.set(id, { resolve, reject, timer, kind: 'ping' }); send({ v: 1, type: 'ping', requestId: id }); }) : request({ v: 1, type: 'ping' }, 'ping'); },
    calibrate(hashes, elapsedMs) {
      if (state !== 'open' || hello?.webProfile !== true) return false;
      if (!Number.isSafeInteger(hashes) || hashes < 0 || hashes > 2_000_000_000 || !Number.isSafeInteger(elapsedMs) || elapsedMs < 1000 || elapsedMs > 60000) return false;
      send({ v: 1, type: 'calibrate', hashes, elapsedMs });
      return true;
    },
    /** @param {{generation:number, jobId:string, nonceHex:string, hashHex:string}} c */
    submit(c) { return request({ v: 1, type: 'submit', jobId: c.jobId, generation: c.generation, nonceHex: c.nonceHex, hashHex: c.hashHex }, 'share'); },
  };
}
