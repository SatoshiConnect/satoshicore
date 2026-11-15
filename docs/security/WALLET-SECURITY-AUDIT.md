# WALLET SECURITY AUDIT — lib/nsatWallet.js + WalletPanel (web wallet)

Commit basis: `f8e02cc` + hardening diff (2026-11-14). Prior audits retained where still valid; this file is the current source of truth.

## PASS — verified controls (with test evidence)

| Control | Evidence |
|---|---|
| CSPRNG: `crypto.getRandomValues` (32-byte seed) | code audit; browser-native CSPRNG |
| KDF: PBKDF2‑HMAC‑SHA256, 600,000 iterations, 16-byte random salt per entry | keystore suite |
| AEAD: AES‑256‑GCM, 12-byte random IV per encryption | keystore suite |
| Seed never persisted in plaintext / seed strkey never in keystore blob | `create → unlock round trip … seed never at rest ✔` |
| Address cannot diverge from signing key at creation/import: pubkey DERIVED from seed inside the wallet entry | code audit (`walletEntry`) |
| Restore integrity: 14 malformed/tampered backup shapes refused BEFORE overwriting live keystore (NEW this session) | `keystoreRestore refuses malformed backups ✔` |
| Unlock integrity: displayed pubkey must equal derived signing key or unlock is refused (NEW — anti-phishing pairing check) | `unlock integrity ✔` |
| Wrong password: single failure-mode error, no oracle detail, no partial state | `wrong password fails closed ✔` |
| Keystore list exposes only name + address (no ciphertext shape leaks in UI) | same suite |
| Backup export = ciphertext blob only | same suite (`keystoreExport`) |
| Zero-float money: 128-bit balances as decimal strings, BigInt arithmetic, exact integer stroops | `nsatClient.formatExactBalance` regex-guarded; send path rejects non-integer amounts |
| Exact Mainnet identity gate before any signing; review modal re-states the verified network string at the signing step | identity suite + browser E2E review-modal screenshot |
| Local signing: Ed25519 over `sha256(netHash ‖ ENVELOPE_TYPE_TX ‖ ENVELOPE_TX_V0 ‖ txV0)`; finalization tracked by sequence advance (`waitSeqReached`), never assumed | code audit + e2e-send suite (devnet) |
| Replay defense: monotonic sequence derived from authoritative `seqnum` pull before each send | code audit |

## UNVERIFIED / BLOCKED (honest limits)

| Limit | Why | Path |
|---|---|---|
| localStorage kill-for-password is NOT hardware security | Keystore is only as strong as the passphrase and the browser profile's integrity | Documented to users in the unlock panel; no claim of hardware-wallet security anywhere in the UI |
| Seed lifetime in memory | JS cannot guarantee zeroization of every copy the runtime made (WebCrypto internals, string-encoded seed shown once); active buffers and expanded Ed25519 secret keys are overwritten, duplicates may still exist | Irreducible JS limitation — documented, not claimed |
| Browser runtime compromise (malicious extension, exploit) defeats everything | Threat model T9/T13: assume the browser is trusted only at use time | Mitigation is a minimized surface (no remote scripts in the wallet bundle), not a false guarantee |
| XSS on the Pages-hosted site | No `dangerouslySetInnerHTML` found by audit + secret scan; site-level CSP is NOT set at this host (GitHub Pages standard headers only) | Site CSP is UNVERIFIED — avoid claiming defense there |
| Seed zeroization on lock | `zeroSeed()` overwrites the active buffer and any in-flight signing copy on lock, account switch, unmount, pagehide and 10-min-idle background; `ed25519Keypair`/`ed25519Sign` wipe the expanded 64-byte secret key after use | code audit + `zeroSeed wipes signing-key bytes ✔`; UI lock path not yet exercised in a browser |
| Inactivity / background lock | 5-minute idle auto-lock (operator may tune 1–60 min, cannot disable), immediate lock on tab hide/pagehide, and pending unlock/create/import results are discarded if the app left the foreground | code audit; browser-level visibility behavior unverified |
| Clipboard sniffing of addresses | Copy-address uses `navigator.clipboard`; OS-level clipboard readers are outside our control | Documented residual |
| Desktop/Tauri partner audit parity | The desktop wallet's custodial model was reviewed in prior sessions (macOS-Status doc), but this session's web hardening did not re-run desktop suites | Re-run on next desktop session |

## Regression coverage for every new control
`node --test tests/keystore.test.mjs` → 10/10 ✔ (subtitle: key custody & integrity).
`node --test tests/wallet-engine.test.mjs` → 5/5 ✔ (offline signing; lock-cancelled signing refuses before and after async account lookup).
