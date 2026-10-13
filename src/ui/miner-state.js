/**
 * miner-state.js — the user-facing mining state machine.
 *
 *   idle → connecting → waiting_for_job → mining → stopping → stopped
 *                 ↘ error ↙ (upstream/socket loss, worker failure)
 *
 * Invariants: nothing but `start_clicked` leaves idle/stopped/error; a
 * WebSocket opening or a job arriving never starts hashing by itself.
 */
export const STATES = Object.freeze(['idle', 'connecting', 'waiting_for_job', 'mining', 'stopping', 'stopped', 'error']);

const TRANSITIONS = {
  idle:            { start_clicked: 'connecting' },
  stopped:         { start_clicked: 'connecting' },
  error:           { start_clicked: 'connecting' },
  connecting:      { session_active: 'waiting_for_job', job: 'waiting_for_job', stop_clicked: 'stopping', upstream_closed: 'error', ws_closed: 'error', start_failed: 'error' },
  waiting_for_job: { job: 'mining', stop_clicked: 'stopping', upstream_closed: 'error', ws_closed: 'error' },
  mining:          { stop_clicked: 'stopping', upstream_closed: 'error', ws_closed: 'error', workers_failed: 'error', nonce_exhausted: 'error' },
  stopping:        { workers_drained: 'stopped', ws_closed: 'stopped', upstream_closed: 'stopped' },
};

export function createMinerState() {
  let state = 'idle';
  let reason = null;
  const subs = new Set();
  return {
    get state() { return state; },
    get reason() { return reason; },
    get isHashingAllowed() { return state === 'mining'; },
    /** @param {string} event @param {{reason?:string}} [data] → true if a transition happened */
    dispatch(event, data = {}) {
      const to = TRANSITIONS[state]?.[event];
      if (!to) return false;
      const from = state;
      state = to;
      reason = to === 'error' ? (data.reason ?? event) : null;
      for (const fn of subs) fn({ from, to, event, reason });
      return true;
    },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
}
