# NSAT Wallet — Browser Extension (Chrome MV3)

The same wallet as [satoshicore.org/wallet](https://satoshicore.org/wallet), packaged as a
browser extension popup. It is **not a second wallet project**: the popup bundles the web
wallet's audited UI and engine verbatim — `components/WalletPanel.js` over
`lib/nsatWallet.js` / `lib/nsatClient.js` / `lib/nsatCodec.js` / `lib/nsatSendPreflight.js` —
built once by `scripts/build-extension.mjs` (esbuild, no other tooling).

## What is identical to the web wallet

- Local Ed25519 signing (tweetnacl) — the seed never leaves the device; the gateway only
  ever relays already-signed envelopes (keyless by design).
- Encrypted keystore: AES-GCM-256 + PBKDF2-SHA256 600k. Only ciphertext is ever persisted.
- Exact network-identity gate: the node's reported passphrase must equal the baked-in
  `NSAT Mainnet ; October 2026 ; bc3098829fffc717` or signing is refused (fail-closed).
- Live fee from the ledger header (`baseFee` 10) — the wallet never invents a fee.
- BigInt/string amounts end-to-end, review-before-sign, exact-hash confirmation, lock +
  idle auto-lock, encrypted backup export / fail-closed restore.
- Shielded (Orchard) is **excluded by design** — no verified browser proof path exists;
  the popup shows the same honest "DESKTOP ONLY" gate as the web wallet.

## What is different (extension threat model)

| Concern | Web wallet | Extension popup |
|---|---|---|
| Keystore persistence | page `localStorage` (origin-scoped) | `chrome.storage.local` (extension-scoped; no web page can read it) — via `src/storage.js` + `setWalletStorage()` |
| Unlocked seed lifetime | until lock/idle-lock/tab close | popup open at most — closing the popup destroys the JS context (stronger) |
| Backup download | anchor-click | `chrome.downloads` API (`WalletPanel` branches on availability) |
| Backend reach | gateway/indexer URLs via Next env | same, baked in at build time; `host_permissions` grant fetch access to exactly those origins (CORS-exempt) |
| OS keychain | n/a (browser) | n/a — encrypted-at-rest is the strongest tier available to an extension page |

## Build

```sh
npm install
npm run build:extension          # → gateway.satoshicore.org + satoshicore.org (domains)
npm run test:extension           # builds + runs tests/extension.test.mjs
```

The build bakes in **domain endpoints only** — a bare IP or loopback origin is
refused unless a devnet build opts in explicitly, so a shipped artifact never
carries `127.0.0.1` that would need fixing later:

```sh
# devnet build against this machine (explicit opt-in; never ship this)
NSAT_EXT_GATEWAY_URL=http://127.0.0.1:8787 \
NSAT_EXT_INDEXER_URL=http://127.0.0.1:8789 \
NSAT_EXT_ALLOW_LOOPBACK=1 \
npm run build:extension
```

Override the domains with `NSAT_EXT_GATEWAY_URL` / `NSAT_EXT_INDEXER_URL` for a
staging origin; `tests/extension.test.mjs` fails the run if either the bundle or
`host_permissions` contains an IP or loopback origin.

Verified production endpoints for this build (`2026-11-13`):
`https://gateway.satoshicore.org/health` 200, `https://gateway.satoshicore.org/api/v1/chain/info` 200,
`https://satoshicore.org/v1/health` 200. The resulting manifest grants only
`https://gateway.satoshicore.org/*` and `https://satoshicore.org/*` with permissions
`storage` + `downloads`.

Packaged artifact: `extension/nsat-wallet-v24.0.0.zip` (80,457 B, sha256
`bf125183db43b5d3…`) — contents: `manifest.json`, `popup.html`, `popup.js`,
`wallet.css`, `icons/`. Load it with **Load unpacked** after unzipping, or upload it
to the Chrome Web Store listing.

`NSAT_EXT_NETWORK_ID` overrides the baked-in signing passphrase for a devnet build —
the identity gate still refuses to sign against any node that does not report the exact
same passphrase.

## Load unpacked (development)

1. Chrome/Chromium → `chrome://extensions`
2. Enable **Developer mode** → **Load unpacked** → select `extension/dist`
3. Click the NSAT icon.

## Production deployment notes

- Once a Chrome Web Store ID exists, add the extension's `chrome-extension://<id>` origin
  to the gateway's `ALLOWED_ORIGINS` — not required for fetches granted by
  `host_permissions`, but defense-in-depth for any future `EventSource`/CORS-sensitive path.
- Store listing must not advertise shielded features (desktop-only, per
  `nsat-core/docs/FINAL-PRODUCTION-ACCEPTANCE.md` F9).

## Out of scope (deliberately)

Injected content scripts / a `window.nsat` provider API (MetaMask-style dApp surface).
That is a separate security review with its own threat model; the popup is intentionally
the entire extension surface.
