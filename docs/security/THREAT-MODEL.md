# NSAT — THREAT MODEL (STRIDE + ASSET/CONTROL MATRIX)

Evidence set for the hardening session of 2026‑10‑31 (UTC).
- Web repo commit: `f8004b10b81413b578d8c3fad3ff5ccad0d730fd` + this session's hardening diff
- Core repo commit: `9af27bad7cb58e9a08246dfd6268602ec31ee59a` (branch `feature/shielded-core-integration`)

Nothing in this document claims absolute security. Every control below lists a
verification method; anything not yet verified is marked **UNVERIFIED**.

## Asset classification

| Asset | Where it lives | Compromise blast radius |
|---|---|---|
| Browser-held seed (in memory, unlocked only) | Web/Ddesktop wallet runtime | All funds of that wallet |
| Encrypted keystore (AES‑256‑GCM, PBKDF2 600k) | `localStorage`, backup files | Funds only if the password is also weak/stolen |
| Validator A/B/C signing keys | iMac host, isolated per validator | Consensus halt (7 of 3 impossible; loss of liveness, not safety) |
| Treasury keys | Offline/iMac custody, offline workflow (see TREASURY-ISOLATION-PLAN) | Full treasury |
| Ledger databases | iMac host | Halt/recovery needed; identities and history preserved by backups |
| Core HTTP RPC (11626) | loopback only | Read/tx relay — verified non-public |
| Gateway (8790 prod / 8787 devnet) | node process | Public-facing relay; keyless by design |
| GitHub Pages static site | wallet.satoshicore.org | Phishing UI only; no keys leave browser without owner action |

## Trust boundaries

1. Browser runtime ⇢ HTTPS Gateway — only signed envelopes cross; no key material.
2. Gateway ⇢ Core RPC — loopback, route allowlist, no admin proxying.
3. Core ⇢ Validators/peers — quorum protocol.
4. Browser ⇢ user — phishing/address-spoofing boundary (mitigated by the signing-key/address integrity check).
5. CI/CD ⇢ artifacts — no Mainnet secrets in CI by policy.

## STRIDE per boundary (selected significant threats only)

| # | Threat | Class | Control | Verification |
|---|---|---|---|---|
| T1 | Devnet masquerading as Mainnet (wallet signs over fake network) | Spoofing | Byte-exact network identity, fail closed, 9 unit cases | `services/api-gateway/tests/sdk-identity.test.mjs` — 9/9 ✔ |
| T2 | Tampered keystore pairs a phisher's display address with the victim's signing key | Tampering/Phishing | Unlock-time integrity check: displayed pubkey must equal derived signing key; restore-time per-entry schema validation | `tests/keystore.test.mjs` — 6/6 ✔ |
| T3 | Gateway becomes a signing oracle | Elevation | Gateway has no key-handling code path; validateEnvelope accepts base64 XDR only | code inspection of `server.js`, src audit |
| T4 | Admin RPC reachable through gateway | Elevation | Explicit route allowlist (5 routes), everything else 404 | curl probes: `/bans`, `/api/v1/droppeer` → 404 ✔ |
| T5 | Core RPC publicly reachable | Information disclosure | Core HTTP bound to loopback; external probe to host IP → connection refused | curl `http://<host>:11626` → 000 refused ✔ |
| T6 | Non-browser clients bypass CORS | Repudiation | CORS is browser-only protection; gateway rate-limits/validates/limits body size for everyone | `gateway.test.js` rate-limit + 413 cases ✔ |
| T7 | Ledger-busy answer mistaken for authority (false zero balance / failed submit) | Information disclosure | Busy retried with bounded backoff, then explicit 503; never a plausible wrong answer | busy-retry tests ✔ + live observation |
| T8 | Disposal network reachable from LAN | Information disclosure | Devnet gateway restarted bound to `127.0.0.1` (NSAT_GATEWAY_HOST) | `lsof -iTCP:8787` → loopback only ✔ |
| T9 | Browser XSS exfiltrates unlocked seed | Elevation | Static export, no dangerouslySetInnerHTML in wallet UI; CSP headers on gateway; browser-level CSP for site is a residual gap (see RESIDUAL-RISKS) | code search + static scan ✔, CSP on API: PASS; site CSP: UNVERIFIED (GitHub Pages) |
| T10 | Dependency compromise | Supply chain | Zero-runtime-dep gateway; `npm audit` tracked; secret scan in repo | `tests/security-scan.mjs` ✔; audit findings tracked in RESIDUAL-RISKS (1 HIGH product-facing block on Next 16 upgrade — owner action) |
| T11 | Log/leak of secrets | Information disclosure | Structured logging with fixed field sets (no echo of bodies); static secret scan | scan ✔ |
| T12 | Resource exhaustion at gateway | DoS | Fixed-window rate limit, 64 KiB body cap, upstream 10 s timeout, 1 MiB response cap | tests ✔ |
| T13 | Physical host compromise | — | **No in-browser or process-isolation control defends this.** Not claimed; host controls in IMAC-HARDENING-RUNBOOK | BLOCKED (owner actions) |
| T14 | Unknown future vulnerabilities (e.g. in Next, ed25519 lib, browser engines) | — | Defense-in-depth stance: static export, minimal deps, loopback bindings, fail-closed identity, signed-envelope-only relay. Post-quantum migration documented in RESIDUAL-RISKS | standing program, UNVERIFIED by nature |

## Honest limits explicitly NOT covered

- Host compromise ends process isolation: gateway process ≠ security boundary against the host's root.
- Browser runtime compromise (malicious extension or exploit) defeats everything in the wallet; the design assumes the browser is trusted at unlocking time and limits the seed's lifetime in memory instead.
- Three validators + gateway + vault on one physical iMac is a single-host liveness SPOF (host failure halts finality) even though it is safety-preserving (quorum intersection holds).
