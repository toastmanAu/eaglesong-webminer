# TEST_PLAN

All tests run with `node --test` (Node ≥ 20, no test framework). No mainnet
network access is needed for any suite; the live solo gate (PASS 2) is a
separate, manual, operator-run procedure.

| Command | What runs | Needs |
|---|---|---|
| `npm test` | `tests/*.test.js` — PASS 0 source audit, hash vectors, target, nonce, kernel, protocol, share, stratum client, session, bridge server, UI core, coordinator (real worker code on MessageChannel), protocol client | nothing (vendor/ for the audit tests; they skip without it) |
| `npm run test:integration` | `tests/integration/*.test.js` — (a) no-browser stack fake proxy → bridge → client → coordinator; (b) **browser → bridge → REAL unmodified solo-proxy.js → fake node** (skips if no proxy checkout; set `SOLO_PROXY_DIR`) | Playwright Chromium for (b) |
| `npm run test:e2e` | `tests/e2e/*.test.js` — headless Chromium on the built single file: idle → start → genuine server-validated share → job churn → stop → teardown; hidden-tab pause/resume | Playwright Chromium |
| `npm run test:gpu` | WebGPU parity (PASS 4) — skips cleanly until implemented | — |
| `npm run fixtures` | regenerate oracle-hashed fixtures (byte-identical) | `cargo` + `vendor/eaglesong` |
| `npm run pass0:capture` | re-capture Stratum/RPC transcripts from an unmodified proxy against the fake node | a proxy checkout |
| `npm run bench` | Node benchmark of the JS kernel, JSON output | — |

## Independence of oracles

- Digests: official Rust crate (`tools/eaglesong-oracle`) → fixtures → JS core → worker → bridge recomputation → proxy's own `eaglesong.js` (vendored lineage). Agreement is asserted at every hop.
- Nonce serialization: hand-written u128-LE in tests; the real mainnet block `0x12f7887` nonce; the captured `submit_block` body from the real proxy.
- Targets: hand-derived powers of two; the real testnet tip compact `0x1d08c0c8`.

## Mutation checks performed

- Legacy `meetsTarget` vs consensus: adversarial MSB/LSB vectors flip the verdict.
- `compactToTarget`: `0xffff<<240` must NOT clamp, `0xffffff<<248` must.
- Range allocator: >1M nonces across 1..16 consumers, gap/overlap assertion.
- Duplicate set: same nonce, same job, new generation → still duplicate.
- Session: rate limit exempts block candidates; unknown generation never accepted.
- Coordinator: watchdog replaces a worker that never answers; cursor kept on target-only change; 2^64 exhaustion stops.

## Not yet covered (honest gaps)

- A real CKB node (`submit_block` acceptance by consensus) — PASS 2 devnet gate.
- WASM and WebGPU parity — PASS 3/4.
- Pool relay profile — PASS 5.
- Android device runs — manual; the e2e emulates a 390×844 mobile viewport only.
