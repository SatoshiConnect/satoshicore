# NSAT — SECURITY CONTROL MATRIX (asset → threat → control → evidence)

Session: 2026‑10‑31. Every row cites its test command or probe.

| Asset/Threat (THREAT-MODEL id) | Control in place | Verification method | Result |
|---|---|---|---|
| Wallet seed at rest (T2) | AES‑256‑GCM + PBKDF2‑SHA256 600k keystore; seed zeroized after single-use; ciphertext-only export | `node --test tests/keystore.test.mjs` | PASS 6/6 |
| Wrong password | Fail closed with non-leaking error; no partial mutation | same suite | PASS |
| Tampered backup blob | Per-entry schema validation (name, G-strkey pubkey, kdf algo+iterations, salt/nonce/box codecs) BEFORE replacing live keystore | same suite (14 malformed cases) | PASS |
| Phishing address pairing | Unlock-time check: derived pubkey == stored `pubkey` else refuse | same suite (`integrity failure`) | PASS |
| Fake web wallet entry | seed strkey never persisted; keystore list exposes name+address only | same suite | PASS |
| Devnet-as-Mainnet (T1) | Byte-exact identity or refuse; blank config fails closed; drift detected between verifications | `node --test services/api-gateway/tests/` (identity suite 1–9) | PASS |
| Network change after verification | Wallet re-verifies per connect; review modal re-renders the exact verified network string in the signing step | browser E2E + identity test 9 | PASS (unit) / PASS (E2E mainnet read-path) |
| Gateway as signing oracle (T3) | No key-handling path; base64-XDR envelope validation only | audit + `gateway.test.js` auth tests | PASS |
| Admin RPC exposure (T4) | 5-route allowlist | curl probes → 404 | PASS |
| Public Core RPC (T5) | Loopback bind | external curl → refused (000) | PASS |
| Non-browser bypass of CORS (T6) | Rate limit/body cap/timeouts apply to every client | `gateway.test.js` | PASS |
| Ledger-busy false authority (T7) | Bounded busy-retry → explicit 503; never a plausible wrong answer | busy-retry tests | PASS |
| Disposable network on LAN (T8) | Devnet gateway bound to 127.0.0.1 | `lsof -nP -iTCP:8787` | PASS (fixed this session) |
| XSS exfiltration (T9) | Static export, controlled rendering, gateway JSON CSP `default-src 'none'; frame-ancestors 'none'; sandbox` | hardening-headers test | PASS (API) / UNVERIFIED (Pages site CSP) |
| Log leakage (T11) | Fixed-field structured logs; no request bodies echoed | audit + static secret scan | PASS |
| Resource exhaustion (T12) | 120 req/min/IP; 64 KiB POST cap; 10 s upstream timeout; 1 MiB response cap | `gateway.test.js` | PASS |
| Host compromise (T13) | None claimed. Host controls are operator actions (FileVault/firewall/backup) | IMAC-HARDENING-RUNBOOK | BLOCKED_OWNER_ACTION |
| Dependency compromise (T10) | Gateway zero runtime deps; audit tracked; lockfile refreshed this session | `npm audit` | PASS (gateway) / 21 findings UNRESOLVED on Next web app → RESIDUAL-RISKS |
| CI secrets (T20) | No secrets in repo/workflows; secret scan in repo | `node tests/security-scan.mjs` | PASS |
| Unknown future vulns | fail-closed identity, signed-envelope-only, loopback bindings, minimal surface | architecture stance | UNVERIFIED by design (standing) |
