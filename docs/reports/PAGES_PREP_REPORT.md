# GitHub Pages release preparation — 2026-10-13

Status: **prepared locally, not published**. `dist/index.html` built with `wss://bridge.example.org` is a validation artifact only; that hostname is a placeholder.

## Completed

- Added a Pages workflow that runs unit, integration, and browser tests; audits repository files; requires a public WSS bridge URL; audits the generated page; verifies a healthy public bridge and an ACKed genuine share; and deploys only after every pre-deploy gate passes. A separate post-deploy Chromium gate tests the actual public page. If it fails, the workflow fails, though the deployed artifact remains live until repaired.
- Removed the browser bundle's localhost bridge fallback. The public build refuses missing, plaintext, local-IP, and non-public host URLs.
- Added source and artifact secret audits, a non-destructive dependency audit, a project MIT license, and deployment instructions.
- Removed private LAN addresses from public docs. The latest source audit scanned 117 candidate files and found no matched keys, tokens, or LAN addresses.
- Added explicit per-IP WebSocket connection caps and an optional Cloudflare client-IP header that is trusted only from a loopback tunnel peer.

## Verified locally

- Fifteen socket-free test files pass, including Pages URL, bridge correctness, the opt-in browser target profile, nonce continuity through candidate-capped batches, and a mocked live-gate flow.
- `./scripts/check-deps.sh` passes.
- `PAGES_BRIDGE_URL=wss://bridge.example.org npm run build:pages` and `node scripts/audit-pages-artifact.mjs` pass.
- The Pages workflow parses as YAML.
- The public WSS live gate has not run against a real host yet; its unit test covers verified payout, Start, job, genuine Eaglesong share, ACK, Stop, and fail-closed cases.
- The post-deploy browser test is intentionally skipped without `PAGES_URL` in local runs. `REQUIRE_PUBLIC_PAGE=1` makes a missing URL fail closed; this was checked locally. Its real public run remains pending.

## Open blockers

- The workspace's `.git` directory is read-only: `git init -b main` fails with `Read-only file system`. The project is still not a Git repository.
- `gh auth status` reports an invalid token for the configured GitHub account. No repository was created or pushed.
- The final repository name and public WSS backend host are pending. GitHub Pages cannot run the Node bridge.
- This execution environment denies local socket binding (`EPERM`), so socket-backed tests and the real CKB node gate could not be rerun here.
- PASS 2's opt-in bridge target has unit tests, but real proxy and browser validation plus the CKB node acceptance gate are not complete. A public site must not claim production solo mining before those gates pass.
