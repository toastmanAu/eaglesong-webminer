# LIVE_INTEROP_REPORT

Status (2026-10-13): **the isolated CKB development chain has accepted browser-mined Eaglesong blocks.** This proves real-node interoperability on the development chain. It does not prove CKB mainnet mining or a monetary payout.

## Live development-chain gate

- CKB `0.210.0` ran with `[pow] func = "Eaglesong"`, genesis `compact_target = 0x20010000`, Miner RPC on `127.0.0.1:18314`, and the block assembler lock `0x1111…1111`. The node, unmodified solo proxy, and bridge used separate loopback ports; Cloudflare Tunnel exposed only the bridge at `wss://eaglesong-dev.wyltekpool.com`.
- `npm run verify:live` with `PAGES_ORIGIN=https://toastmanau.github.io` passed public WSS health, verified node-derived payout, Start, real Stratum job, browser Eaglesong work, proxy ACK, and Stop. The proxy reported `payoutDrift: false`.
- The node accepted the candidate at height 2 as `0xcf191ae02f9a6dbb66c161dbd9624c3c231325449f40ece7717fed6f36ebbc53`. Its parent is the earlier browser-mined height-1 block `0x3526ae8da61838591f6c8bf29d8483a3f110be2d24aa73e938a87726471181c8`.
- A later gate submitted browser nonce `b901000000000000e12d9be800000000` (molecule little endian). The real node accepted height 3, hash `0x3172ee8c1b11430753b6ed1c3ebe44d4c891586508de49f29fae6923df92ffe6`, with JSON-RPC nonce `0xe89b2de100000000000001b9`. Converting that nonce to 16 little-endian bytes exactly reproduces the browser nonce. Height 2 is its ancestor.
- The public Pages build is explicitly labeled as a development-chain demo. These blocks and the displayed `ckt1…` address have no monetary value. Mainnet interoperability remains unverified.

## 2026-10-14 submission flood and repair

The first development genesis used `compact_target = 0x20010000` (roughly one network candidate per 256 hashes). An 8-worker browser run generated thousands of valid block candidates in seconds. Because network candidates intentionally bypassed the ordinary share rate limit, proxy and node submissions backed up; the browser recorded `share request timeout after 15000ms` and Stop was delayed. The old development-chain data is preserved under ignored `runtime/ckb/data-before-difficulty-fix` for diagnosis.

An initial repair changed the target to `0x1e400000`, but CKB's short development epoch adjusted it easier during a high-rate run. That 8-worker predeployment test still produced 6,081 block candidates and 930 upstream errors in 36 seconds. Its chain data is preserved under ignored `runtime/ckb/data-after-first-fix`.

The current isolated development chain uses `compact_target = 0x1e040000` (roughly one candidate per 4.2 million hashes) and a long genesis epoch of 1,000,000 blocks to keep the target stable for this demo. The browser now returns at most one candidate per worker batch and waits for its submission result before giving that worker more nonce work. The bridge caps concurrent submissions per session, including network candidates; the public runtime sets that cap to two and limits simultaneous sessions to four. This preserves explicit responses and bounds pressure on the unmodified solo proxy.

With the final chain, public WSS → bridge → unmodified proxy → real CKB node passed again. An 8-worker Chromium run of the patched page produced 135,706,767 genuine hashes in 36 seconds, 29 block candidates, 13 local accepted shares, 2 stale results, **zero upstream errors**, and Stop completed in 128 ms. The node held `compact_target = 0x1e040000` through height 26. Its height-1 block `0xd7024609f608831325a67345d237f4cc62898b9ec16387e722ea097da50d2b86` has that target; the proxy reported 29 accepted `submit_block` responses across the run. This chain is still a valueless development demo.

## What has been proven against real code

| Layer | Real? | Evidence |
|---|---|---|
| Eaglesong | official Rust crate as oracle | `tests/fixtures/*.json`, `tests/hash-vectors.test.js` |
| Browser miner | real headless Chromium, built `dist/index.html` | `tests/e2e/browser-mining.test.js` |
| Bridge | real | all `tests/*.test.js` |
| solo-proxy.js | **real, unmodified** (operator copy `ce1f7349` and GitHub main `027584a6`) | `tests/integration/real-proxy.test.js`, logs in `docs/reports/logs/real-proxy-*.log` |
| CKB node in the PASS 1 test harness | **fake** (`tests/helpers/fake-ckb-node.js`): serves one real mainnet block as a template with `compact_target 0x1f040000`, records `submit_block`, validates nothing | — |

The PASS 1 harness alone showed `submit_block` construction. The live development-chain gate above additionally demonstrates real node acceptance. No claim of pool compatibility is made.

## Environment facts that shaped the live gate

- A synced **testnet** node on the operator's LAN has its `Miner` RPC module disabled (`get_block_template` → `RPCModuleIsDisabled`). This project did not change the shared node.
- `ckb 0.210.0` is installed locally. A separate **dev chain** (`ckb init --chain dev`, `[pow] func = "Eaglesong"`, easy genesis target) provided the PASS 2 live gate with zero mainnet exposure.

## PASS 2 live gate procedure (executed)

1. `ckb init --chain dev` in a scratch dir; set `[pow] func = "Eaglesong"`; set `block_assembler` to a dev lock; enable `Miner` module; `ckb run`.
2. Start the **unmodified** operator `solo-proxy.js` with `node.host=127.0.0.1`, `node.port=18314`, Stratum on `3334`.
3. Start the bridge, open `dist/index.html`, Start.
4. Record: proxy log (`share accepted`, `BLOCK SOLUTION`, `submit_block` result), `get_block` of the new tip showing `header.nonce`, and verify `u128_le(header.nonce)` equals the browser's submitted nonce bytes; verify the cellbase lock equals the configured block assembler.
5. Distinguish `node_submitted` (RPC returned a hash) from `block_confirmed` (the block is the tip's ancestor after N blocks).
