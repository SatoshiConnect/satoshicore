# Deployment Architecture — SatoshiCore Web Platform v24.0

## Overview

```
                    ┌─────────────────────────────┐
                    │   GitHub Pages (static)     │
                    │   satoshicore.org           │   ← built by GitHub Actions
                    │   www.satoshicore.org       │     from Next.js static export
                    └──────────────┬──────────────┘
                                   │ browser fetches (public, CORS-scoped)
                    ┌──────────────┴──────────────┐
                    │                             │
      ┌─────────────▼─────────────┐   ┌───────────▼──────────────┐
      │ Web Wallet API Gateway    │   │ Blockchain Indexer       │
      │ (separate backend service)│   │ (separate backend service)│
      │ - signed-tx relay only    │   │ - balances / history      │
      │ - NEVER admin endpoints   │   │ - explorer data           │
      └───────────────────────────┘   └──────────────────────────┘
```

The website is a **fully static export** (`output: 'export'` in
`next.config.js`). There is no Node.js server at the hosting layer. All
public pages and the client-side Web Wallet interface run in the browser.

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

## Custom domain — `satoshicore.org` / `www.satoshicore.org`

**DNS changes require owner action; nothing is automated here.**

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
