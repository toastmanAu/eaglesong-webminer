# EagleSong WebMiner — Detailed Coding-Agent Engineering Specification

**Spec version:** 1.0 — 2026-10-11  
**Status:** Ready for staged implementation; live interoperability and performance are not yet verified.  
**Project:** `eaglesong-webminer`  
**Goal:** A real, opt-in Nervos CKB Eaglesong browser lottery miner, mobile-first, with JavaScript CPU, WebAssembly CPU, and optional WebGPU backends; a secure WebSocket bridge; a proven CKB solo-node path; and eventually verified pool-relay mode.

> **Agent operating instruction:** Build executable, tested code; do not stop at mockups or scaffolding. Follow phases sequentially and require proof from automated tests plus real share logs. Do not claim that a local share is a pool share, or that an accepted pool share is a block. Do not make assumptions about Stratum field positions or byte order. Do not rewrite proven CKB block construction unless it fails an explicit integration test.

## 0. Reference material: inspect before coding

1. Browser UX reference: https://mine.solopool.com/miner.html (UX and feature reference **only**, not an asserted reusable codebase or license).
2. NerdMiner CKB (default branch `dev`): https://github.com/toastmanAu/NerdMiner_CKB
   - `src/eaglesong/eaglesong.cpp` / `.h`: reference C sponge implementation.
   - `src/mining.cpp`: mining work loop, nonce assembly, job change.
   - `src/stratum.cpp`: subscribe/notify/submit examples.
   - `LICENSE`: MIT attribution to Bitmaker; respect licensing for copied portions.
3. Existing Node.js proxy (default branch `main`): https://github.com/toastmanAu/ckb-stratum-proxy
   - `solo-proxy.js`: CKB node block template and `submit_block` path; per-job registry.
   - `proxy.js`: upstream pool relay (requires compatibility and accounting fixes).
   - `eaglesong.js`: JavaScript algorithm and **legacy comparison implementation that needs audit**.
   - `ckb-target.js`: consensus-correct BE-hash/LE-target comparison.
   - `job-registry.js`: bounded template snapshots and share validation.
   - `ckb-header.js`, `ckb-merkle.js`, `blake2b.js`: do not reproduce in browser; server owns template/header construction.
   - `test/*.test.js`: existing reference/regression fixtures.
   - `config.example.json`: presently tuned for high-throughput miners (`minDiff:1`, `initialDiff:7000`); **not** appropriate for browser hashes without a web profile.
   - `README.md` states MIT; repository currently has no separately detected LICENSE file. Preserve attribution and add a proper license file only in a repository you are authorized to edit.
4. Official reference algorithm: https://github.com/nervosnetwork/eaglesong (MIT; vectors at `src/test_vectors.txt`, Rust implementation at `src/lib.rs`).
5. Consensus specification: https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0027-block-structure/0027-block-structure.md
   - `pow_hash = ckbhash(molecule_serialize(raw_header))`.
   - `input = pow_hash[32] || nonce_u128_le[16]`.
   - `output = eaglesong(input)`.
   - **`from_be(output) <= compact_to_target(raw.compact_target)`**.
6. CKB repository / supported mainnet requirements: https://github.com/nervosnetwork/ckb
7. WebGPU availability: https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API ; https://developer.mozilla.org/en-US/docs/Web/API/WorkerNavigator/gpu . WebGPU is optional, requires secure context, and is not universally available.

**Source freeze:** At the beginning of implementation, record exact commit SHAs from all dependencies in `docs/SOURCE_VERSIONS.md`. The tree snapshots inspected during planning were NerdMiner_CKB `dev` tree `cc6d2fee5b7981d1adab5ce32d86e6073c6408ad` and ckb-stratum-proxy `main` tree `027584a65202ee8b8d58509da90096867bb885ca`; these are **tree hashes, not commit SHAs**.

## 1. Functional/nonfunctional contract

### MVP must
- Present a usable portrait-first web interface in a browser, without installing native software.
- Remain **stopped** until the user explicitly presses Start. Stopping, navigating away, and page termination must cease local hashing; no covert mining.
- Connect via WSS (or `ws://localhost` for development) to a trusted **Node.js browser bridge**, which communicates with an existing localhost-only TCP Stratum solo proxy.
- Receive genuine CKB work from the connected CKB node (`get_block_template` via `solo-proxy.js`).
- Produce genuine Eaglesong hashes over the exact 48-byte CKB PoW message, search unique nonce ranges, test against assigned local share target, submit full 16-byte nonces, and show verified local share acceptance/rejection.
- Independently revalidate every submitted share on the server. Detect and submit network-target solutions using the exact original template; never treat a mock solution as a mainnet block.
- Report honest measured hash count/rate and separate **local accepted**, **upstream accepted**, **rejected**, **stale**, **block candidate**, **node-submitted**, **node-accepted**, and **confirmed** states.
- Support JavaScript CPU Worker backend and fallback. Compile a WASM backend next. Implement optional WebGPU only after CPU end-to-end works.
- Run unattended only while the user explicitly keeps the mining session active; respond to browser/device throttling or suspension with truthful telemetry.
- Build the browser frontend to one self-contained `dist/index.html` with inline JS/CSS/Worker/WGSL and (if practical) inlined WASM, with **no third-party runtime CDN**. Developer source files may be modular.

