# GATEWAY SECURITY AUDIT — satoshicore-web/services/api-gateway

Commit basis: `f8004b1…` + hardening diff; gateway code `server.js` (365→383 lines).

## Verified properties (all PASS this session)

| Property | Evidence |
|---|---|
| Keyless relay: no key-handling code path; only base64 XDR envelopes accepted (`validateEnvelope`, ≤8192 chars) | code audit + unit tests |
| Explicit 5-route allowlist; admin endpoints unproxyable | `GET /bans` → 404, `GET /api/v1/droppeer` → 404 (live probe) |
| Rate limiting 120 req/min per IP with bounded memory | `rate limit enforced per IP` ✔ |
| Body cap 64 KiB → 413, upload drained so client receives the response | `oversized POST body rejected with 413` ✔ |
| Upstream timeout 10 s; upstream responses capped at 1 MiB | code audit |
| Busy (ledger-close) responses retried with bounded exponential backoff, then explicit 503 — never surfaced as a definitive zero balance / missing account / failed submit | `busy responses retried…✔`, `permanently busy core yields explicit 503 ✔` |
| CORS: exact-origin allowlist only, no wildcard reflection except explicitly configured; preflight from disallowed origin → 403 | `gateway: … CORS … ✔` |
| Network identity comes from the RUNNING core (not env) so clients verify the chain itself; malformed → null → wallet fails closed | `network status: identity comes from the running core ✔`, `…identity missing → network null ✔` |
| Account query: strict 56-char G-strkey validation | `account route validates G-strkey ✔` |
| Safe errors: upstream bodies replaced with `core node error {upstream_status}`; no internal detail echoed | code audit |
| Structured logs with fixed fields; no request bodies/secrets logged | code audit |
| NEW this session: hardening headers on every response (JSON, proxied, 404): nosniff, X-Frame-Options DENY, Referrer-Policy no-referrer, CSP `default-src 'none'; frame-ancestors 'none'; sandbox`, HSTS (inert over HTTP, enforced when TLS front is added) | `hardening headers present on every response ✔` (22/22 suite green) |
| NEW this session: `serverTime` is now the authoritative `ledger.closeTime` from core (fix: previously a non-existent field, always null) | live probe on 8790 |

## NEW control: explicit bind address
`NSAT_GATEWAY_HOST` (default all interfaces). The disposable devnet gateway
(PID 72832 → restarted as PID 12908) is now loopback-only:
`lsof -nP -iTCP:8787 -sTCP:LISTEN` → `127.0.0.1:8787`.

## Live production probes (read-only, 2026‑10‑31)

- `GET :8790/api/v1/network/status` → `core: ok, ledger 88790, network "NSAT Mainnet ; October 2026 ; bc3098829fffc717"` ✔
- Core `:11626/info` reachable only from loopback; host-interface probe refused ✔

## Compromised-gateway thought experiment (required by directive)
A fully compromised gateway process **cannot produce a spending signature**:
it holds no kernel of key material, no seed, no password — it can only relay,
drop, or lie (drop → wallet reports unfinalized; lie about identity → identity
check refuses mismatch). It can still DoS or misdirect a victim to a *correctly
rendered* review modal with its own destination — which the user sees before
signing. Residual risk: gateway-level DoS and misleading **read** data; not
signature forgery. This is the correct blast radius for a public relay.

## BLOCKED / UNVERIFIED
- TLS is terminated by the operator's reverse proxy front, not this process — HSTS here is inert until the HTTPS front is in place (deployment runbook covers it).
- No mTLS/API-key tier exists between browser and gateway (owner decision recorded as an open option; keyless was chosen deliberately).
