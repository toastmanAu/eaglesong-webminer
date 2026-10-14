/**
 * app.js — DOM glue for EagleSong WebMiner. All logic lives in the tested
 * modules (protocol-client, miner-coordinator, miner-state, mining-stats, odds);
 * this file only wires events to the page. Nothing starts until the user
 * presses Start; nothing auto-starts on reload or reconnect.
 */
import { createProtocolClient } from './protocol-client.js';
import { createMinerCoordinator, MAX_WORKERS } from './miner-coordinator.js';
import { createMinerState } from './miner-state.js';
import { createMiningStats } from './mining-stats.js';
import { oddsForTarget, formatHashrate, formatDuration, formatProbability } from './odds.js';
import { targetToHexBE } from '../hash/target.js';

const $ = (id) => document.getElementById(id);
const CONFIG = readConfig();
const LOG_MAX = 250;
const PREF_KEY = 'eagle.prefs.v1';

// ── capabilities ────────────────────────────────────────────────────────────
const caps = {
  workers: typeof Worker === 'function',
  bigint: typeof BigInt === 'function',
  wasm: typeof WebAssembly === 'object',
  webgpu: typeof navigator !== 'undefined' && 'gpu' in navigator,
  secure: typeof isSecureContext === 'boolean' ? isSecureContext : false,
  hardwareConcurrency: navigator.hardwareConcurrency || 1,
  mobile: navigator.userAgentData?.mobile ?? /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent),
};
$('cap-workers').textContent = caps.workers ? 'yes' : 'NO — cannot mine';
$('cap-bigint').textContent = caps.bigint ? 'yes' : 'NO — cannot mine';
$('cap-wasm').textContent = caps.wasm ? 'available (backend not yet enabled)' : 'no';
$('cap-webgpu').textContent = caps.webgpu ? 'available (backend not yet enabled)' : 'no';
$('cap-secure').textContent = caps.secure ? 'yes' : 'no (http) — fine for localhost dev';
$('diag-build').textContent = `${CONFIG.version} ${CONFIG.buildHash ? CONFIG.buildHash.slice(0, 12) : 'dev'}`;
$('bridge-url').textContent = CONFIG.bridgeUrl;
if (caps.mobile) $('device-warning').hidden = false;

// ── preferences (safe UI prefs only) ────────────────────────────────────────
const prefs = loadPrefs();
const maxWorkers = Math.max(1, Math.min(MAX_WORKERS, caps.mobile ? Math.min(4, caps.hardwareConcurrency) : Math.min(8, caps.hardwareConcurrency - 1 || 1)));
$('workers').max = String(maxWorkers);
$('workers').value = String(Math.min(maxWorkers, prefs.workers ?? (caps.mobile ? 1 : Math.max(1, Math.min(4, maxWorkers)))));
$('intensity').value = String(prefs.intensity ?? (caps.mobile ? 50 : 100));
$('keep-background').checked = prefs.keepBackground === true;
$('workers-help').textContent = `Hardware threads detected: ${caps.hardwareConcurrency}. Max here: ${maxWorkers}.`;
syncOutputs();

// ── core objects ────────────────────────────────────────────────────────────
const state = createMinerState();
const stats = createMiningStats();
const client = createProtocolClient({ url: CONFIG.bridgeUrl, capabilities: ['cpu-js'] });
let calibrationHashes = 0;
let calibrationAt = performance.now();
const coord = createMinerCoordinator({
  createWorker, workerCount: Number($('workers').value), intensity: Number($('intensity').value), batchTargetMs: 50,
  maxCandidatesPerBatch: 1,
  onBatch: (b) => { stats.addHashes(b.hashes, 'cpu'); calibrationHashes += b.hashes; if (b.bestHashHex) stats.recordBestHash(b.bestHashHex); },
  onCandidate: (c) => submitCandidate(c),
  onEvent: (type, d) => {
    if (type === 'worker_ready') { $('cap-selftest').textContent = d.selftest ? 'PASS (official vectors)' : 'FAIL'; if (!d.selftest) log('err', `worker ${d.workerIndex} Eaglesong self-test FAILED — mining disabled`); }
    else if (type === 'worker_crash') log('warn', `worker ${d.workerIndex} unresponsive — replaced (${d.message})`);
    else if (type === 'worker_error') log('warn', `worker ${d.workerIndex} error: ${d.message}`);
    else if (type === 'exhausted') { log('err', 'nonce space exhausted for this session — stopping'); state.dispatch('nonce_exhausted', { reason: 'nonce space exhausted' }); stopAll(); }
    else if (type === 'selftest_failed') { selftestFailed = true; }
  },
});
let selftestFailed = false;
let userWantsMining = false;
let pausedByVisibility = false;
let lastRttMs = null;
const logEntries = [];
window.__eagle = { state, stats, coord, client, get logEntries() { return logEntries; } };

