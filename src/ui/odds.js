/**
 * odds.js — lottery arithmetic for display. Uses Number(BigInt) approximations
 * ONLY here, never for consensus decisions.
 */

/**
 * @param {bigint|null} networkTarget
 * @param {number} hashesPerSecond
 * @returns {{pPerHash:number, meanSecondsPerBlock:number, pNextDay:number, pNextHour:number}|null}
 */
export function oddsForTarget(networkTarget, hashesPerSecond) {
  if (typeof networkTarget !== 'bigint' || !Number.isFinite(hashesPerSecond) || hashesPerSecond <= 0) return null;
  // p = (target + 1) / 2^256, computed with 60 bits of precision
  const scaled = ((networkTarget + 1n) << 60n) >> 256n;
  const pPerHash = Math.min(1, Number(scaled) / 2 ** 60);
  if (pPerHash === 0) return { pPerHash: 0, meanSecondsPerBlock: Infinity, pNextDay: 0, pNextHour: 0 };
  const rate = hashesPerSecond * pPerHash; // blocks per second
  return {
    pPerHash,
    meanSecondsPerBlock: 1 / rate,
    pNextHour: -Math.expm1(-rate * 3600),
    pNextDay: -Math.expm1(-rate * 86400),
  };
}

export function formatHashrate(hps) {
  if (!Number.isFinite(hps) || hps <= 0) return '0 H/s';
  if (hps >= 1e9) return `${(hps / 1e9).toFixed(2)} GH/s`;
  if (hps >= 1e6) return `${(hps / 1e6).toFixed(2)} MH/s`;
  if (hps >= 1e4) return `${(hps / 1e3).toFixed(1)} kH/s`;
  if (hps >= 1e3) return `${(hps / 1e3).toFixed(1)} kH/s`;
  return `${Math.round(hps)} H/s`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return 'N/A';
  if (seconds > 1e6 * 365.25 * 86400) return '> 1 million years';
  if (seconds < 60) return `${Math.round(seconds)} s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)} min`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} h`;
  if (seconds < 365.25 * 86400) return `${(seconds / 86400).toFixed(1)} days`;
  return `${(seconds / (365.25 * 86400)).toFixed(1)} years`;
}

export function formatProbability(p) {
  if (!Number.isFinite(p) || p < 0) return 'N/A';
  if (p >= 0.01) return `${(p * 100).toFixed(1)} %`;
  if (p === 0) return '≈ 0';
  return `1 in ${formatBig(1 / p)}`;
}

function formatBig(n) {
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)} trillion`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} billion`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} million`;
  return Math.round(n).toLocaleString('en-US');
}
