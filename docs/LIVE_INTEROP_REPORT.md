# LIVE_INTEROP_REPORT

Status after PASS 1 (2026-10-13): **no live CKB node has been used yet.**

## What has been proven against real code

| Layer | Real? | Evidence |
|---|---|---|
| Eaglesong | official Rust crate as oracle | `tests/fixtures/*.json`, `tests/hash-vectors.test.js` |
| Browser miner | real headless Chromium, built `dist/index.html` | `tests/e2e/browser-mining.test.js` |
| Bridge | real | all `tests/*.test.js` |
| solo-proxy.js | **real, unmodified** (operator copy `ce1f7349` and GitHub main `027584a6`) | `tests/integration/real-proxy.test.js`, logs in `docs/reports/logs/real-proxy-*.log` |
| CKB node | **fake** (`tests/helpers/fake-ckb-node.js`): serves one real mainnet block as a template with `compact_target 0x1f040000`, records `submit_block`, validates nothing | — |

So: genuine Eaglesong work, genuine Stratum, genuine proxy share validation and genuine `submit_block` *construction* — but **no node has accepted a block**, and no claim of pool compatibility is made.

## Environment facts that shape the live gate

- No CKB node on this host. A synced **testnet** node on the operator's LAN has its `Miner` RPC module disabled (`get_block_template` → `RPCModuleIsDisabled`). Enabling it (`rpc.modules += "Miner"`, a `[block_assembler]`, restart) is an operator decision on shared infrastructure, not something this project should do unattended.
- `ckb 0.210.0` is installed locally. A private **dev chain** (`ckb init --chain dev`, `[pow] func = "Eaglesong"`, easy genesis target) is the planned PASS 2 live gate: it lets a browser genuinely solve blocks and lets `submit_block` be judged by real consensus code, with zero mainnet exposure.

## PASS 2 live gate procedure (planned)

1. `ckb init --chain dev` in a scratch dir; set `[pow] func = "Eaglesong"`; set `block_assembler` to a dev lock; enable `Miner` module; `ckb run`.
2. Start the **unmodified** operator `solo-proxy.js` with `node.host=127.0.0.1`, `port=8114`, Stratum on `3334`.
3. Start the bridge, open `dist/index.html`, Start.
4. Record: proxy log (`share accepted`, `BLOCK SOLUTION`, `submit_block` result), `get_block` of the new tip showing `header.nonce`, and verify `u128_le(header.nonce)` equals the browser's submitted nonce bytes; verify the cellbase lock equals the configured block assembler.
5. Distinguish `node_submitted` (RPC returned a hash) from `block_confirmed` (the block is the tip's ancestor after N blocks).