// ── bridge events ───────────────────────────────────────────────────────────
client.on('open', () => { setConn('Connected', 'badge-info'); log('info', 'bridge connected'); });
client.on('hello', (h) => {
  $('session-id').textContent = h.sessionId;
  $('diag-protocol').textContent = `${h.protocol} · bridge ${h.bridgeVersion ?? '?'}`;
  $('badge-mode').textContent = h.mode === 'solo' ? 'Solo' : 'Pool';
  showPayout(h.payout);
  log('info', `session ${h.sessionId.slice(0, 8)}… payout ${h.payout?.address ?? 'n/a'} (${h.payout?.verified ? 'verified' : 'unverified'})`);
});
client.on('job', (job) => {
  coord.setJob(job);
  stats.recordJob({ jobId: job.jobId, generation: job.generation, height: job.height, receivedAtMs: job.receivedAtMs });
  $('job-id').textContent = job.jobId;
  $('job-gen').textContent = `gen ${job.generation}`;
  $('job-height').textContent = job.height === null ? '—' : job.height.toLocaleString('en-US');
  $('share-diff').textContent = job.shareDifficulty === null ? '—' : job.shareDifficulty.toExponential(3);
  $('net-target').textContent = job.networkTarget === null ? 'unknown (pool mode)' : targetToHexBE(job.networkTarget);
  log(job.change === 'target' ? 'info' : 'ok', job.change === 'target' ? `target update → gen ${job.generation}` : `job ${job.jobId} height ${job.height} gen ${job.generation}${job.cleanJobs ? ' (clean)' : ''}`);
  if (state.dispatch('job')) onStateChanged();
});
client.on('status', (s) => {
  if (s.payout) showPayout(s.payout);
  if (s.connected === false && state.state !== 'idle' && state.state !== 'stopped' && state.state !== 'stopping') {
    // upstream gone while we were mining: reflect it truthfully
  }
  $('job-age').textContent = typeof s.jobAgeMs === 'number' ? `${(s.jobAgeMs / 1000).toFixed(1)} s` : '—';
});
function showPayout(payout) {
  $('payout-address').textContent = payout?.address ?? 'not configured by the operator';
  $('payout-verified').textContent = payout?.verified ? 'verified from node template' : 'unverified (operator config)';
  $('payout-verified').className = `badge ${payout?.verified ? 'badge-ok' : 'badge-warn'}`;
  $('payout-source').textContent = payout?.verified
    ? 'Derived by the proxy from the current node cellbase lock. You cannot change it here.'
    : 'Operator-configured or unavailable. A typed address here would not redirect rewards.';
}
client.on('error', (e) => {
  log('err', `bridge error ${e.code}: ${e.message}`);
  if (e.code === 'UPSTREAM_CLOSED' || e.code === 'UPSTREAM_UNAVAILABLE' || e.code === 'UPSTREAM_PROTOCOL') {
    if (state.dispatch('upstream_closed', { reason: e.message })) { coord.stop(); stats.stop(); onStateChanged(); }
  }
});
client.on('request_error', (e) => log('warn', `request ${e.requestId} refused: ${e.code} ${e.message}`));
client.on('protocol_error', (e) => log('err', `bridge frame rejected: ${e.message}`));
client.on('close', (c) => {
  setConn('Disconnected', 'badge-neutral');
  log('warn', `bridge connection closed (${c.code ?? 'n/a'})`);
  if (state.dispatch('ws_closed', { reason: 'bridge connection lost' })) { coord.stop(); stats.stop(); onStateChanged(); }
});
client.on('reconnecting', (r) => { setConn(`Reconnecting (${r.attempt})`, 'badge-warn'); log('info', `reconnecting in ${r.delayMs} ms — mining will NOT resume by itself`); });

