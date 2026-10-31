# NSAT Web Wallet — Release Manifest

Like-for-like reproducibility record for the CURRENT release candidate. Any
future build must regenerate this exact manifest before replacing it.

## 1. Source

| Field | Value |
|---|---|
| Repository | https://github.com/SatoshiConnect/satoshicore |
| Branch | `feature/web-platform-v1` |
| Commit | `0575685` "web wallet: fail-closed mainnet identity, gateway hardening, release skill and devnet e2e conservation test" |
| Build tool | Next.js static export (`output: 'export'`), Node 26, `npm run build` |

## 2. Build configuration

- `NEXT_PUBLIC_API_GATEWAY_URL` = NOT SET at build time → `GATEWAY_URL=''` →
  wallet runs in fail-closed offline mode until the operator builds with the
  real gateway origin. This is intentional for a release candidate: it cannot
  silently point at an unintended service.
- `NEXT_PUBLIC_NSAT_NETWORK_ID` = NOT SET at build time → the in-code default
  production identity constant is compiled in and verified against the
  artifact by the CI identity gate.
- No private keys, seeds, or credentials anywhere in the artifact (security
  scan PASS).

## 3. Artifact

| Field | Value |
|---|---|
| Output directory | `out/` |
| Files | 30 |
| Aggregate SHA-256 (file-listed, sorted, re-hashed) | `d259c26d196c1fea200fc46212d5619fdcafa88e60fe75b6987d77db3c8d799c` |
| Mainnet-identity marker chunks | `out/_next/static/chunks/app/wallet/page-7c16a06201270fdf.js`, `out/_next/static/chunks/app/status/page-689eed071450f96f.js` (exactly 2 — wallet + status) |

Reproduce the digest:
```bash
cd out && find . -type f | sort | xargs shasum -a 256 | shasum -a 256
```

## 4. Deploy workflow

`.github/workflows/deploy-pages.yml`: static build → static-export acceptance →
security scan → artifact identity gate (`grep -rl 'NSAT Mainnet ; October 2026 ; bc3098829fffc717' out/_next/static/chunks`) →
`npm audit --omit=dev --audit-level=high` → **manual owner approval gate** before the deploy job runs.

## 5. Test results bound to this commit

- `npm test` → 5/5 PASS
- `node tests/security-scan.mjs` → PASS (30 files)
- `services/api-gateway npm test` → 21/21 PASS
- `NSAT_E2E=1 node tests/e2e-send.test.mjs` → 5/5 PASS (disposable devnet)

## 6. Published deployment record (2026-10-31)

| Field | Value |
|---|---|
| Trigger | `workflow_dispatch` on `feature/web-platform-v1`, commit `bcbec59` |
| Run | https://github.com/SatoshiConnect/satoshicore/actions/runs/41152790152 — build + gateway tests + deploy: ALL SUCCESS |
| Pages configuration | `build_type: workflow` (Actions-artifact publishing), `cname: wallet.satoshicore.org`, legacy gh-pages publishing retired |
| Published URL | http://wallet.satoshicore.org/ — GET 200, `<title>SatoshiCore — Web Platform</title>`, `/wallet/` GET 200 |
| HTTPS | NOT YET enforced — TLS certificate still provisioning; enforcement is the owner's Pages-Settings action after issuance (API PATCH refused) |
| Gateway for this origin | NOT YET — artifact built without `NEXT_PUBLIC_API_GATEWAY_URL` (fail-closed offline); rebuild with the real gateway URL once the gateway is hosted |

## 7. Gateway artifact

`services/api-gateway/server.js` — single file, zero runtime dependencies,
same commit. Not shipped in `out/` (static export forbids server artifacts;
static-export tests assert their absence).

## 8. Runtime dependencies

Web: Next.js build toolchain only (see package.json / package-lock.json).
Gateway: node:http / node:url standard modules only, Node ≥ 18 (AbortSignal
timeout usage).
Recovery procedure: redeploy artifact + gateway; see
WEB-WALLET-GATEWAY-DEPLOYMENT.md §3.
