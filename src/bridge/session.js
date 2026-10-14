/**
 * session.js — one browser session: validates inbound frames, owns exactly one
 * upstream TCP Stratum session while mining is started, assigns generations,
 * classifies shares (bridge recomputation first, upstream ACK second) and tears
 * everything down on stop / socket loss / WebSocket close.
 *
 * States: idle → connecting → active → stopping → stopped (→ connecting again) ; closed
 */
import { randomBytes } from 'node:crypto';
import { validateClientMessage } from './ws-schema.js';
import { createSessionJobRegistry } from './job-registry.js';
import { evaluateSubmit } from './share-validator.js';
import { createStratumConnection } from './stratum-tcp.js';
import { hexToBytes, bytesToHex } from '../hash/eaglesong-core.js';
import { targetToHexBE, difficultyFromTarget } from '../hash/target.js';
import { createWebProfile } from './web-profile.js';

export const PROTOCOL_NAME = 'ckb-128nonce-v1';
export const BRIDGE_VERSION = '0.1.0';

/**
 * @param {object} deps
 * @param {(obj:object)=>void} deps.send          deliver a JSON message to the browser
 * @param {(code:number, reason:string)=>void} deps.close  close the WebSocket
 * @param {object} deps.config                   validated bridge config
 * @param {Function} [deps.logger]
 * @param {Function} [deps.connectionFactory]    for tests
 * @param {()=>number} [deps.now]
 */
