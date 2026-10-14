# EagleSong WebMiner

An **opt-in Nervos CKB Eaglesong browser lottery miner**: a single self-contained
`dist/index.html` (mobile-first, no third-party scripts) that hashes genuine CKB
work in Web Workers, plus a Node.js WebSocket **bridge** that speaks real TCP
Stratum to the existing `ckb-stratum-proxy` solo proxy. Nothing runs until you
press **Start**. Rewards go to the node operator's configured block-assembler
address, which the page displays as the actual payout.

Status: **PASS 0 and PASS 1 complete** (CPU JavaScript backend, deterministic
and real-proxy integration). WASM, WebGPU and pool relay are later, gated passes
and are disabled in the UI. See `docs/reports/`.

## Quick start (Ubuntu 22.04+, Node 20+)

```bash
git clone <this repo> eaglesong-webminer && cd eaglesong-webminer
./scripts/check-deps.sh       # read-only dependency audit
npm ci
npm test                     # fast, deterministic unit tests
npx playwright install chromium
npm run test:e2e             # headless Chromium: start → genuine server-validated share → stop
npm run test:integration     # no-browser stack + browser → REAL solo-proxy.js (skips if no proxy checkout)

# demo without any CKB infrastructure (fake proxy, local test shares only):
node scripts/dev-all.mjs --fake-stratum
# → open http://127.0.0.1:5173/index.html and press Start
```

### With the real solo proxy and a CKB node (Deployment A, private)

1. Run a CKB node with the `Miner` RPC module and a `[block_assembler]` configured, RPC on `127.0.0.1:8114`.
2. Run the **unmodified** `solo-proxy.js` with `local.host=127.0.0.1`, `local.port=3334` (not 3333 if something else owns it), `node.host=127.0.0.1`.
3. `cp config.example.json config.json`, check `stratum.port` and `bridge.allowedOrigins`. To show a node-derived payout, set `stratum.statsPort` to the solo proxy's loopback stats port. The bridge verifies only a healthy, fresh template with no payout drift; unavailable or stale stats revoke verification.
4. `npm run dev` (builds the page, serves it on 5173, starts the bridge on 8788) — or `npm run build` and host `dist/index.html` anywhere; `npm run bridge` runs the bridge alone.

### GitHub Pages (public page)

GitHub Pages hosts the static page; it does not run the Node bridge. Set up a separate public WSS bridge endpoint and private solo proxy/CKB node, then follow [docs/GITHUB_PAGES.md](docs/GITHUB_PAGES.md). The Pages build requires the public `PAGES_BRIDGE_URL` repository variable and fails if it points to localhost or plaintext WebSocket.

The Connection card lets each browser save a custom bridge endpoint and an optional mining address. When an address is entered, Start checks that it exactly matches the endpoint's node-verified solo payout and stops if that verification later changes. The address is a safety check: it does not reconfigure the node or redirect rewards. To mine to a different address, run a compatible bridge, solo proxy, and CKB node whose block assembler pays that address, and allow this site's origin on that bridge. Settings stay in this browser; reloading never starts mining.

Windows 11: install Node 20+ from nodejs.org, then the same `npm` commands in PowerShell (`npx playwright install chromium` for the browser tests). Optional for later passes: clang/wasm-ld or Emscripten (WASM), Rust `cargo` (to rebuild the Eaglesong oracle fixtures).

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | build + static server + bridge (`--fake-stratum` adds the deterministic fake proxy) |
| `npm run bridge` | bridge only (`node src/bridge/server.js [config.json]`) |
| `npm run build` | `dist/index.html` (`--bridge-url wss://host` to bake in a public bridge) |
| `npm run build:pages` | fail-closed GitHub Pages artifact using `PAGES_BRIDGE_URL` |
| `./scripts/check-deps.sh` | read-only audit of Node, packages, and optional tools |
| `npm test` / `test:integration` / `test:e2e` / `test:gpu` | see `docs/TEST_PLAN.md` |
| `npm run bench` | reproducible JSON benchmark of the JS kernel in Node |
| `npm run fixtures` | regenerate oracle-hashed fixtures (needs `cargo`) |
| `npm run pass0:capture` | capture Stratum/RPC transcripts from an unmodified proxy |

## What the share states mean

`local_accepted` — the bridge recomputed your Eaglesong hash, it met the share
target, and the proxy ACKed it. **It is not a payout.** `block_candidate` — the
hash also met the network target; the proxy decides about `submit_block`.
`node_submitted` / `node_accepted` / `block_confirmed` are only ever set from
node evidence (PASS 2+). Everything `rejected_*` tells you why.

## Documentation

`docs/ARCHITECTURE.md`, `docs/PROTOCOL.md`, `docs/SECURITY.md`, `docs/TEST_PLAN.md`,
`docs/SOURCE_VERSIONS.md`, `docs/LIVE_INTEROP_REPORT.md`, `docs/reports/PASS*_REPORT.md`,
`LICENSES/` (MIT notices for nervosnetwork/eaglesong, NerdMiner_CKB, ckb-stratum-proxy).

## License

MIT. Third-party notices in `LICENSES/README.md`.
