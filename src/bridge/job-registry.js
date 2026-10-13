/**
 * job-registry.js — per-browser-session registry of job snapshots keyed by the
 * bridge-assigned `generation`, plus a bounded duplicate-share set.
 *
 * Every change to powHash, prefix or either target gets a new generation, so a
 * late submit can be judged against exactly the state in effect when it was
 * mined. Snapshots are frozen copies: nothing upstream can mutate them later.
 */

/**
 * @typedef {object} JobSnapshotInput
 * @property {string} jobId
 * @property {Uint8Array} powHash       32 bytes
 * @property {Uint8Array} prefix8       8 bytes
 * @property {bigint} shareTarget
 * @property {bigint|null} networkTarget
 * @property {number|null} height
 * @property {boolean} cleanJobs
 * @property {number} receivedAt       ms epoch
 */

export function createSessionJobRegistry({ maxJobs = 32 } = {}) {
  if (!Number.isInteger(maxJobs) || maxJobs < 1) throw new RangeError('maxJobs must be a positive integer');
  /** @type {Map<number, object>} generation → frozen snapshot (insertion order = age) */
  const jobs = new Map();
  /** @type {Map<string, Set<string>>} jobId → nonces already submitted */
  const submitted = new Map();
  let generation = 0;

  function dropJob(gen) {
    const snap = jobs.get(gen);
    jobs.delete(gen);
    if (!snap) return;
    // keep the duplicate set while ANY retained generation still uses this jobId
    for (const s of jobs.values()) if (s.jobId === snap.jobId) return;
    submitted.delete(snap.jobId);
  }

  return {
    /** @param {JobSnapshotInput} input → frozen snapshot with a fresh generation */
    add(input) {
      validate(input);
      generation += 1;
      const snap = Object.freeze({
        generation,
        jobId: input.jobId,
        powHash: Uint8Array.from(input.powHash),
        prefix8: Uint8Array.from(input.prefix8),
        shareTarget: input.shareTarget,
        networkTarget: input.networkTarget,
        height: input.height ?? null,
        cleanJobs: Boolean(input.cleanJobs),
        receivedAt: input.receivedAt,
      });
      jobs.set(generation, snap);
      while (jobs.size > maxJobs) dropJob(jobs.keys().next().value);
      return snap;
    },
    get(gen) { return jobs.get(gen); },
    get current() { return generation === 0 ? undefined : jobs.get(generation); },
    get size() { return jobs.size; },
    get generation() { return generation; },
    /** @returns {boolean} true if this {jobId, nonce} is new; false if already submitted */
    markSubmitted(jobId, nonceHex) {
      let set = submitted.get(jobId);
      if (!set) { set = new Set(); submitted.set(jobId, set); }
      if (set.has(nonceHex)) return false;
      set.add(nonceHex);
      return true;
    },
    hasSubmitted(jobId, nonceHex) { return submitted.get(jobId)?.has(nonceHex) === true; },
    clear() { jobs.clear(); submitted.clear(); },
  };
}

function validate(i) {
  if (typeof i.jobId !== 'string' || i.jobId.length === 0) throw new RangeError('snapshot.jobId required');
  if (!(i.powHash instanceof Uint8Array) || i.powHash.length !== 32) throw new RangeError('snapshot.powHash must be 32 bytes');
  if (!(i.prefix8 instanceof Uint8Array) || i.prefix8.length !== 8) throw new RangeError('snapshot.prefix8 must be 8 bytes');
  if (typeof i.shareTarget !== 'bigint') throw new TypeError('snapshot.shareTarget must be a BigInt');
  if (i.networkTarget !== null && typeof i.networkTarget !== 'bigint') throw new TypeError('snapshot.networkTarget must be a BigInt or null');
  if (typeof i.receivedAt !== 'number') throw new TypeError('snapshot.receivedAt must be a number');
}