### Non-goals for MVP
- No standalone browser connection to raw TCP Stratum. A bridge/server is required.
- No arbitrary public user-supplied RPC, Stratum host, or bridge host. Upstreams are server-operator allowlisted.
- No individual payouts to arbitrary browser-entered CKB addresses. Solo rewards currently go to the configured node block-assembler address; pool rewards follow configured pool accounts. Display the true payout destination from trusted server config.
- No forced background mining, push-service-worker mining, persistent stealth mining, hardware overclocking, wallets/private keys, mining rewards promises, or automatic endpoint discovery.
- No assertion that SoloPool source code can legally be reused. Re-create its general UX independently.

### Quality bars
- Functional in current desktop Chromium and modern Android Chrome/Edge, with graceful fallback for missing GPU/WASM features.
- Never exceed 100ms main-thread blocking during mining. UI updates at ~1 Hz or throttled appropriately.
- Handle disconnects, no jobs, invalid targets, malformed hex, oversized JSON, device-loss, worker crashes, zero workers, duplicate shares, exhausted nonce ranges, and rapid job churn.
- All hashing outputs cross-checked against an independent official Eaglesong implementation and at least two CKB 48-byte inputs, not merely against the same port twice.

## 2. System design and trust boundaries

```
Browser (static index.html)         Server (Node.js, private LAN)
  UI + controls
  Miner coordinator
  JS/WASM CPU Web Workers  \
  optional WebGPU worker   ----->  WSS bridge :8787
  per-session statistics   <-----     |  authenticated/allowlisted Origin
                                    one private TCP Stratum session per browser
                                             |
                                   127.0.0.1:3333
                                             |
                                ckb-stratum-proxy
                                solo-proxy.js (MVP)
                                    /          \
                              RPC :8114   WS :28114
                                      CKB node

Pool phase: bridge --> separately configured relay `proxy.js` --> verified external pool.
```

**Bridge responsibilities:** WebSocket lifecycle, authentication/origin checks (if deployed publicly), one private TCP Stratum socket per browser session, protocol negotiation/normalization, payout identity, target conversions, unique session/nonce allocation, validating limits, request-response mapping, share feedback, rate limiting, telemetry. Do not leak node RPC methods, internal credentials, or raw TCP endpoint selection to the browser.

**Browser responsibilities:** controlled hash execution, per-job epoch cancellation, local prefiltering, independent candidate verification, measured hash counts, UI/rendering/odds, and explicit start/stop. Browser result is never trusted without server-side verification.

**Proxy responsibilities:** upstream/downstream Stratum and actual node template/submission mechanics; maintain existing ASIC behavior. Changes to the proxy must have regressions demonstrating no breakage for K7/GodMiner and Goldshell/NerdMiner paths.

For MVP, prefer running bridge and solo proxy as separate processes. Allow docker compose or one `npm run dev:all` helper. Configuration must bind internal Stratum and CKB RPC to `127.0.0.1`, not `0.0.0.0`.

## 3. Canonical cryptographic and job model

### Hash function and buffers

```
powHash32 = HEX_DECODE(job.powHashHex)                  // 32 raw bytes; preserve order
nonce16  = 8-byte little-endian uint64 counter || 8-byte session prefix
input48  = powHash32 || nonce16
hash32   = EAGLESONG(input48)
hashValue = parse_u256_big_endian(hash32)
shareOK   = hashValue <= shareTargetBigInt
blockOK   = networkTargetKnown && hashValue <= networkTargetBigInt
```

The 128-bit nonce is a **single integer serialized little-endian for CKB consensus**, represented here as lower eight counter bytes and upper eight prefix bytes. Do not confuse `nonce16` raw hex for the textual `0x`-prefixed numeric nonce used in node JSON RPC `submit_block`. **Critical conversion before `submit_block`:** current `solo-proxy.js/submitBlock` appears to construct the RPC nonce as `'0x' + noncePadded`, treating the 32 hex characters of the *raw nonce bytes* as though they are already a numeric, big-endian u128 string. Because the header Molecule codec writes the numeric u128 **little-endian**, this can serialize a different nonce from the one that was hashed. The agent MUST audit this and, for the browser profile, convert `rawNonceLE` to `numericRpcNonceHex = '0x' + reverseBytes(rawNonceLE).toString('hex')`, then prove `serialize_u128_le(BigInt(numericRpcNonceHex)) === rawNonceLE`. Do not blindly alter existing ASIC code paths until their nonce conventions are recorded and tested. This is a possible **block-losing bug**, not cosmetic.

Do **not** copy misleading comments suggesting the Eaglesong output is interpreted as LE. The official RFC requires numeric **BE interpretation** of the raw hash. The proxy's `ckb-target.js/meetsTargetLE` correctly compares hash bytes `0..31` against the stored little-endian target bytes `31..0`. A legacy `eaglesong.js/meetsTarget` comparison works byte-reversed and must not be used for consensus validation.

