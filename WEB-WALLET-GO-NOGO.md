# NSAT Web Wallet — GO / NO-GO

Verdict date: 2026-10-31 · Commit `0575685`

## Verdict: NO-GO for PUBLIC deployment. GO for staging.

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
| PUBLIC_DEPLOYMENT_APPROVED | **NO-GO** | Explicit owner approval not yet given; the CI deploy job remains behind a manual approval gate |
| PUBLIC_WALLET_LIVE | **NO-GO** | Depends on both above + remaining UNVERIFIED platform matrix |

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
