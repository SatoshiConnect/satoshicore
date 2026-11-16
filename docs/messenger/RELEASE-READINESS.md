# Messenger P3 — release readiness

Status: **deployed to production on 2026-11-16 after owner approval; the
two-wallet payment-request acceptance passed.** The web, Firestore rules and
gateway P2 are live. No transaction was submitted and no funds were moved.

Branch: `feat/messenger-payments-p3` · deployed commit `5f3b3d4` (on top of
`0c38578`; includes the same-origin relay and PWA root-registration fixes).

## Deployment record

| Item | Value |
|---|---|
| Firestore rules | ruleset `e4bac944-e3f3-4765-83fd-a4583dccb127`, sha256 `5ce23c7b…` |
| Gateway relay | `chat-relay.mjs` sha256 `a0218edb…`, launchd `org.satoshicore.gateway` running |
| Webroot | `~/nsat-ops/satoshicore-webroot-swfix-5f3b3d4` |
| Live index | sha256 `b47b51f3f096d2cc00470f5c85bc5e043a1db0709adb656fe8764345a265da2e` |
| Production checks | P3 checker 4/4; `verify:deployed` 8 passed / 0 failed / 2 advisory; focused payment tests 21/21; service-worker tests 4/4 |
| Artifact checks | markers for `NSAT-PAY-REQUEST/1`, `NSAT-TX/1`, `Finalized`, `Unverified`, `nw-chat-tx-card`, `chatEnabled:!0`; same-origin relay origin present; root `/sw.js` registration; 66 files, no source maps or private keys |
| Live acceptance | two unfunded wallets, exact `9007199254740993` NSAT request, recipient amount/address exact, Review prefilled the Send page, confirmation disabled, no modal or transaction; relay writes 200 and test rows removed |
| Rollback | webroot `satoshicore-webroot-menu-02f5644`; gateway backups in `~/nsat-ops/backups/p3-20261116/`; previous ruleset `1f1bbce6-cf44-49f2-b2da-59b46b55a2e9` |

Headless Chromium rendered the signed-out gate (`Open your wallet`) and the
acceptance ran in two clean browser profiles. A fresh production check after
`5f3b3d4` confirmed the PWA registration: `/wallet/` registered
`https://satoshicore.org/sw.js` with scope `https://satoshicore.org/`; the
`nsat-pwa-v4` cache contained both `/` and `/wallet/`; the page was controlled
by `/sw.js` after reload; and there was no `/wallet/sw.js` request, failed
request or console error.

## What is ready

| Area | Evidence |
|---|---|
| Payment request encoding | exact signed-128-bit integer, authenticated sender binding; 6 tests |
| Transaction card parsing | strict payload, no sender/status injection; 3 tests |
| Exact-hash verification | network → confirmation → detail → native payment match; 10 tests |
| Encrypted relay round-trip | synthetic wallets, real HTTP relay, request + card; 1 test |
| Live Mainnet read | known transfer `6de0ea9e…fe4d` → **finalized**, ledger 301705; wrong amount → **unknown** |
| Shadow release gateway | P2 block gate + exact-hash card check: 4/4 passed on `127.0.0.1:8798` |
| Web build | `next build` passes with the production flags |
| Whole test suite | `npm test` passes after the build |

Reproduce the read-only production checks:

```bash
cd .messenger-audit
npm run verify:messenger-p3
# after the P2 gateway is deployed:
NSAT_GATEWAY_URL=https://gateway.satoshicore.org \
  node scripts/verify-messenger-p3.mjs --require-relay-gates
```

The script never publishes a chat key, stores a message or submits a transaction.
It computes one throwaway Ed25519 key in memory only for a signed GET of the
wallet's own block list.

## Deployment order (procedure used after owner approval)

**Do not publish the web build before the gateway.** The current production
gateway predates P2: a signed `GET /api/v1/chat/blocks` answers `not found`. A web
build containing P3 would still send messages, but every thread would show
"Could not read the block list" and the block control would fail.

1. **Firestore rules.** Deploy `firestore.rules` so the Contact screen in this
   bundle can write its contact graph. This does not affect payment requests or
   card verification, but it is part of the same UI release.
   ```bash
   npx firebase deploy --only firestore:rules --project nsat-wallet-login
   ```
   Record the previous ruleset in Firebase Console → Firestore → Rules → version
   history before changing it.

