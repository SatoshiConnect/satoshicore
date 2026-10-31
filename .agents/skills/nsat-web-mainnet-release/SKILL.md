---
name: nsat-web-mainnet-release
description: Verify, secure, build, test, and release the existing NSAT Web Wallet against the exact NSAT Mainnet network identity and production API Gateway. Use for wallet deployment, Mainnet connection, security reviews, CI/CD, and production release acceptance.
license: Proprietary (SatoshiConnect). Internal engineering guidance; no third-party content.
---

# nsat-web-mainnet-release

Govern the NSAT Web Wallet production release: exact Mainnet identity, browser key custody, gateway posture, HTTPS deployment, and the release gate.

## When to invoke

Any task mentioning production release, Mainnet connection, deployment, staging acceptance, or GO/NO-GO for the Web Wallet.

## Authoritative constants (verify, never re-derive ad hoc)

- Mainnet identity (full passphrase — byte-exact, verified in `nsat-core` MAINNET-ACTIVATION-20261025 + echoed live by all validators):
  `NSAT Mainnet ; October 2026 ; bc3098829fffc717`
- Default base fee on Mainnet genesis: `10` stroops (confirm live via `/api/v1/chain/info`)
- Gateway contract: `services/api-gateway/openapi.yaml` — routes `/health`, `/api/v1/network/status`, `/api/v1/chain/info`, `/api/v1/account`, `/api/v1/tx` ONLY (strict allowlist; no admin endpoints)
- SDK: `lib/nsatClient.js`; wallet engine: `lib/nsatWallet.js`; codec: `lib/nsatCodec.js`; UI: `components/WalletPanel.js`

## Step-by-step release verification (deterministic)

0. Read `WALLET-SKILLS-INVENTORY.md` (`.agents/skills/`) and inspect `WEB-WALLET-*.md` docs for current release state.
1. **Unit + contract + identity suites** (blocking):
   ```
   cd services/api-gateway && npm test
   ```
   Must be green: gateway unit/mock-core tests, SDK↔gateway contract test, and
   `tests/sdk-identity.test.mjs` (9 strict-identity wind-tunnel scenarios).
2. **Static build + artifact scans** (blocking):
   ```
   npm ci && npm run build && npm test && node tests/security-scan.mjs out
   ```
   Security scan must find zero credential/admin/internal-URL findings.
3. **Mainnet identity assertion**: `grep` the built `out/` for
   `bc3098829fffc717` — exactly one occurrence (the embedded default identity
   constant), never a loose "NSAT" fallback.
4. **Devnet E2E** (for behavioral changes; disposable only):
   `bash scripts/wallet-devnet.sh start` (nsat-core repo) on a FRESH
   `NSAT_WALLET_DEVNET_DIR`, gateway with `ALLOWED_ORIGINS=*` bound to the
   devnet core, `NEXT_PUBLIC_NSAT_NETWORK_ID` set to the DEVNET identity for
   the staging build. Never reuse a stale devnet data dir (fee-100 genesis).
5. **Mainnet read-only**: point the SDK at the production gateway and run
   network identity verification + exact-fee + account read + ledger
   advancement checks. NO writes, NO payments, no Treasury credentials ever.
6. **Deployment artifact inspection**: confirm the workflow
   (`.github/workflows/deploy-pages.yml`) still gates the `deploy` job behind
   explicit owner action; record `out/` SHA-256 digest of all files in the
   release manifest.

## Security invariants to re-check on every release

- Wallet sends are enabled ONLY after `verifyNetworkIdentity()` returns ok
  (exact-match; the SDK refuses prefix/witespace/malformed/outage states —
  see `tests/sdk-identity.test.mjs` scenario names).
- Signing: `buildSignedTx({ netPassphrase: EXPECTED_NETWORK_ID })` — the
  verified identity, not an unverified reported string.
- Keystore: AES-GCM-256 + PBKDF2-SHA256(600k), ciphertext-only in
  `localStorage` (`scw-web-keystore-v1`); format changes require a migration
  path + tests (never silently `v:1` → `v:2`).
- Seed material never leaves the browser, is never logged, and is wiped from
  JS memory after use (`scrub`); no clipboard auto-copy of secrets.
- Gateway: keyless, body-size limit, rate limit, origin allowlist, bounded
  upstream timeout, busy-retry with explicit 503, no wildcard proxying.
- Monetary arithmetic: BigInt/string only; confirmed payment requires an
  exact `prev - after == amount + fee` debit check on-chain.

## Evidence requirements

For every PASS claim in release docs, include: exact command, node/browser
version, timestamp, and (for commit-bound claims) the commit SHA. GO/NO-GO
must distinguish ENGINEERING_COMPLETE / STAGING_VERIFIED /
MAINNET_READ_ONLY_VERIFIED / PRODUCTION_GATEWAY_DEPLOYED /
PUBLIC_DEPLOYMENT_APPROVED / PUBLIC_WALLET_LIVE — never collapse them.

## Acceptance criteria

- All suites green with recorded output.
- No unverified network-name acceptance anywhere in `lib/` or `components/`.
- Release docs (`WEB-WALLET-MAINNET-COMPLETION.md`, `WEB-WALLET-SECURITY-REVIEW.md`,
  `WEB-WALLET-GATEWAY-DEPLOYMENT.md`, `WEB-WALLET-E2E-RESULTS.md`,
  `WEB-WALLET-RELEASE-MANIFEST.md`, `WEB-WALLET-GO-NOGO.md`) all present and
  status-consistent with the recorded evidence.
