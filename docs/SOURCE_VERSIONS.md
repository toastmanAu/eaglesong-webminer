# SOURCE_VERSIONS — pinned upstream sources (PASS 0 source freeze)

Recorded 2026-10-13. Recreate `vendor/` with `scripts/fetch-sources.sh`.

| Source | Branch | **Commit SHA** (pinned) | Tree hash of that commit | License |
|---|---|---|---|---|
| https://github.com/toastmanAu/ckb-stratum-proxy | `main` | `027584a65202ee8b8d58509da90096867bb885ca` (2026-07-09 "fix: never drop a network-target block on a low_diff share reject") | `b6162965d646a9c11f266a9ea2f33a7ad986f6b3` | MIT per `package.json` (no LICENSE file in repo) |
| https://github.com/toastmanAu/NerdMiner_CKB | `dev` | `cc6d2fee5b7981d1adab5ce32d86e6073c6408ad` (2026-02-27) | `33253767479fc936742b99957d172f9d8b85b6f7` | MIT, Copyright (c) 2023 Bitmaker; previous work HAN Miner (c) 2022 Valerio Vaccaro |
| https://github.com/nervosnetwork/eaglesong | `master` | `39d3832dbbfb7cb513b89f4370b26793e30d9f18` (2020-01-22) | `252535c62476eca0e3bcfbc89a0577e2acf3f01e` | MIT (COPYING), Copyright (c) 2018 Nervos Foundation |

**Correction to the spec:** the spec called `027584a6…` and `cc6d2fee…` "tree hashes, not commit SHAs". They are **commit SHAs** (verified with `git rev-parse HEAD` after `git clone`); the tree hashes are the third column above.

## Local, non-GitHub source that matters

`/home/phill/proxy-server` is the solo proxy actually operated here. It is **ahead of GitHub main** on an independent history (GitHub's `027584a` is not an ancestor):

| | |
|---|---|
| HEAD | `ce1f73495d5160420554ca0e8d25d287cb97d601` — 2026-07-17 "fix: encode submit_block nonce as canonical Uint128 (BE, no leading zeros)" |
| Differs from GitHub main in | `solo-proxy.js`, `ckb-target.js` (+`nonceToUint128Hex`), `ckb-merkle.js`, `config.example.json`, `dashboard.html`; adds `ckb-address.js`, `test/nonce-encoding.test.js`; drops `proxy.js`/`README.md` |
| Tests | `npm test` → 56 pass / 0 fail (GitHub main clone: 44 pass / 0 fail) |

The spec's pitfall 11 (raw LE nonce used as the numeric RPC nonce in `submitBlock`) **is real on GitHub main and already fixed in the local operator copy**. Both are pinned by transcript fixtures and `tests/pass0-source-audit.test.js` (see `docs/reports/PASS0_REPORT.md`).

## Tooling versions used for PASS 0

| Tool | Version |
|---|---|
| Node.js | v22.22.0 (spec minimum >= 20) |
| npm | 11.12.0 |
| cargo / rustc (for `tools/eaglesong-oracle`) | cargo 1.92.0 |
| clang (wasm32 target available via `wasm-ld`) | clang 21.0.0 (swiftly); `/usr/lib/llvm-17/bin/wasm-ld` also present |
| ckb (portable, for a local devnet in PASS 2) | ckb 0.210.0 (2592ddf 2026-09-17) |
| Playwright Chromium cache | `~/.cache/ms-playwright/chromium-1243` |

## Reference environment facts (not sources, but they shape the plan)

- No CKB node on `127.0.0.1:8114`. A synced **testnet** node on the operator's LAN has its `Miner` RPC module disabled (`get_block_template` → `RPCModuleIsDisabled`), so it cannot feed a solo proxy without a node-config change by the operator.
- `127.0.0.1:3333` is the live **CKB Interim Pool** Stratum edge (`pool-edge@au-adelaide-01.service`) — not solo-proxy. Per operator instruction it is left alone; this project's solo-proxy instances use `127.0.0.1:3334` and the bridge `127.0.0.1:8788` (the spec's `8787` is taken by another dashboard on this host).

## Fixture provenance

- `tests/fixtures/eaglesong-vectors.json` — all 8 vectors from `vendor/eaglesong/src/test_vectors.txt` plus the 3 constants in `src/lib.rs`; every one re-hashed by the Rust oracle at generation time (generation aborts on disagreement).
- `tests/fixtures/ckb-pow48-vectors.json` — 64 48-byte CKB PoW inputs (5 hand-chosen edge cases incl. the spec's regression nonce, 59 from xorshift64* seed `0x4542574d2d434b42`), digests from the Rust oracle. `generatorSha256` records SHA-256 of `scripts/gen-fixtures.mjs`. Regeneration is byte-identical.
- `tests/fixtures/stratum-transcripts/*.json` — exact frames captured from the **unmodified** `solo-proxy.js` of each source above, driven by `scripts/pass0-capture-transcript.mjs` against a fake node serving a real mainnet block (`test/fixtures/mainnet-block-raw.json`) with `compact_target` lowered to `0x1f040000` so a CPU can solve the block target.
