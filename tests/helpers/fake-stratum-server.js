/**
 * fake-stratum-server.js — deterministic TCP Stratum fixture that speaks the
 * `solo-proxy-v1` dialect exactly as captured from the real proxy in PASS 0
 * (tests/fixtures/stratum-transcripts). Used by unit, integration and e2e tests.
 *
 * It recomputes Eaglesong for every submit (like the real proxy does) so a
 * share is only ACKed when the nonce genuinely meets the share target. Fault
 * injection knobs let tests exercise timeouts, malformed frames and closes.
 */
import net from 'node:net';
import { eaglesong, hexToBytes, bytesToHex } from '../../src/hash/eaglesong-core.js';
import { targetFromHexLE, meetsTarget } from '../../src/hash/target.js';

const randomHex = (bytes) => bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)));

/**
 * @param {object} opts
 * @param {{jobId:string, powHashHex:string, height:number, networkTargetLE:string}} opts.job
 * @param {string} opts.shareTargetLE
 * @param {number} [opts.shareDifficulty]
 * @param {string} [opts.extranonce1Hex]  fixed 4-byte extranonce1 for every connection (default: random per connection)
 */
export function createFakeStratumServer(opts) {
  const state = {
    job: { ...opts.job },
    shareTargetLE: opts.shareTargetLE,
    shareDifficulty: opts.shareDifficulty ?? 0.000001,
    extranonce1Hex: opts.extranonce1Hex ?? null,
    faults: { dropSubmitResponses: false, notifyParamCount: 5, closeOnSubmit: false, submitDelayMs: 0 },
  };
  const connections = new Set();
  const frames = [];      // {connId, dir:'c2s'|'s2c', line}
  const submits = [];     // {connId, jobId, nonceHex, accepted, isBlock, hashHex}
  const blocks = [];      // network-target solutions seen (what the real proxy would submit_block)
  let connIdCounter = 0;
  let server = null;

  const send = (conn, obj) => {
    const line = JSON.stringify(obj);
    frames.push({ connId: conn.id, dir: 's2c', line });
    if (!conn.socket.destroyed) conn.socket.write(line + '\n');
  };

  const notifyFor = (clean) => {
    const full = [state.job.jobId, state.job.powHashHex, state.job.height, state.job.networkTargetLE, clean];
    const params = state.faults.notifyParamCount === 4 ? [full[0], full[1], full[3], full[4]] : full;
    return { id: null, method: 'mining.notify', params };
  };
  const sendTargetAndJob = (conn, clean) => {
    send(conn, { id: null, method: 'mining.set_target', params: [state.shareTargetLE] });
    send(conn, { id: null, method: 'mining.set_difficulty', params: [state.shareDifficulty] });
    send(conn, notifyFor(clean));
  };

  function handle(conn, msg) {
    switch (msg.method) {
      case 'mining.subscribe': {
        conn.extranonce1 = state.extranonce1Hex ?? randomHex(4);
        conn.userAgent = msg.params?.[0];
        send(conn, { id: msg.id, result: [[['mining.set_difficulty', conn.extranonce1], ['mining.notify', conn.extranonce1]], conn.extranonce1, 4], error: null });
        return;
      }
      case 'mining.authorize': {
        conn.worker = msg.params?.[0];
        conn.authorized = true;
        send(conn, { id: msg.id, result: true, error: null });
        sendTargetAndJob(conn, false);
        return;
      }
      case 'mining.submit': {
        const nonceHex = msg.params[msg.params.length - 1];
        const jobId = msg.params[1];
        const record = { connId: conn.id, jobId, nonceHex, accepted: false, isBlock: false, hashHex: null };
        submits.push(record);
        if (state.faults.closeOnSubmit) { conn.socket.destroy(); return; }
        if (jobId !== state.job.jobId) {
          // the real proxy blind-ACKs unknown jobs (PASS 0 finding); mimic that so the bridge is tested against it
          record.accepted = true; record.unknownJob = true;
          if (!state.faults.dropSubmitResponses) send(conn, { id: msg.id, result: true, error: null });
          return;
        }
        const input = new Uint8Array(48);
        input.set(hexToBytes(state.job.powHashHex), 0);
        input.set(hexToBytes(nonceHex), 32);
        const hash = eaglesong(input);
        record.hashHex = bytesToHex(hash);
        record.isBlock = meetsTarget(hash, targetFromHexLE(state.job.networkTargetLE));
        record.accepted = record.isBlock || meetsTarget(hash, targetFromHexLE(state.shareTargetLE));
        if (record.isBlock) blocks.push({ ...record, at: Date.now() });
        if (state.faults.dropSubmitResponses) return;
        const reply = record.accepted
          ? { id: msg.id, result: true, error: null }
          : { id: msg.id, result: false, error: [23, 'Low difficulty share', null] };
        if (state.faults.submitDelayMs > 0) setTimeout(() => send(conn, reply), state.faults.submitDelayMs);
        else send(conn, reply);
        return;
      }
      case 'mining.extranonce.subscribe':
      case 'mining.suggest_difficulty':
        send(conn, { id: msg.id, result: true, error: null });
        return;
      default:
        if (msg.id !== undefined) send(conn, { id: msg.id, result: null, error: [20, `unknown method ${msg.method}`, null] });
    }
  }

  return {
    state, connections, frames, submits, blocks,
    get port() { return server?.address()?.port ?? null; },
    start({ host = '127.0.0.1', port = 0 } = {}) {
      return new Promise((resolve, reject) => {
        server = net.createServer(socket => {
          const conn = { id: ++connIdCounter, socket, buf: '', authorized: false, extranonce1: null, worker: null };
          connections.add(conn);
          socket.setEncoding('utf8');
          socket.on('data', d => {
            conn.buf += d;
            let nl;
            while ((nl = conn.buf.indexOf('\n')) !== -1) {
              const line = conn.buf.slice(0, nl).trim(); conn.buf = conn.buf.slice(nl + 1);
              if (!line) continue;
              frames.push({ connId: conn.id, dir: 'c2s', line });
              let msg; try { msg = JSON.parse(line); } catch { continue; }
              handle(conn, msg);
            }
          });
          socket.on('close', () => connections.delete(conn));
          socket.on('error', () => {});
        });
        server.once('error', reject);
        server.listen(port, host, () => resolve(server.address().port));
      });
    },
    /** push a new job to every authorized connection (new powHash → clean or not) */
    setJob(job, clean = false) {
      state.job = { ...state.job, ...job };
      for (const c of connections) if (c.authorized) send(c, notifyFor(clean));
    },
    /** change only the share target (vardiff) */
    setShareTarget(shareTargetLE, difficulty = state.shareDifficulty) {
      state.shareTargetLE = shareTargetLE; state.shareDifficulty = difficulty;
      for (const c of connections) if (c.authorized) {
        send(c, { id: null, method: 'mining.set_target', params: [shareTargetLE] });
        send(c, { id: null, method: 'mining.set_difficulty', params: [difficulty] });
      }
    },
    /** send an arbitrary raw line to all connections (fault injection) */
    sendRaw(line) { for (const c of connections) { frames.push({ connId: c.id, dir: 's2c', line }); c.socket.write(line + '\n'); } },
    closeAllConnections() { for (const c of connections) c.socket.destroy(); },
    stop() {
      return new Promise(resolve => {
        for (const c of connections) c.socket.destroy();
        if (!server) return resolve();
        server.close(() => { server = null; resolve(); });
      });
    },
  };
}

/** Convenience: the job/targets the real solo proxy issued in the PASS 0 transcript. */
export function transcriptJob(t) {
  return {
    job: { jobId: t.job.jobId, powHashHex: t.job.powHashHex, height: t.job.height, networkTargetLE: t.job.networkTargetLE },
    shareTargetLE: t.job.shareTargetLE,
    shareDifficulty: 0.000001,
    extranonce1Hex: t.extranonce1,
  };
}
