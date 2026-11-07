# NSAT Web Wallet — Gateway Deployment Runbook

Commit `0575685` · gateway source `services/api-gateway/server.js` (zero runtime dependencies)

## 1. Contract (matches `openapi.yaml`)

| Endpoint | Behavior |
|---|---|
| `GET /health` | Gateway liveness only (core health is NOT implied) |
| `GET /api/v1/network/status` | gateway + core liveness, current ledger, network name echo |
| `GET /api/v1/chain/info` | proxied core `/info` (ledger num/hash, baseFee, baseReserve, protocol version) |
| `GET /api/v1/account?acc=G…` | exact account read: `balance128` (decimal string), `seqnum` |
| `POST /api/v1/tx {envelope_xdr}` | relay of ALREADY-SIGNED envelopes to core `tx` |

Guards verified by `services/api-gateway` test suite (21/21 as of this commit):
route allowlist (no admin proxy), 413 body limit, per-IP rate limit, CORS
allowlist, bounded upstream timeout, core-busy bounded retry → explicit 503,
mismatched-network envelopes forwarded verbatim for core verdict (client
identity gate is authoritative, see WEB-WALLET-SECURITY-REVIEW.md §3).

## 2. Environment

| Variable | Meaning | Production guidance |
|---|---|---|
| `PORT` | gateway listen port | e.g. 8787 behind reverse proxy |
| `NSAT_CORE_HTTP_URL` | core HTTP interface the gateway relays to | MUST stay loopback/private (127.0.0.1); core admin endpoints stay unreachable publicly |
| `ALLOWED_ORIGINS` | comma-separated browser origins | exact production origin(s); never `*` |
| `MAX_BODY_BYTES` | envelope cap | keep 64 KiB default |
| `RATE_WINDOW_MS` / `RATE_MAX_REQUESTS` | rate limit window/ceiling | tune to expected traffic; default 120 req/60s per IP |
| `CORE_TIMEOUT_MS`, `CORE_BUSY_RETRIES`, `CORE_BUSY_DELAY_MS` | upstream pacing | defaults are sane; raise retries only if core is chronically busy |

No secret variables exist for the gateway by design — it never holds key material.

## 3. Bring-up procedure

```bash
cd services/api-gateway
PORT=8787 \
NSAT_CORE_HTTP_URL=http://127.0.0.1:11626 \
ALLOWED_ORIGINS=https://<production-origin> \
node server.js            # or run under your process supervisor
curl -s https://<gateway-host>/health          # expect {status:"ok"}
curl -s https://<gateway-host>/api/v1/network/status
```

## 3a. Live production deployment on this iMac (2026-10-31)

The gateway is installed as a launchd LaunchAgent, TCC-safe, keyless, loopback-bound:

| Item | Value |
|---|---|
| Service label | `org.satoshicore.gateway` (`~/Library/LaunchAgents/org.satoshicore.gateway.plist`) |
| Runtime copy | `~/nsat-ops/gateway/server.js` (deploy target outside `~/Desktop` to avoid macOS TCC file-access denial) |
| Listen | `127.0.0.1:8790` only (never exposed directly; TLS termination is before/around it) |
| Upstream | `NSAT_CORE_HTTP_URL=http://127.0.0.1:11626` (node A HTTP interface, loopback) |
| CORS allowlist | `https://wallet.satoshicore.org`, dev origins `:3000`, static-export check origins `:8899` |
| Deploy/upgrade | `~/nsat-ops/deploy-gateway.sh` (repo → runtime copy → launchd restart → health probe) |
| Verified live | `GET /health` 200; `GET /api/v1/network/status` 200 with ledger ~89,5xx, identity echoed byte-exact; foreign-origin preflight 403 |

`ALLOWED_ORIGINS` lives in BOTH the plist `EnvironmentVariables` (authoritative — it
overrides the wrapper default) and `~/nsat-ops/gateway-launch-wrapper.sh`; update both
whenever the deploy domain changes. The web build pipeline
(`.github/workflows/deploy-pages.yml`) now bakes `NEXT_PUBLIC_API_GATEWAY_URL` and the
byte-exact network identity into every artifact.

### 3b. Runtime refresh to the read-surface build (2026-11-07)

The launchd service was still running a 2026-11-05 runtime copy that predated
`131803b` ("proxy the rest of the wallet's read surface"), so `GET /v1/tx/{hash}`
answered `{"error":"not found"}` on port 8787 while the indexer on 8789 returned
the transaction — the wallet read path disagreed with the explorer.

| Item | Value |
|---|---|
| Source | `integrate/wallet-exact-hash` @ `131803b` (`services/api-gateway/server.js`) |
| Runtime sha256 | `57d5c9f23e8cc81a…` (`~/nsat-ops/gateway/server.js`) |
| Pre-deploy backup | `~/nsat-ops/gateway/server.js.bak-20261107T081218Z-adhoc` |
| Tests | `node --test tests/` → 37 passed, 0 failed |
| Verification | 15/15 random transactions byte-identical across gateway 8787, indexer 8789 and shadow indexer 8796; unknown hash relays the indexer's 404 body; malformed/uppercase/traversal → 400; `POST /v1/tx/{hash}` → 404; CORS echoes the allowlisted origin only; `Cache-Control: no-store` |

Deploy used `GATEWAY_SRC=.shadow-release/web-integration/services/api-gateway ~/nsat-ops/deploy-gateway.sh`
because the default source branch (`feat/latency-exact-hash-confirmation`) does not
contain the read-surface routes. The script now honours `GATEWAY_SRC` so a deploy
can no longer silently drop them.

**Known dependency:** `GET /v1/confirmations/{hash}` needs an indexer build that
serves `/v1/confirmations`; the production indexer on 8789 still answers 404 there
so that one route returns 503, while the shadow indexer on 8796 serves it. Upgrading
the production indexer to the shadow build closes it — deliberately not done by
pointing the production gateway at 8796, which would route live wallet traffic to
the shadow known-host.

Reverse-proxy requirements: terminate TLS with modern ciphers, set
`Content-Security-Policy` and `Strict-Transport-Security` at the edge, do NOT
forward `X-Forwarded-*` trust for the rate limit unless the proxy is trusted.

## 4. Pre-flight checklist (tick before PUBLIC gateway exposure)

- [ ] Core HTTP listener reachable ONLY on loopback from the gateway host
- [ ] `ALLOWED_ORIGINS` exact-match production origin (not `*`)
- [ ] `/health`, `/api/v1/network/status` return 200 from the public HTTPS origin
- [ ] CORS: a foreign origin receives no permissive header
- [ ] Oversized body → 413; burst → 429; core-down → 502/503 (bounded)
- [ ] No admin core route (e.g. `/setledger`, upgrades, bans) answers through the gateway
- [ ] Log review: no keys, no envelopes-with-secrets, no IP-leak of internal hosts

## 5. Blockers (unchanged)

Public gateway deployment itself requires separate operator authorization and
hosting (domain, TLS certificate, process supervision). No credentials are
embedded; no DNS was modified; the deploy workflow gates the static site
behind explicit owner action (`.github/workflows/deploy-pages.yml`).