### Network/share target representations
- Internally normalize all numeric targets to `targetBE` (a canonical 64-character hexadecimal big-endian encoding) or `BigInt`.
- At a known Stratum wire boundary, explicitly decode the source-defined `targetLE` (reverse 32 bytes) or `targetBE` (as-is). No heuristics from target shape alone.
- `compact_target` is converted on the server using CKB compact target semantics, bounded to `[0, 2^256-1]`. Keep exact arithmetic with `BigInt`.
- `shareTarget` must be kept distinct from `networkTarget`. In solo mode the proxy's job notify carries the network target; `mining.set_target` may carry easier variable share target. In pool relay mode a target from the pool is usually **not** the true network target; when no trusted network target is known, display network odds as unavailable.
- CKB reference diff1 target in current proxy = `2^224` (expected `2^32` hashes per diff1 share). Use for informational shares only; difficulty semantics remain implementation-specific across pools.

### Reference vectors
- Official empty-input Eaglesong: `9e4452fc7aed93d7240b7b55263792befd1be09252b456401122ba71a56f62a0`.
- Official `34 ASCII '1' bytes plus newline` Eaglesong: `a50a3310f78cbaeadcffe2d46262119eeeda9d6568b4df1b636399742c867aca`.
- Generate and check independently two fixed 48-byte CKB PoW inputs with known nonzero higher/lower nonce bytes and nonzero pow hash. Save JSON fixtures and SHA256 of fixture source (for reproducibility).
- For hash/target comparison, test zero vs max, equality, MSB-only hash `ff00...00` vs target `2^200`, LSB-only hash `00...ff` vs target `2^200`, and targets encoded in opposite endianness (must fail).

### Nonce allocation
- Implement one **central nonce-range allocator** in the browser coordinator. Every worker/device gets disjoint `[start, start+count)` lower-64-bit ranges for the same session prefix and job generation.
- Use `BigInt` on JS coordinator; do not cast counters above `2^53-1` through Number. In WASM use `uint64_t`. In portable WGSL split 64-bit counter into two `u32` words, explicitly handling carry.
- On connection/reconnection, bridge assigns a new unique 8-byte prefix per miner identity/session (integrated with actual proxy subscribe/extranonce semantics). **Do not invent a prefix that collides with pool/proxy nonce allocation.** The bridge may normalize a server-assigned shorter prefix with zero padding only after verifying nonce contract.
- On job `generation` change, workers stop at next bounded batch boundary and discard unrelated old work. If only the share target changes while `pow_hash` and nonce prefix remain fixed, **continue from the next untested nonce counter**, not from zero; do not repeat work. Valid network-target solutions for recently superseded jobs should still be forwarded and independently checked against server-preserved job snapshots (not discarded because another job arrived).
- If lower-64 counter reaches `2^64`, ask bridge for a fresh prefix or fail closed; never wrap and repeat work.
- Handle `clean_jobs` according to protocol policy; all outstanding work is invalidated on an actual clean job. Do not rely on `job_id` alone if a server reuses it; use a local generation counter.

## 4. Wire protocol contracts

### A. Browser <-> bridge (WebSocket, JSON, version 1)

All messages have a string `type`, integer `v:1`, `sessionId` when assigned, and optional unique `requestId`. Enforce max inbound JSON frame 16 KB, strict schemas, normalized lowercase hex, bounds and no additional dangerous control fields. Never allow URL/host/port selection in a browser JSON message. Examples below are illustrative rather than a locked final serialization; implement shared Zod/JSON-schema or explicit validators.

**Client -> bridge**

```json
{"v":1,"type":"hello","client":"EagleWebMiner/1.0","capabilities":["cpu-js","cpu-wasm","webgpu"]}
{"v":1,"type":"start","requestId":"start-1","workerLabel":"web-01"}
{"v":1,"type":"submit","requestId":"share-42","jobId":"a1","generation":7,"nonceHex":"01000000000000001122334400000000","hashHex":"...64 lowercase hex chars..."}
{"v":1,"type":"stop","requestId":"stop-1"}
{"v":1,"type":"ping","requestId":"ping-1"}
```

`hashHex` is diagnostic only, never authoritative. Don't make acceptance depend on the browser's asserted hash. The bridge or proxy computes it.

**Bridge -> client**

```json
{"v":1,"type":"hello","sessionId":"random-opaque-id","mode":"solo","payout":{"kind":"node_block_assembler","address":"ckb1...","verified":true},"protocol":"ckb-128nonce-v1"}
{"v":1,"type":"target","generation":7,"shareTargetBE":"...64 hex characters...","networkTargetBE":"...64 hex characters or null...","shareDifficulty":"0.00008"}
{"v":1,"type":"job","jobId":"a1","generation":7,"powHashHex":"...64 hex characters...","height":12345678,"cleanJobs":true,"prefix8Hex":"1122334400000000","shareTargetBE":"...64 hex characters...","networkTargetBE":"...64 hex characters or null...","issuedAt":1770000000000}
{"v":1,"type":"share_result","requestId":"share-42","classification":"local_accepted","accepted":true,"reason":null}
{"v":1,"type":"status","connected":true,"nodeHealthy":true,"jobAgeMs":500,"payoutVerified":true}
{"v":1,"type":"error","code":"INVALID_NONCE","message":"..."}
```

`generation` is a **bridge-assigned monotonically increasing session-local integer** incremented on changes to powHash, nonce prefix, or any target. A target-only update may keep powHash but must bump generation and cancel/reconfigure hashing, not silently use a mismatched share target. Include a `jobKey` or mapping (`jobId`, `generation`) server-side so late shares are evaluated against the target state in effect when computed.

