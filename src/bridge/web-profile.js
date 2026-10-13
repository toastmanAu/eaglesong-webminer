/**
 * Optional browser target overlay. The proxy's target remains authoritative:
 * every share sent upstream meets its target, while the bridge may ask the
 * browser to solve a harder target to avoid share floods.
 *
 * Calibration is advisory and server-clamped. Acceptance still depends on an
 * independently recomputed Eaglesong digest, never on reported hash counts.
 */
import { targetForExpectedHashes } from '../hash/target.js';

const INITIAL_EXPECTED_HASHES = 100000n;
const MIN_HPS = 100;
const MAX_HPS = 2_000_000;
const MIN_CALIBRATION_INTERVAL_MS = 5000;

export function createWebProfile({ targetShareSeconds = 30, now = Date.now } = {}) {
  if (!Number.isInteger(targetShareSeconds) || targetShareSeconds < 1 || targetShareSeconds > 3600) {
    throw new RangeError('targetShareSeconds must be an integer in [1, 3600]');
  }
  let desiredTarget = targetForExpectedHashes(INITIAL_EXPECTED_HASHES);
  let desiredWork = INITIAL_EXPECTED_HASHES;
  let observedWorkFloor = 1n;
  let lastCalibrationAt = -Infinity;
  let lastHardeningAt = -Infinity;
  const validShareTimes = [];
  return {
    targetFor(upstreamTarget) {
      if (typeof upstreamTarget !== 'bigint' || upstreamTarget <= 0n) throw new RangeError('upstream target invalid');
      return desiredTarget < upstreamTarget ? desiredTarget : upstreamTarget;
    },
    calibrate({ hashes, elapsedMs }) {
      if (!Number.isSafeInteger(hashes) || hashes < 0 || hashes > 2_000_000_000 ||
          !Number.isSafeInteger(elapsedMs) || elapsedMs < 1000 || elapsedMs > 60000) {
        throw new RangeError('calibration counts invalid');
      }
      const t = now();
      if (t - lastCalibrationAt < MIN_CALIBRATION_INTERVAL_MS) return false;
      lastCalibrationAt = t;
      const reportedHps = Math.floor(hashes * 1000 / elapsedMs);
      const hps = Math.max(MIN_HPS, Math.min(MAX_HPS, reportedHps));
      const reportedWork = BigInt(hps) * BigInt(targetShareSeconds);
      desiredWork = reportedWork > observedWorkFloor ? reportedWork : observedWorkFloor;
      desiredTarget = targetForExpectedHashes(desiredWork);
      return true;
    },
    /** Call only after the bridge recomputed a unique, target-valid share. */
    recordValidShare() {
      const t = now();
      while (validShareTimes.length && validShareTimes[0] < t - 10000) validShareTimes.shift();
      validShareTimes.push(t);
      if (validShareTimes.length < 4 || t - lastHardeningAt < 1000) return false;
      const cap = BigInt(MAX_HPS) * BigInt(targetShareSeconds);
      const harder = desiredWork * 4n;
      const nextWork = harder < cap ? harder : cap;
      validShareTimes.length = 0;
      lastHardeningAt = t;
      if (nextWork <= desiredWork) return false;
      observedWorkFloor = nextWork;
      desiredWork = nextWork;
      desiredTarget = targetForExpectedHashes(desiredWork);
      return true;
    },
  };
}
