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
| R7 | Inactivity auto-lock for the web wallet not yet implemented | LOW | Open | Future hardening item (idle timer); no protocol impact |
| R8 | E2E suite skip-by-default without disposable devnet env | LOW | By design (no Mainnet txs from the CI/E2E path) | Keep; document in release manifest as deliberately skipped |
| R9 | `next build` production artifact stale vs latest wallet lib edits (unit/static suites green; rebuild+redeploy pending) | LOW | Open | Rerun Gate 4 (`next build` + static-export suite) at next deploy window |
| R10 | Browser runtime compromise (malicious extension/exploit) is OUT of scope of every control here | Acknowledged | Standing assumption | Threat model: minimize seed lifetime; no effective software guarantee possible |

## Explicit non-claims
- No control above claims protection against host-root compromise.
- Nothing claims zero vulnerabilities or future-attack immunity.
- All "PASS" statements elsewhere in this suite reference the exact test command that produced the evidence.
