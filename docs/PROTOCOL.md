# PROTOCOL — wire contracts

Three boundaries, each with its own explicitly pinned encoding. **No heuristics
from target shape**: every hex field below says which byte order it is in.

```
browser  <── WebSocket JSON v1 ──>  bridge  <── TCP line-JSON Stratum ──>  solo-proxy  <── JSON-RPC ──>  CKB node
```

## 0. Canonical crypto model (CKB consensus, RFC 0027)

```
powHash32 = HEX(job.powHashHex)                      32 bytes, byte order preserved
nonce16   = counter_u64_le(8) || prefix8(8)          the 16 bytes appended to powHash
hash32    = EAGLESONG(powHash32 || nonce16)          32 bytes
hashValue = U256_from_big_endian(hash32)             byte 0 is the MOST significant
shareOK   = hashValue <= shareTarget
blockOK   = hashValue <= networkTarget = compact_to_target(raw_header.compact_target)
```

The 128-bit header nonce is ONE number. Its molecule serialization is little-endian,
so `nonce16` above **is** `nonce.to_le_bytes()`; the numeric value is
`U128_from_little_endian(nonce16)`. Three spellings of the same nonce exist and must
never be confused:

| Where | Spelling | Example (counter=1, prefix=11223344 00000000) |
|---|---|---|
| hashed bytes / Stratum `mining.submit` / browser `nonceHex` | 32 hex chars, raw LE bytes | `01000000000000001122334400000000` |
| numeric value | BigInt | `0x443322110000000000000001` = 2^64·0x1122334400000000-as-LE + 1 |
| CKB JSON-RPC `submit_block` `header.nonce` | canonical Uint128: `0x` + BE hex, **no redundant leading zeros** | `0x443322110000000000000001` (a node rejects `0x0000000044…`) |

Conversion happens exactly once, on the `submit_block` path:
`rpcNonce = '0x' + stripLeadingZeros(reverseBytes(nonce16).hex)`; the inverse
`u128_to_le_bytes(BigInt(rpcNonce)) === nonce16` is a test invariant
(`tests/pass0-source-audit.test.js`, PASS 1 `tests/nonce.test.js`).

Targets: a `targetBE` string is 64 hex chars read as BE; a `targetLE` string is the
byte-reversal. `compact_target` decodes as `mantissa << 8*(exp-3)` (or `>>` when
`exp <= 3`), clamped to `2^256-1`. Reference `DIFF1_TARGET = 2^224` (≈2^32 hashes/share)
is informational only.

## 1. Upstream profile `solo-proxy-v1` (captured, both GitHub main and local copy)

Transcripts: `tests/fixtures/stratum-transcripts/{ckb-stratum-proxy-main,solo-proxy-local}.json`.
Framing: one JSON object per `\n`-terminated line.

| Step | Client → proxy | Proxy → client (exact shape captured) |
|---|---|---|
| subscribe | `{"id":1,"method":"mining.subscribe","params":["EagleWebMiner/1.0"]}` | `{"id":1,"result":[[["mining.set_difficulty",SID],["mining.notify",SID]],SID,4],"error":null}` — `SID` = 8 hex chars (4 bytes), doubles as **extranonce1**; extranonce2_size = 4. (A UA matching `/godminer\|ckbminer/i` gets the flat `[null, en1_16hex, 8]` tuple and BE targets — we never send such a UA.) |
| authorize | `{"id":2,"method":"mining.authorize","params":["web-01","x"]}` | `{"id":2,"result":true,"error":null}` then immediately `set_target`, `set_difficulty`, `notify` |
| share target | — | `{"id":null,"method":"mining.set_target","params":[TARGET_LE_64HEX]}` + `{"method":"mining.set_difficulty","params":[diff]}` — **LE**; derived from `diffToTargetLE(diff)` |
| job | — | `{"id":null,"method":"mining.notify","params":[JOB_ID_HEX, POW_HASH_64HEX, HEIGHT_NUMBER, NETWORK_TARGET_LE_64HEX, CLEAN_BOOL]}` — **five** fields, `params[2]` is a JSON number (height) |
| submit | `{"id":N,"method":"mining.submit","params":["web-01", JOB_ID_HEX, NONCE_32HEX]}` — nonce is the full 16 hashed bytes; the proxy reads the **last** param | accepted: `{"id":N,"result":true,"error":null}`; below local target: `{"id":N,"result":false,"error":[23,"Low difficulty share",null]}` |

The proxy recomputes Eaglesong over `pow_hash || nonce` itself and compares BE
hash vs its stored LE target (`ckb-target.js/meetsTargetLE`). It does **not**
check that the submitted nonce carries its extranonce1 — prefix uniqueness is the
bridge's responsibility. Observed (and pinned as FINDINGS) in both versions:

- a replayed identical share is accepted again (no duplicate set);
- a share naming an unknown job id is ACKed `result:true` without any validation.
- share "accepted" means **local vardiff target met**; a block is only when the
  proxy itself logs `BLOCK SOLUTION` and calls `submit_block`. Stratum never
  tells the miner which happened → the bridge classifies `local_accepted` /
  `upstream_accepted` from the ACK and must not call anything a block from the ACK.

