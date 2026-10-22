# SatoshiCore Wallet — Web + PWA

Official web wallet (non-custodial) for the NSAT network, live at:
`https://satoshiconnect.github.io/satoshicore/` (GitHub Pages once enabled).

- Static ESM bundle built with Bun from the shared SDK (`dev/nsat-wallet universal/shared/sdk`).
- PWA manifest + network-first service worker that never caches `/rpc` or user data.
- Private keys are generated with device CSPRNG, encrypted with PBKDF2-HMAC-SHA256 (600,000) + AES-GCM, and never leave the browser.