Error/response classifications (distinct): `local_accepted`, `upstream_accepted`, `rejected_low_diff`, `rejected_duplicate`, `rejected_stale`, `rejected_invalid`, `block_candidate`, `node_submitted`, `node_accepted`, `block_confirmed`, `upstream_error`. A share ACK and a node accepting a block are separate states; confirmation requires explicit chain verification.

**WS flow:** browser connects -> bridge validates Origin/auth -> creates TCP session -> subscribes/authenticates as dedicated `EagleWebMiner/1.0` miner -> receives target/job -> forwards normalized job to browser only when requested Start is active -> browser hashes -> submit -> bridge validates, correlates submission ID and forwards once -> result/timeout. WS close tears down miner TCP socket and all allocations. Reconnect creates fresh prefix and generation; previous session nonce must not be reused.

### B. Bridge <-> solo proxy (real TCP Stratum)

Current `solo-proxy.js` has these concrete behaviors:
- Non-GodMiner `mining.subscribe` uses a nested response containing session ID and extranonce2 size; GodMiner uses a simple tuple. Handle either response shape explicitly; browser UA must use the non-GodMiner path unless adding an independently tested web profile.
- Solo non-GodMiner notify is **five** fields: `[job_id, pow_hash_hex, height, network_target_le_hex, clean_jobs]`.
- The NerdMiner `stratum.cpp` reference describes a **four** field notify: `[job_id, pow_hash_hex, target_hex, clean_jobs]`.
- Non-GodMiner `mining.set_target` from solo proxy uses LE wire format; GodMiner targets are BE.
- Non-GodMiner solo proxy `mining.submit` accepts a full 16-byte nonce (32 hex characters) in a three-field list `[worker, job_id, nonce_hex]` (it uses the LAST parameter to find nonce).

Use separate parsers pinned to known upstream profiles, e.g. `solo-proxy-v1`, `nerdminer-v1`, `godminer-v1`, `pool-relay-v1`. Reject unknown shapes with actionable logs. Keep reference fixtures capturing the **real traffic** from localhost TCP proxy. Do not alter K7 code paths without regression tests.

**CRITICAL: submit nonce as 32 hex chars containing the same 16 bytes hashed** across browser -> bridge -> Stratum. On the `submit_block` path only, translate from raw little-endian nonce bytes to the numeric u128 RPC string exactly once and test the reverse conversion via Molecule serialization. Never replace the full nonce with the 64-bit counter or reverse bytes twice. Current `solo-proxy.js` code likely lacks this conversion; prove or disprove with a test before trusting block submission.

### C. Pool relay — phase gated

`proxy.js` currently originates an upstream single pool account, uses Bitcoin-style five-field forwarding `[worker,jobId,en2,ntime,nonce]` but also handles CKB 16-byte nonce, and changes extranonce allocation per miner. **Do not claim pool interoperability without capturing and verifying the target pool's actual subscribe/notify/submit schema, extranonce contract, difficulty/target endianness, and accepted share response**. Use real upstream pool account configuration; avoid arbitrary browser payout entry.

Existing code incorrectly increments `totals.blocksFound` upon *every upstream accepted share*. Replace with separate counters, and never infer a discovered block from `mining.submit` ACK alone. Existing proxy also allows certain local-only shares to receive `result:true`; surface those as `local_accepted`, not `upstream_accepted`.

## 5. Server modifications and browser-class low difficulty

The example config currently uses `minDiff:1`, `initialDiff:7000`, which yields impractically sparse browser shares. Create an opt-in `webMiner` profile that preserves existing ASIC default behavior.

- Suggested share interval: ~15–60s after calibration; start at ~30s.
- Initial target estimated using measured hashes per second: expected hashes for 30s ≈ `max(1, H*30)`; desired target approximately `floor((2^256-1)/expectedHashes)`, clamped to max.
- If retaining difficulty-based vardiff, `diff ≈ H*30/2^32`. For H=1,000 H/s this is around `0.00000698`; for H=100 H/s around `0.000000698`.
- **Fix precision**: existing `ckb-target.js/diffToTargetLE` rounds difficulty to six decimal places, which collapses difficulties < ~5e-7 to zero and can divide by zero. Use exact target-based calculations where possible, or higher-precision fixed-point BigInt with explicit nonzero guards. Zero, negative, NaN and infinite difficulty must reject, not silently produce a target.
- Update vardiff based on *observed valid locally verified shares or accurately measured hash counts* with server-imposed min/max; do not trust unbounded client-reported hashrate to set share acceptance unconditionally.
- Low-difficulty shares are **diagnostic/local shares**. Make zero guarantees that they satisfy an external pool's minimum payout/share threshold.
- Duplicate share set keyed by `{jobId, fullNonceHex}` and bounded recent-job registry. Enforce replay protection and submit rate limits without risking loss of rare genuine network solutions.
- Ensure all network-target candidates are evaluated against the job's exact captured network target and template, even if local share vardiff was concurrently changed. Keep bounded old jobs for grace period.

**Configuration example:**

```json
{
  "bridge": {
    "listenHost": "127.0.0.1",
    "port": 8787,
    "allowedOrigins": ["http://localhost:5173", "https://miner.example.org"],
    "maxConnections": 50,
    "maxInboundFrameBytes": 16384,
    "perSessionSubmissionsPerMinute": 120
  },
  "stratum": { "host": "127.0.0.1", "port": 3333, "profile": "solo-proxy-v1" },
  "mining": { "mode": "solo", "targetShareSeconds": 30, "webProfileEnabled": true },
  "payout": { "displayConfiguredAddressOnly": true }
}
```

