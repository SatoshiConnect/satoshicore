# Security Policy — SatoshiCore Web Platform v24.0

## Hard rules enforced in this repository

1. **No secrets in the repository or static output.** Private keys,
   mnemonics, signing seeds, API credentials and connection strings must
   never be committed. `tests/security-scan.mjs` runs in CI against the
   built `out/` directory and fails the build on credential-shaped
   patterns (GitHub/AWS tokens, private key blocks, key assignments,
   internal service URLs, connection strings).
2. **No administrative HTTP APIs exposed publicly.** SatoshiCore admin
   endpoints are not referenced anywhere in the static site and must not be
   added to any public configuration. They belong only to backend services
   on restricted networks with their own authentication.
3. **Client-side signing only.** The Web Wallet performs transaction
   signing in the browser. The API Gateway, once deployed, receives only
   already-signed transactions for relay — never key material.
4. **Experimental key handling.** Key material entered in the Web Wallet's
   experimental mode stays in memory for the session only: it is never
   persisted to localStorage, never transmitted, and is lost on refresh.
5. **Owner-gated publication.** The GitHub Pages deploy job is disabled
   (`if: false`). DNS changes, Pages activation, and production Web Wallet
   publication all require explicit owner approval.

## Backend separation

- **Web Wallet API Gateway** — separate service. Public surface limited to
  health check and signed-transaction relay.
- **Blockchain Indexer** — separate service. Read-only chain data.
- The static site talks to these only from the browser, only via URLs set
  through public env vars (`NEXT_PUBLIC_*`). Secrets for these services are
  configured in the services' own environments, never here.

## Reporting

Report vulnerabilities privately to the repository maintainers. Do not open
public issues containing exploit details.
