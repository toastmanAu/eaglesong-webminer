# SECURITY

## Threat model (MVP, solo mode)

| Asset | Threat | Control |
|---|---|---|
| CKB node RPC (`get_block_template`, `submit_block`) | exposure to the web | never reachable from the browser; only `solo-proxy.js` talks to it, and the bridge only talks Stratum to the proxy on loopback |
| Stratum endpoint selection | browser-chosen upstreams / SSRF | no host/port/url field is accepted in any browser frame (`ws-schema.js` rejects them by name and by closed schema); upstream comes only from the server config |
| Bridge availability | floods | per-IP/global connection caps, 16 KB frame cap (`ws` `maxPayload` → close 1009), per-session submit rate limit (block candidates exempt so a real solution is never dropped), heartbeat ping/pong |
| Share accounting | forged/replayed shares | bridge recomputes Eaglesong, checks the session prefix, keeps a duplicate set keyed `{jobId, nonce}`, judges by generation snapshot; unknown generations are **rejected**, never ACKed |
| Browser trust | asserted hash/difficulty | `hashHex` is diagnostic; acceptance depends only on server recomputation |
| Payout | user believes a typed address pays them | the UI shows the endpoint-reported payout. An optional entered address is checked against a node-verified solo payout before Start and on updates; it cannot redirect rewards. The bridge verifies only healthy fresh templates without payout drift. |
| Covert mining | mining without consent | nothing hashes before Start; reload/reconnect never auto-starts; hidden tab pauses by default; `pagehide` stops workers and the upstream session |
| Supply chain | third-party runtime code | `dist/index.html` is self-contained; CSP meta `default-src 'none'`. `connect-src wss:` allows user-selected secure bridge endpoints on the public page. Browser users must trust the endpoint they choose; its payout verification is an assertion by that endpoint, not independent browser access to a CKB node. |
| Secrets | leakage in the page/logs | no pool credentials, keys or internal hostnames in `dist/`; the bridge log redacts browser IPs to `/16`; `/healthz` exposes counts only |

## Public deployment (Deployment B) checklist

- Terminate TLS in front of the bridge (reverse proxy or tunnel); serve the page over HTTPS so the WebSocket is `wss://`.
- Set `bridge.allowedOrigins` to the exact page origin(s). The bridge refuses missing/unknown `Origin` with 403.
- Set `bridge.trustedClientIpHeader` to `cf-connecting-ip` only when a trusted Cloudflare tunnel is the sole local peer. Otherwise the socket peer is the client IP. Set `maxConnectionsPerIp` for the expected audience.
- Add HTTP response headers at the static host: `Content-Security-Policy: frame-ancestors 'none'` (header-only directive; the inlined meta CSP covers everything else), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.
- Keep `stratum.host` loopback; run the bridge as an unprivileged user; put per-IP rate limits at the proxy layer too.
- Keep tunnel credentials and any deployment tokens outside the repository and browser artifact. The Stratum `"x"` authorization value is a protocol placeholder, not a secret.

## Reporting

Open an issue marked *security* in the repository that hosts this project; do not include live share/nonce data from mainnet sessions.
