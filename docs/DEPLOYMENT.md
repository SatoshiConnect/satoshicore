# Deployment Architecture — SatoshiCore Web Platform v24.0

## Overview

```
                    ┌─────────────────────────────┐
                    │   GitHub Pages (static)     │
                    │   satoshicore.org           │   ← built by GitHub Actions
                    │   www.satoshicore.org       │     from Next.js static export
                    └──────────────┬──────────────┘
                                   │ browser fetches (CORS allowlist)
                    ┌──────────────┴──────────────┐
                                   │
                    ┌──────────────▼──────────────┐
                    │ Web Wallet API Gateway      │
                    │ (services/api-gateway)      │
                    │ - /api/v1/chain/info (read) │
                    │ - /api/v1/tx (signed relay) │
                    │ - holds no keys             │
                    └──────────────┬──────────────┘
                                   │ same-host/private network
                                   │ :11626 (allowlisted routes only)
                    ┌──────────────▼──────────────┐
                    │ nsat-core node              │
                    │ (SatoshiConnect/nsat-core)  │
                    └─────────────────────────────┘

      ┌───────────────────────────┐
      │ Blockchain Indexer        │  ← separate future service
      │ (balances / history)      │    (not yet built)
      └───────────────────────────┘
```

The website is a **fully static export** (`output: 'export'` in
`next.config.js`). There is no Node.js server at the hosting layer. All
public pages and the client-side Web Wallet interface run in the browser.

## API Gateway ↔ nsat-core connection

`services/api-gateway` is the production relay between the static site and
the nsat-core node (see `SatoshiConnect/nsat-core`, branch
`nsat/minimal-core-v40`):

- **Read path:** `/api/v1/chain/info` proxies the core's public `/info`.
- **Write path:** `/api/v1/tx` forwards base64 **signed** transaction
  envelopes to the core's `tx` endpoint. Signing is client-side; the gateway
  never touches key material.
- **No admin surface:** the gateway has an explicit route allowlist — core
  administrative/operational endpoints are not proxied.
- The gateway should run on the same host or private network as the nsat-core
  node; only the gateway's public endpoints are exposed to the internet.
- Website integration: set `NEXT_PUBLIC_API_GATEWAY_URL` at build time. When
  unset or unreachable, the site renders its offline/experimental state.

## GitHub Pages hosting

1. **Build pipeline** (`.github/workflows/deploy-pages.yml`):
   - Installs dependencies, runs `next build` with `output: 'export'`.
   - Runs verification tests (`tests/static-export.test.mjs`) and a security
     scan (`tests/security-scan.mjs`) against `out/`.
   - Uploads `out/` as the Pages artifact.
2. **Deploy job**: intentionally disabled (`if: false`) until owner approval.
   To activate:
   - Repository → Settings → Pages → Source: **GitHub Actions**.
   - Change the deploy job gate to `if: github.ref_name == 'main'`.

### Preview vs custom-domain builds

- **github.io preview** (push builds): site is served under
  `/satoshicore/`, so the workflow sets `NEXT_PUBLIC_BASE_PATH=/satoshicore`
  for pushes to `main`. All asset URLs are correctly prefixed.
- **Custom domain** (`workflow_dispatch` with `custom_domain=true`): built
  with an empty base path and `CNAME.reference` is copied into `out/CNAME`.

> Note: pushes to `feature/**` build with an empty base path so the artifact
> can be inspected locally; they are never deployed.

## Custom domain — `wallet.satoshicore.org` (production decision 2026-10-31)

> Production uses `wallet.satoshicore.org`. Its DNS (`CNAME` →
> `satoshiconnect.github.io`) was already in place, and the repo Pages
> configuration binds this domain (legacy-site divergence resolved by this
> decision). The apex `satoshicore.org` remains a documented future option
> (it needs 3 more apex A records plus a `www` CNAME before it can equal
> Pages coverage); the apex is NOT the deployed wallet origin as of this
> cycle.

**DNS additions for apex/www (future option) require owner action; nothing
here is automated.**

1. At the DNS provider for `satoshicore.org`, add:
   - Apex `A` records → GitHub Pages IPs:
     `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
   - `www` `CNAME` → `SatoshiConnect.github.io`.
2. After the first custom-domain build/deploy, verify the domain in
   Repository → Settings → Pages → Custom domain: `satoshicore.org`,
   and enable **Enforce HTTPS** once the certificate is issued.
3. The deployed artifact contains the `CNAME` file (`satoshicore.org`).

## Offline / experimental state

The static site has no backend of its own. Components that need a backend
(`components/BackendStatus.js`) probe `NEXT_PUBLIC_API_GATEWAY_URL` /
`NEXT_PUBLIC_INDEXER_URL` `/health` endpoints from the browser:

- **Unset or unreachable** → the UI renders an explicit
  *Offline / experimental* state; nothing fails silently.
- **Reachable** → the live feature renders.

Backend URLs are public, non-sensitive configuration. The Web Wallet also has
an explicit in-browser experimental mode; production signing is gated behind
owner approval and the API Gateway.

## Local verification before deploy

```bash
npm ci
npm run build          # static export into ./out
npm test               # static-export checks (pages, asset paths, artifacts)
node tests/security-scan.mjs out
npx serve out          # or: npx http-server out -p 8080
```

Open `http://localhost:8080` and verify `/`, `/wallet/`, `/docs/`,
`/status/` and that assets load (Network tab shows no 404s).

## What is intentionally NOT in scope here

- No DNS changes (owner).
- No activation of the Pages deploy job (owner).
- No publication of a production Web Wallet (owner).
- No admin API exposure — administrative endpoints live only inside the
  backend services' private networks; the static site never references them.