// ── start / stop ────────────────────────────────────────────────────────────
$('btn-start').addEventListener('click', startMining);
$('btn-stop').addEventListener('click', stopAll);

async function startMining() {
  if (!caps.workers || !caps.bigint) { log('err', 'this browser lacks Web Workers or BigInt — cannot mine'); return; }
  if (selftestFailed) { log('err', 'Eaglesong self-test failed in a worker — refusing to mine'); return; }
  if (!state.dispatch('start_clicked')) return;
  userWantsMining = true; pausedByVisibility = false;
  onStateChanged();
  try {
    if (coord.snapshot().workers === 0) {
      const info = await coord.init();
      log('info', `${info.workers} CPU worker(s) ready, self-test ${info.selftest ? 'PASS' : 'FAIL'}`);
      if (!info.selftest) throw new Error('Eaglesong self-test failed');
    }
    if (client.state !== 'open') { client.connect(); await waitForOpen(8000); }
    await client.start(`web-${(client.hello?.sessionId ?? 'x').slice(0, 6)}`);
    calibrationHashes = 0; calibrationAt = performance.now();
    stats.start();
    if (state.dispatch('session_active')) onStateChanged();
  } catch (e) {
    log('err', `start failed: ${e.message}`);
    if (state.dispatch('start_failed', { reason: e.message })) onStateChanged();
    userWantsMining = false;
  }
}

async function stopAll() {
  userWantsMining = false; pausedByVisibility = false;
  if (!state.dispatch('stop_clicked')) return;
  onStateChanged();
  await coord.stop();
  stats.stop();
  try { if (client.state === 'open') await client.stop(); } catch (e) { log('warn', `stop ack: ${e.message}`); }
  if (state.dispatch('workers_drained')) onStateChanged();
  render();
  log('ok', 'stopped — no hashing, upstream session closed');
}

function onStateChanged() {
  const s = state.state;
  const label = { idle: 'Idle', connecting: 'Connecting…', waiting_for_job: 'Waiting for job…', mining: pausedByVisibility ? 'Paused (tab hidden)' : 'Mining', stopping: 'Stopping…', stopped: 'Stopped', error: 'Error' }[s];
  const detail = {
    idle: 'Nothing is running. Mining starts only when you press Start.',
    connecting: 'Opening a private Stratum session through the bridge.',
    waiting_for_job: 'Session active; waiting for the node’s block template.',
    mining: pausedByVisibility ? 'Tab is hidden; hashing is paused (enable “keep hashing” to change this).' : 'Hashing genuine CKB work in Web Workers.',
    stopping: 'Draining workers and closing the upstream session.',
    stopped: 'Stopped. No residual work.',
    error: `Stopped: ${state.reason ?? 'error'}. Press Start to try again.`,
  }[s];
  $('state-label').textContent = label; $('state-label').dataset.state = s; $('state-detail').textContent = detail;
  $('btn-start').disabled = !(s === 'idle' || s === 'stopped' || s === 'error');
  $('btn-stop').disabled = !(s === 'connecting' || s === 'waiting_for_job' || s === 'mining');
  $('badge-backend').textContent = s === 'mining' && !pausedByVisibility ? `Backend: CPU-JS ×${coord.snapshot().workers}` : 'Backend: idle';
  if (s === 'mining' && !pausedByVisibility) coord.start(); else if (s !== 'mining') coord.stop();
}

