# PASS 2 progress — 2026-10-13

PASS 2 is **in progress**. No real CKB node has accepted a block in this project.

## Implemented

- The bridge can read the solo proxy's loopback stats endpoint when `stratum.statsPort` is configured. It uses the node-derived `payoutAddress` only with a healthy node, no payout drift, and a template at most 120 seconds old. Missing or stale stats revoke verification in connected browser sessions.
- The bridge now publishes a job received before Stratum connection setup finishes. Previously, a target and notify arriving before `connect()` resolved could leave the browser without a job.
- A network-target candidate rejected by upstream remains a `block_candidate` but has `accepted: false`. A Stratum ACK remains only local acceptance.
- An opt-in bridge-side browser target overlay now starts at about 100,000 hashes/share, clamps client calibration, hardens after bursts of independently valid shares, and never makes the target easier than the proxy's. The proxy and ASIC paths were not changed. This has unit evidence only; the real-proxy browser gate remains open.
- Ordinary shares for a replaced job are rejected before the proxy can blindly ACK them. Retained old-job network candidates are still recomputed and forwarded.
- The CPU worker emits a network-target solution even when a harder browser share target excludes it. Candidate-capped batches return their unsearched tails to the coordinator, including at the end of the 64-bit counter space.
- A reused upstream job ID cannot make an old ordinary share current. Stopping or losing the upstream connection clears old job snapshots, so a candidate from one Stratum session cannot enter the next.

## Evidence

- Fourteen socket-free test files pass, including `web-profile`, `session-correctness`, `coordinator`, `mine-batch`, and `proxy-stats`. They cover target clamps, advisory calibration, observed-share hardening, old-job and cross-session rejection, captured network candidate recovery, nonce continuity through candidate caps, mocked stats HTTP limits, and upstream rejection.
- `npm run build` succeeds.
- This execution environment denies loopback `listen()` with `EPERM`, so the socket-backed bridge, real proxy, browser, and devnet gates could not be rerun here. Their PASS 1 evidence remains in `PASS1_REPORT.md`; it does not prove PASS 2.

## Remaining PASS 2 gate

1. Run a dedicated unmodified proxy instance on port 3334 with `initialDiff` and `minDiff` at 1e-6; do not use values below its known precision limit. The bridge profile remains opt-in. If the proxy code itself is changed later, add K7/GodMiner and Goldshell/NerdMiner regression coverage first.
2. Run the browser through the bridge profile at realistic hashrate and show stable local share delivery without rate-limit flooding. Verify the proxy's vardiff does not outrun the bridge's selected target.
3. Run a private Eaglesong CKB devnet, obtain a real `submit_block` response, and verify nonce and cellbase lock on chain as described in `docs/LIVE_INTEROP_REPORT.md`.
