# NSAT Web Wallet — GO / NO-GO

Verdict date: 2026-10-31 · Commit `0575685`

## Verdict: GO for staging AND for the published static site (HTTP). NO-GO still for the full production wallet (gateway-dependent) and for HTTPS enforcement.

Engineering-controlled work for the transparent (non-Shielded) web wallet is
complete and evidence-backed. What stands between now and a public wallet is
strictly deployment authorization + external validation, NOT code.

## Per-state verdict

| State | Verdict | Reason |
|---|---|---|
| ENGINEERING_COMPLETE | **GO** | All in-scope features implemented; suites green: static-export 5/5, security scan clean, gateway+identity 21/21, disposable-devnet E2E 5/5 with exact conservation |
| STAGING_VERIFIED | **GO** | E2E ran the real build-sign-submit-finalize path on a disposable devnet through the real gateway; identity-masquerade negative tests pass |
| MAINNET_READ_ONLY_VERIFIED | CONDITIONAL | Identity constant is compiled-in and artifact-gated; a live read-only pass against the DEPLOYED PRODUCTION gateway has not happened yet because the gateway isn't publicly deployed |
| PRODUCTION_GATEWAY_DEPLOYED | **NO-GO** | Requires operator authorization + hosting (domain/TLS/process supervision) — runbook ready in WEB-WALLET-GATEWAY-DEPLOYMENT.md |
| PUBLIC_DEPLOYMENT_APPROVED | **GO (2026-10-31)** | Owner approved deployment; CI deploy job is now gated on main pushes or explicit workflow_dispatch; Pages source migrated from legacy gh-pages to Actions artifacts next deploy is live |
| PUBLIC_WALLET_LIVE | **PARTIAL (2026-10-31)** | Static site PUBLISHED at http://wallet.satoshicore.org/ (owner-approved domain; run 41152790152) — served over HTTP 200 for `/` and `/wallet/`. HTTPS not yet serving: the TLS certificate is still provisioning and enforcement must be flipped in Repository → Settings → Pages → Enforce HTTPS once issued (API PATCH refused; TXT challenge absent). Wallet's transactional features stay offline (fail-closed) until the production gateway exists |

## Blocking conditions to flip to GO (checklist)

1. Operator deploys the production gateway per the runbook (§3 bring-up +
   §4 pre-flight) and provides the HTTPS origin.
2. Static artifact REBUILT with `NEXT_PUBLIC_API_GATEWAY_URL=https://<gateway-origin>`
   and re-verified (artifact identity gate + security scan + a read-only
   Mainnet pass through the deployed gateway).
3. Safari/WebKit + Android Chromium wallet matrix tested (currently UNVERIFIED)
   — or the release explicitly ships Chromium-only messaging.
4. `npm audit` deviations (CI warnings) resolved or explicitly risk-accepted in
   WEB-WALLET-SECURITY-REVIEW.md §5.
5. Owner signs the deployment approval; only then is the CI gate lifted.

## Standing cautions

- Web Shielded support is OUT OF SCOPE and is NOT claimed anywhere in the docs; do not enable or advertise Shielded from the web client.
- No Mainnet transaction of any kind was submitted in this cycle; Treasury keys were never approached.
- The E2E conservation evidence is a disposable-devnet fact, not a Mainnet claim.
