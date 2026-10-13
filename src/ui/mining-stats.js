/**
 * mining-stats.js — honest, measured hash statistics: totals, overall rate,
 * rolling 5 s / 30 s rates, peak, best hash, and per-classification share
 * counters. Only counts hashes that workers actually reported.
 */

/** approximate "difficulty" of a digest = 2^256 / (value+1), as a Number for display */
export function hashDifficulty(hashHex) {
  const v = BigInt('0x' + hashHex) + 1n;
  // 2^256 / v with ~15 significant digits
  const num = (1n << 256n) * 1000000000000000n / v;
  return Number(num) / 1e15;
}

export function createMiningStats({ now = Date.now, windowMs = 30_000 } = {}) {
  const samples = []; // {t, n}
  let total = 0;
  let startedAt = null, stoppedAt = null;
  let peak = 0;
  let bestHex = null;
  const byBackend = {};
  const shares = {};
  let lastJob = null;

  const prune = (t) => { while (samples.length && samples[0].t < t - windowMs) samples.shift(); };
  const rateWindow = (t, ms) => {
    let n = 0, oldest = t;
    for (const s of samples) if (s.t > t - ms) { n += s.n; if (s.t < oldest) oldest = s.t; }
    const span = Math.max(Math.min(ms, t - (startedAt ?? t)), 1);
    return (n * 1000) / span;
  };

  return {
    start() { if (startedAt === null || stoppedAt !== null) { startedAt = now(); stoppedAt = null; samples.length = 0; } },
    stop() { if (startedAt !== null && stoppedAt === null) stoppedAt = now(); },
    reset() { samples.length = 0; total = 0; startedAt = null; stoppedAt = null; peak = 0; bestHex = null; for (const k in byBackend) delete byBackend[k]; for (const k in shares) delete shares[k]; },
    addHashes(n, backend = 'cpu') {
      if (!Number.isFinite(n) || n < 0 || stoppedAt !== null) return;
      const t = now();
      total += n; byBackend[backend] = (byBackend[backend] ?? 0) + n;
      samples.push({ t, n }); prune(t);
      const r5 = rateWindow(t, 5000);
      if (r5 > peak && t - (startedAt ?? t) >= 2000) peak = r5;
    },
    recordBestHash(hashHex) { if (bestHex === null || hashHex < bestHex) bestHex = hashHex; },
    recordShare(classification) { shares[classification] = (shares[classification] ?? 0) + 1; },
    recordJob(info) { lastJob = info; },
    snapshot() {
      const t = stoppedAt ?? now();
      const uptimeMs = startedAt === null ? 0 : t - startedAt;
      prune(t);
      return {
        totalHashes: total, uptimeMs,
        rateOverall: uptimeMs > 0 ? (total * 1000) / uptimeMs : 0,
        rate5s: startedAt === null ? 0 : rateWindow(t, 5000),
        rate30s: startedAt === null ? 0 : rateWindow(t, 30_000),
        peakRate: peak,
        bestHashHex: bestHex,
        bestDifficulty: bestHex === null ? 0 : hashDifficulty(bestHex),
        byBackend: { ...byBackend },
        shares: { ...shares },
        lastJob,
        running: startedAt !== null && stoppedAt === null,
      };
    },
  };
}
