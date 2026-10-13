# AGENTS.md — operating instructions for coding agents

Authoritative spec: `eaglesong_webminer_agent_spec.md`. Work in passes; never
claim a later pass's capability early.

## Ground rules
- **TDD.** Write the failing test, watch it fail, implement, watch it pass. Expected values come from the Rust oracle, hand-derived literals, or captured real traffic — never from the code under test.
- **Fail closed.** Unknown Stratum shapes, wrong hex lengths, unknown generations, foreign prefixes: reject and log. Never ACK what you did not validate.
- **Do not modify `solo-proxy.js`** without ASIC regression tests (K7/GodMiner, Goldshell/NerdMiner paths). PASS 2's web profile must be opt-in.
- **Byte orders are explicit.** Hash is BE for comparison; targets on the solo-proxy wire are LE; the header nonce is LE in molecule and canonical BE hex in JSON-RPC. See `docs/PROTOCOL.md §0`.
- **Ports on this host:** 3333 is a live pool edge, 8787/8081 belong to another dashboard. Use 3334 (proxy) and 8788 (bridge). Pick free ports in tests (port 0).
- **No covert mining.** Nothing hashes before Start; reload/reconnect never auto-starts.
- **Honest wording.** A Stratum ACK is `local_accepted`, not a block. A fake node accepting `submit_block` is `node_submitted` at most, never `block_confirmed`.

## Milestones
| Pass | State | Gate evidence |
|---|---|---|
| 0 | done | `docs/reports/PASS0_REPORT.md`, `tests/pass0-source-audit.test.js`, transcripts |
| 1 | done | `docs/reports/PASS1_REPORT.md`, e2e + real-proxy logs |
| 2 | next | web vardiff profile (opt-in), payout verification from proxy stats, **devnet live gate** (`docs/LIVE_INTEROP_REPORT.md`) |
| 3 | — | WASM backend from `vendor/NerdMiner_CKB/src/eaglesong/eaglesong.cpp`, parity vs oracle |
| 4 | — | WebGPU, 10k-vector parity, 1M nonce uniqueness |
| 5 | — | pool relay with captured live transcript, or mark DISABLED |

## Where things are
`src/hash` (crypto, pure) · `src/bridge` (server) · `src/ui` (browser) · `tests/` (node:test) · `tests/helpers/fake-stratum-server.js` (replays the captured dialect) · `tests/helpers/real-proxy-harness.js` (runs an unmodified proxy against a fake node) · `tools/eaglesong-oracle` (Rust) · `vendor/` (pinned upstreams, `scripts/fetch-sources.sh`).
