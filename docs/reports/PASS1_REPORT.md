# PASS 1 — end-to-end local CPU JS MVP — COMPLETION REPORT

Date: 2026-10-13. Node v22.22.0, Playwright 1.61.0 (Chromium 1228), esbuild 0.28.2. Host: i7-14700KF, Ubuntu (Linux 6.8).

## Gate

> One verified accepted low-difficulty share from browser on real solo proxy (or fully automated fake proxy for initial CI) and a clean Stop test; main-thread remains responsive.

**Met, on both:**

1. **Fake proxy (CI)** — `tests/e2e/browser-mining.test.js`: headless Chromium loads the built `dist/index.html`, presses Start, hashes genuinely, a share is recomputed by the bridge AND by the fake proxy → `local accepted`; a job change mid-batch binds nothing to the wrong job; Stop freezes the hash count and closes the upstream TCP session; reload stays Idle; closing the page releases the bridge session. Long-task probe: no main-thread task ≥ 100 ms. **2 pass / 0 fail** (`docs/reports/logs/e2e.log`).
2. **REAL, unmodified `solo-proxy.js`** — `tests/integration/real-proxy.test.js` (browser → bridge → real proxy → fake node):
   - operator copy `/home/phill/proxy-server @ ce1f7349`: 57 `share accepted (web-…)` lines in the proxy's own log, 4 `🎉 BLOCK SOLUTION`, `submit_block` called with `header.nonce=0x7f8ebc0a0000000000001c2c` → u128-LE `2c1c0000000000000abc8e7f00000000` → **Eaglesong meets the network target** (the submitted block carries the nonce that was actually solved). **1 pass** (`docs/reports/logs/real-proxy-operator-copy.log`).
   - GitHub main `vendor/ckb-stratum-proxy @ 027584a6`: 46 accepted shares, `submit_block` with `header.nonce=0x767300000000000047d135f100000000` → LE `00000000f135d1470000000000007376` → **does not meet the target**: pitfall 11 reproduced end to end from a browser. **1 pass** (the test asserts the bug for this checkout) (`docs/reports/logs/real-proxy-github-main.log`).

The CKB node in both real-proxy runs is a fake (`tests/helpers/fake-ckb-node.js`) serving a real mainnet block as a template with `compact_target 0x1f040000`; it accepts any `submit_block`. No claim of node acceptance is made — see `docs/LIVE_INTEROP_REPORT.md`.

## Files delivered (architecture: `docs/ARCHITECTURE.md`)

- `src/hash/` — `eaglesong-core.js` (Uint8Array sponge + precomputed first block), `eaglesong-constants.js` (generated from official `const_vars.rs`), `target.js`, `nonce.js` (raw/numeric/RPC nonce, BigInt range allocator), `mine-batch.js` (kernel), `cpu-worker-core.js` + `cpu-worker.js`.
- `src/bridge/` — `server.js` (ws, Origin allowlist, caps, `/healthz`), `session.js`, `ws-schema.js`, `protocol-adapter.js` (`solo-proxy-v1`), `stratum-tcp.js`, `job-registry.js`, `share-validator.js`, `config.js`.
- `src/ui/` — `index.html` (template), `styles.css`, `app.js`, `protocol-client.js`, `miner-coordinator.js`, `miner-state.js`, `mining-stats.js`, `odds.js`.
- `scripts/` — `build-single-file.mjs` (esbuild → one HTML, CSP), `dev-all.mjs` (`--fake-stratum`), `bench.mjs`, `demo-screenshot.mjs`, `gen-fixtures.mjs`, `pass0-capture-transcript.mjs`, `fetch-sources.sh`, `lib/static-server.mjs`.
- `tests/` — 14 unit files, `integration/` (2), `e2e/` (1), `helpers/` (fake stratum replaying the captured dialect, fake CKB node, real-proxy harness), `fixtures/`.
- `dist/index.html` — 99,635 bytes, self-contained, `sha256` shown in the page's diagnostics; CSP `default-src 'none'; connect-src <bridge>` (no CDN, no credentials, no internal hostnames).
- Docs: `README.md`, `AGENTS.md`, `docs/{ARCHITECTURE,PROTOCOL,SECURITY,TEST_PLAN,SOURCE_VERSIONS,LIVE_INTEROP_REPORT}.md`, `LICENSES/`, `config.example.json`.

## Architectural decisions

- Bridge recomputation is the acceptance authority; browser `hashHex` is diagnostic (`share-validator.js`). Classification order: stale → invalid (job/prefix) → duplicate → recompute → `block_candidate` / `share_ok` / `rejected_low_diff`; `share_ok`/`block_candidate` are forwarded exactly once; the upstream ACK becomes `local_accepted`; block candidates bypass the rate limit.
- Generations (bridge-assigned, monotonic) key all snapshots; a target-only change bumps the generation but the browser keeps its nonce cursor (`coordinator.test.js` test 4).
- Prefix = proxy extranonce1 zero-padded to 8 bytes (NerdMiner contract); the browser never chooses a prefix; the bridge rejects foreign prefixes.
- Worker protocol carries counters as decimal strings; BigInt everywhere else; the allocator truncates at 2^64 and the coordinator stops with `exhausted` (never wraps).
- Adaptive batches (~50 ms target), intensity as rest/duty cycle, watchdog replaces hung workers, hidden tab pauses by default, `pagehide` stops everything.

