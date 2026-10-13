/**
 * stratum-tcp.js — one private TCP Stratum session (line-framed JSON) per
 * browser session, speaking a pinned upstream profile.
 *
 * Emits: 'target' {shareTarget, shareTargetLE, difficulty?}, 'job' {jobId,
 * powHashHex, height, networkTarget, networkTargetLE, cleanJobs}, 'difficulty',
 * 'protocol_error' (Error), 'close' ({reason}). Fails closed on any frame that
 * does not match the profile: protocol_error + close.
 */
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { createStratumProfile, ProtocolError } from './protocol-adapter.js';

const DEFAULTS = { connectTimeoutMs: 8000, requestTimeoutMs: 10000, maxLineBytes: 65536, password: 'x', userAgent: 'EagleWebMiner/1.0' };

/**
 * @param {object} o
 * @param {string} o.host  @param {number} o.port  @param {string} o.profile  @param {string} o.worker
 * @param {(level:string, msg:string, data?:object)=>void} [o.logger]
 */
export function createStratumConnection(o) {
  const opts = { ...DEFAULTS, ...o };
  const profile = createStratumProfile(opts.profile); // throws on unknown profile before any socket
  const log = typeof opts.logger === 'function' ? opts.logger : () => {};
  const em = new EventEmitter();
  let socket = null;
  let state = 'idle';
  let buf = '';
  let nextId = 1;
  /** @type {Map<number, {resolve:Function, reject:Function, timer:any, kind:string}>} */
  const pending = new Map();
  let closeReason = null;

  function fail(reason, err) {
    if (state === 'closed') return;
    state = 'closed';
    closeReason = reason;
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error(`stratum connection closed (${reason})`)); }
    pending.clear();
    if (socket) { socket.destroy(); socket = null; }
    if (err) em.emit('protocol_error', err);
    em.emit('close', { reason });
  }

  function send(obj) {
    if (!socket || socket.destroyed) throw new Error('stratum connection closed');
    socket.write(JSON.stringify(obj) + '\n');
  }

  function request(obj, kind) {
    return new Promise((resolve, reject) => {
      if (state === 'closed' || !socket) return reject(new Error('stratum connection closed'));
      const timer = setTimeout(() => { pending.delete(obj.id); reject(new Error(`stratum ${kind} timeout after ${opts.requestTimeoutMs}ms`)); }, opts.requestTimeoutMs);
      pending.set(obj.id, { resolve, reject, timer, kind });
      try { send(obj); } catch (e) { clearTimeout(timer); pending.delete(obj.id); reject(e); }
    });
  }

  function onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return fail('bad_json', new ProtocolError('upstream sent a non-JSON line', line.slice(0, 200))); }
    if (msg === null || typeof msg !== 'object') return fail('bad_frame', new ProtocolError('upstream sent a non-object frame', msg));

    if (msg.method === undefined && msg.id !== undefined && msg.id !== null) {
      const p = pending.get(msg.id);
      if (!p) { log('warn', 'response for unknown request id', { id: msg.id }); return; }
      clearTimeout(p.timer); pending.delete(msg.id);
      p.resolve(msg);
      return;
    }
    try {
      switch (msg.method) {
        case 'mining.notify': em.emit('job', profile.parseNotify(msg)); break;
        case 'mining.set_target': em.emit('target', profile.parseSetTarget(msg)); break;
        case 'mining.set_difficulty': em.emit('difficulty', profile.parseSetDifficulty(msg)); break;
        default:
          log('warn', `ignoring unknown upstream method ${String(msg.method)}`, { frame: line.slice(0, 200) });
      }
    } catch (e) {
      if (e instanceof ProtocolError) return fail('protocol_error', e);
      throw e;
    }
  }

  function onData(chunk) {
    buf += chunk;
    if (buf.length > opts.maxLineBytes) return fail('line_too_long', new ProtocolError(`upstream line exceeds ${opts.maxLineBytes} bytes`));
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onLine(line);
      if (state === 'closed') return;
    }
  }

  Object.defineProperties(em, {
    state: { get: () => state, enumerable: true },
    closeReason: { get: () => closeReason, enumerable: true },
  });
  return Object.assign(em, {
    profile,
    /** connect + subscribe + authorize → {extranonce1Hex, extranonce2Size, prefix8} */
    async connect() {
      if (state !== 'idle') throw new Error(`connect() called in state ${state}`);
      state = 'connecting';
      await new Promise((resolve, reject) => {
        socket = net.connect({ host: opts.host, port: opts.port });
        const timer = setTimeout(() => { reject(new Error(`stratum connect timeout to ${opts.host}:${opts.port}`)); socket?.destroy(); }, opts.connectTimeoutMs);
        socket.setEncoding('utf8');
        socket.setNoDelay(true);
        socket.once('connect', () => { clearTimeout(timer); resolve(); });
        socket.once('error', (e) => { clearTimeout(timer); reject(e); });
        socket.on('data', onData);
        socket.on('close', () => fail(closeReason ?? 'socket_closed'));
      }).catch((e) => { fail('connect_failed'); throw e; });
      socket.removeAllListeners('error');
      socket.on('error', (e) => { log('warn', `socket error: ${e.message}`); fail('socket_error'); });

      const subMsg = await request(profile.buildSubscribe(nextId++, opts.userAgent), 'subscribe').catch((e) => { fail('subscribe_failed'); throw e; });
      let sub;
      try { sub = profile.parseSubscribeResult(subMsg); } catch (e) { fail('protocol_error', e); throw e; }
      state = 'subscribed';
      const authMsg = await request(profile.buildAuthorize(nextId++, opts.worker, opts.password), 'authorize').catch((e) => { fail('authorize_failed'); throw e; });
      if (authMsg.result !== true) { const e = new ProtocolError('authorize rejected', authMsg); fail('authorize_rejected', e); throw e; }
      state = 'authorized';
      return { extranonce1Hex: sub.extranonce1Hex, extranonce2Size: sub.extranonce2Size, prefix8: profile.prefix8FromExtranonce1(sub.extranonce1Hex) };
    },
    /** forward one share → {accepted, errorCode, errorMessage}; rejects on timeout/close */
    async submit(jobId, nonceHex) {
      if (state !== 'authorized') throw new Error(`stratum connection closed or not authorized (state=${state})`);
      const msg = await request(profile.buildSubmit(nextId++, opts.worker, jobId, nonceHex), 'submit');
      return profile.parseSubmitResult(msg);
    },
    close() { fail('closed_by_bridge'); },
  });
}
