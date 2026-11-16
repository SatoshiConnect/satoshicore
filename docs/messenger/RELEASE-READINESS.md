# Messenger P3 — release readiness

Status: **release candidate ready for owner-approved deployment; nothing was deployed
in this pass.** The web and gateway code are verified locally against the live
Mainnet read path. Production runtime, data and funds were not changed.

Branch: `feat/messenger-payments-p3` · baseline commit `0c38578` · this document
and the verification polish are committed on top of it.

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

## Deployment order (owner approval required)

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

5. **Browser acceptance with disposable wallets.** Two newly created, unfunded
   wallets on the live site: add each other by address, send one payment request,
   verify the recipient sees the exact amount and the **Review payment** button.
   Do not approve a send. A transaction card cannot be exercised end-to-end
   without a real on-chain payment, so that path is covered by the read-only
   Mainnet check and the synthetic relay round-trip instead.

## Rollback

1. **Web first:** switch `~/nsat-ops/satoshicore-webroot` back to the previous
   versioned webroot. This removes the new UI before the old gateway can make its
   block/request controls look broken.
2. **Gateway:** restore the backed-up `chat-relay.mjs` and restart the launchd
   job. The additive chat tables do not need a schema rollback.
3. **Rules:** restore the previous Firestore ruleset from Console version history.
4. Undelivered ciphertext in `chat.sqlite` is not deleted by rollback.

## Remaining limits and gates

- No production deploy, Firebase rules release, Mainnet transaction or funded-key
  use happened in this pass. Each of those is a separate owner decision.
- The screen has not been visually exercised with two real signed-in accounts in
  this environment. The 12-tab browser session was full and was not replaced.
- The first P1/P2/P3 release order matters; see above. P1 account contacts and
  relay blocks are not retroactive to clients that stay on the old build.
- The production gateway's `/v1/confirmations/{hash}` and `/v1/tx/{hash}` routes
  have the required shape; the release candidate adds no indexer change.
- No new payment amount format or signing path is introduced. The existing fee,
  network identity, reserve and local-signing gates remain authoritative.