The actual config should be schema-validated and loaded only on the server. Bind localhost by default; for public WSS use a secure reverse proxy/tunnel with origin/auth policy, rate limiting, and connection quotas. Do not put pool credentials in the browser or `dist/index.html`.

## 6. Frontend and backend module contracts

Recommended source tree:

```
eaglesong-webminer/
├── package.json                    # Node >=20; scripts below
├── package-lock.json
├── AGENTS.md                        # operational instructions and milestones
├── LICENSES/                       # third-party notices / required MIT attribution
├── config.example.json
├── docs/
│   ├── ARCHITECTURE.md
│   ├── PROTOCOL.md
│   ├── SECURITY.md
│   ├── SOURCE_VERSIONS.md
│   ├── TEST_PLAN.md
│   └── LIVE_INTEROP_REPORT.md
├── src/
│   ├── ui/
│   │   ├── index.html
│   │   ├── app.js                    # state + DOM rendering
│   │   ├── styles.css
│   │   ├── protocol-client.js
│   │   ├── miner-coordinator.js      # nonce allocator, backend lifecycle
│   │   ├── miner-state.js
│   │   ├── mining-stats.js
│   │   └── odds.js
│   ├── hash/
│   │   ├── eaglesong-core.js         # Uint8Array only; no Node Buffer
│   │   ├── target.js                 # explicit BE/LE conversions
│   │   ├── nonce.js                  # LE u128; BigInt range math
│   │   ├── cpu-worker.js
│   │   ├── wasm-worker.js
│   │   ├── eaglesong-wasm.c          # portable extraction of C source
│   │   ├── gpu-worker.js
│   │   └── eaglesong.wgsl
│   └── bridge/
│       ├── server.js
│       ├── config.js
│       ├── session.js
│       ├── stratum-tcp.js
│       ├── protocol-adapter.js
│       ├── share-validator.js
│       ├── job-registry.js
│       └── stats.js
├── scripts/
│   ├── build-single-file.mjs
│   ├── build-wasm.sh
│   ├── dev-all.mjs
│   └── bench.mjs
├── tests/
│   ├── fixtures/
│   │   ├── eaglesong-vectors.json
│   │   ├── ckb-pow48-vectors.json
│   │   └── stratum-transcripts/
│   ├── hash-vectors.test.js
│   ├── target.test.js
│   ├── nonce.test.js
│   ├── protocol.test.js
│   ├── share.test.js
│   ├── range-allocation.test.js
│   ├── job-churn.test.js
│   ├── reconnect.test.js
│   ├── wasm-parity.test.js
│   ├── webgpu-parity.test.js
│   └── integration.test.js
└── dist/
    └── index.html                 # single-file output, not hand-edited
```

### Interface contracts (TypeScript type notation allowed even in JS implementation)

```ts
type NormalizedJob = {
  jobId: string;
  generation: number;
  powHash: Uint8Array;       // exactly 32 bytes
  prefix8: Uint8Array;       // exactly 8 bytes; server-provisioned
  shareTarget: bigint;       // canonical numeric U256
  networkTarget: bigint | null;
  cleanJobs: boolean;
  height: number | null;
  receivedAtMs: number;
};

type NonceRange = {
  generation: number;
  firstLo: bigint;           // 0..2^64-1
  count: number;             // bounded batch count
};

type HashBackend = {
  init(): Promise<void>;
  selftest(): Promise<boolean>;
  startJob(job: NormalizedJob): Promise<void>;
  mine(range: NonceRange): Promise<{ hashes: number; candidates: Candidate[] }>;
  cancel(generation: number): Promise<void>;
  dispose(): Promise<void>;
};

type Candidate = {
  generation: number;
  jobId: string;
  nonceHex: string;          // 16 hashed nonce bytes, as 32 hex chars
  hashHex: string;           // 32 raw digest bytes, as 64 hex chars
};
```

No large arrays of per-hash hashes should cross worker/message boundaries. Batch completion returns counts and rare candidates only. A bounded diagnostic sample may report 'best hash' without transferring every output.

### CPU JavaScript backend
- Port existing `eaglesong.js` from Node `Buffer` to `Uint8Array` with typed-array reuse and minimal allocation.
- Fixed 512-bit state (`16 * u32`), 256-bit rate, 43 rounds, delimiter `0x06`, 32-byte output.
- Use `Worker` and adjustable worker count from 1 to conservative limit (`min(hardwareConcurrency-1, 8)` on desktop; lower default on phones), adjustable intensity 0–100% implemented via yield/rest periods, not wasteful busy loops.
- Batch duration measured and adaptive (~25–100ms); frequent job/stop checks, worker watchdog, rolling 5s/30s/overall H/s.
- Worker coordination and start/stop state machine: `idle -> connecting -> waiting_for_job -> mining -> stopping -> stopped`, with error/reconnect branches. Never show Mining merely because WebSocket is connected.

