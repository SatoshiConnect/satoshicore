# Wallet web security review — 2026-11-16

Scope: the PWA wallet at `https://satoshicore.org` and the branch
`codex/wallet-manager-continuation` (commits `44b9cbe` … `be27a35`), with focus on
the standalone gate, wallet/account visibility, keystore, backup/restore and the
deployed static artifact. Mainnet, genesis, ledger, validators and real keys were
not touched. Nothing here is a third-party audit or a claim of zero risk.

## Method

Code inspection of `lib/nsatWallet.js`, `lib/walletBinding.js`, `lib/sessionPolicy.js`,
`lib/driveBackup.js`, `components/WalletPanel.js`, `components/GoogleAccount.js`,
`components/DriveBackupCard.js`, `public/sw.js`, `app/layout.js`; the deployed
webroot and live HTTP responses; `npm audit`; and browser checks on the live origin
in a clean (incognito) 430×932 window.

## Findings

| # | Finding | Severity | Status |
|---|---|---|---|
| F1 | `unlockWithPassword()` decrypted the keystore *before* checking that this session may see that wallet, and did not refuse a hidden wallet. Not reachable through the shipped UI (both pickers list only visible wallets) and spending was blocked only because the activated session had no address. | MEDIUM (defense-in-depth, code contradicted its comment) | **FIXED** `3759193` — `visibleWalletNamed()` decides before `keystoreUnlock()`; test `an unlock request resolves only wallets this session may see` |
| F2 | `keystoreRestore()` replaced the whole keystore with the backup file, so a `Restore keystore` deleted every wallet created after that backup (ciphertext gone, key unrecoverable) while the UI said "Existing wallets stay as they are". Local file restore had no confirmation step at all. | **HIGH (irreversible key/data loss)** | **FIXED** — restore now merges (same name + same signing key takes the backup entry, same name + different key is reported as a conflict and left alone) and returns `{added, updated, conflicts}`; three tests in `tests/keystore.test.mjs`; UI reports the counts |
| F3 | Drive restore bound *every* local wallet to the signed-in email (`for (const wallet of keystoreList()) bindOwner(...)`), so a signed-in account adopted the labels — and visibility — of wallets belonging to another account. | MEDIUM (breaks account isolation labels) | **FIXED** — only names present in the backup are bound, and never over another account's label |
| F4 | The Drive backup file necessarily contains wallet names, public addresses, KDF salt and nonce in readable form (seeds are AES-GCM ciphertext). The card said only "encrypted with each wallet's password", and `/privacy/` did not mention Drive backup at all. | MEDIUM (privacy disclosure) | **FIXED** — card states what is readable vs encrypted; `/privacy/` has a "Google Drive backup (optional)" row |
| F5 | Keystore export downloads the entire keystore without a password, including names/addresses of wallets this session hides. | MEDIUM (metadata exposure on a shared browser) | **MITIGATED** — the export now states how many hidden wallets the file carries. Full removal would need per-session filtering, which risks silently shrinking a backup; needs an owner decision |
| F6 | `connect-src 'self' https:` allows a script that already runs in the page to send data to any HTTPS host. | MEDIUM (widens XSS impact) | **OPEN** — needs a narrow allowlist (self, `*.googleapis.com`, `*.google.com`, `*.firebaseapp.com`, gateway/indexer origins) plus a staged test of Google sign-in and Drive backup; not changed without that test because a wrong allowlist breaks sign-in/backup on the live wallet |
| F7 | CSP is delivered as a `<meta>` tag, so `frame-ancestors` cannot be expressed; clickjacking is covered only by the `X-Frame-Options: DENY` header from Caddy. | LOW | **OPEN (accepted for now)** — add `frame-ancestors 'none'` as a real header at the host when the Caddy config is next changed |
| F8 | `script-src` includes `'unsafe-inline'` (needed by the theme bootstrap and install-prompt capture). | LOW | **ACCEPTED** — both inline scripts are fixed strings with no interpolation; a nonce/hash CSP needs a build-time change and was not attempted here |
| F9 | Dependency advisories: `next@14.2.15` (1 critical, several high: Server-Actions DoS, dev-server origin check, image-optimizer issues), `firebase`/`@grpc/grpc-js` (high), `postcss` (high, build-time). | HIGH by advisory / LOW in this deployment | **OPEN** — the production artifact is a static export served by Caddy, so Server Actions, `next/image`, middleware and the Node server do not run there; `postcss` and `grpc-js` are not in the browser path. Still needs a scheduled, owner-approved major upgrade with full regression (see R1) |
| F10 | Wallet names, public addresses, per-wallet transaction history and account labels are stored unencrypted in `localStorage`; encryption protects keys, not metadata. | LOW (inherent) | **DOCUMENTED** — stated in `/privacy/`; local device access is out of scope of every control here |

## Controls verified (evidence)

- Seed never at rest: `keystoreCreate`/`walletEntry` store only `{name, pubkey, kdf, aead, nonce, box}`; `npm test` asserts the returned seed string does not appear in storage. Password bytes and plaintext buffers are zeroed.
- KDF/AEAD: PBKDF2-HMAC-SHA256 × 600,000, 16-byte random salt, AES-GCM-256, fresh 12-byte random IV per entry; restore rejects any other algorithm, iteration count, salt/nonce length or short ciphertext.
- Unlock integrity: the address shown must equal the key derived from the decrypted seed (`keystore integrity failure` path, tested); wrong password fails closed.
- Restore is fail-closed and now non-destructive; malformed/duplicate-name/altered-parameter backups are refused before touching live state (tests `keystoreRestore refuses …`, `… rejects altered …`).
- Lock hygiene: idle auto-lock (1–60 min, clamps, cannot be disabled), lock on `visibilitychange`/`pagehide`, seed buffers wiped with `zeroSeed`, unmount wipes too.
- No plaintext seed or password is logged: no `console.*` calls in `app/`, `components/` or `lib/`; no `eval`/`new Function`; the only `dangerouslySetInnerHTML` uses are two fixed bootstrap scripts.
- Network: signing requires `EXPECTED_NETWORK_ID` byte-exact (fail closed when absent); the gateway receives only an already-signed envelope; `verifyNetworkIdentity()` treats missing/mismatched identity as failure.
- Service worker: cross-origin and dynamic API paths are never cached (`sw.js`), so money values cannot be served stale from cache.
- Deployed artifact: `index.html` sha256 `d2b6030e…a6ddd`; no seed-like (`S…`) strings, no `.env`/`*.map`/dotfiles in the webroot; `/.env`, `/package.json`, `/lib/*` return 404; HSTS, `nosniff`, `X-Frame-Options: DENY` present; after visiting the gate the live origin's `localStorage` was empty.
- OAuth/Drive: only `drive.appdata` scope; Drive access token kept in memory; sign-in alone uploads nothing; backup upload body is the keystore blob (ciphertext for seeds).

## Not verified here

- Real Google sign-in / sign-out round trip and Drive backup + restore against a real account (no test account available in this session).
- Behaviour on Android/iOS Safari, and the installed-PWA (standalone) window.
- Remote revocation of a lost device — impossible with the client SDK alone (see `docs/GOOGLE-SIGN-IN.md`).
- Any claim about third-party security of Google/Firebase/Cloudflare infrastructure.