// ── shares ──────────────────────────────────────────────────────────────────
function submitCandidate(c) {
  $('st-last-nonce').textContent = c.nonceHex;
  return client.submit(c).then((r) => {
    stats.recordShare(r.classification);
    const lvl = r.classification === 'block_candidate' ? 'gold' : r.accepted ? 'ok' : r.classification.startsWith('rejected') ? 'warn' : 'err';
    log(lvl, `share ${r.classification}${r.reason ? ` — ${r.reason}` : ''} nonce ${c.nonceHex.slice(0, 16)}… hash ${(r.hashHex ?? c.hashHex).slice(0, 12)}…`);
    renderShares();
  }, (e) => { stats.recordShare('upstream_error'); log('err', `submit failed: ${e.message}`); renderShares(); });
}
function renderShares() {
  const sh = stats.snapshot().shares;
  for (const li of $('share-counters').children) li.querySelector('b').textContent = String(sh[li.dataset.cls] ?? 0);
}

// ── settings ────────────────────────────────────────────────────────────────
$('workers').addEventListener('input', () => { syncOutputs(); savePrefs(); });
$('workers').addEventListener('change', async () => { await coord.setWorkerCount(Number($('workers').value)); if (state.state === 'mining') $('badge-backend').textContent = `Backend: CPU-JS ×${coord.snapshot().workers}`; });
$('intensity').addEventListener('input', () => { syncOutputs(); coord.setIntensity(Number($('intensity').value)); savePrefs(); });
$('keep-background').addEventListener('change', savePrefs);
function syncOutputs() { $('workers-out').textContent = $('workers').value; $('intensity-out').textContent = $('intensity').value; }

// ── visibility / unload policy ──────────────────────────────────────────────
document.addEventListener('visibilitychange', () => {
  if (state.state !== 'mining') return;
  if (document.hidden && !$('keep-background').checked) { pausedByVisibility = true; coord.stop(); log('info', 'tab hidden → hashing paused'); onStateChanged(); }
  else if (!document.hidden && pausedByVisibility) { pausedByVisibility = false; log('info', 'tab visible → hashing resumed'); onStateChanged(); }
});
window.addEventListener('pagehide', () => { coord.stop(); try { if (client.state === 'open') client.stop(); } catch { /* leaving */ } client.disconnect(); });

// ── render loop (1 Hz) ──────────────────────────────────────────────────────
setInterval(render, 1000);
setInterval(() => {
  const now = performance.now();
  const elapsedMs = Math.round(now - calibrationAt);
  if (state.state === 'mining' && !pausedByVisibility && calibrationHashes > 0 && elapsedMs >= 1000 && elapsedMs <= 60000) {
    client.calibrate(Math.min(2_000_000_000, Math.floor(calibrationHashes)), elapsedMs);
  }
  calibrationHashes = 0; calibrationAt = now;
}, 5000);
setInterval(async () => { if (client.state === 'open') { const t0 = performance.now(); try { await client.ping(); lastRttMs = performance.now() - t0; } catch { lastRttMs = null; } } }, 10000);
function render() {
  const s = stats.snapshot();
  const live = s.uptimeMs < 5000 ? s.rateOverall : s.rate5s;
  $('rate-live').textContent = state.state === 'mining' && !pausedByVisibility ? Math.round(live).toLocaleString('en-US') : '0';
  $('st-total').textContent = s.totalHashes.toLocaleString('en-US');
  $('st-5s').textContent = formatHashrate(s.rate5s); $('st-30s').textContent = formatHashrate(s.rate30s); $('st-peak').textContent = formatHashrate(s.peakRate);
  $('st-uptime').textContent = formatDuration(s.uptimeMs / 1000);
  $('st-best-hash').textContent = s.bestHashHex ?? '—';
  $('st-best-diff').textContent = s.bestHashHex ? s.bestDifficulty.toExponential(2) : '—';
  $('rtt').textContent = lastRttMs === null ? '—' : `${Math.round(lastRttMs)} ms`;
  if (s.lastJob) $('job-age').textContent = `${((Date.now() - s.lastJob.receivedAtMs) / 1000).toFixed(0)} s`;
  const job = client.currentJob;
  const rate = s.uptimeMs >= 30000 ? s.rate30s : s.rateOverall;
  const o = job ? oddsForTarget(job.networkTarget, rate) : null;
  $('odds-p').textContent = o ? formatProbability(o.pPerHash) : 'N/A';
  $('odds-mean').textContent = o ? formatDuration(o.meanSecondsPerBlock) : 'N/A';
  $('odds-hour').textContent = o ? formatProbability(o.pNextHour) : 'N/A';
  $('odds-day').textContent = o ? formatProbability(o.pNextDay) : 'N/A';
  $('odds-note').textContent = job?.networkTarget === null ? 'Network target unknown (pool mode): odds unavailable.' : 'Computed from the network target of the current job and your measured hash rate. This is a lottery.';
}