### WASM backend
- Extract algorithm into portable C functions without ESP/FreeRTOS/IRAM_ATTR Arduino dependencies.
- Compile via Emscripten or clang/wasm32 with documented reproducible script. Prefer a tiny C interface taking a 32-byte pow_hash, nonce prefix and 64-bit low nonce and output buffer; expose batch hashing entrypoint if crossing boundary per nonce is costly.
- Implement C fixed-state precomputation for the first 32-byte absorption. Because 48-byte input spans two 32-byte rate blocks, reconstruct the second block with `nonce16`, delimiter at offset 16, and exact reference padding. Prove equality against unoptimized reference for all test vectors.
- Run WASM in Worker; no WASM work on main thread. Benchmark JS versus WASM with same device, same test and actual hash count; no assumed speedup claims.

### WebGPU backend
- Optional; use feature detection `navigator.gpu` or `WorkerNavigator.gpu` and `requestAdapter`/`requestDevice`. HTTPS in production; catch device loss and fail over to WASM.
- WGSL shader implements EXACT Eaglesong rounds, wrapping `u32` arithmetic, rotations, coefficient injection, two-rate-block absorption, 32-byte output, BE hash/target compare.
- Use fixed-state first-block precomputation supplied via uniform/storage buffer, after independent reference parity tests.
- Every invocation gets a unique nonce computed from `{baseLoHi, baseLoLow, invocationIndex}` with carry; never rely on WGSL portable `u64`.
- GPU dispatch bounded and dynamically calibrated (target <= ~100ms, device-specific). Size buffers conservatively. Expose a small atomic candidate queue with overflow marker. On overflow, retry smaller ranges or replay on CPU; **do not silently discard possible block candidates**.
- Validate each returned candidate again via CPU/WASM before sending to server. Periodically run sampled GPU-vs-CPU parity checks during operation and switch backend off on mismatch.
- GPU power/intensity throttle: dispatch duty cycle, not shader busy-wait. Default GPU off on mobile unless explicitly enabled.

## 7. UI / interaction specification

### Layout (mobile portrait first, single viewport friendly)
1. Header: EagleSong WebMiner / CKB, backend status, connected indicator, clearly labeled `Solo` or `Pool`, support/help.
2. Payout: **server-confirmed address and attribution**; read-only until per-user routing genuinely supported. Copy button + link to explorer if chain confirmed. Do not present a writable address as effective payout control.
3. Connect/status: WSS endpoint label (operator-configured), node status, height, job ID, job age, RTT, current share difficulty.
4. Mining control: one explicit **Start Mining**, **Stop Mining**, safe restart, CPU workers/intensity slider, GPU enable/intensity slider, backend auto/manual selector, on-device warning.
5. Stats: total measured hashes, live H/s and each CPU/GPU component, peak H/s, uptime, last nonce/job, best hash/difficulty, shares by category, actual upstream ACKs and rejection reasons.
6. Odds: network target from trusted node -> probability per hash `p = (target+1)/2^256`, mean block interval `1/(H*p)`, chance next day `-expm1(-H*p*86400)`; use `Number(BigInt)` approximation only for display. When target unknown, display N/A. Show prominently: browser mining is a lottery and unlikely to earn a block.
7. Live log: timestamped normalized events (last 250 in-memory); copy diagnostic report button with optional redaction of user IDs/IP/addresses.
8. Capability/diagnostics: JS/WASM/GPU support matrix, fallback reason, reference vector self-test results, benchmark results.

**UX properties:** dark low-contrast Nervos-inspired aesthetic, accessible text, large touch targets, responsive tablet/desktop, no animated rendering competing with hashing, reduced-motion compliance, distinct badges only for genuinely meaningful state. Use semantic HTML and ARIA. Errors should be actionable. Remember only safe UI preferences in localStorage (not keys or credentials); do not auto-start on reload.

**Visibility policy:** mobile browsers may throttle or stop background tabs. On `visibilitychange`, reduce intensity or pause by default; provide clear UI reflecting actual hashing. Never bypass user/OS resource controls.

## 8. Security, correctness and deployment

- Public-facing WebSocket bridge requires HTTPS/WSS, strict Origin allowlist, client/session auth or invite tokens as appropriate, bounded sessions/IP, heartbeat timeouts, maximal buffer sizes, schema validation, and log redaction. Browser-level origin checks alone do not substitute for authentication/rate limits.
- No arbitrary downstream-target host/port from user input; guards against internal-network access, SSRF, or unauthorized CKB node methods.
- Restrict node RPC to loopback/private network; never expose `get_block_template` or `submit_block` RPC directly to the web client.
- Run Node bridge as an unprivileged process, optionally behind reverse proxy/Cloudflare Tunnel; front-end static hosting on Cloudflare Pages is okay but Pages alone cannot replace the long-lived TCP Stratum server.
- `dist/index.html` contains no pool credentials, private keys, API secrets, mining-account passwords, or internal network hostnames.
- Deduplicate nonces/job submissions; require valid worker/session, full 16-byte nonce, hex length, target, generation and job snapshot; do not trust claimed browser hash or difficulty.
- Fail closed for malformed targets, unknown source profile, inconsistent job formats, non-unique prefix, source mismatches, and GPU vector test failures.
- Show version/hash of loaded code and normalized protocol version in diagnostic report.
- Preserve MIT notices from original NerdMiner implementation and official Eaglesong, and attribute the previous proxy implementation; do not copy SoloPool page source without checking its license.

## 9. Build scripts, documentation and operator setup

