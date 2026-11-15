# Store listing tab — paste-ready

Everything below is plain text, ready to paste into the Chrome Web Store
dashboard. Line breaks are kept where the store preserves them.

## Name (45 characters max)

```
NSAT Wallet
```

## Short description (132 characters max)

```
Non-custodial NSAT wallet. Keys are created and encrypted on your device, and every transaction is signed locally.
```

(113 characters.)

## Category

```
Productivity
```

Alternative if a reviewer prefers it: **Tools**. Do not pick "Shopping" or
anything finance-adjacent that implies trading — this wallet has no exchange,
swap, fiat or yield feature, and claiming one would misdescribe the item.

## Language

```
English
```

## Homepage URL

```
https://satoshicore.org/
```

## Support URL

```
https://satoshicore.org/security/
```

## Privacy policy URL

```
https://satoshicore.org/extension/privacy/
```

## Detailed description

```
NSAT Wallet is a non-custodial wallet for the NSAT network (SatoshiCore). It runs as a browser popup and keeps the keys on your machine.

WHAT IT DOES
- Create a new NSAT account, or import one from your own encrypted backup.
- Unlock with a password; the seed is decrypted into memory only while the popup is open.
- Show balance, sequence number and the live base fee read from the ledger.
- Review a transfer (recipient, amount, fee, total debit) before anything is signed.
- Sign locally with Ed25519 and submit the already-signed transaction.
- Show confirmed / failed only when the index returns that transaction's ledger result.
- Export an encrypted backup file you can restore elsewhere.

HOW IT PROTECTS THE KEY
- The seed is generated on your device and stored only as AES-GCM-256 ciphertext, keyed by your password through PBKDF2-HMAC-SHA256 with 600,000 iterations.
- Nothing signs until you confirm the recipient, amount, fee and total debit.
- A signature is refused unless the network reports the exact Mainnet identity the build expects, so a test network cannot pass as Mainnet.
- The storage area is the extension's own; no web page can read it.

WHAT IT DOES NOT DO
- It does not hold, transfer or recover funds for you: there is no account, no server-side key, and no password reset. If you lose the password and have no backup, the funds at that address are unreachable.
- It does not exchange, swap or sell NSAT, and it is not an investment product.
- It does not collect analytics, advertising identifiers or browsing data.
- Shielded (private) transfers are desktop-only and are not part of this extension.

REQUIREMENTS
Chrome 114 or newer (Manifest V3). The extension talks only to two first-party endpoints: gateway.satoshicore.org for chain reads and signed-transaction relay, and satoshicore.org for public indexed history.

LIMITS YOU SHOULD KNOW
A browser extension is not a hardware wallet. Malware on your computer or a compromised browser can capture what you type. For large balances, use a device you trust and keep an encrypted backup offline. This build has internal review and test evidence but no external security audit.
```

## Graphics

| Asset | Requirement | Status |
|---|---|---|
| Store icon | 128×128 PNG | **ready** — `extension/icons/icon-128.png` |
| Screenshots | 1–5 × 1280×800 (or 640×400) | **owner must capture** — see `screenshots.md` |
| Small promo tile | 440×280, optional | not produced |
| Marquee promo tile | 1400×560, optional | not produced |
| YouTube video | optional | none |

## Test instructions tab (paste this)

```
No account, credentials or funds are needed.

1. Install the extension and click the toolbar icon.
2. Choose "Create wallet", set a password of at least 12 characters, and confirm.
3. The popup now shows the wallet: address, balance (0), fee read from the ledger, and the Send form.
4. Optional: lock and unlock with the same password to see the keystore round-trip.

Sending is disabled without funds, so no reviewer action can move real value. The extension needs no sign-in and contacts only the two endpoints listed in the privacy policy.
```

## Reviewer notes worth repeating in the submission form

- The extension has **no** remote code, **no** content scripts and **no**
  background worker; the popup is the entire surface.
- Version 24.0.0, packaged 2026-11-14, 80,478 bytes,
  sha256 `945d58a2bb80…`; the same digest is printed on
  <https://satoshicore.org/download/> so the store artifact can be matched to
  the published one.
- The wallet deliberately refuses to sign when the network identity does not
  match byte-for-byte. A reviewer testing against a different network will see
  that refusal as a designed safety gate, not a bug.
