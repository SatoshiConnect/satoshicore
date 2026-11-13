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
2. **Deploy job**: owner-gated. Automatic on `main`, or manual through
   `workflow_dispatch` (see below). Requires Repository → Settings → Pages →
   Source: **GitHub Actions**.
3. **Verify job**: runs after `deploy` against the URL Pages reports and fails
   the run when the live artifact is not the build just produced. See
   *Post-deploy verification*.

### Preview vs custom-domain builds

- **Production/custom domain** (`satoshicore.org`, the default for both
  `main` pushes and `workflow_dispatch`): built with an **empty** base path.
  The live site proves this — its script tags are `/_next/...`. A non-empty
  base path on the custom domain publishes an artifact whose assets 404.
- **github.io subpath preview** (only `workflow_dispatch` with
  `custom_domain=false`): built with `NEXT_PUBLIC_BASE_PATH=/satoshicore`.
  This build must never be published to the custom domain.
- `custom_domain_name` (dispatch input, default `satoshicore.org`) is written
  to `out/CNAME`, so a root deploy never silently ships the
  `wallet.satoshicore.org` value that `CNAME.reference` holds.

> Note: pushes to `feature/**` build with an empty base path so the artifact
> can be inspected locally; they are never deployed.

## Deploying to satoshicore.org

1. Actions → **Build, test and deploy static site to GitHub Pages** →
   *Run workflow* on `main` with `custom_domain=true` (default) and
   `custom_domain_name=satoshicore.org`.
2. The build job runs `npm ci`, `next build`, the static-export tests, the
   Mainnet-identity regression check and the output security scan. Any failure
   stops the deploy.
3. `deploy` publishes the artifact; `verify` then fetches the live URLs and
   prints the evidence. A stale deploy fails here, not in a release note.

Nothing in this repository changes DNS. The apex `A` records and the `www`
CNAME remain an owner action (see the section below).

## Post-deploy verification

```bash
node scripts/verify-deployed-site.mjs https://satoshicore.org
# or: npm run verify:deployed -- https://satoshicore.org
```

Read-only, dependency-free, exit code 1 on failure. It asserts that the live
origin serves:

- a wallet-first homepage (`Open NSAT Wallet`, `Install Browser Extension`,
  link to `/wallet/`) — an old landing page fails;
- `/wallet/`, `/docs/` and `/download/` as HTML (the download page must carry
  the sha256 and say the artifact is unpublished);
- `/manifest.webmanifest` as parsable JSON with `display: standalone`, a
  **relative** `start_url`, and 192/512 icons that actually resolve as images;
- `/sw.js` as JavaScript that ignores cross-origin requests, ignores non-GET
  requests and names no money endpoint;
- `/offline.html`.

Two advisory lines (`WARN`, never gate the run) report the gateway `/health`
and the CORS preflight for the deployed origin. The gateway allowlist is
owner-managed, so a stale entry is reported rather than failing a site deploy.

The same check can be run without deploying: Actions → **Verify deployed site
(read-only, no deploy)** with a `site_url` input.

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
node scripts/verify-deployed-site.mjs http://127.0.0.1:8080   # same checks as CI
```

Open `http://localhost:8080` and verify `/`, `/wallet/`, `/docs/`,
`/status/` and that assets load (Network tab shows no 404s).

## What is intentionally NOT in scope here

- No DNS changes (owner).
- No activation of the Pages deploy job (owner).
- No publication of a production Web Wallet (owner).
- No admin API exposure — administrative endpoints live only inside the
  backend services' private networks; the static site never references them.
