# Privacy Policy — NSAT Wallet browser extension

Last updated: 2026-11-14 · Version 1.0 · Applies to NSAT Wallet v24.0.0
(Chromium build; the Firefox build runs the same code)

This is the canonical text. It is published at
<https://satoshicore.org/extension/privacy/> — keep the page and this file in
sync, and bump the version line when either changes. The Chrome Web Store
privacy-policy field must point at the published page, not at this file.

---

## 1. Who this policy is from

NSAT Wallet is an independent, non-commercial study project for the NSAT
network (SatoshiCore). There is no company, no account system, and no
server-side copy of your wallet. The item is published on the Chrome Web Store
by the developer account named on its listing page.

Contact: open a private security advisory at
<https://github.com/SatoshiConnect/satoshicore/security>. Please do not post
wallet details in a public issue.

## 2. In one paragraph

The extension keeps your keys on your device. It has no account, no analytics,
no advertising and no tracking. It contacts two first-party endpoints, and the
only user data those endpoints receive is the public wallet address you are
looking at and, when you send, a transaction you already signed.

## 3. What is stored on your device

Stored in the extension's own storage area (`chrome.storage.local`). No web
page can read it, and it is removed when you uninstall the extension.

| Stored | Detail |
|---|---|
| Encrypted keystore | AES-GCM-256 ciphertext, key derived from your password with PBKDF2-HMAC-SHA256 (600,000 iterations). The seed is never stored in plaintext. |
| Wallet label and public address | Needed to list your wallets and show the address before unlock. A public address is not a secret. |
| Local transaction history | Up to 200 entries per account you have viewed: recipient, amount, fee, hash, ledger result. Never uploaded. |
| Interface preferences | Theme and similar display settings. |

While the wallet is unlocked, the decrypted seed exists in the popup's memory so
it can sign. Closing the popup destroys that context; an idle auto-lock (5
minutes) locks it earlier and overwrites the key bytes. The extension sets no
cookies and writes nothing to web pages.

## 4. What leaves your device

Two origins, both operated by this project:

| Request | Data sent | Purpose |
|---|---|---|
| `GET gateway.satoshicore.org/api/v1/account?acc=<address>` | Public wallet address | Balance and sequence number |
| `GET gateway.satoshicore.org/api/v1/chain/info`, `/explorer/snapshot`, `/network/status`, `/sponsorship/policy` | None about you | Ledger height, base fee, network identity |
| `POST gateway.satoshicore.org/api/v1/tx` | A transaction you reviewed and signed | Relay to the network |
| `GET satoshicore.org/v1/accounts/<address>/transactions`, `/events` | Public wallet address | Indexed public history |
| `GET satoshicore.org/v1/tx/<hash>`, `/v1/confirmations/<hash>`, `/v1/health` | Public transaction hash | Confirmation status |

Your password, seed and private keys are never transmitted — not to these
endpoints, not anywhere. Signing happens on your device; the gateway receives
only an already-signed envelope and cannot alter or re-sign it.

As with any web request, the servers necessarily receive standard metadata (IP
address, time, requested path, user agent) in order to serve and protect the
service. The extension adds no identifiers of its own, sets no cookies, and does
no analytics or profiling. Log retention depends on the servers' configuration;
ask via the contact above if you need specifics.

Blockchain data is public by design: a transaction you send becomes visible on
the NSAT chain and cannot be deleted by anyone, including this project.

## 5. What this extension does not do

- No account, email address, phone number or identity document.
- No analytics, telemetry, crash reporting, advertising, fingerprinting or
  third-party scripts.
- No access to your browsing history, tabs, page content, clipboard contents,
  location, contacts or files (the manifest requests none of those permissions).
- No selling or sharing of user data, because there is nothing to sell.
- No remote code: everything the extension executes ships inside the package.

## 6. Third parties

There are none beyond the two endpoints in section 4, both run by this project.
No analytics, advertising, crash-reporting or push providers are integrated.
Your browser vendor and operating system may collect their own telemetry under
their policies; that is outside this extension's control.

## 7. Your choices

- **Stop network access:** lock the wallet or close the popup; nothing runs in
  the background (the extension has no background worker).
- **Remove local data:** delete a wallet in the interface, or uninstall the
  extension. Uninstalling erases the encrypted keystore — export an encrypted
  backup first if you want to restore it.
- **Delete server-side data:** there is none tied to you. Chain data, once
  broadcast, is public and permanent.

## 8. Security, and its limits

The seed is generated on your device, stored only as ciphertext, and used to
sign locally. A signature is refused unless the network reports the exact
Mainnet identity this build expects. The encrypted backup is protected by the
same password.

A browser extension is not a hardware wallet. Malware on your computer, a
compromised browser, or someone who knows your password can defeat these
protections. There is no password reset and no recovery service: if you lose the
password and have no backup, the funds at that address are unreachable by anyone.
This build has internal review and test evidence, but no external security audit.

## 9. Children

The extension is not directed at children and should not be used by anyone under
18. It handles irreversibly transferable value.

## 10. Changes to this policy

Material changes are published on this page and noted in the store listing
before the affected version ships; the date and version at the top always
identify the current text. The extension itself does not phone home, so it cannot
tell you about a policy change inside the popup.

## 11. Scope

This policy covers the browser extension. The website has its own disclosure at
<https://satoshicore.org/privacy/>, and the technical security model is
documented at <https://satoshicore.org/security/>.
