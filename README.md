# satoshicore

SatoshiCore Web Platform v24.0 — Next.js static-export website deployed to
GitHub Pages. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the
architecture, custom-domain setup and activation checklist, and
[SECURITY.md](SECURITY.md) for the security invariants.

## Quick start

```bash
npm ci
npm run dev     # local dev server
npm run build   # static export into ./out
npm test        # verify static export + security scan
```

## Branches

- `main` — production source.
- `feature/web-platform-v1` — current static-platform workstream.
  Deployment to GitHub Pages is intentionally disabled until owner approval.

## Backend services (separate, not in this repo)

- Web Wallet API Gateway
- Blockchain Indexer

The static site degrades gracefully to an offline/experimental state when
these are not configured.