Implement these commands in root `package.json` (or equivalent documented scripts):

```
npm ci
npm run dev             # frontend localhost dev server + bridge if appropriate
npm run bridge          # start WebSocket bridge alone
npm run build           # fully self-contained dist/index.html
npm run test            # fast deterministic Node/unit tests
npm run test:integration # fixture TCP Stratum server, WS bridge, browser miner
npm run test:e2e        # headless browser UI / session lifecycle
npm run test:gpu        # optional WebGPU hardware, skip cleanly if unavailable
npm run bench           # reproducible JSON/CSV hash benchmarking
```

Documentation must include copy/paste setup for Ubuntu 22.04+ and Windows 11; Node v20+; optional clang/Emscripten; local full CKB node prerequisites and block assembler payout configuration. Ensure no real-mainnet network step is required to run unit tests. Include `.env.example`/`config.example.json`, `README.md`, `SECURITY.md`, `docs/LIVE_INTEROP_REPORT.md`, and recorded command output from final tests. Do not invent live performance measurements.

**Deployment A, private local:** local node & proxy at loopback, bridge at `127.0.0.1:8787`, frontend served locally; HTTP+WS localhost acceptable for dev.

**Deployment B, public site:** static `index.html` on Cloudflare Pages; WSS on dedicated Node host behind HTTPS reverse proxy/tunnel; authentication quotas and server-specific payout display. If user-specific payouts are not implemented, UI must say the rewards go to the operator's configured payout address.

## 10. Tests, acceptance criteria and proof

### Unit and property-based tests (mandatory)
- Official empty and ASCII vectors; two independent CKB 48-byte vectors. Ensure JS, native C/WASM, and WGSL (where supported) produce exact 32-byte digests.
- Target BE-vs-LE adversarial vectors, U256 equality edge, full FF hash/target, compact-target boundaries and invalid difficulty.
- `nonce 0, 1, 2^32-1, 2^32, 2^64-1` and random deterministic values; nonce high prefix varied. Validate parsed full little-endian u128 and text RPC conversion. **Mandatory independent byte-reversal regression:** raw hex `01000000000000001122334400000000` should yield numeric RPC nonce `0x00000000443322110000000000000001`, and Molecule `u128-le` serialization of that numeric value must restore exactly the original 16 raw bytes.
- Non-overlap of >1 million nonce assignments across 1..16 workers and separate GPUs; carry boundaries; reconnect resets prefix; **target-only update retains the next nonce offset** and does not repeat prior work.
- Four/five field notify, nested/simple subscribe, target encoding profiles, 3/5 field submits as actually supported. Invalid upstream shapes fail closed with explanatory log.
- Duplicate, stale job, template rollover, local share only, upstream-accepted, upstream-rejected, network-target candidate, unknown job, node RPC outage/retry. An unknown job cannot be counted as accepted without validation.
- Browser foreground/background, start/stop/restart, socket loss, worker crash, GPU device loss, no WebGPU, zero CPU cores reported, websocket status out of order.
- Ensure at least one browser share test uses a deterministic easy share target and is validated **by server recomputation of Eaglesong**; do not fake result after UI increment.
- Random fuzz samples for malformed hex and incorrect target lengths; client frame size limits.

### Deterministic integration fixture
1. Start a fake TCP Stratum proxy responding with a *recorded realistic* subscribe/auth, notify, `mining.set_target`, and low share difficulty.
2. Start WebSocket bridge.
3. Load built `dist/index.html` in Playwright/Chromium, press Start, assert actual hashes increase.
4. Fixture sends work that produces a verified share in bounded time (e.g. deliberately permissive target, capped to allow rendering and validation); bridge verifies hash independently and returns `local_accepted`.
5. Issue new job mid-batch; verify no submission incorrectly bound to another job.
6. Reject a deliberately malformed/replayed nonce; verify correct rejection and no false successes.
7. Press Stop; confirm no further new nonce allocations/hashes; close page; confirm socket/resources close.

### Live solo integration gate
- Bring up an actual CKB node with verified block assembler, plus the **unmodified** solo proxy first; verify it has a recent template and reports correct configured reward address.
- Connect bridge as a web browser client. Capture sanitized TCP/WSS transcripts; prove actual subscribe, authorize, target, notify, low-difficulty local accepted share flow. Do not require finding a mainnet block.
- If using a controlled dev chain with easy target, submit and confirm an actual accepted block and verify the block nonce/header and reward destination. Distinguish submission ACK from block canonicality confirmation.
- Compare CPU backend hash to server's independent reference for the actual submitted nonce.

### GPU release gate
- WebGPU computes exactly the same digest on at least 10,000 deterministic 48-byte PoW vectors (host-side checking batches), including carries and random prefixes; no duplicate nonces over 1M combined assignments.
- No device-loss crash, no missed candidates due to output overflow, no UI hangs. Benchmark in desktop and Android devices; provide exact browser/device versions, hash rates, temperature/thermal observations if available, power caveats. Do not set a fabricated H/s threshold.

### Pool release gate
- Captured live subscribe/auth/notify/submit and ACK from the specific target pool, validated extranonce and full nonce, independently verified share target, and credited worker payout/account identity.
- Never label a pool accepted share as a block. No public arbitrary-address feature until attributable per-user pool payout actually works.

## 11. Execution phases and stop/go gates

