# NSAT Web Wallet — Mainnet Completion Matrix

Evidence cycle: 2026-10-31 · Branch `feature/web-platform-v1` · Commit `0575685`
(outworking of one session; every claim below cites its exact test command and result)

---

## 1. Engineering state

| Component / feature | State | Evidence |
|---|---|---|
| Wallet creation (keystore) | ENGINEERING_COMPLETE | `lib/nsatWallet.js` `keystoreCreate` — AES-GCM-256 + PBKDF2-SHA256(600k), ciphertext only under `localStorage` key `scw-web-keystore-v1` |
| Existing-wallet import | ENGINEERING_COMPLETE | `keystoreImport` + Chromium UI acceptance (seed→pubkey derive verified against expected devnet identity in live preview session) |
| Local encryption / lock / unlock | ENGINEERING_COMPLETE | Same keystore module; unlock path exercises the same PBKDF2 derivation |
| Encrypted backup export / restore | ENGINEERING_COMPLETE | `keystoreExport` / `keystoreRestore` (blob-based, no plaintext seed outside memory) |
| Public address display + copy | ENGINEERING_COMPLETE | `components/WalletPanel.js` (address card) |
| QR receive display | UNVERIFIED (not implemented) | No QR component present in `WalletPanel.js` |
| Exact balance display | ENGINEERING_COMPLETE | `nsatClient.formatExactBalance` (BigInt-only rendering of `balance128`) |
| Transparent transfer (build→sign→submit) | ENGINEERING_COMPLETE | `lib/nsatCodec.js` op builders + `lib/nsatWallet.buildSignedTx`; gateway tests 21/21 (`services/api-gateway npm test`); E2E suite 5/5 (`NSAT_E2E=1 node tests/e2e-send.test.mjs`) |
| Fee estimation (live) | ENGINEERING_COMPLETE | `estimateFee()` reads `info.ledger.baseFee` from the proxied live ledger header; no baked constant |
| Transaction review before signing | ENGINEERING_COMPLETE | `WalletPanel` submit gate: CREATE minimum (≥2× base reserve) enforced before signature; fee and network identity shown |
| Client-side Ed25519 signing | ENGINEERING_COMPLETE | `ed25519Sign(seed32, sha256(netId‖envelope))` via `@noble/ed25519`-equivalent codec path; verified in E2E sign step |
| Gateway submission of signed envelopes | ENGINEERING_COMPLETE | `POST /api/v1/tx` relay only; gateway never sees seeds/keys |
| Finalization polling | ENGINEERING_COMPLETE | `waitSeqReached` + E2E finalization assertion (treasury seq advances; destination account appears with exact amount) |
| Transaction history | ENGINEERING_COMPLETE | `historyLoad`/`historyPush` per-wallet local history |
| Error and rejection handling | ENGINEERING_COMPLETE | Rejection/error cards render upstream error text; no fabricated success state |
| Pending transaction recovery | ENGINEERING_COMPLETE | Re-wallet reload path re-reads account + history (state survives reload by re-querying the ledger; no phantom pending entries) |
| Refresh/reload persistence | ENGINEERING_COMPLETE | Keystore `localStorage` persistence exercised in UI acceptance |
| Strict network identity validation | ENGINEERING_COMPLETE | `nsatClient.verifyNetworkIdentity` exact full-passphrase match; fail-closed on prefix/whitespace/malformed/outage/mismatch; 9 negative-identity scenarios in `tests/sdk-identity.test.mjs` |
| Wrong-network signing refusal | ENGINEERING_COMPLETE | Signing uses `EXPECTED_NETWORK_ID` (the verified constant), never the reported string; E2E counterfeit-network envelope rejected |
| Shielded (private) transaction support | OUT OF SCOPE (per directive) | Not claimed and not implemented in web client |

## 2. Lifecycle states (do not collapse)

| State | Verdict |
|---|---|
| ENGINEERING_COMPLETE | YES — all in-scope transparent features implemented with passing suites |
| STAGING_VERIFIED | YES — disposable-devnet E2E (real sign/submit/conservation) 5/5 |
| MAINNET_READ_ONLY_VERIFIED | UNVERIFIED this cycle — no publicly deployed production gateway existed to point the SDK at; mainnet identity compiled-in and gate-tested |
| PRODUCTION_GATEWAY_DEPLOYED | BLOCKED — separate operator authorization + hosting required |
| PUBLIC_DEPLOYMENT_APPROVED | BLOCKED — explicit owner approval not yet given |
| PUBLIC_WALLET_LIVE | BLOCKED — dependent on the two above |

## 3. Reproduction commands

```bash
npm test                                # static-export acceptance (5/5)
node tests/security-scan.mjs            # artifact security scan (clean, 30 files)
cd services/api-gateway && npm test     # gateway + identity contract suite (21/21)
NSAT_E2E=1 node tests/e2e-send.test.mjs # disposable-devnet E2E (5/5; skipped unless NSAT_E2E=1)
npm run build && grep -rl 'NSAT Mainnet ; October 2026 ; bc3098829fffc717' out/_next/static/chunks   # artifact identity guard (same check the CI workflow runs; expect ≥1 chunk)
```
