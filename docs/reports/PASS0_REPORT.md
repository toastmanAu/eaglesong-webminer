# PASS 0 — source audit + reproducible baseline — COMPLETION REPORT

Date: 2026-10-13. Project root `/home/phill/browser-miner/real-build`.

## Deliverables

| Spec item | Where |
|---|---|
| `docs/SOURCE_VERSIONS.md` (exact commit SHAs; tree hashes; local operator copy) | `docs/SOURCE_VERSIONS.md` |
| `docs/PROTOCOL.md` (canonical crypto model, upstream profiles as captured, browser↔bridge v1) | `docs/PROTOCOL.md` |
| exact wire fixtures from existing code | `tests/fixtures/stratum-transcripts/ckb-stratum-proxy-main.json`, `…/solo-proxy-local.json` — every TCP line in both directions plus the `submit_block` JSON-RPC body, captured from the **unmodified** `solo-proxy.js` of GitHub main `027584a6` and of the operator copy `ce1f7349` by `scripts/pass0-capture-transcript.mjs` |
| unit test reproducing the legacy eaglesong comparison error | `tests/pass0-source-audit.test.js` tests 3–4 |
| clean output of existing proxy tests | operator copy `npm test`: **56 pass / 0 fail**; GitHub main clone: **44 pass / 0 fail** (run 2026-10-13, Node v22.22.0) |
| reference vectors + two fixed 48-byte CKB inputs with fixture SHA-256 | `tests/fixtures/eaglesong-vectors.json` (11 official vectors), `tests/fixtures/ckb-pow48-vectors.json` (64 vectors incl. 5 fixed edge cases; `generatorSha256 cc740eae…`), produced by the Rust oracle `tools/eaglesong-oracle` (official crate) |
| independent oracle | `tools/eaglesong-oracle` (Rust, wraps `nervosnetwork/eaglesong @ 39d3832d`), verified against all published vectors at fixture-generation time |

## Gate: canonical endian/target/nonce decisions justified with unit tests

`node --test tests/pass0-source-audit.test.js` → **32 pass / 0 fail**. Highlights:

| # | Finding | Test |
|---|---|---|
| 1 | legacy `eaglesong.js/meetsTarget()` compares the hash little-endian: accepts `ff00…00` vs 2^200 (consensus rejects) and rejects `00…ff` (consensus accepts) | 3, 4 |
| 2 | `ckb-target.js/meetsTargetLE()` matches BigInt big-endian semantics on all edge vectors; a BE-encoded target fed to it flips the verdict (no heuristics possible) | 5, 6 |
| 3 | **Mandatory nonce regression**: raw `01000000000000001122334400000000` ⇄ numeric `0x443322110000000000000001` ⇄ same raw bytes via u128-LE. The spec's literal `0x00000000443322110000000000000001` is the same number but **non-canonical** — a real node rejects redundant leading zeros (proven by the operator's 2026-07-17 fix history and `test/nonce-encoding.test.js`) | 7, 8 |
| 4 | **Pitfall 11 confirmed on GitHub main**: `submitBlock` passes the raw padded nonce as the numeric header nonce → header carries the byte-reversed nonce; reproduced on the real code path: captured `submit_block` nonce `0xbe84000000000000a5b60f9800000000` LE-serializes to the reversal of the hashed bytes and its Eaglesong does **not** meet the target | 9, 32 |
| 5 | **Fixed in the operator copy**: captured `submit_block` nonce `0xfdea349f0000000000005db7` LE-serializes to exactly the hashed `b75d0000000000009f34eafd00000000` | 31 |
| 6 | pitfall 6: `diffToTargetLE` six-decimal rounding collapses 1e-6 and 1.4e-6; 4e-7 **throws** (BigInt division by zero) inside the share handler | 10, 11 |
| 7 | solo notify is 5 fields, `params[2]` is the height (NerdMiner's 4-field reading would fail) | 14, 23 |
| 8 | subscribe (non-GodMiner UA) is the nested 3-tuple with a 4-byte extranonce1; set_target is LE | 13, 15, 22, 24 |
| 9 | NEW FINDING: both proxy versions accept a replayed identical share again (no duplicate set) | 19, 28 |
| 10 | NEW FINDING (pitfall 8): a share naming an unknown job id is ACKed `result:true` without validation | 20, 29 |

## Corrections to the spec made during the audit

- `027584a6…` and `cc6d2fee…` are **commit SHAs**, not tree hashes (tree hashes recorded alongside).
- The operator's running proxy (`~/proxy-server`) is ahead of GitHub main and already fixes pitfall 11; GitHub main still has it.
- The default bridge port 8787 and Stratum port 3333 are taken on this host by unrelated services (pool edge, dashboard); the project uses 8788 and 3334.

## Source compatibility map

| Path | Profile | Browser uses? | Notes |
|---|---|---|---|
| `solo-proxy.js` non-GodMiner UA | `solo-proxy-v1` | **yes** | nested subscribe, 5-field notify, LE targets, 3-field full-nonce submit |
| `solo-proxy.js` GodMiner/K7 UA | `godminer-v1` | no | flat tuple, BE targets, 8-byte submits with prepended extranonce1 — untouched |
| NerdMiner `stratum.cpp` | `nerdminer-v1` | no (contract mirrored) | 4-field notify incompatible with solo proxy; nonce layout `counter_le || en1` adopted |
| `proxy.js` pool relay | `pool-relay-v1` | no (PASS 5) | mislabels every upstream ACK as `BLOCK FOUND` (pitfall 5) |

## Risks carried forward

- No real CKB node available on this host (testnet node at `.134` has `Miner` disabled) — live gate deferred to PASS 2 with a local devnet.
- The operator proxy's vardiff cannot express browser-class difficulty safely (`diffToTargetLE` precision) — PASS 2 web profile.
