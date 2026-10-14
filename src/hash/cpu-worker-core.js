/**
 * cpu-worker-core.js — the CPU worker's message handler, environment-agnostic.
 * `attachWorker(port)` works on a browser Worker global (`self`), a Node
 * MessagePort, or a worker_threads parentPort — anything with
 * postMessage/addEventListener('message').
 *
 * Protocol (all hex lowercase, counters as decimal strings — no BigInt/typed
 * arrays cross the boundary):
 *   → {type:'init'}                                   ← {type:'ready', selftest:boolean, backend:'cpu-js'}
 *   → {type:'job', generation, jobId, powHashHex, prefix8Hex, shareTargetBE, networkTargetBE|null}
 *   → {type:'mine', generation, firstLo, count}        ← {type:'batch', generation, firstLo, count, hashes, candidates, bestHashHex, nextLo, durationMs, truncated, stale}
 *   → {type:'cancel', generation}                      (drops the held job if it is older)
 *   any failure                                        ← {type:'error', message, inReplyTo}
 */
import { mineRange } from './mine-batch.js';
import { eaglesong, hexToBytes, bytesToHex } from './eaglesong-core.js';
import { targetFromHexBE } from './target.js';

const VECTORS = [
  ['', '9e4452fc7aed93d7240b7b55263792befd1be09252b456401122ba71a56f62a0'],
  [bytesToHex(new TextEncoder().encode('1'.repeat(34) + '\n')), 'a50a3310f78cbaeadcffe2d46262119eeeda9d6568b4df1b636399742c867aca'],
  // oracle-generated CKB 48-byte vector (tests/fixtures/ckb-pow48-vectors.json, fixed-1)
  ['0f1e2d3c4b5a69788796a5b4c3d2e1f0ffeeddccbbaa9988776655443322110001000000000000001122334400000000', '3f64a723a2d3778c7f6a078fd810932ff82fe79005965c60a01b453270dcd3ec'],
];

export function selftest() {
  return VECTORS.every(([inHex, outHex]) => bytesToHex(eaglesong(hexToBytes(inHex))) === outHex);
}

const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** @param {{postMessage:Function, addEventListener:Function}} port */
export function attachWorker(port) {
  let job = null; // {generation, jobId, powHash, prefix8, shareTarget, networkTarget}
  const reply = (m) => port.postMessage(m);
  const error = (message, inReplyTo) => reply({ type: 'error', message: String(message), inReplyTo });

  port.addEventListener('message', (ev) => {
    const m = ev?.data;
    if (!m || typeof m !== 'object') return error('non-object message', null);
    try {
      switch (m.type) {
        case 'init':
          reply({ type: 'ready', selftest: selftest(), backend: 'cpu-js' });
          return;
        case 'job': {
          if (!Number.isSafeInteger(m.generation)) throw new RangeError('job.generation must be a safe integer');
          const powHash = hexToBytes(m.powHashHex);
          const prefix8 = hexToBytes(m.prefix8Hex);
          if (powHash.length !== 32 || prefix8.length !== 8) throw new RangeError('job: powHash must be 32 bytes and prefix 8 bytes');
          job = {
            generation: m.generation, jobId: String(m.jobId), powHash, prefix8,
            shareTarget: targetFromHexBE(m.shareTargetBE),
            networkTarget: m.networkTargetBE === null || m.networkTargetBE === undefined ? null : targetFromHexBE(m.networkTargetBE),
          };
          return;
        }
        case 'cancel':
          if (job && Number.isSafeInteger(m.generation) && job.generation <= m.generation) job = null;
          return;
        case 'mine': {
          if (typeof m.firstLo !== 'string' || !/^\d+$/.test(m.firstLo)) throw new RangeError('mine.firstLo must be a decimal string');
          if (!Number.isInteger(m.count) || m.count <= 0) throw new RangeError('mine.count must be a positive integer');
          if (m.maxCandidates !== undefined && (!Number.isInteger(m.maxCandidates) || m.maxCandidates < 1 || m.maxCandidates > 64)) {
            throw new RangeError('mine.maxCandidates must be an integer in [1, 64]');
          }
          const firstLo = BigInt(m.firstLo);
          if (!job || job.generation !== m.generation) {
            reply({ type: 'batch', generation: m.generation, firstLo: m.firstLo, count: m.count, hashes: 0, candidates: [], bestHashHex: null, nextLo: m.firstLo, durationMs: 0, truncated: false, stale: true });
            return;
          }
          const t0 = nowMs();
          const r = mineRange(job, { firstLo, count: m.count }, { maxCandidates: m.maxCandidates ?? 64 });
          reply({
            type: 'batch', generation: job.generation, firstLo: m.firstLo, count: m.count,
            hashes: r.hashes, candidates: r.candidates, bestHashHex: r.bestHashHex, nextLo: r.nextLo.toString(),
            durationMs: nowMs() - t0, truncated: r.truncated, stale: false,
          });
          return;
        }
        default:
          error(`unknown message type ${String(m.type)}`, m.type);
      }
    } catch (e) {
      error(e?.message ?? e, m.type);
    }
  });
}