### NerdMiner profile `nerdminer-v1` (reference only, NOT compatible as-is)

`NerdMiner_CKB/src/stratum.cpp` parses `mining.notify` as **four** fields
`[job_id, pow_hash, target, clean]` and reads `params[2]` as the target. Against
`solo-proxy-v1` that field is the height, so `hex_to_bytes` fails. A bridge must
normalize; it must never relay raw frames across profiles. NerdMiner's nonce
contract (`counter_u64_le || extranonce1 zero-padded to 8`, submit as 3-field with
32-hex nonce, abort check every 256 nonces) is the one the browser mirrors.

### GodMiner/K7 profile `godminer-v1` (out of scope, documented so we never collide)

Flat subscribe tuple, 8-byte extranonce1 `0011223344556677`, BE targets, 8-byte
nonce submits that the proxy prepends extranonce1 to. Nothing in this project
sends a GodMiner UA, and `solo-proxy.js` is not modified in PASS 0/1.

## 2. Browser ↔ bridge: WebSocket JSON, `v: 1`

Common envelope: every message is a JSON object with string `type`, integer `v: 1`,
optional `requestId` (string ≤ 64 chars). Inbound frames > 16384 bytes, non-object
JSON, unknown `type`, unknown extra fields, or any field named like a host/port/url
are rejected with `error` and the connection may be closed. Hex fields are
normalized to lowercase and length-checked before use.

**Client → bridge**

| type | fields | notes |
|---|---|---|
| `hello` | `client: string(≤64)`, `capabilities: string[]` | first message, once |
| `start` | `workerLabel?: string(≤32, [A-Za-z0-9._-])` | opens the private TCP Stratum session; jobs flow only after this |
| `submit` | `jobId`, `generation: int`, `nonceHex: 32 hex`, `hashHex?: 64 hex (diagnostic only)` | one submit = at most one upstream `mining.submit` |
| `calibrate` | `hashes: int`, `elapsedMs: int` | optional web profile only; bounded advisory hash count, never authoritative for share acceptance |
| `stop` | — | tears down the TCP session; no more jobs |
| `ping` | — | → `pong` |

**Bridge → client**

| type | fields |
|---|---|
| `hello` | `sessionId`, `mode: "solo"`, `payout: { kind: "node_block_assembler", address: string\|null, verified: bool }`, `protocol: "ckb-128nonce-v1"`, `bridgeVersion`, `webProfile: bool` |
| `job` | `jobId`, `generation`, `powHashHex`, `height\|null`, `cleanJobs`, `prefix8Hex`, `shareTargetBE`, `networkTargetBE\|null`, `issuedAt` |
| `target` | `generation`, `shareTargetBE`, `networkTargetBE\|null`, `shareDifficulty` — sent when only the target changed; **generation still increments** |
| `share_result` | `requestId`, `classification`, `accepted: bool`, `reason: string\|null`, `upstream?: {result, error}` |
| `status` | `connected`, `nodeHealthy`, `jobAgeMs`, `payoutVerified`, `payout`, `templateAgeSec`, `stratumState` |
| `error` | `code`, `message` |
| `pong` | `requestId` |

`generation` is bridge-assigned, per session, monotonically increasing, bumped on
any change to `powHash`, prefix, or either target. The bridge keeps a bounded
registry of `{generation → job snapshot}` so a late submit is judged against the
state in effect when it was mined.
An ordinary share for a replaced job is rejected even if the proxy would ACK
an unknown job ID. A retained old-job **network candidate** is recomputed
against its exact captured network target and forwarded for block recovery.

Classifications: `local_accepted` (bridge recomputation met the share target and
upstream ACKed), `upstream_accepted` (reserved for pool mode), `rejected_low_diff`,
`rejected_duplicate`, `rejected_stale` (generation no longer in registry),
`rejected_invalid` (malformed / wrong prefix / hash mismatch), `block_candidate`
(bridge recomputation met the network target — forwarded regardless of share
target), `node_submitted` / `node_accepted` / `block_confirmed` (only when the
solo proxy or node evidence says so — never inferred from a Stratum ACK),
`upstream_error`.

## 3. Nonce allocation

- Prefix: the bridge takes the proxy's per-TCP-session 4-byte extranonce1 and
  zero-pads to 8 bytes (`prefix8Hex`), exactly as NerdMiner does, so every
  browser session hashes a disjoint high-64-bit space from every other miner on
  the proxy. A new TCP session (start, reconnect) → new extranonce1 → new prefix.
- Counter: the browser coordinator owns one `BigInt` cursor per generation and
  hands disjoint `[firstLo, firstLo+count)` ranges to workers. A target-only
  generation bump keeps the cursor (no repeated work); a `powHash`/prefix change
  resets it to 0. Reaching `2^64` fails closed (stop + request a new session).