2. **Gateway P2.** Back up the live `server.js` and `chat-relay.mjs`, copy
   `chat-relay.mjs` from the reviewed commit (never edit the live file in place),
   then restart only `org.satoshicore.gateway`.
   ```bash
   cd .messenger-audit
   git show HEAD:services/api-gateway/chat-relay.mjs > /tmp/nsat-chat-relay.mjs
   install -m 0644 /tmp/nsat-chat-relay.mjs ~/nsat-ops/gateway/chat-relay.mjs
   launchctl bootout gui/$(id -u)/org.satoshicore.gateway
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/org.satoshicore.gateway.plist
   ```
   `NSAT_CHAT_RELAY=1` and the existing `NSAT_CHAT_DB` stay configured. The new
   tables (`chat_quota`, `chat_blocks`) are additive.

3. **Verify the gateway before the web release.**
   ```bash
   NSAT_GATEWAY_URL=https://gateway.satoshicore.org \
     node scripts/verify-messenger-p3.mjs --require-relay-gates
   ```
   Expect 4/4 PASS. Stop here if the P2 check fails.

4. **Web build and publish.** Use the same public Firebase web config as the live
   build; those values are public and must not be replaced with secrets.
   ```bash
   NEXT_PUBLIC_API_SAME_ORIGIN=1 \
   NEXT_PUBLIC_CHAT_RELAY=1 \
   NEXT_PUBLIC_NSAT_NETWORK_ID='NSAT Mainnet ; October 2026 ; bc3098829fffc717' \
   NEXT_PUBLIC_FIREBASE_API_KEY=… \
   NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=… \
   NEXT_PUBLIC_FIREBASE_PROJECT_ID=… \
   NEXT_PUBLIC_FIREBASE_APP_ID=… \
   npm run build
   ```
   Publish `out/` to a **new** versioned webroot and switch the symlink only after
   the artifact check:
   ```bash
   node scripts/verify-deployed-site.mjs https://satoshicore.org
   ```
   The build must contain `Request payment`, `NSAT-PAY-REQUEST/1`,
   `NSAT-TX/1`, `Finalized`, `Unverified` and `nw-chat-tx-card`. (Next minifies
   the middle dot in `Verified · Finalized` to the JS escape `\xb7`, so grep for
   the stable words rather than the full label.)

5. **Browser acceptance with disposable wallets (passed 2026-11-16).**
   Two newly created, unfunded wallets in independent browser profiles added each
   other by address and sent one `9007199254740993` NSAT request. The recipient
   saw the exact amount and requesting address; **Review payment** prefilled
   `#nw-dest` and `#nw-amt` exactly; `Review Transaction` was disabled and no
   modal opened. No send was approved. The two test keys and quota row were
   deleted afterwards, and both addresses had no on-chain account (`404`). A
   transaction card still cannot be exercised end-to-end without a real on-chain
   payment, so that path is covered by the read-only Mainnet check and the
   synthetic relay round-trip instead.

## Rollback

1. **Web first:** switch `~/nsat-ops/satoshicore-webroot` back to
   `satoshicore-webroot-menu-02f5644`. This removes the new UI before the old
   gateway can make its block/request controls look broken.
2. **Gateway:** restore `~/nsat-ops/backups/p3-20261116/chat-relay.mjs.pre-p3`
   and restart the launchd job. The additive chat tables do not need a schema
   rollback.
3. **Rules:** re-release ruleset
   `1f1bbce6-cf44-49f2-b2da-59b46b55a2e9` (also saved as
   `~/nsat-ops/backups/p3-20261116/firestore.rules.live`) or restore it from
   Console version history.
4. Undelivered ciphertext in `chat.sqlite` is not deleted by rollback.

## Remaining limits and gates

- Production deploy and Firebase rules release happened in this pass; no Mainnet
  transaction or funded-key use did.
- The two-wallet acceptance used standalone wallets, not two Google-linked
  accounts; that account-specific path remains untested.
- The first P1/P2/P3 release order matters; see above. P1 account contacts and
  relay blocks are not retroactive to clients that stay on the old build.
- The production gateway's `/v1/confirmations/{hash}` and `/v1/tx/{hash}` routes
  have the required shape; the release candidate adds no indexer change.
- No new payment amount format or signing path is introduced. The existing fee,
  network identity, reserve and local-signing gates remain authoritative.