// ── log & diagnostics ───────────────────────────────────────────────────────
function log(level, text) {
  const entry = { t: Date.now(), level, text };
  logEntries.push(entry); if (logEntries.length > LOG_MAX) logEntries.shift();
  const li = document.createElement('li');
  const ts = document.createElement('span'); ts.className = 'ts'; ts.textContent = new Date(entry.t).toISOString().slice(11, 19);
  const msg = document.createElement('span'); msg.className = `lvl-${level}`; msg.textContent = text;
  li.append(ts, msg);
  const el = $('log'); el.append(li); while (el.children.length > LOG_MAX) el.firstChild.remove();
  el.scrollTop = el.scrollHeight;
}
$('btn-copy-addr').addEventListener('click', () => copyText($('payout-address').textContent, 'address copied'));
$('btn-copy-diag').addEventListener('click', () => {
  const redact = $('redact').checked;
  const red = (s) => (redact && typeof s === 'string' ? s.replace(/[0-9a-f]{16,}/gi, (m) => m.slice(0, 4) + '…') : s);
  const report = {
    app: { version: CONFIG.version, buildHash: CONFIG.buildHash, protocol: client.hello?.protocol ?? null, bridge: redact ? '[redacted]' : CONFIG.bridgeUrl },
    browser: { ua: navigator.userAgent, ...caps },
    state: { state: state.state, reason: state.reason, pausedByVisibility, coordinator: { ...coord.snapshot(), cursor: coord.snapshot().cursor.toString() } },
    stats: stats.snapshot(),
    session: redact ? '[redacted]' : client.hello?.sessionId ?? null,
    log: logEntries.map(e => ({ ...e, text: red(e.text) })),
  };
  copyText(JSON.stringify(report, null, 2), 'diagnostic report copied');
});
async function copyText(text, okMsg) { try { await navigator.clipboard.writeText(text); log('ok', okMsg); } catch { log('warn', 'clipboard unavailable — select the text manually'); } }

// ── helpers ─────────────────────────────────────────────────────────────────
function readConfig() {
  const el = document.getElementById('eagle-config');
  if (!el) throw new Error('miner build configuration missing');
  const config = JSON.parse(el.textContent);
  if (!config || typeof config !== 'object' || typeof config.bridgeUrl !== 'string' || !/^wss?:\/\//.test(config.bridgeUrl)) {
    throw new Error('miner bridge URL missing or invalid');
  }
  return config;
}
function createWorker() {
  const src = document.getElementById('cpu-worker-src')?.textContent ?? '';
  if (src.trim() && !src.includes('INLINE_WORKER')) {
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    const w = new Worker(url); setTimeout(() => URL.revokeObjectURL(url), 1000);
    return w;
  }
  return new Worker(new URL('../hash/cpu-worker.js', import.meta.url), { type: 'module' }); // unbuilt dev fallback
}
function waitForOpen(ms) {
  return new Promise((resolve, reject) => {
    if (client.state === 'open') return resolve();
    const timer = setTimeout(() => { off(); reject(new Error('bridge connection timeout')); }, ms);
    const off = client.on('hello', () => { clearTimeout(timer); off(); resolve(); });
  });
}
function loadPrefs() { try { const j = JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}'); return j && typeof j === 'object' ? j : {}; } catch { return {}; } }
function savePrefs() { try { localStorage.setItem(PREF_KEY, JSON.stringify({ workers: Number($('workers').value), intensity: Number($('intensity').value), keepBackground: $('keep-background').checked })); } catch { /* private mode */ } }
function setConn(text, cls) { const b = $('badge-conn'); b.textContent = text; b.className = `badge ${cls}`; }

log('info', `EagleSong WebMiner ${CONFIG.version} loaded — idle. Press Start to begin.`);
onStateChanged();
render();
