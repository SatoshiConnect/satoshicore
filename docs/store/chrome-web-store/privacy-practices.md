# Privacy tab — paste-ready

Answers for the Chrome Web Store **Privacy practices** tab, written against
`extension/dist/manifest.json` as packaged for v24.0.0.

## Single purpose description

```
NSAT Wallet is a non-custodial wallet for the NSAT network: it creates or imports a signing key on the user's own device, signs NSAT transactions locally after the user reviews recipient, amount, fee and total debit, and submits those already-signed transactions to the network. Nothing else is in scope: no browsing features, no page modification, no exchange or trading.
```

## Permission justifications

The manifest declares exactly two API permissions and two host permissions.
Anything broader (`<all_urls>`, `tabs`, `scripting`, `cookies`, `history`,
`clipboardRead`) is absent by design.

### `storage`

```
Persists the wallet so it survives closing the popup and restarting the browser. chrome.storage.local holds the encrypted keystore (AES-GCM-256 ciphertext over PBKDF2-HMAC-SHA256, 600,000 iterations), the wallet label and public address, and up to 200 locally cached public history entries per account. There is no account system and no server-side storage: if the extension could not store this locally, a wallet could not exist. No web page can read this area.
```

### `downloads`

```
Used only when the user explicitly exports an encrypted backup, to save the file (scw-web-backup.json) through the browser's normal download flow. It never downloads anything the user did not request, and it is never used to fetch remote code or updates.
```

### Host permission — `https://gateway.satoshicore.org/*`

```
The wallet's only write path. It reads chain info, the live base fee, network status, sponsorship policy and one account's balance/sequence (GET /api/v1/chain/info, /api/v1/explorer/snapshot, /api/v1/network/status, /api/v1/account?acc=<public address>, /api/v1/sponsorship/policy) and posts the already-signed transaction envelope (POST /api/v1/tx). The gateway never receives the seed, password or private key, and cannot alter or re-sign an envelope. Requests come from the extension context, which is why the origin is granted explicitly instead of relying on CORS.
```

### Host permission — `https://satoshicore.org/*`

```
Read-only public index endpoints used to show confirmed history and the ledger result of a transaction: GET /v1/health, /v1/accounts/<public address>/transactions, /v1/accounts/<public address>/events, /v1/tx/<hash>, /v1/confirmations/<hash>. No user identifier is sent beyond the public wallet address the user is already looking at.
```

## Remote code

```
No. All code is bundled into the package at build time (esbuild, scripts/build-extension.mjs). The extension loads no scripts, no WASM and no eval'd strings from the network; every network response it handles is JSON data. Manifest V3's remote-code restriction is fully honoured.
```

## Data usage form — recommended answers

Chrome asks which categories of user data the item collects. "Collect" means
data leaving the device, so the answers follow the actual traffic:

| Category | Answer | Why |
|---|---|---|
| Financial and payment information | **Yes** | The public wallet address is sent to the project's own gateway/indexer to read balance and history, and a signed transaction is sent when the user sends one. This is the service working, not profiling. |
| Authentication information | **No** | The seed/password never leave the device. The encrypted keystore lives in `chrome.storage.local`; decrypted material exists only in the popup's memory while unlocked. Disclosed in the policy, not collected. |
| Personally identifiable information | **No** | No name, email, phone, account or identifier is asked for or stored. |
| Health, location, web history, user activity, website content, personal communications | **No** | No permission grants access to any of it, and no content script runs on pages. |

Certifications (all three can be answered truthfully):

- Not selling or transferring user data to third parties.
- Not using or transferring user data for purposes unrelated to the single purpose.
- Not using or transferring user data to determine creditworthiness or for lending.

### Why "Financial and payment information: yes"

Under-declaring is a common rejection reason. The extension does transmit
public wallet addresses and signed transactions to the project's own services —
that is financial data about the user's account, even though it is
pseudonymous and public on-chain. Declaring it and explaining the limited use
is both truthful and easier to review than a blanket "collects nothing".

If the dashboard's live definition of collection says "off-device
transmission" and the reviewer treats the first-party gateway as a service
provider, this remains consistent: the data is used only to operate the wallet
the user asked for. The owner should re-read the current wording at submission
time and, if Chrome's form has changed, adjust this table — not the policy.

## What the reviewer can verify without funds

- Create wallet → lock → unlock: the keystore round-trips through
  `chrome.storage.local` and the popup renders balance 0, the live fee, and the
  Send form.
- No request is made until the popup opens; there is no background worker and
  no content script, so nothing runs on other tabs.
- DevTools → Network inside the popup shows only the two allowed origins and
  only JSON traffic.