### PASS 0 — source audit + reproducible baseline
Deliver `docs/SOURCE_VERSIONS.md`, `docs/PROTOCOL.md`, exact wire fixtures from existing code, unit test reproducing legacy eaglesong comparison error, and clean output of existing proxy tests (`npm test`). Identify any existing regressions without silently rewriting ASIC code.

**Gate:** All canonical endian/target/nonce decisions justified with unit tests, including the raw-LE nonce to numeric RPC conversion; source compatibility map completed.

### PASS 1 — end-to-end local CPU JS MVP
Deliver bridge, versioned WSS messages, UI, `Uint8Array` Eaglesong, nonce allocator, worker lifecycle, diagnostic share classification, fake TCP fixture, and local solo connection.

**Gate:** One verified accepted low-difficulty share from browser on real solo proxy (or fully automated fake proxy for initial CI) and a clean Stop test; main-thread remains responsive.

### PASS 2 — browser share profile, server correctness, and live solo
Deliver vardiff precision fix / per-web profile, improved share accounting and reject reason, historical job handling, secure configs, source-backed payout address display, actual CKB node live transcript.

**Gate:** Reproducible local share delivery with realistic browser hashrate and independently verified share hash. No ASIC path regression.

### PASS 3 — WASM and speed optimization
Deliver cross-compiled C/WASM backend, first-absorption-state reuse, parity suite, worker integration, benchmark comparisons, and CPU backend selection.

**Gate:** Zero parity failures; measured benchmarks with no unsupported performance claims.

### PASS 4 — WebGPU optional
Deliver WGSL shader, GPU scheduling, candidate buffer overflow handling, fallback logic, parity/nonce uniqueness suites, performance UI.

**Gate:** 10k vector parity + 1M non-overlapping nonce cases + continuous mixed-device test. No device support => graceful skip, not release failure for CPU miner.

### PASS 5 — pool interoperability and deployment
Deliver verified pool adapter and transcript (or mark pool EXPERIMENTAL/DISABLED), public deployment docs, WSS security, origin/auth tests, browser compatibility report and release notes.

**Gate:** Pool share is confirmed by upstream and attribution verified before marking feature production-ready. Public deployment only after abuse prevention and payout disclosure are complete.

## 12. Known pitfalls found in source review — treat as tests

1. `eaglesong.js` old `meetsTarget()` compares LE hash; `ckb-target.js/meetsTargetLE()` explicitly compares hash BE to target LE. Use latter model for consensus. Fix or deprecate old helper; make tests fail if reintroduced.
2. `NerdMiner_CKB/src/stratum.cpp` uses 4-field notify and reads `params[2]` as target; current solo proxy uses 5 fields and `params[2]` is HEIGHT. A bridge must *normalize*, not transparently pass all frames to an incompatible miner.
3. `NerdMiner_CKB/src/mining.cpp` uses low64 + high8 extranonce prefix and job abort every 256 nonces; mirror semantics but don't copy FreeRTOS constructs into JS.
4. `solo-proxy.js` handles three-field submits as full nonce but K7/GodMiner has special prepend semantics; pin the browser's user agent and nonce contract deliberately.
5. `proxy.js` incorrectly labels every upstream accepted share as `BLOCK FOUND`; separate pool acceptance from actual node-confirmed block.
6. `ckb-target.js` six-decimal fixed-point difficulty conversion can round tiny positive values to zero and divide by zero; fix for browser difficulty range.
7. `config.example.json` defaults for ASICs are far too difficult for browser class; web-only profile, preserve ASIC defaults.
8. `job-registry.js` holds exact snapshots; never validate late submissions only against globals. Never auto-ACK unknown/expired jobs as accepted.
9. Solo payout depends on actual node block assembler; simply typing a CKB address in browser **does not** direct rewards to that address.
10. README claims `NerdMiner_CKB` live-pool test is pending; do not claim it's proven without a live test transcript.
11. **Possible high-severity nonce serialization mismatch:** `solo-proxy.js/submitBlock` currently uses the Stratum-submitted `noncePadded` hex as the CKB RPC numeric nonce; `ckb-header.js/writeU128` writes an RPC numeric nonce as LE bytes. An unswapped raw nonce can therefore produce a *different* header nonce than the one Eaglesong hashed. Add an actual `submit_block` round-trip test and correct the conversion in the web-miner path without breaking ASIC profiles.
12. Modern CKB node versions/network upgrades may differ from historical RFC; validate exact current mainnet header/RPC compatibility on target CKB node and record chain/genesis/version in live report.

## 13. Required completion report from coding agent

For each pass, provide:
- Files changed and architectural decisions.
- How to launch from scratch with literal commands.
- Tests run and exact pass/fail output. Name any unrun tests explicitly.
- Sample sanitized share logs with correct statuses.
- Functional limitations / risks.
- Benchmarks in reproducible format where applicable.
- Screenshot or concise UI demonstration evidence where browser is available.
- Recommendation for next pass.

**Final definition of done:** A user can open the static HTML, see the true server-defined payout destination, intentionally start CKB hashing, observe a real work job and measurable hashes, submit at least one genuinely computed and server-validated share, stop without residual work, and trace all share statuses without confusing local acceptance, pool credit, or discovered blocks. WASM/GPU/pool are subsequent gated capabilities and may be disabled if not proven.