export function createSession(deps) {
  const { send, close, config } = deps;
  const log = deps.logger ?? (() => {});
  const now = deps.now ?? Date.now;
  const connect = deps.connectionFactory ?? createStratumConnection;
  const sessionId = randomBytes(12).toString('hex');
  const registry = createSessionJobRegistry({ maxJobs: config.bridge.maxJobsPerSession ?? 32 });
  const stats = { submits: 0, byClassification: {}, startedAt: now(), jobs: 0, upstreamSessions: 0 };
  const submitTimes = []; // sliding window for the rate limit
  let pendingSubmissions = 0;
  let state = 'idle';
  let conn = null;
  let prefix8 = null;
  let shareTarget = null;     // bigint from the latest set_target
  let upstreamShareTarget = null;
  let webProfile = config.mining?.webProfileEnabled ? createWebProfile({ targetShareSeconds: config.mining.targetShareSeconds, now }) : null;
  let heldJob = null;         // notify that arrived before any target
  let currentJob = null;      // latest upstream job (jobId, powHashHex, height, networkTarget, cleanJobs)
  let activeJobGeneration = 0; // target-only snapshots retain this job boundary
  let capabilities = [];
  let workerLabel = 'web';

  let proxyStats = deps.proxyStats ?? null;
  const payout = {
    kind: 'node_block_assembler',
    address: proxyStats?.address ?? config.payout?.displayAddress ?? null,
    verified: proxyStats?.verified === true,
  };
  send({ v: 1, type: 'hello', sessionId, mode: config.mining?.mode ?? 'solo', payout, protocol: PROTOCOL_NAME, bridgeVersion: BRIDGE_VERSION,
    webProfile: webProfile !== null });

  const error = (code, message, requestId) => send({ v: 1, type: 'error', code, message, ...(requestId ? { requestId } : {}) });
  const status = (extra = {}) => send({
    v: 1, type: 'status',
    connected: state === 'active',
    nodeHealthy: proxyStats?.nodeHealthy ?? null,
    jobAgeMs: registry.current ? now() - registry.current.receivedAt : null,
    payoutVerified: payout.verified,
    payout: { ...payout },
    templateAgeSec: proxyStats?.templateAgeSec ?? null,
    stratumState: conn?.state ?? 'none',
    ...extra,
  });
  const bump = (cls) => { stats.byClassification[cls] = (stats.byClassification[cls] ?? 0) + 1; };

  function publishSnapshot(snap, kind) {
    const common = {
      v: 1, generation: snap.generation, jobId: snap.jobId,
      shareTargetBE: targetToHexBE(snap.shareTarget),
      networkTargetBE: snap.networkTarget === null ? null : targetToHexBE(snap.networkTarget),
      shareDifficulty: difficultyFromTarget(snap.shareTarget),
    };
    if (kind === 'job') {
      send({ ...common, type: 'job', powHashHex: bytesToHex(snap.powHash), height: snap.height, cleanJobs: snap.cleanJobs, prefix8Hex: bytesToHex(snap.prefix8), issuedAt: snap.receivedAt });
    } else {
      send({ ...common, type: 'target' });
    }
  }

  function snapshotCurrent(kind) {
    if (!currentJob || shareTarget === null || !prefix8) return;
    const snap = registry.add({
      jobId: currentJob.jobId, powHash: hexToBytes(currentJob.powHashHex), prefix8,
      shareTarget, networkTarget: currentJob.networkTarget, height: currentJob.height, cleanJobs: currentJob.cleanJobs,
      receivedAt: now(),
    });
    stats.jobs++;
    if (kind === 'job') activeJobGeneration = snap.generation;
    publishSnapshot(snap, kind);
  }

  function teardownUpstream(reason) {
    const c = conn; conn = null;
    if (c) c.close();
    registry.clear(); // a later Start opens a different Stratum session and prefix
    currentJob = null; heldJob = null; shareTarget = null; upstreamShareTarget = null; prefix8 = null;
    activeJobGeneration = 0;
    log('info', `upstream torn down (${reason})`, { sessionId });
  }

  async function handleStart(msg) {
    if (state === 'active' || state === 'connecting') return error('ALREADY_STARTED', 'mining session is already started', msg.requestId);
    if (state === 'closed') return;
    if (msg.workerLabel) workerLabel = msg.workerLabel;
    if (config.mining?.webProfileEnabled) webProfile = createWebProfile({ targetShareSeconds: config.mining.targetShareSeconds, now });
    state = 'connecting';
    status();
    const generationAtStart = registry.generation;
    const c = connect({
      host: config.stratum.host, port: config.stratum.port, profile: config.stratum.profile,
      worker: workerLabel, requestTimeoutMs: config.bridge.submitTimeoutMs ?? 10000, logger: log,
    });
    conn = c;
    c.on('target', ({ shareTarget: st }) => {
      if (conn !== c) return;
      upstreamShareTarget = st;
      shareTarget = webProfile ? webProfile.targetFor(st) : st;
      if (heldJob) { currentJob = heldJob; heldJob = null; snapshotCurrent('job'); }
      else if (currentJob) snapshotCurrent('target');
    });
    c.on('job', (job) => {
      if (conn !== c) return;
      if (shareTarget === null) { heldJob = job; return; } // fail closed: never mine without a share target
      currentJob = job;
      snapshotCurrent('job');
    });
    c.on('protocol_error', (e) => { if (conn === c) error('UPSTREAM_PROTOCOL', `upstream frame rejected: ${e.message}`); });
    c.on('close', ({ reason }) => {
      if (conn !== c) return;
      const wasActive = state === 'active' || state === 'connecting';
      conn = null;
      registry.clear();
      currentJob = null; heldJob = null; shareTarget = null; upstreamShareTarget = null; prefix8 = null;
      activeJobGeneration = 0;
      if (wasActive) {
        state = 'stopped';
        error('UPSTREAM_CLOSED', `upstream stratum session closed (${reason}); press Start to reconnect`);
        status();
      }
    });
    try {
      const info = await c.connect();
      if (conn !== c) return; // stopped meanwhile
      prefix8 = info.prefix8;
      stats.upstreamSessions++;
      state = 'active';
      status({ requestId: msg.requestId }); // the ack the browser's start() correlates on
      // target/job events may already have arrived before connect() resolved
      if (heldJob && shareTarget !== null) { currentJob = heldJob; heldJob = null; }
      if (currentJob && shareTarget !== null && registry.generation === generationAtStart) snapshotCurrent('job');
    } catch (e) {
      if (conn !== c) return;
      conn = null;
      state = 'stopped';
      error('UPSTREAM_UNAVAILABLE', `could not open upstream stratum session: ${e.message}`, msg.requestId);
      status();
    }
  }

  function handleStop(msg) {
    if (state === 'idle' || state === 'stopped') { status(); return; }
    state = 'stopping';
    teardownUpstream('stop requested');
    state = 'stopped';
    status({ requestId: msg.requestId });
  }

  function handleCalibration(msg) {
    if (!webProfile) return error('PROFILE_DISABLED', 'browser target calibration is disabled', msg.requestId);
    if (state !== 'active' || upstreamShareTarget === null) return error('NOT_STARTED', 'mining session is not active', msg.requestId);
    if (!webProfile.calibrate(msg)) return;
    const nextTarget = webProfile.targetFor(upstreamShareTarget);
    if (nextTarget === shareTarget) return;
    shareTarget = nextTarget;
    if (currentJob) snapshotCurrent('target');
  }

  function rateLimited() {
    const limit = config.bridge.perSessionSubmissionsPerMinute ?? 120;
    const t0 = now() - 60_000;
    while (submitTimes.length && submitTimes[0] < t0) submitTimes.shift();
    return submitTimes.length >= limit;
  }

  async function handleSubmit(msg) {
    if (state !== 'active' || !conn) return error('NOT_STARTED', 'mining session is not active', msg.requestId);
    if (pendingSubmissions >= (config.bridge.maxConcurrentSubmissions ?? 8)) {
      return error('SUBMISSION_BUSY', 'too many submissions awaiting upstream; slow down', msg.requestId);
    }
    pendingSubmissions++;
    try { await submitValidated(msg); }
    finally { pendingSubmissions--; }
  }

  async function submitValidated(msg) {
    stats.submits++;
    const v = evaluateSubmit(registry, msg);
    const base = { v: 1, type: 'share_result', requestId: msg.requestId ?? null, jobId: msg.jobId, generation: msg.generation, nonceHex: msg.nonceHex, hashHex: v.hashHex, clientHashMismatch: v.clientHashMismatch };

    if (v.classification !== 'block_candidate') {
      if (rateLimited()) { stats.submits--; return error('RATE_LIMITED', 'too many submissions; slow down', msg.requestId); }
      submitTimes.push(now());
    }
    if (v.classification.startsWith('rejected_')) {
      bump(v.classification);
      return send({ ...base, classification: v.classification, accepted: false, reason: v.reason, upstream: null });
    }
    if (v.classification !== 'block_candidate' && (v.snapshot.generation < activeJobGeneration || v.snapshot.jobId !== currentJob?.jobId)) {
      bump('rejected_stale');
      return send({ ...base, classification: 'rejected_stale', accepted: false,
        reason: 'job was replaced; only an independently verified network candidate can use a retained old job', upstream: null });
    }
    if (webProfile?.recordValidShare() && upstreamShareTarget !== null) {
      const nextTarget = webProfile.targetFor(upstreamShareTarget);
      if (nextTarget !== shareTarget) { shareTarget = nextTarget; snapshotCurrent('target'); }
    }
    // share_ok or block_candidate: forward exactly once
    let upstream;
    try {
      upstream = await conn.submit(v.snapshot.jobId, msg.nonceHex);
    } catch (e) {
      bump('upstream_error');
      return send({ ...base, classification: 'upstream_error', accepted: false, reason: `upstream submit failed: ${e.message}`, upstream: null });
    }
    let classification;
    if (v.classification === 'block_candidate') classification = 'block_candidate';
    else if (upstream.accepted) classification = 'local_accepted';
    else if (upstream.errorCode === 23) classification = 'rejected_low_diff';
    else classification = 'upstream_error';
    bump(classification);
    send({
      ...base, classification,
      accepted: upstream.accepted === true,
      reason: classification === 'block_candidate'
        ? `meets the network target; upstream ${upstream.accepted ? 'ACKed' : 'did not ACK'} — the solo proxy decides whether to call submit_block`
        : (upstream.accepted ? 'upstream accepted' : `upstream rejected: ${upstream.errorMessage ?? 'unknown'}`),
      upstream,
    });
  }

  return {
    sessionId, stats, registry,
    applyProxyStats(value) {
      if (state === 'closed') return;
      proxyStats = value;
      payout.address = value?.address ?? config.payout?.displayAddress ?? null;
      payout.verified = value?.verified === true;
      status();
    },
    get state() { return state; },
    get capabilities() { return capabilities; },
    /** @param {string|Buffer} raw one WebSocket frame */
    handleMessage(raw) {
      if (state === 'closed') return;
      const r = validateClientMessage(raw);
      if (!r.ok) {
        let requestId;
        try { const j = JSON.parse(typeof raw === 'string' ? raw : raw.toString()); if (typeof j?.requestId === 'string' && j.requestId.length <= 64) requestId = j.requestId; } catch { /* ignore */ }
        return error(r.code, r.message, requestId);
      }
      const msg = r.msg;
      switch (msg.type) {
        case 'hello': capabilities = msg.capabilities; return;
        case 'start': return void handleStart(msg);
        case 'stop': return handleStop(msg);
        case 'submit': return void handleSubmit(msg);
        case 'calibrate': return handleCalibration(msg);
        case 'ping': return send({ v: 1, type: 'pong', requestId: msg.requestId ?? null });
        default: return error('UNKNOWN_TYPE', 'unknown message type', msg.requestId);
      }
    },
    sendStatus() { if (state !== 'closed') status(); },
    /** the WebSocket is gone: release everything */
    onClose() {
      if (state === 'closed') return;
      state = 'closed';
      teardownUpstream('websocket closed');
      registry.clear();
    },
    terminate(code, reason) { this.onClose(); close(code, reason); },
  };
}
