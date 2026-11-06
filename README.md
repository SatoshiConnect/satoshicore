# satoshicore

Official NSAT Web Wallet (non-custodial) and SatoshiCore Web Platform v24.0 —
Next.js static-export site deployed to GitHub Pages at
`https://wallet.satoshicore.org/`. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)
for the architecture, custom-domain setup and activation checklist, and
[SECURITY.md](SECURITY.md) for the security invariants. The security audit
series lives in [docs/security/](docs/security/THREAT-MODEL.md).

Current evidence-based runtime and release status: [PROJECT-STATUS.md](PROJECT-STATUS.md) · [project-status.json](project-status.json).

Key custody is browser-side only: Ed25519 keys are generated with the device
CSPRNG, encrypted with PBKDF2-HMAC-SHA256 (600,000 iterations) + AES-256-GCM,
and never leave the browser. Transactions are signed locally and relayed as
already-signed XDR envelopes through the Web Wallet API Gateway.

## Quick start

```bash
npm ci
npm run dev     # local dev server (binds to the loopback Mainnet gateway)
npm run build   # static export into ./out
npm test        # verify static export + security scan
node --test services/api-gateway/tests/   # gateway + SDK contract + identity
node --test tests/keystore.test.mjs       # key-custody regression suite
```

## Branches

- `main` — production source.
- `feature/web-platform-v1` — older branch, five commits behind `main` as of
  2026-10-31; it contains no commits missing from `main`.

## Backend services (separate, not in this repo)

- Web Wallet API Gateway (`services/api-gateway/` — keyless signed-envelope
  relay, server-side hardening headers, route allowlist)
- NSAT Mainnet node(s) on the operator host (loopback RPC only)