## How to launch from scratch

```bash
cd /home/phill/browser-miner/real-build
npm ci && npx playwright install chromium
npm test && npm run test:e2e && npm run test:integration
node scripts/dev-all.mjs --fake-stratum      # then open http://127.0.0.1:5173/index.html → Start
# with the real proxy: run solo-proxy.js on 127.0.0.1:3334, cp config.example.json config.json, npm run dev
```

## Tests run — exact results

| Suite | Result | Log |
|---|---|---|
| `npm test` (14 files: pass0 audit, hash vectors, target, nonce, mine-batch, protocol, share, stratum-tcp, session, bridge-server, ui-core, coordinator, protocol-client) | **171 pass / 0 fail / 0 cancelled** | `docs/reports/logs/unit.log` |
| `tests/integration/node-miner.test.js` | **4 pass / 0 fail** | `docs/reports/logs/integration-node-miner.log` |
| `tests/integration/real-proxy.test.js` (operator copy) | **1 pass** | `docs/reports/logs/real-proxy-operator-copy.log` |
| `tests/integration/real-proxy.test.js` (`SOLO_PROXY_DIR=vendor/ckb-stratum-proxy`) | **1 pass** (asserts the GitHub-main nonce bug) | `docs/reports/logs/real-proxy-github-main.log` |
| `tests/e2e/browser-mining.test.js` | **2 pass / 0 fail** | `docs/reports/logs/e2e.log` |
| existing proxy suites (unchanged code) | operator 56/56, GitHub main 44/44 | PASS 0 |

**Unrun / not applicable:** `npm run test:gpu` (no GPU backend yet — would skip), `wasm-parity`, `webgpu-parity`, `reconnect.test.js` as a separate file (reconnect behaviour is covered inside `protocol-client.test.js` tests 8–9 and `session.test.js` tests 11–12), Android device run.

## Sample sanitized share log (real operator proxy, from `real-proxy-operator-copy.log`)

```
[MINE ] #1 subscribed (ua=EagleWebMiner/1.0, session=…)
[MINE ] #1 authorized as web-c522dd
[MINE ] #1 share accepted (web-c522dd)           × 57
[MINE ] 🎉 BLOCK SOLUTION on job #1! Submitting…  × 4
submit_block header.nonce=0x7f8ebc0a0000000000001c2c → le=2c1c0000000000000abc8e7f00000000 meetsTarget=true
```
Browser-side classifications in the same run: `local_accepted` ≥ 1, `block_candidate` ≥ 1, `rejected_invalid` = 0. (The bridge rate limit of 600/min was hit in this run because at diff 1e-6 the browser produces far more shares than a vardiff would allow — exactly the PASS 2 work item.)

## Benchmark (reproducible, `npm run bench`, `docs/reports/bench-node-cpu-js.json`)

| Kernel | Threads | Platform | Measured |
|---|---|---|---|
| cpu-js (precomputed first block), Node v22.22.0 | 1 | linux x64, i7-14700KF | **602,008 H/s** over 5.017 s (3,020,000 hashes) |

Browser figure from the screenshot run (`scripts/demo-screenshot.mjs`, headless desktop Chromium 1228, 4 CPU-JS workers, measured from worker batch counts): **1.62 MH/s (5 s window), 23,504,822 hashes**, 217 `local_accepted`, 0 rejected — against the fake proxy. This is a desktop figure; no phone measurement is claimed.

## UI evidence

`docs/reports/screenshots/idle-mobile.png`, `mining-mobile.png`, `mining-desktop.png` (390×844 and 1280×900, headless Chromium, fake proxy). The page shows: state label with `data-state`, live H/s, read-only payout + "unverified (operator config)", job/height/generation, share counters by classification, odds with the lottery warning, live log, capabilities and build hash.

## Functional limitations / risks

1. **No real node yet.** `node_submitted`/`node_accepted`/`block_confirmed` are never emitted; `payout.verified` is false.
2. **Browser-class difficulty is not yet served by the proxy.** The unmodified proxy's `diffToTargetLE` collapses below ~1e-6 and throws at 4e-7; at 1e-6 a desktop browser floods ~hundreds of shares/s. PASS 2 adds an opt-in web profile and vardiff on measured hashrate.
3. Two findings in the unmodified proxy stand (duplicate shares re-accepted; unknown job blind-ACKed). The bridge compensates for its own sessions (dedupe, reject stale) but the proxy paths are untouched.
4. WASM/WebGPU are disabled options; pool mode is refused by config validation.
5. The e2e uses a mobile viewport in desktop Chromium; no physical Android run yet.

## Recommendation for PASS 2

- Add `webMiner` profile to the proxy behind a UA/config flag: exact BigInt share targets from measured hashrate (`targetForExpectedHashes(H*30)`), min/max clamps, dedupe set, no blind-ACK of unknown jobs; regression tests for GodMiner/NerdMiner paths first.
- Read the proxy stats endpoint (`payoutAddress`, `nodeHealthy`, `templateAge`) in the bridge → `payout.verified`, `status.nodeHealthy`.
- Live gate on a local `ckb 0.210.0` dev chain with `func = "Eaglesong"`: browser solves a real block, node accepts `submit_block`, verify header nonce and cellbase lock on chain.
