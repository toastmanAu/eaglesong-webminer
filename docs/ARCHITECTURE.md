# ARCHITECTURE

```
Browser (dist/index.html, one file)          Node.js bridge (src/bridge)                 existing proxy / node
┌──────────────────────────────┐             ┌──────────────────────────────┐             ┌──────────────────┐
│ app.js (DOM glue only)       │             │ server.js  ws + /healthz     │             │ solo-proxy.js    │
│ miner-state.js  FSM          │  WebSocket  │ session.js one per browser   │  TCP line   │ (UNMODIFIED)     │
│ protocol-client.js  JSON v1  │◀───────────▶│ ws-schema.js strict inbound  │◀───────────▶│ 127.0.0.1:3334   │
│ miner-coordinator.js         │             │ protocol-adapter.js profiles │             │  get_block_tpl   │
│  └ nonce allocator (BigInt)  │             │ stratum-tcp.js 1 TCP/session │             │  submit_block    │
│  └ N × Worker(cpu-worker.js) │             │ job-registry.js generations  │             └────────┬─────────┘
│       └ mine-batch.js kernel │             │ share-validator.js recompute │                      │ JSON-RPC
│ mining-stats.js, odds.js     │             │ config.js validated config   │             ┌────────┴─────────┐
└──────────────────────────────┘             └──────────────────────────────┘             │ CKB node (8114)  │
                                                                                          └──────────────────┘
```

## Modules

| Module | Responsibility | Tested by |
|---|---|---|
| `src/hash/eaglesong-core.js` | Eaglesong sponge on `Uint8Array`; `createCkbHasher` precomputes the first 32-byte absorption (pow hash) so each nonce costs one absorption + one permutation | `tests/hash-vectors.test.js` (official vectors + 64 Rust-oracle vectors) |
| `src/hash/eaglesong-constants.js` | generated from the official `const_vars.rs` | — |
| `src/hash/target.js` | compact → target, explicit BE/LE hex, BigInt comparisons, precision-safe difficulty | `tests/target.test.js` |
| `src/hash/nonce.js` | raw LE ↔ numeric ↔ canonical RPC nonce; `buildNonce16`; `createRangeAllocator` (u64 cursor, fails closed at 2^64) | `tests/nonce.test.js` |
| `src/hash/mine-batch.js` | pure kernel: hash a counter range, return counts + rare candidates + best hash | `tests/mine-batch.test.js` (reproduces proxy-accepted nonces) |
| `src/hash/cpu-worker-core.js`, `cpu-worker.js` | worker message protocol; browser entry | `tests/coordinator.test.js` (runs the real worker code on a MessageChannel) |
| `src/ui/miner-coordinator.js` | workers, generations, adaptive batches (~50 ms), intensity duty cycle, watchdog, exhaustion | `tests/coordinator.test.js` |
| `src/ui/protocol-client.js` | bridge WebSocket client; strict parsing; reconnect without auto-start | `tests/protocol-client.test.js` |
| `src/ui/miner-state.js`, `mining-stats.js`, `odds.js` | explicit FSM; measured rates; lottery odds | `tests/ui-core.test.js` |
| `src/ui/app.js`, `index.html`, `styles.css` | UI | `tests/e2e/browser-mining.test.js` (headless Chromium) |
| `src/bridge/ws-schema.js` | closed-schema validation of every browser frame (≤16 KB, no host/port fields) | `tests/protocol.test.js` |
| `src/bridge/protocol-adapter.js` | upstream profile `solo-proxy-v1` pinned to captured frames; fails closed on foreign shapes | `tests/protocol.test.js` |
| `src/bridge/stratum-tcp.js` | one TCP Stratum session; id correlation; timeouts; fail-closed on bad frames | `tests/stratum-tcp.test.js` |
| `src/bridge/job-registry.js`, `share-validator.js` | generation snapshots; duplicate set; independent Eaglesong recomputation and classification | `tests/share.test.js` |
| `src/bridge/session.js` | per-browser lifecycle, generation bumps, forwarding exactly once, rate limit (block candidates exempt) | `tests/session.test.js` |
| `src/bridge/server.js`, `config.js` | Origin allowlist, connection cap, frame cap, heartbeat, health; validated config | `tests/bridge-server.test.js` |

## Key decisions

- **The bridge recomputes every share** with the same audited core the browser uses; the browser's `hashHex` is diagnostic only. The proxy recomputes again with its own (vendored-lineage) implementation; both are cross-checked against the official Rust crate in tests.
- **Generations, not job ids**, key the bridge's snapshots: any change to pow hash, prefix, or either target bumps the generation; late shares are judged against their own generation.
- **Prefix = the proxy's extranonce1 zero-padded to 8 bytes** (NerdMiner contract), so every TCP session (= every browser session) hashes a disjoint high-64-bit nonce space. The browser never invents a prefix.
- **Nonce counter is BigInt everywhere**; a decimal string crosses the worker boundary; nothing goes through `Number`.
- **Single-file build**: esbuild bundles `app.js` and `cpu-worker.js` to IIFEs; the worker runs from a Blob URL; a CSP meta pins `connect-src` to the configured bridge; no third-party runtime assets.
- **The proxy remains unmodified.** PASS 2's opt-in bridge target overlay asks browsers to solve a target at least as hard as the proxy's, then recalibrates using bounded hash reports and observed valid shares. A dedicated low-difficulty proxy instance is still required for browser-sized shares; ASIC paths remain separate.

## Data flow for one share

1. proxy `mining.notify` → `stratum-tcp` parses (profile) → `session` snapshots `{generation, jobId, powHash, prefix8, shareTarget, networkTarget}` → `job` frame to browser.
2. `protocol-client` normalizes → `coordinator.setJob` (cursor kept if only targets changed) → workers get `job`, then `mine` ranges.
3. worker finds `hash ≤ shareTarget` → candidate `{generation, jobId, nonceHex, hashHex}` → `client.submit`.
4. `session`: schema → registry lookup by generation → prefix check → duplicate set → **recompute Eaglesong** → classification → forward `mining.submit [worker, jobId, nonceHex]` once → ACK → `share_result`.
5. If the recomputed hash also meets the network target the classification is `block_candidate`; the proxy decides about `submit_block`. The bridge never calls anything a block.
