# RESIDUAL RISKS — NSAT (2026‑10‑31 session)

Everything that remains open after this hardening session, honestly labeled.
Nothing here should be read as "accepted" — each item carries its owner/next step.

## FIX-EXCELLENT/summary of session deltas
- FIXED: devnet/no-disposable gateway exposure on LAN (loopback bind enforced).
- FIXED: missing HTTP security headers (CSP, frame-ancestors, nosniff, HSTS).
- FIXED: gateway `serverTime` always-null (now authoritative ledger closeTime).
- FIXED: tampered-keystore acceptance (restore schema validation + unlock-time
  signing-key/address integrity check with 6/6 regression tests).

## OPEN — required by directive to be listed here

| ID | Risk | Sev | Status | Next step / owner |
|---|---|---|---|---|
| R1 | Next.js 14 production advisory set (1 critical: Server-Actions DoS; several high/moderate) | HIGH (product) | Open — `npm audit fix` could not remove; fix requires breaking upgrade to Next 16.4.3 **owner-approved breaking upgrade + full regression** | Mitigations in force: production artifact is a STATIC EXPORT (no Server Actions/image optimizer/middleware run in production), dev server is local-only. Not a zero risk — flagged for a scheduled major upgrade |
| R2 | Site-level CSP on wallet.satoshicore.org (GitHub Pages does not support custom CSP headers) | MEDIUM | Open | Mitigation: static export with inlined subresources only, no remote scripts in the wallet bundle; consider adding a CSP `meta` tag (owner-approved change to the wallet layout, low cost) |
| R3 | Single-host validator topology (3 validators + vault + gateway on one iMac): liveness SPOF; not a consensus-safety issue | HIGH (ops) | Open — design-level, requires topology migration approval | Owner-approved multi-host rollout per IMAC-HARDENING-RUNBOOK item 8 |
| R4 | Hardward-wallet/air-gapped signing for Treasury not implemented | HIGH (custody) | Open | Owner custody program (TREASURY-ISOLATION-PLAN items 4–5) |
| R5 | Shielded protocol external cryptographic audit not yet performed | HIGH | PENDING_EXTERNAL | Independent qualified reviewer; gate for public Shielded user funds |
| R6 | Post-quantum migration: Ed25519/Halo2 signatures are not PQC | MEDIUM (long-term) | Open — deliberate; NO swap without a protocol design + compatibility testing + coordinated upgrade, per directive | Documented as cryptographic-agility requirement in THREAT-MODEL T14 |
| R7 | Inactivity auto-lock for the web wallet not yet implemented | LOW | **FIXED (2026-11-14)** | 5-minute idle lock (1–60 min configurable, not disableable) + immediate lock on background/pagehide; UI behavior still needs a browser pass |
| R8 | E2E suite skip-by-default without disposable devnet env | LOW | By design (no Mainnet txs from the CI/E2E path) | Keep; document in release manifest as deliberately skipped |
| R9 | Production artifact stale vs latest wallet lib edits | LOW | **FIXED (2026-11-14)** — rebuild deployed to the Caddy webroot from commit `5f4eaa0`; `npm run verify:deployed` passed 8/8 (2 advisory) | Keep the deploy step and `verify:deployed` in every wallet release |
| R10 | Browser runtime compromise (malicious extension/exploit) is OUT of scope of every control here | Acknowledged | Standing assumption | Threat model: minimize seed lifetime; no effective software guarantee possible |
| R11 | CSP `connect-src 'self' https:` lets an injected script exfiltrate to any HTTPS host; CSP is a `<meta>` tag so `frame-ancestors` is unavailable | MEDIUM | Open — narrow allowlist + `frame-ancestors` header need a staged sign-in/Drive test and a Caddy config change | See `WALLET-WEB-REVIEW-2026-11-16.md` F6/F7 |
| R12 | Keystore export (no password) carries names/addresses of wallets the current session hides | MEDIUM | Mitigated (explicit warning in the export toast); full filtering needs an owner decision because a filtered file is a smaller backup | `WALLET-WEB-REVIEW-2026-11-16.md` F5 |
| R13 | Drive backup file contains wallet names and public addresses in readable form (seeds encrypted) | MEDIUM | Disclosed in the card and `/privacy/`; re-encrypting metadata is a format change and not done | `WALLET-WEB-REVIEW-2026-11-16.md` F4 |
| R14 | Chat has no Double Ratchet: a leaked wallet seed decrypts stored envelopes (up to the 30-day retention) and there is no post-compromise recovery | MEDIUM | Open — deliberate (hand-rolled ratchet explicitly rejected); per-message ephemeral keys, 30-day retention, delete-on-read | `E2E-CHAT-DESIGN.md` "Cryptography honesty" |
| R15 | Chat relay learns who talks to whom, when, and the message size | MEDIUM | Disclosed; hiding the social graph needs padding and cover traffic, not built | `E2E-CHAT-DESIGN.md` "What the relay learns" |
| R16 | Chat is not enabled on the production gateway or web root; the relay exists and is tested, but no user can reach it | INFO | Open by choice — enabling restarts the wallet's read surface (`NSAT_CHAT_RELAY=1`) and needs operator approval | `E2E-CHAT-DESIGN.md` "Enabling it" |
| R17 | Chat transcript is session-only: locking the wallet or closing the tab loses it, because nothing plaintext is written to storage | LOW | By design (shared-device trade-off); the relay deletes a message once it is read, so there is no second copy | `E2E-CHAT-DESIGN.md` "Client" |
| R18 | Profile ID lookup is exact-ID only: a signed-in account can check whether one ID is free, and cannot list claims | LOW | By design (`allow get`, `allow list: if false`) | `PROFILE.md` |
| R19 | A profile cannot prove wallet ownership or sign anything; a primary wallet is a display preference over an already-linked public address | INFO | Stated in the card and the docs; no signing path is reachable from `lib/profile.js` | `PROFILE.md` |
| R20 | Profile writes are not exercised against a live database (needs a signed-in account and published rules) | MEDIUM | Open — the rules and the module are tested; the live round trip is not | `PROFILE.md` "What is verified" |

## Explicit non-claims
- No control above claims protection against host-root compromise.
- Nothing claims zero vulnerabilities or future-attack immunity.
- All "PASS" statements elsewhere in this suite reference the exact test command that produced the evidence.
