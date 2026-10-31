# SECURITY TEST RESULTS — 2026‑10‑31 session

Every line below is an actually-run command or probe with its live result.

## Automated suites (all green)

| Command | Scope | Result |
|---|---|---|
| `node --test services/api-gateway/tests/` | gateway + SDK contract + identity drift suites | 22/22 PASS (incl. NEW hardening-header case) |
| `node --test tests/keystore.test.mjs` | key custody, restore integrity, unlock integrity | 6/6 PASS |
| `node tests/static-export.test.mjs` | Pages static export constraints (no secrets/artifacts) | 5/5 PASS |
| `node tests/security-scan.mjs` | credential/admin/internal-service secret scan | 30 files clean PASS |
| `npm audit` | dependency vulnerabilities | tracked (NOT all green — see RESIDUAL-RISKS) |

## Live read-only production probes (no mutation)

| Probe | Expected | Result |
|---|---|---|
| `curl :8790/api/v1/network/status` | Mainnet identity, ledger advancing | ledger 88,790, identity byte-exact ✔ |
| `curl :11626/info` from a non-loopback interface | refused | 000 ✔ |
| `curl :8787/*` (devnet gateway) | loopback-bound post-change | `lsof` shows `127.0.0.1:8787` ✔ |
| `curl :8790/bans`, `curl :8790/api/v1/droppeer` | 404 (allowlist) | 404 ✔ |
| Gateway `serverTime` field | authoritative closeTime | populated ✔ |
| Hardening headers on live gateway responses | present | nosniff, DENY, no-referrer, CSP, HSTS ✔ |

## Browser verification of wallet posture
- Overview / Send / Review-modal screenshots under `tests/screenshots/` show the
  live Mainnet badge (verified identity), live base fee 10 stroops, and the
  pre-sign review modal (destination, amount, fee, total debit, exact network
  string) — visual evidence only, no transaction submitted.

## NOT run (with reasons)
- Rust/nsat-core consensus suites: out of scope for the web session; no core source changed; recorded without fabricated results.
- Full production static rebuild (`next build`) after the wallet hardening edits: wallet unit + static suites green; a fresh production build/deploy is covered by Gate 4 at deploy time (REPORTED, not silently skipped).
- Safari/WebKit, native builds: not this session's target.

## Honest NO conclusion about absolute security
No run here establishes zero vulnerabilities. It establishes: specific
controls verified, specific weaknesses fixed, and remaining risks listed
explicitly.
