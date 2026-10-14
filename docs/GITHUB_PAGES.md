# GitHub Pages deployment

GitHub Pages serves only the self-contained browser page. A public WSS endpoint must run the Node bridge; the solo proxy and CKB node stay private behind it. The browser never receives node RPC or Stratum host selection.

## Before publication

1. Run `./scripts/check-deps.sh`, `npm ci`, `npm test`, `node scripts/audit-public.mjs`, and `PAGES_BRIDGE_URL=wss://your-bridge.example.org npm run build:pages`.
2. Run `node scripts/audit-pages-artifact.mjs`. The build refuses a missing, local, or plaintext bridge URL.
3. Set up the bridge host with TLS or a trusted tunnel. Keep the bridge and Stratum listeners on loopback. Allow only the exact Pages origin in `bridge.allowedOrigins`; the origin is `https://OWNER.github.io` for a project site, without the repository path.
4. If Cloudflare Tunnel is the sole local peer, set `bridge.trustedClientIpHeader` to `cf-connecting-ip`; otherwise omit it. Set `bridge.maxConnectionsPerIp`, `bridge.maxConnections`, and `bridge.maxConcurrentSubmissions` for available capacity. Set `stratum.statsPort` only to the proxy's loopback stats endpoint so the node-derived payout can be verified.

Use a **separate** solo proxy instance for the web bridge on port 3334. Keep the existing ASIC or pool edge on 3333 untouched. For the unmodified proxy's web instance, set `vardiff.initialDiff` and `vardiff.minDiff` to `0.000001`, and use its own free loopback stats port. Its six-decimal target converter is safe at `0.000001` and unsafe below about `0.0000005`. Set `mining.webProfileEnabled: true` in the bridge config; the bridge advertises a harder adaptive target to browsers and never forwards a share that fails its independently checked target. For the public devnet, use the current genesis target `0x1e040000` and `genesis_epoch_length = 1000000` to keep the demo target stable. The original easy target `0x20010000` caused a submission flood during an 8-worker run. See [LIVE_INTEROP_REPORT.md](LIVE_INTEROP_REPORT.md).

## GitHub configuration

1. Create a public repository and push this project only after the source audit passes. Keep `config.json`, `.env`, tunnel credentials, node data, and logs out of Git.
2. In repository Settings → Secrets and variables → Actions → Variables, create `PAGES_BRIDGE_URL` with the public `wss://` origin. This is a public URL, not a secret.
3. In Settings → Pages, choose **GitHub Actions** as the build and deployment source.
4. Push `main` or run the `GitHub Pages` workflow manually. The workflow runs tests, both public audits, and `verify:live` before publishing `dist/index.html`. The live gate opens the public WSS bridge with the Pages Origin, requires a fresh verified payout and healthy node, hashes a bounded real job, submits a share, requires a proxy ACK, and sends Stop. After deployment, Chromium opens the actual Pages URL and verifies idle, a real ACKed browser share, Stop, and idle after reload. A failed post-deploy gate fails the workflow and requires repair; it does not undo the already published artifact. `local_accepted` and `block_candidate` do not mean a confirmed block.
5. Open the deployed HTTPS page. Confirm its bridge badge connects, the actual payout is verified from fresh proxy stats, Start produces independently checked shares, Stop halts hashing, and reload stays idle.

Visitors can enter a custom `wss://` bridge endpoint and an optional CKB mining address in the Connection card. The browser saves these settings locally. The bridge must implement `ckb-128nonce-v1` and allow the Pages origin (`https://OWNER.github.io`). If an address is entered, the browser requires a matching node-verified solo payout before it sends Start, and stops if verification changes. The field does not reconfigure a shared bridge or its node; each different payout needs a compatible endpoint backed by a node block assembler configured for that address. Plaintext `ws://` is allowed only for local development on an HTTP page.

## Current deployment

The public bridge is `wss://eaglesong-dev.wyltekpool.com` and the dedicated real CKB development chain has accepted browser-mined blocks; see [LIVE_INTEROP_REPORT.md](LIVE_INTEROP_REPORT.md). The Pages build labels this as a development-chain demo with no monetary rewards. Mainnet mining remains unverified. `local_accepted` means a proxy ACK, not a block or payout.

For a manual preflight, set `PAGES_BRIDGE_URL` and `PAGES_ORIGIN=https://OWNER.github.io`, then run `npm run verify:live`. It fails after at most four million hashes if no independently validated share is ACKed. The public bridge and real development node passed this gate on 2026-10-13.
