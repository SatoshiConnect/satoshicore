# Browser extension — human test checklist

The extension shares `components/WalletPanel.js` and `lib/*` with the web
wallet, so the artifact tests prove packaging, not behaviour. A person has to
load it once in each browser family before the download page may call it
supported. Nothing here spends real NSAT: create a fresh wallet, and never
import a seed that holds a balance.

## Build

```bash
npm run build:extension            # extension/dist          (Chromium MV3)
npm run build:extension:firefox    # extension/dist-firefox   (Firefox MV3)
npm run test:extension             # builds both, 10 artifact tests, release.json check
```

Packaging (only needed when the artifact changes; the zips are committed and
`release.json` is verified against them):

```bash
# The archive's top level is manifest.json, so zip from inside the build dir.
(cd extension/dist && zip -qr ../nsat-wallet-v24.0.0-production.zip .)
(cd extension/dist-firefox && zip -qr ../nsat-wallet-v24.0.0-firefox.zip .)
npm run release:extension   # writes bytes + sha256 into release.json
```

> The committed zips are built from the `dist` / `dist-firefox` roots, so the
> archive's top level is `manifest.json`. After repackaging, run
> `npm run release:extension` (writes bytes + sha256 into `release.json`) and
> re-run `npm run test:extension`. If `release.json` and the zip disagree, the
> check fails — that is the point.

## Load it

**Chrome / Edge / Brave** (`chrome://extensions`, `edge://extensions`)

1. Enable *Developer mode*.
2. *Load unpacked* → `satoshicore-web/extension/dist`.
3. Pin the toolbar action; the popup should open at 400×600.
4. Expect **no** warnings about permissions beyond `storage` and `downloads`.

**Firefox** (`about:debugging#/runtime/this-firefox`)

1. *Load Temporary Add-on…* → `extension/dist-firefox/manifest.json`.
2. The add-on ID must read `wallet@satoshicore.org`.
3. Temporary add-ons disappear on restart; that is expected for this test.

## Checklist (record PASS/FAIL per browser)

| # | Check | Expected |
|---|---|---|
| 1 | Popup opens with no console errors | Network panel shows only `gateway.satoshicore.org` requests |
| 2 | Create wallet | 24-word seed shown once, address starts with `G`, copy works |
| 3 | Reload popup | Wallet persists (comes from `chrome.storage.local`, not `localStorage`) |
| 4 | Lock → unlock | Wrong password rejected; correct password restores the same address |
| 5 | Idle lock | After the idle window the wallet locks itself |
| 6 | Network identity | Identity line shows `NSAT Mainnet ; October 2026 ; bc3098829fffc717`; a mismatch must block signing, not warn |
| 7 | Balance | Reads the live ledger; `0 NSAT` is shown as exact, not rounded |
| 8 | Receive | Address + QR encode the same account as the web wallet |
| 9 | Send preflight | Insufficient balance, bad address and fee errors appear before any signature |
| 10 | Signing stays local | No seed/key material in the request body of any request (inspect `/api/v1/tx`) |
| 11 | Endpoints | `manifest.json` `host_permissions` contains only the two domains — no IP, no loopback |
| 12 | Backup/export | Exported file is encrypted and refuses a wrong password |

Do not run a send with a real balance for this checklist.

## After testing

- Update `extension/release.json`: the browser's `status` (for example
  `BUILD_PRODUCED` → a tested state) and a note saying which version and date
  you exercised. The download page renders these strings directly, so vague
  notes become vague public claims.
- `npm run test:extension` again, then commit the zip and `release.json`
  together, so the digest on `/download` matches the file in the repo.

## Known limits

- **Safari (macOS/iOS)**: no package exists. It needs an Xcode project and
  distribution review; the download page reports `NOT_SUPPORTED`.
- **Opera / Vivaldi**: Chromium MV3 should load, but neither has been
  exercised — they stay `NOT_TESTED` until someone does.
- **Store publication**: nothing is submitted to any store. Distribution is
  *Load unpacked* from the repository archive.
