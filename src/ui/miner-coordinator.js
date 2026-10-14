/**
 * miner-coordinator.js — owns the workers, the single nonce-range allocator,
 * the current generation, batch sizing, the intensity duty cycle and the
 * watchdog. Pure JS (no DOM) so it is unit-tested in Node against the real
 * worker code on a MessageChannel.
 *
 *   createWorker()          → Worker-like {postMessage, addEventListener, terminate}
 *   setJob(normalizedJob)   → new generation; cursor kept for target-only changes
 *   start()/stop()          → explicit; stop() resolves once no batch is in flight
 *   onCandidate(c)          → {generation, jobId, nonceHex, hashHex, meetsNetwork}
 *   onBatch(b)              → {workerIndex, generation, hashes, count, durationMs, bestHashHex}
 *   onEvent(type, data)     → 'worker_ready' | 'worker_crash' | 'worker_error' | 'exhausted' | 'selftest_failed'
 */
import { createRangeAllocator } from '../hash/nonce.js';
import { bytesToHex } from '../hash/eaglesong-core.js';
import { targetToHexBE } from '../hash/target.js';

export const MAX_WORKERS = 16;
const MIN_BATCH = 16, MAX_BATCH = 2_000_000;

export function createMinerCoordinator(opts) {
  const {
    createWorker, onCandidate = () => {}, onBatch = () => {}, onEvent = () => {},
    batchTargetMs = 50, initialBatchCount = 2000, watchdogMs = 4000,
    now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
    setTimeoutFn = (fn, ms) => setTimeout(fn, ms), clearTimeoutFn = (h) => clearTimeout(h),
  } = opts;
  const maxCandidatesPerBatch = opts.maxCandidatesPerBatch ?? 64;
  if (!Number.isInteger(maxCandidatesPerBatch) || maxCandidatesPerBatch < 1 || maxCandidatesPerBatch > 64) {
    throw new RangeError('maxCandidatesPerBatch must be an integer in [1, 64]');
  }
  let intensity = clampIntensity(opts.intensity ?? 100);
  let desiredWorkers = clampWorkers(opts.workerCount ?? 1);

  /** @type {Array<{index:number, w:any, ready:boolean, selftest:boolean|null, busy:boolean, batchCount:number, restTimer:any, watchdog:any, generationSent:number}>} */
  const workers = [];
  const allocator = createRangeAllocator();
  const pendingRanges = []; // unsearched tails from candidate-capped or interrupted batches
  let job = null;          // normalized job (BigInt targets, Uint8Array hashes)
  let jobKey = null;       // powHashHex + prefix8Hex → detects target-only changes
  let running = false;
  let stopResolvers = [];
  let disposed = false;
  const rests = { count: 0, lastMs: 0 };

  function clampIntensity(v) { return Math.min(100, Math.max(1, Math.round(Number(v) || 100))); }
  function clampWorkers(n) { return Math.min(MAX_WORKERS, Math.max(1, Math.floor(Number(n) || 1))); }

  function spawn(index) {
    const slot = { index, w: null, ready: false, selftest: null, busy: false, awaitingCandidate: false, batchCount: initialBatchCount, restTimer: null, watchdog: null, generationSent: -1, range: null, rangeKey: null };
    slot.w = createWorker();
    slot.w.addEventListener('message', (ev) => onMessage(slot, ev.data));
    slot.w.addEventListener?.('error', (ev) => { onEvent('worker_error', { workerIndex: index, message: ev?.message ?? 'worker error' }); replace(slot, 'error event'); });
    slot.w.postMessage({ type: 'init' });
    armWatchdog(slot, 'init');
    if (job) sendJob(slot);
    return slot;
  }

  function armWatchdog(slot, what) {
    disarm(slot);
    slot.watchdog = setTimeoutFn(() => {
      slot.watchdog = null;
      onEvent('worker_crash', { workerIndex: slot.index, message: `no response to ${what} within ${watchdogMs}ms` });
      replace(slot, `watchdog (${what})`);
    }, watchdogMs);
  }
  function disarm(slot) { if (slot.watchdog) { clearTimeoutFn(slot.watchdog); slot.watchdog = null; } }

  function replace(slot, reason) {
    disarm(slot);
    if (slot.restTimer) { clearTimeoutFn(slot.restTimer); slot.restTimer = null; }
    try { slot.w.terminate(); } catch { /* ignore */ }
    const wasBusy = slot.busy;
    if (slot.range && slot.rangeKey === jobKey) pendingRanges.push(slot.range);
    slot.range = null;
    slot.busy = false;
    const idx = workers.indexOf(slot);
    if (idx === -1 || disposed) { if (wasBusy) checkDrained(); return; }
    if (idx >= desiredWorkers) { workers.splice(idx, 1); if (wasBusy) checkDrained(); return; }
    const fresh = spawn(slot.index);
    workers[idx] = fresh;
    if (wasBusy) checkDrained();
  }

  function sendJob(slot) {
    slot.w.postMessage({
      type: 'job', generation: job.generation, jobId: job.jobId,
      powHashHex: bytesToHex(job.powHash), prefix8Hex: bytesToHex(job.prefix8),
      shareTargetBE: targetToHexBE(job.shareTarget), networkTargetBE: job.networkTarget === null ? null : targetToHexBE(job.networkTarget),
    });
    slot.generationSent = job.generation;
  }

  function dispatch(slot) {
    if (!running || !job || !slot.ready || slot.busy || slot.awaitingCandidate || disposed) return;
    if (slot.generationSent !== job.generation) sendJob(slot);
    const range = pendingRanges.shift() ?? allocator.next(slot.batchCount);
    if (range === null) {
      if (!workers.some(s => s.busy)) exhausted();
      return;
    }
    slot.busy = true;
    slot.range = range;
    slot.rangeKey = jobKey;
    slot.w.postMessage({ type: 'mine', generation: job.generation, firstLo: range.firstLo.toString(), count: range.count, maxCandidates: maxCandidatesPerBatch });
    armWatchdog(slot, 'mine');
  }

  function exhausted() {
    if (!running) return;
    running = false;
    onEvent('exhausted', { cursor: allocator.cursor.toString() });
    checkDrained();
  }

  function onMessage(slot, m) {
    if (disposed || !workers.includes(slot)) return;
    if (!m || typeof m !== 'object') return;
    switch (m.type) {
      case 'ready':
        disarm(slot);
        slot.ready = true; slot.selftest = m.selftest === true;
        onEvent('worker_ready', { workerIndex: slot.index, selftest: slot.selftest, backend: m.backend });
        if (!slot.selftest) onEvent('selftest_failed', { workerIndex: slot.index });
        dispatch(slot);
        return;
      case 'batch': {
        disarm(slot);
        slot.busy = false;
        const assigned = slot.range;
        slot.range = null;
        if (!m.stale && m.truncated && assigned && slot.rangeKey === jobKey &&
            Number.isInteger(m.hashes) && m.hashes > 0 && m.hashes < assigned.count) {
          pendingRanges.push({ firstLo: assigned.firstLo + BigInt(m.hashes), count: assigned.count - m.hashes });
        }
        if (!m.stale) {
          // adaptive batch size toward batchTargetMs (bounded, smoothed)
          const d = Math.max(m.durationMs, 0.25);
          const ideal = (m.count * batchTargetMs) / d;
          slot.batchCount = Math.round(Math.min(MAX_BATCH, Math.max(MIN_BATCH, slot.batchCount * 0.5 + ideal * 0.5)));
          onBatch({ workerIndex: slot.index, generation: m.generation, hashes: m.hashes, count: m.count, durationMs: m.durationMs, bestHashHex: m.bestHashHex, truncated: m.truncated });
          const pending = [];
          for (const c of m.candidates) {
            try {
              const result = onCandidate(c);
              if (result && typeof result.then === 'function') pending.push(result);
            } catch (e) { onEvent('worker_error', { workerIndex: slot.index, message: `candidate handler: ${e.message}` }); }
          }
          if (pending.length) {
            slot.awaitingCandidate = true;
            Promise.allSettled(pending).then(() => {
              slot.awaitingCandidate = false;
              if (running && workers.includes(slot)) dispatch(slot);
            });
          }
        }
        if (slot.awaitingCandidate) { if (!running) checkDrained(); return; }
        if (!running) { checkDrained(); return; }
        if (intensity >= 100 || m.stale) { dispatch(slot); return; }
        const rest = Math.max(1, Math.round(m.durationMs * (100 - intensity) / intensity));
        rests.count++; rests.lastMs = rest;
        slot.restTimer = setTimeoutFn(() => { slot.restTimer = null; dispatch(slot); }, rest);
        return;
      }
      case 'error':
        onEvent('worker_error', { workerIndex: slot.index, message: m.message, inReplyTo: m.inReplyTo });
        if (m.inReplyTo === 'mine') {
          disarm(slot);
          if (slot.range && slot.rangeKey === jobKey) pendingRanges.push(slot.range);
          slot.range = null;
          slot.busy = false;
          if (running) dispatch(slot); else checkDrained();
        }
        return;
      default:
    }
  }

  function checkDrained() {
    if (workers.some(s => s.busy)) return;
    const rs = stopResolvers; stopResolvers = [];
    for (const r of rs) r();
  }

  return {
    async init() {
      for (let i = workers.length; i < desiredWorkers; i++) workers.push(spawn(i));
      await new Promise((resolve) => {
        const check = () => { if (workers.every(s => s.ready || s.watchdog === null)) resolve(); else setTimeoutFn(check, 10); };
        check();
      });
      return { workers: workers.length, selftest: workers.length > 0 && workers.every(s => s.selftest === true) };
    },
    /** @param {object} normalizedJob {jobId, generation, powHash, prefix8, shareTarget, networkTarget} */
    setJob(normalizedJob) {
      const key = bytesToHex(normalizedJob.powHash) + bytesToHex(normalizedJob.prefix8);
      if (key !== jobKey) { allocator.reset(); pendingRanges.length = 0; } // new work → fresh counter; target-only → keep cursor
      jobKey = key;
      job = normalizedJob;
      for (const s of workers) if (s.ready && !s.busy) dispatch(s);
      // busy workers pick the new generation up at their next dispatch; their in-flight batch is still counted/forwarded
    },
    start({ startLo } = {}) {
      if (running || disposed) return;
      if (startLo !== undefined) { allocator.reset(startLo); pendingRanges.length = 0; }
      running = true;
      for (const s of workers) dispatch(s);
    },
    stop() {
      running = false;
      for (const s of workers) if (s.restTimer) { clearTimeoutFn(s.restTimer); s.restTimer = null; }
      return new Promise((resolve) => { stopResolvers.push(resolve); checkDrained(); });
    },
    setIntensity(v) { intensity = clampIntensity(v); },
    async setWorkerCount(n) {
      desiredWorkers = clampWorkers(n);
      while (workers.length > desiredWorkers) {
        const s = workers.pop();
        disarm(s);
        if (s.restTimer) clearTimeoutFn(s.restTimer);
        if (s.range && s.rangeKey === jobKey) pendingRanges.push(s.range);
        try { s.w.terminate(); } catch { /* ignore */ }
      }
      for (let i = workers.length; i < desiredWorkers; i++) workers.push(spawn(i));
      for (const s of workers) dispatch(s);
      await new Promise((resolve) => { const check = () => { if (workers.every(s => s.ready || s.watchdog === null)) resolve(); else setTimeoutFn(check, 10); }; check(); });
    },
    snapshot() {
      return {
        running, workers: workers.length, readyWorkers: workers.filter(s => s.ready).length,
        inflight: workers.filter(s => s.busy).length, generation: job?.generation ?? null,
        cursor: allocator.cursor, exhausted: allocator.exhausted, intensity,
        batchCounts: workers.map(s => s.batchCount),
        rests: { ...rests },
      };
    },
    async dispose() {
      disposed = true; running = false;
      for (const s of workers) { disarm(s); if (s.restTimer) clearTimeoutFn(s.restTimer); try { s.w.terminate(); } catch { /* ignore */ } s.busy = false; }
      workers.length = 0;
      checkDrained();
    },
  };
}
