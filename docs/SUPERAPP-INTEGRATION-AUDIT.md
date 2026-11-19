# SatoshiCore Super App — Phase 1 audit and integration decision

Date: 2026-11-19 · Scope: reuse-before-rewrite audit of the existing codebase and of
the eight candidate GitHub projects, plus the first implemented slice.

Everything below marked "measured" was read from the working tree or the GitHub API
on this date; everything else is stated as a decision or an open risk.

## 1. What exists today (measured)

| Area | State | Evidence |
| --- | --- | --- |
| Web app | Next.js **14.2.15**, static export to GitHub Pages, PWA (service worker, manifest, share target), MV3 extension, 69 scheduled test files | `satoshicore-web/package.json`, `next.config.js`, `public/`, `extension/` |
| Web source control | **repaired today**: the main checkout `satoshicore-web/` was missing, so `.messenger-audit/` and two release snapshots were dangling worktrees with no usable git metadata. Re-cloned `SatoshiConnect/satoshicore` (base `86cf954`) and imported the newer working tree | commit `fa9115f` on branch `feature/superapp-integration` |
| Auth | Google sign-in + email link through Firebase Auth; `email_verified` enforced in Firestore rules; no second login system | `lib/firebaseAuth.js`, `lib/emailAuth.js`, `firestore.rules` |
| Identity | `profiles/{uid}` (handle, primary address, display text, visibility) + `profileIds/{id}` claim; contacts/friend requests/blocks in `contacts/`, `requests/`, `blocks/`, opt-in `discoveryEmails/` | `lib/profile.js`, `lib/contacts.js`, `firestore.rules` |
| Messaging | 48 client modules (relay client, E2EE, outbox, retry, presence, pins, search, forward, payments, push) + Node gateway relay `/api/v1/chat/*` | `lib/chat*.js`, `lib/e2eChat.js`, `services/api-gateway/server.js`, `docs/messenger/*` |
| Message crypto | X25519 (`clamp(SHA-512(seed))`) + XSalsa20-Poly1305 sealed envelopes signed with the wallet's Ed25519 key; device chat identity delegated once by the wallet | `lib/e2eChat.js`, `lib/chatIdentity.js`, `tests/e2e-chat.test.mjs` |
| Wallet (web) | Non-custodial browser keystore (PBKDF2-HMAC-SHA256 600k + AES-256-GCM), local signing, NSAT XDR encoder, fee-policy gate, signed-envelope relay | `lib/nsatWallet.js`, `lib/nsatCodec.js`, `lib/nsatSendPreflight.js`, `services/api-gateway/server.js` |
| Wallet (desktop) | Python keystore + RPC with Rust/NSAT core; 32-case acceptance suite recorded | `nsat-core/desktop/satoshicore-wallet/`, `nsat-core/MACOS-WALLET-STATUS.md` |
| Chain | `nsat-core` at `e9e02e386` (fee-free V_16 self-open, reserve-free account entry from V_15) | `git -C nsat-core log -1` |
| Characters | **was missing** — no character record, no character↔wallet binding, no in-world identity | `ls lib/characters.js` returned nothing before this slice |
| Pixel world | **missing** — no game server, no room, no renderer, no map data | no matching files in the tree |

## 2. Upstream evaluation (measured via GitHub API, 2026-11-19)

Pinned commits are the head of each default branch at audit time. "Verdict" is a
decision for this project, not a statement about the project's quality.

| Repository | License | Pinned commit | Maintenance signal | Verdict |
| --- | --- | --- | --- | --- |
| `TelegramOrg/Telegram-web-k` | **GPL-3.0** | `2e4bbb5` | 79★, pushed 2026-11-13 | **Reject as code.** GPL-3.0 is copyleft: linking it into the web bundle would relicense the combined work. It is also an MTProto client expecting Telegram's own API, not a general chat backend. Use it as a *visual reference only* (parity target), never copy markup or CSS from it. |
| `matrix-org/matrix-js-sdk` | Apache-2.0 | `484d22d` | 2.2k★, pushed 2026-11-19 | **Not now.** Migration would replace a working, tested relay + E2EE stack with a homeserver dependency and discard the wallet-signed envelope model. No requirement it uniquely satisfies. Revisit only if federation becomes a product requirement, with an evidence-based migration note. |
| `matrix-construct/tuwunel` | Apache-2.0 | `2f05870` | 2.8k★, pushed 2026-11-18 | **Not now.** Same reason as above, plus a Rust homeserver to operate on a 16 GB iMac for a feature nobody asked for yet. |
| `trustwallet/wallet-core` | Apache-2.0 | `f90a51f` | 3.6k★, pushed 2026-11-19 | **Reject for NSAT signing.** No NSAT chain in its registry; its Stellar-family support does not encode NSAT fee-policy, memo or sponsorship rules. Adding C++/WASM binding for a signing path we already have verified would add supply-chain risk, not remove it. |
| `gemwalletcom/wallet` | **GPL-3.0** | `9e6b022` | 416★, pushed 2026-11-19 | **Reference only.** Its Rust core already lives in this workspace as an isolated fork (`satoshicore-wallet`, `f93c246`); that repo must keep GPL-3.0 and must not be statically linked into the web bundle. |
| `RSamaium/RPG-JS` | MIT | `a244232` (v5) | 1.7k★, pushed 2026-11-19 | **Candidate, not chosen first.** Full MMORPG framework (`@rpgjs/server` 5.3.0) with its own client, events and Tiled map pipeline. Strong map tooling; opinionated about scenes and UI, and heavier than a presence room needs. Keep as the fallback if authored maps become the bottleneck. |
| `colyseus/colyseus` | MIT | `31bb1a8` (npm **0.18.12**, 343 KB unpacked) | 7.6k★, pushed 2026-11-18 | **Chosen for the world layer.** Server-authoritative rooms, delta state sync, tiny Footprint, works with any renderer, maps directly onto "room per location" and lazy loading. No UI opinions to fight. |
| `cc26-sudo/Gather` | **none** | `6d7ae2d` | 0★, pushed 2026-03-19 | **Reject.** No license file means all rights reserved: copying it would be infringement. Nothing here justifies asking for a license. |

