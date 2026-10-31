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
