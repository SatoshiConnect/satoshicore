# NSAT Web Wallet — Security Review (transparent release)

Review cycle: 2026-10-31 · Commit `0575685`. No security certification is claimed by this document; findings and invariants only.

## 1. Key custody (browser)

| Area | Finding | Status |
|---|---|---|
| At-rest storage | Ciphertext-only in `localStorage` key `scw-web-keystore-v1`; plaintext seed is never persisted | PASS (code-verified) |
| Key derivation | PBKDF2-SHA256, 600,000 iterations; AES-256-GCM for the seed envelope | PASS (code-verified) |
| Keystore format stability | v1 format; every format change requires an explicit migration path plus tests (per invariant in `.agents/skills/nsat-web-mainnet-release/SKILL.md`). No format change was made in this cycle, so no silent upgrade exists | PASS |
| In-memory lifetime | Seed wiped after use (`scrub` in `lib/nsatWallet.js`); no idle-time seed retention documented in code | PASS (code-verified) |
| Seed transmission | No code path sends keystore/seed material over the network; gateway is keyless by contract and by implementation (server test suite asserts no proxy route can accept key-shaped payloads) | PASS (code + tests) |
| Console/log leakage | No `console.log` of seed/keystore in `lib/`, `components/`, or `services/api-gateway/` | PASS (security scan: clean) |
| Clipboard | Address copy only; no auto-copy of seed/password implemented | PASS |

## 2. Explicit limitations (do not overstate)

- Encrypted `localStorage` is NOT hardware-wallet-grade security. XSS in the page context can reach the DOM; mitigations for this release are: absence of secret auto-exposure, hardcoded CSP policy at the deployment layer, and no network egress of secrets. An XSS finding would still be high severity → treat as a standing release gate.
- Single-key custody (no multisig, no OS-keychain enclave in this release). OS-backed storage is future work.
- `npm audit --omit=dev --audit-level=high` is wired into the deploy workflow; current deviations are reported as CI warnings and must be answered in this document before public release.

## 3. Mainnet identity protection

- Fail-closed exact-match on the full production passphrase (`NSAT Mainnet ; October 2026 ; bc3098829fffc717`).
- Refused states: prefix-consistent imposters, differing suffix, whitespace variance, empty/malformed identity, gateway outage, post-verification network change.
- Signing always uses the locally compiled-in verified identity, never a server-echoed string — so a masquerading gateway cannot induce off-network signatures.
- Negative tests: `services/api-gateway/tests/sdk-identity.test.mjs` (9 identity scenarios).

## 4. Gateway exposure control

- Strict route allowlist: `/health`, `/api/v1/network/status`, `/api/v1/chain/info`, `/api/v1/account`, `/api/v1/tx` only; no admin core endpoints proxied (verified by gateway suite 21/21).
- Body-size limit → HTTP 413; per-IP fixed-window rate limit; CORS origin allowlist; bounded upstream timeout (10s) with bounded busy-retries then explicit HTTP 503; structured JSON logs without request keys or payloads of secrets.
- The core's HTTP listener stays on loopback (127.0.0.1) — the gateway is the only public surface.

## 5. Supply chain

- Web app: zero runtime dependencies beyond the Next.js build toolchain declared in `package.json`; gateway server is dependency-free (`require('node:…')` only).
- Pinned versions in `package-lock.json`; deploy workflow runs `npm audit --omit=dev --audit-level=high` and flags findings.

## 6. Open security items before PUBLIC_WALLET_LIVE

1. Production HTTPS origin with CSP/HSTS secure headers verified against the real deployment (deploy-time check, checklist in WEB-WALLET-GATEWAY-DEPLOYMENT.md).
2. Cross-browser (Safari/WebKit, Android Chromium) key-derivation consistency test (web crypto available subset differences).
3. Independent review of the Ed25519/codec implementation is NOT done; functional tests pass but this is not a cryptographic certification.