## 3. Chosen architecture

```
Static Next.js app (Pages)            Node services (self-hosted)
┌───────────────────────────┐         ┌──────────────────────────────┐
│ UI: Chats · World · Wallet│         │ api-gateway: relay + indexer │
│ keystore, signing, E2EE   │────────▶│ (already exists, unchanged)  │
└───────────┬───────────────┘         └──────────────┬───────────────┘
            │                                        │
            │ identity / profile / contacts          │ signed envelopes only
            ▼                                        ▼
       Firestore (Firebase)                    NSAT Mainnet node
            ▲
            │ world presence (in-memory, never a location history)
            │
   ┌────────┴───────────────┐
   │ world server (new):    │
   │ Colyseus room per city │
   └────────────────────────┘
```

Rules this architecture keeps:

- **One identity.** Firebase `uid` + `profiles/{uid}` stays the account. Characters
  hang under the account; there is no second login, and the world server never
  issues its own credentials.
- **Separation of concerns.** Chat data lives in the relay + Firestore; game state
  lives in room memory; money moves only through the existing gateway as
  already-signed XDR. The game server is never a custodian.
- **License boundary.** No GPL code is imported into the web bundle or the world
  server. The GPL fork stays a separate artifact.
- **No new paid services.** Everything above runs on the local machine for
  development and on the existing operator host for release.

## 4. First implemented slice — character identity and verified wallet binding

Requirement covered: *"1 User Account → Multiple Characters, 1 Character → 1
Dedicated NSAT Wallet Address … The Wallet binding must be authenticated and
verifiable … Changing appearance must not change wallet ownership … Deleting a
character must never destroy its private keys."*

Files changed:

| File | Change |
| --- | --- |
| `lib/characters.js` | New. Opaque `ch_`+128-bit ids; exact document shape; appearance bounds; Ed25519-signed binding `nsc-character\|1\|<characterId>\|<owner>\|<address>\|<issuedAt>`; `bindWallet`, `planUnlinkWallet` (backup-gated), `planDeleteCharacter` (tombstone), `renameCharacter`/`restyleCharacter` (id and wallet untouched); the only payment lookup, `resolveRecipient`, which rejects a display name and an unverified binding |
| `tests/characters.test.mjs` | New. 15 tests: id stability, name/appearance bounds, exact key set (no seed/password/location), binding verifying only for its character/account/address/time, seed-mismatch refusal, owner-mismatch and silent re-point refusal, rename/restyle preserving the wallet, backup-gated unlink, tombstone semantics, name-never-an-address, character limit, rules shape |
| `firestore.rules` | New `characters/{owner}/list/{characterId}` block: owner-only writes, `get` for signed-in accounts, `list` closed, **`delete` denied** (tombstones only), immutable id/owner/createdAt, tombstone cannot be revived, appearance index ranges and address shape enforced server-side |
| `package.json` | `tests/characters.test.mjs` added to the `test` chain |

Validation actually run:

```
$ node --test tests/characters.test.mjs
ℹ tests 15  ℹ pass 15  ℹ fail 0
$ node scripts/check-test-coverage.mjs
npm test coverage OK: all 69 tests/*.test.mjs files are scheduled.
```

Not run: Firestore emulator rules validation (the Firebase CLI is not installed in
this workspace) and the full `npm test` chain. Both are listed as open checks.

## 5. Known risks and open items

1. **Rules are unverified against the emulator.** Syntax and semantics were
   reviewed by hand and mirrored from the existing profile block, but no
   `firebase emulators:exec` run happened here.
2. **Binding verification is client-side today.** `resolveRecipient` verifies the
   signature, but nothing server-side re-checks it yet. The world server and any
   future "pay this character" endpoint must verify the same bytes before showing
   an address.
3. **Character documents are not yet written by any UI.** This slice is the
   record + crypto + rules layer; the Create Character flow, chat entry point and
   world rendering are the next slices.
4. **Two release snapshots (`.deploy-d06138d`, `.shadow-release/web-integration`)
   are still dangling worktrees.** They were not migrated; only the newest tree
   (`.messenger-audit`) was.
5. **No performance numbers yet.** Nothing was benchmarked; no claim about
   capacity is made.

## 6. Next implementation task

A Colyseus world server (`services/world-server/`) with:

1. same-origin ticket endpoint that authenticates with the existing Firebase
   session and reads the character id — no new login;
2. one room per city, broadcasting position + presence, never storing a
   real-world location;
3. a server-side `resolveRecipient` re-check before any "send NSAT" action is
   offered;
4. a first canvas scene with one animated avatar and collision against a tile map,
   verified by two clients in a local run.

Then the Create Character flow that writes the document this slice defines.
