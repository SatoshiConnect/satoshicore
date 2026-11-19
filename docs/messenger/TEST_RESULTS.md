# TEST_RESULTS

Evidence recorded **2026-11-16**, with a production smoke test on **2026-11-17**, on the user's machine:

| Item | Value |
|---|---|
| Repository | `NSAT-Core-Rebase/.messenger-audit` |
| Branch / HEAD | `feat/chat-first-wallet-ux` / `d63d6ff` + uncommitted worktree changes |
| OS | macOS 26.7.1 |
| Node | v26.8.2 |
| npm | 11.19.1 |
| Test runner | `node --test` (built-in) |
| Working tree | modified and new files; **no source commit/push**; production deploy is recorded in `DEPLOYMENT_GUIDE.md` §12 |

Every command below was executed during this audit. Numbers are copied from the
runner output, not estimated. Duration figures are the runner's own.

---

## 1. Results summary

| # | Command | Tests | Pass | Fail | Exit | Duration |
|---|---|---|---|---|---|---|
| 1 | `node --test tests/firebase-auth.test.mjs tests/profile.test.mjs tests/contacts.test.mjs` | 42 | 42 | 0 | 0 | 82.3 ms |
| 2 | `npm run test:email-auth` (**Phase 0 + email change**) | 25 | 25 | 0 | 0 | 59.7 ms |
| 3 | `npm run test:chat-payments` | 51 | 51 | 0 | 0 | 1089.5 ms |
| 4 | `node --test tests/chat-relay.test.mjs tests/chat-relay-gates.test.mjs tests/chat-relay-archive.test.mjs tests/e2e-chat.test.mjs` | 42 | 42 | 0 | 0 | 690.1 ms |
| 5 | `npm run test:gateway` (**Phase 1 + proxy-IP regression**) | 6 | 6 | 0 | 0 | 101.1 ms |
| 6 | `npm run test:clipboard` (**B2.7, new**) | 3 | 3 | 0 | 0 | 64.7 ms |
| 7 | `npm run test:export` (**A9.4, new**) | 4 | 4 | 0 | 0 | 75.0 ms |
| 8 | `node --test tests/session-policy.test.mjs` (**A2.4**) | 11 | 11 | 0 | 0 | 74.5 ms |
| 9 | `npm run test:pins` (**B5.6, new**) | 5 | 5 | 0 | 0 | 58.2 ms |
| 10 | `npm run test:forward` (**B2.6, new**) | 3 | 3 | 0 | 0 | 52.1 ms |
| 11 | `npm run test:search` (**B5.3, new**) | 4 | 4 | 0 | 0 | 57.7 ms |
| 12 | `npm run test:relay-status` (**B7.9, new**) | 4 | 4 | 0 | 0 | 55.3 ms |
| 13 | `npm run test:reply` (**B2.3, new**) | 5 | 5 | 0 | 0 | 61.7 ms |
| 14 | `npm run test:share` (**A5.3, new**) | 7 | 7 | 0 | 0 | 57.1 ms |
| 15 | `npm run test:outbox` (**M1, new**) | 6 | 6 | 0 | 0 | 71.3 ms |
| 16 | `node --test tests/chat-events-http.test.mjs` (**M1 realtime + v3 SSE regression**) | 2 | 2 | 0 | 0 | 3243.8 ms |
| 17 | `npm run test:control` (**M1 edit/reactions, new**) | 2 | 2 | 0 | 0 | 62.6 ms |
| 18 | `npm run test:presence` (**opt-in presence, new**) | 2 | 2 | 0 | 0 | 48.9 ms |
| 19 | `npm run test:mute` + `test:notify` (**new**) | 3 | 3 | 0 | 0 | 55.4 ms |
| 20 | `npm run test:chat-tabs` | 6 | 6 | 0 | 0 | 64.4 ms |
| 21 | `npm run test:acceptance:locked` | 3 | 3 | 0 | 0 | 376.0 ms |
| 22 | `npm run build` | — | 14/14 pages | 0 | 0 | not printed |
| 23 | `node tests/static-export.test.mjs` | 12 | 12 | **0** | **0** | 32.3 ms |
| 24 | Production smoke: wallet-signed + delegated v3 runs over `https://gateway.satoshicore.org` (**2026-11-17**) | 13 checks | 13 | 0 | 0 | — |

**Focused suites: 236 automated tests, 236 passed, 0 failed. Production smoke: 13/13 checks passed. Build: passed. Static-export gate: 12/12 (production Firebase config present).**

### 1.1a What suite 2 covers (Phase 0)

`tests/email-auth.test.mjs` — 25 tests over `lib/emailAuth.js` with a fake
provider and a fake Firebase SDK. It proves email/password validation, the
12-character policy, duplicate/invalid-credential/too-many-requests mapping,
registration ordering (persistence → create → verification), the neutral forgot-
password response, reset-code handling, resend/already-verified behaviour,
change-password ordering (reauthenticate → update), and email change ordering
(reauthenticate → `verifyBeforeUpdateEmail`, old address kept until verified).
It also proves the password is never returned in a result or an error message.

**What it does not prove:** no real Firebase account was created, no email was
delivered, no verification link was clicked, no reset code was redeemed, and no
browser form was submitted. Those require the public Firebase config and the
Email/Password provider.

### 1.1b Phase 1 security fixes (this round)

Two findings from `SECURITY_REVIEW.md` were fixed with failure-injection/restart
tests:

- **F5 — atomic contact writes.** `createFirestoreContactsStore.apply()` now
  commits all contact/request documents in one Firestore `writeBatch`, and
  `firestore.rules` uses `existsAfter()`/`getAfter()` so a batched accept is not
  judged against the pre-batch request. `tests/contacts.test.mjs` injects a
  failed commit and proves no friendship is left half-accepted, then retries.
  **The rules change has not been emulator-tested or deployed.**
- **F8 — durable replay guard.** Nonces live in the `chat_nonces` SQLite table,
  not an in-memory map. `tests/chat-relay.test.mjs` replays a signed request
  after closing and reopening the relay on the same database and gets `409`.

### 1.1c Account export (A9.4)

`tests/account-export.test.mjs` — 4 tests: documented shape and sorted peer ids;
request states filtered to the known values; no email/seed/password/token in the
JSON; absent/invalid profile becomes `null`; filename is date-stamped. The
export is **scoped**: no chat transcripts or Auth/session records.

### 1.1d Phase 1 gateway hardening (this round)

`tests/gateway-hardening.test.mjs` — 5 tests:

- **F10** — the per-IP window allows exactly `maxRequests` and then refuses, a
  new window resets, a spoofed-IP flood cannot grow the bucket map past
  `RATE_BUCKET_LIMIT`, and expired buckets are evicted before live ones.
- **F11** — the chat failure log records a stable code and does not pass
  `error.message` through (source assertion, so a future edit cannot quietly
  reintroduce it).

### 1.1e Session lifetime (A2.4)

`tests/session-policy.test.mjs` — 11 tests: the 30-day idle window, the 90-day
absolute window from first sign-in, migration of pre-`startedAt` records, a
clock that moves backwards, blocked/corrupt storage, replacement on account
switch, `startedAt` preservation across touches, and the expiry notice.

### 1.1f Message copy (B2.7)

`tests/clipboard.test.mjs` — 3 tests: the exact message text reaches
`clipboard.writeText`; a missing clipboard reports `CLIPBOARD_UNAVAILABLE`
rather than pretending success; a denied write reaches the caller as a failure.
The UI renders Copy only for plain messages and shows “Copied”/“Copy failed”
plus a screen-reader status.

### 1.1g Pinned conversations (B5.6)

`tests/chat-pins.test.mjs` — 5 tests: toggle on/off, per-wallet isolation,
uppercase normalization, duplicate removal, the 100-entry cap, and blocked or
corrupt storage. The chat list sorts pinned conversations first and exposes a
Pin/Unpin button with `aria-pressed`.

### 1.1h Forwards (B2.6)

`tests/chat-forward.test.mjs` — 3 tests: the current room is excluded, targets
are valid/uppercase/de-duplicated, and the picker caps at 50. The UI sends the
selected text through the existing encrypted client and archives it when saved
history is enabled.

### 1.1i Conversation search (B5.3)

`tests/chat-search.test.mjs` — 4 tests: case-insensitive matching over display
name, @handle and wallet address; an empty query returns the full list; the
caller's pinned-first order is preserved. The UI filters only the local chat
list and shows a no-match state.

### 1.1j Chat failure status (B7.9)

`tests/chat-relay-status.test.mjs` — 4 tests: network failures on send keep the
draft and say nothing was queued; read failures keep the last messages and offer
a retry; server errors get a stable title; a missing error still yields usable
text. Background polls remain silent by design.

### 1.1k Replies (B2.3)

`tests/chat-reply.test.mjs` — 5 tests: target/quote/body round trip, malformed
markers stay inert, invalid fields are rejected, quote and total payload bounds,
and nested replies quote the body rather than the wire format. Copy, forward and
previews use the human-readable body.

### 1.1l Profile sharing (A5.3)

`tests/profile-share.test.mjs` — 7 tests: public profiles share the handle,
contacts/private profiles share the address, address-only profiles still work,
base paths and old `/wallet/` links are preserved, invalid/non-http URLs and
empty profiles produce no link, share text contains only the display label, and
the warning distinguishes a limited profile from a public profile without a
primary wallet.

### 1.1m Real-account browser check (A5.3)

Checked **2026-11-16** against a signed-in Google account on the local dev build
(`http://localhost:65321/wallet/`, chat relay flag enabled). This was a read-only
profile check; no profile field was saved or deleted.

| Check | Result |
|---|---|
| Profile loaded | `@satoshi`, visibility “Any signed-in account”, primary wallet `GDAILW…QB55` |
| Share link | `http://localhost:65321/wallet/?add=%40satoshi` |
| QR | rendered locally, `data:image/png`, natural size 220×220 |
| Copy link | status “Link copied…”; `pbpaste` returned exactly the link |
| Share… | desktop Chromium has no `navigator.share`; fallback said “This browser cannot open a share sheet; the link was copied instead.” |
| Fresh receiver | incognito tab with the link kept the query and showed the sign-in screen |
| Signed-in receiver | opening `?add=%40satoshi` showed the add field pre-filled with `@satoshi` |
| Private save attempt | selecting “Only me” and saving was **refused by the deployed rules**: “The database refused this change”; no profile field changed |
| Private + primary wallet | component state injected with `visibility=private` and the real address: link became `?add=GDAILW…QB55`, no limited warning, QR still rendered |
| Private + no primary wallet | component state injected with `visibility=private`, `primaryAddress=''`: link stayed `?add=%40satoshi` and the warning “This profile is limited and has no primary wallet…” appeared |
| Public + no primary wallet | component state injected with `visibility=signed-in`, `primaryAddress=''`: link stayed `?add=%40satoshi` and the warning “This profile has no primary wallet…” appeared |
| State restored | original `signed-in` / primary wallet restored in the component; UI showed “Any signed-in account” again |

**Not covered:** a second real account, a persisted contacts/private profile (the
rules refused the real save), a mobile native share sheet, and scanning the QR
with a camera. Private/no-primary message checks used injected component state,
not a backend write. The local gateway also returned CORS preflight failures for
balance/chain calls; those are unrelated to sharing and were not counted as a
pass.

### 1.1n Realtime (M1)

`tests/chat-events-http.test.mjs` starts the real gateway with a temporary
SQLite file, refuses an unsigned `/api/v1/chat/events` handshake, authenticates
a signed SSE handshake, and proves that sending a message produces a wake-up
frame for that recipient. The relay unit test also pins replay rejection and
recipient filtering.

### 1.1o Presence (opt-in)

`tests/chat-presence.test.mjs` proves the preference is off by default, scoped per
wallet, and fails closed when storage is corrupt. The relay test proves presence
is only disclosed to a wallet with shared history and an offline heartbeat hides
it immediately.

### 1.1p Edit and reactions (M1)

`tests/chat-control.test.mjs` covers the encrypted control encoding: edit text
and reaction emoji round-trip, while unknown kinds, zero ids, empty edits and
oversized values fail closed. The controls are ordinary E2EE envelopes, so the
relay never sees the target text or emoji.

### 1.1q Outbox and idempotency (M1)

`tests/chat-outbox.test.mjs` — 6 tests: ciphertext-only persistence, dedupe by
`clientId`, per-wallet scope and 50-row cap, removal, bounded failure metadata,
and rejection of corrupt rows. `tests/chat-relay.test.mjs` adds a retry case:
the same `clientId` returns the original row even when the envelope bytes differ.

### 1.1r What suite 1 covers

`tests/firebase-auth.test.mjs`, `tests/profile.test.mjs`,
`tests/contacts.test.mjs` — Google session persistence and sign-out ordering;
handle normalization, claim, rename, rollback; optional display name/bio/status
normalization, bounds and preservation; profile visibility (closed set, default,
fail-closed unknown, preservation); peer-label fallback (display name →
handle → caller fallback); rules-text assertions for verified email, ownership,
wallet linking, text limits and visibility reads; friend-request state machine;
blocks; email-discovery opt-in, hashing and throttle.

### 1.1s Production end-to-end smoke (2026-11-17)

Run directly against `https://gateway.satoshicore.org` with freshly generated,
unfunded throwaway wallet seeds and chat identities. No operator seed, wallet
file or password was used, and no NSAT transaction or signature for a
transaction was made. Each run sent one message A → B, decrypted it as B,
checked the stored row, marked it read, fetched the sender's receipt, acked it,
and then deleted its key/device/message/quota rows from the production SQLite
file.

**Run 1 — wallet-signed requests and v1 bundle (7 checks):**

| Check | Result |
|---|---|
| Two throwaway identities published | PASS |
| Message accepted by production relay | PASS |
| Recipient decrypted the exact message | PASS (relay id 4) |
| Relay stored ciphertext only | PASS (472-byte envelope, no plaintext) |
| Read receipt reached the sender | PASS (`lastId=4`) |
| Recipient ack cleared the relay copy | PASS (`acked=1`) |
| Test rows removed | PASS (4 baseline keys, 0 messages; no smoke address remains) |

**Run 2 — delegated chat identity, v2 bundle and v3 signed requests (6 checks):**

| Check | Result |
|---|---|
| Delegated chat identities published | PASS |
| v3 message accepted by production relay | PASS |
| v3 recipient decrypted the exact message | PASS (relay id 5) |
| v3 read receipt reached the sender | PASS (`lastId=5`) |
| v3 recipient ack cleared the relay copy | PASS (`acked=1`) |
| v3 test rows removed | PASS |

Database `PRAGMA integrity_check` was `ok` after cleanup, and no non-baseline
test key remained. This proves the deployed gateway, relay, client signing,
encryption/decryption, read-receipt and ack paths work together on production,
including the delegated identity the locked-wallet UI uses. The browser UI is
covered separately in §1.1t; Google sign-in and an operator's real wallet seed
remain unverified here.

### 1.1t Production UI hotfix — 2026-11-17

Three production defects found while exercising the real browser UI with two
disposable, unfunded wallets:

1. **SSE rejected the delegated identity.** `relay.authenticate()` verified only
   wallet-signed v1/v2 requests, but the UI signs v3 with its delegated chat key.
   `/api/v1/chat/events` answered 401 and reconnected every 3 s. Fixed in
   `chat-relay.mjs`; regression test added to `tests/chat-events-http.test.mjs`.
2. **Caddy made every browser share one rate bucket.** The gateway used
   `req.socket.remoteAddress`, which is `127.0.0.1` behind Caddy, so 120
   requests/minute were shared by every tab/client. Fixed `clientIp()` to trust
   `X-Forwarded-For` only from a loopback proxy; test added to
   `tests/gateway-hardening.test.mjs`.
3. **Delegated sender → legacy recipient could not be read.** A sender with a
   chat identity produced a v2 envelope, but the recipient could only try its
   chat identity. The opener now falls back to the wallet seed; test added to
   `tests/e2e-chat.test.mjs`.

Production UI acceptance after deploying the hotfix:

| Check | Result |
|---|---|
| `/api/v1/chat/events` from the UI | **200** (previously 401) |
| Repeated UI requests | no 429; same client IP no longer shares the whole site's bucket |
| UI send to a delegated recipient | message bubble **Sent**, POST `/chat/messages` 200 |
| Recipient read/decrypt | exact text, then reply appeared in the UI and the sent bubble changed to **Read** |
| Browser console | empty |

No funds moved. The temporary wallets, keys, devices, messages, quota rows and
local `/tmp` seed files were removed after the test. The browser UI was exercised
in an incognito profile; Google sign-in and an operator wallet seed remain
untested.

### 1.1u Production real-account acceptance — 2026-11-17

Email/Password was **disabled** in Firebase project `nsat-wallet-login`
(`PASSWORD_LOGIN_DISABLED`). The project owner enabled it in the Firebase
console; the probe then returned `INVALID_LOGIN_CREDENTIALS` for a nonexistent
user instead of the disabled-provider error. No Google account was used.

Two real email/password accounts were created through the production gate:

| Account | Result |
|---|---|
| `appmigs+nsat-chat-a-20261117@gmail.com` | created; verification email requested; **not clicked** |
| `appmigs+nsat-chat-b-20261117@gmail.com` | created; verification email requested; **not clicked** |

Each account signed in with its own password in an isolated Chrome profile,
created a disposable wallet, and opened Chats. No NSAT was received, sent, or
staked; both wallets showed 0 NSAT and no on-chain account. The public test
addresses were `GBQPKHQH…DS536` (A) and `GCG3ZLYI…CU7T` (B).

| Check | Result |
|---|---|
| Email/password sign-in on production | PASS for both accounts |
| A → B message | delivered, B decrypted the exact text |
| B → A reply | delivered, A decrypted the exact text |
| Read state | each side showed **Read** for the other side's message |
| Relay storage | messages were acked and removed; read cursors advanced to ids 10 and 11 |
| Accounts after cleanup | both REST sign-ins still succeed |

The shared browser panel hung during the second phase, so the two UI sessions
were driven in **separate headless Chrome profiles** with CDP, not through the
shared preview panel. The accounts are intentionally retained; the disposable
wallet keys and profiles were deleted, and test keys/messages/devices/contacts/
read rows were removed from the production relay. The accounts are unverified
until the owner opens the verification links sent to the plus-addresses.

### 1.2 What suite 2 covers

`npm run test:chat-payments` =
`chat-payment-request`, `chat-payment-inbox`, `chat-payment-inbox-store`,
`chat-coin-approval`, `chat-transaction`, `chat-client`, `chat-identity`,
`chat-identity-backup`, `chat-archive-migration`.

Proves: exact-integer payment-request encoding, strict transaction-card parsing
and closed-ledger verification, encrypted payment inbox store, coin approval
boundary, signed chat client behaviour, chat identity creation/delegation and
multi-tab locking, encrypted identity backup (wrong key/tamper rejected), and the
copy-first archive migration.

### 1.3 What suite 3 covers

`chat-relay`, `chat-relay-gates`, `chat-relay-archive`, `e2e-chat` — 34 tests.

Proves: signature verification (v1/v2/v3), freshness and nonce replay rejection,
sender/signature mismatch, quota and mailbox limits, block semantics (including
clearing queued mail), per-device delivery and isolation, ack scoping and
deletion, retention GC, device trimming, key-bundle shape checks, and a real
HTTP round-trip where A→B decrypts only for B and the relay cannot read or
redirect the envelope.

### 1.4 What suites 4–5 cover

- `chat-tab-sync` (6): one polling leader across tabs, unread/read/cursor
  storage, cross-tab notification.
- `chat-locked-acceptance` (3): end-to-end acceptance for chat while the wallet
  is locked — identity reuse, send/receive, archive path, and that Send NSAT
  remains a separate approval.

---

## 2. Build result

```text
✓ Generating static pages (14/14)
Route (app)                              Size     First Load JS
○ /                                    1.06 kB         192 kB
○ /_not-found                            873 B         88.4 kB
○ /dashboard                           8.74 kB         105 kB
○ /docs                                  183 B        94.5 kB
○ /download                            1.02 kB        95.3 kB
○ /explorer                            3.06 kB        99.3 kB
○ /privacy                               183 B        94.5 kB
○ /security                              183 B        94.5 kB
○ /status                              1.45 kB        97.7 kB
○ /terms                                 183 B        94.5 kB
○ /wallet                                196 B         184 kB
```

Exit 0. **Caveat:** this environment has no `NEXT_PUBLIC_FIREBASE_*` values, so
the generated artifact is **not production-equivalent**:

- the homepage renders “Google sign-in is not configured in this build.” instead
  of the signed-out account gate;
- the wallet shows “Offline: no gateway configured for this build.”

Those strings are visible in the generated HTML and are the direct cause of the
static-export failure in §4. They do not indicate a chat or wallet regression.

---

## 3. Module D — required acceptance scenarios

Status here is about **evidence**, not implementation. “PARTIAL” means the
behaviour is unit-tested but not exercised end-to-end in this environment.

| # | Scenario | Status | Evidence / reason |
|---|---|---|---|
| D1 | New user registers, verifies email, logs in | **PARTIAL** | `tests/email-auth.test.mjs` 25/25 covers the service ordering and validation. Two live accounts were created and signed in on 2026-11-17 after the provider was enabled; verification emails were requested but **not clicked**, so the verified state remains untested. |
| D2 | Existing user signs in with Google | **PARTIAL** | `tests/firebase-auth.test.mjs` (42/42) covers SDK flow and persistence; no browser sign-in run (no Firebase env). |
| D3 | User logs in again on a remembered device | **PARTIAL** | Persistence-choice and session-restore tests pass; no browser restart test. |
| D4 | User revokes another device's session | **BLOCKED** | No session authority/Admin SDK (A2.7). |
| D5 | User resets a forgotten password | **PARTIAL** | Forgot request, neutral response, and reset completion are unit-tested; no email was delivered and no provider-hosted reset page was exercised. |
| D6 | User updates their profile | **PARTIAL** | Handle + primary wallet only; `tests/profile.test.mjs` passes. No display name/avatar/bio. |
| D7 | User searches for and adds a friend | **COMPLETE (unit)** | `tests/contacts.test.mjs` + handle resolution and rules assertions (42/42). No live Firestore. |
| D8 | User blocks another user | **COMPLETE** | Contacts tests + relay block tests (blocks drop queued and future mail). |
| D9 | Two users exchange messages | **COMPLETE** | `tests/e2e-chat.test.mjs` real HTTP relay round-trip; A decrypts, relay cannot. Production smoke 2026-11-17: two throwaway wallets exchanged, decrypted, read-receipted and acked a message over `gateway.satoshicore.org` (13/13, wallet-signed + delegated v3). |
| D10 | Messages appear on two logged-in devices | **PARTIAL** | Relay per-device delivery/ack isolation tested; a second browser needs the chat identity restored — no two-browser run. |
| D11 | User sends an image and a document | **BLOCKED** | No attachments/storage (B4). |
| D12 | User creates a group and invites members | **NOT STARTED** | No group model (B1.2/B6). |
| D13 | Moderator removes an unauthorized participant | **NOT STARTED** | No roles or moderation (A8/B6). |
| D14 | User sends a message while temporarily offline | **NOT STARTED** | No outgoing queue; send fails (B7.3). |
| D15 | App reconnects without duplicating messages | **PARTIAL** | Poll-race, cursor and ack dedupe tests pass; no real offline→online transition test. |
| D16 | Unauthorized users cannot read private conversations | **COMPLETE** | Relay tests: other wallet/device receives nothing; ciphertext only; sender must equal signer. |
| D17 | Restarting services keeps acknowledged persistent messages | **PARTIAL** | SQLite WAL persistence and ack semantics tested in-process; **no process-kill/restart drill was run**. |
| D18 | Account deletion follows retention/deletion policy | **BLOCKED** | No deletion flow; cascades would orphan data without Admin SDK (A9.3). |

Score: **4 COMPLETE, 8 PARTIAL, 3 BLOCKED, 3 NOT STARTED** out of 18.

### 3.1 E2EE extras

| Check | Status | Evidence / gap |
|---|---|---|
| Device verification | **NOT IMPLEMENTED** | No fingerprints/safety numbers. |
| Encrypted messages across multiple devices | **PARTIAL** | Envelope/identity-backup tests pass; no two-browser E2E. |
| Behaviour when a key is missing | **PARTIAL** | Decrypt fails; wrong-key backup rejected (`chat-identity-backup`). No UI-level case. |
| Secure key recovery | **PARTIAL** | Encrypted Drive envelope tests pass; no live Drive round-trip. |
| Behaviour after device revocation | **NOT STARTED** | No revocation mechanism. |

### 3.2 Federation extras

Not applicable: the application is not federated. Cross-homeserver messaging,
remote membership, delayed sync, outage recovery, and federation authorization
were **not tested because they do not exist** (Module C, C1–C6).

---

## 4. Static-export gate (resolved with the production config)

On the first audit run, `node tests/static-export.test.mjs` returned **12 tests,
11 pass, 1 fail, exit 1** because the export had been built without
`NEXT_PUBLIC_FIREBASE_*`:

```text
AssertionError [ERR_ASSERTION]: signed-out homepage does not offer the wallet gate
expected: /nw-gate/
```

That was a build-configuration gap, not a code regression. The production build
was then repeated with the public Firebase config, `NEXT_PUBLIC_CHAT_RELAY=1`
and `NEXT_PUBLIC_API_SAME_ORIGIN=1`; the same gate returned **12/12, exit 0**
(row 23). The deployed site also serves `nw-gate` (see the deployed-site check
in §1.1s and `DEPLOYMENT_GUIDE.md` §12).

What passed in the same file on both runs: PWA manifest, service worker safety
and precache, legal pages, and — relevant to the security review — “Google
sign-in disclosures, setup UI, and targeted CSP ship in the static export”.

The **full `npm test` chain was not run as one command**; the focused suites in
§1 were run individually. Do not describe the aggregate as “full suite green”
without that run.

---

## 5. Not run, and therefore not claimed

| Check | Why |
|---|---|
| Full `npm test` as one command | The focused suites were run individually instead; no aggregate run is claimed. |
| Other focused suites — `chat-unread`, `chat-archive`, `chat-room-races`, `session-policy`, `drive-backup` | Not re-run in this audit. Their files exist and are part of `npm test`; status is unverified here, not failed. |
| Live email flows — account creation, verification delivery/click, provider-hosted reset, change-password reauthentication, email-change link | Requires Firebase public config, the Email/Password provider, authorized domains, email templates, and an inbox. None are available here. |
| Phase 0 UI forms in a browser | A temporary build with **dummy** public Firebase values rendered the gate container (`nw-gate`, “Open your wallet”) but the gate stays on “Checking sign-in session…” until Firebase auth reports readiness, so the email form itself was not observed. That build was discarded and the artifact rebuilt without the dummy values. No browser test with a real project was run. |
| Firestore emulator / live rules tests | No emulator config and no Firebase credentials in this environment. |
| Browser E2E (Playwright/manual) for sign-in, chat, archive, responsive layout | Not performed; no real-account session or operator seed was available. The 2026-11-17 production smoke used the SDK directly, not the browser UI. |
| Operator-wallet login and a real two-person conversation | Not performed; no seed/password was provided. The production smoke used throwaway keys only. |
| Google Drive backup/restore round-trip | Requires an authorized Google account/session. |
| Message-data restart / SQLite restore drill | A **nonce** replay-across-restart test was added, but acknowledged message rows and a full file restore were not drilled; that needs the gateway host and operator approval. |
| `npm audit`, dependency review, fuzzing, DAST, TLS scan | Not performed. |
| Load/DoS testing of the relay | Not performed; quotas are tested functionally, not under load. |
| Visual inspection of chat UI | Screenshots exist from earlier work, but the UI was not re-inspected in this audit. |

---

## 6. Evidence interpretation

These suites are **unit/integration tests with an in-process HTTP server and
synthetic wallet keys**. They prove the code's contracts: signature checks,
authorization scoping, encryption boundaries, quota/retention behaviour, state
machines and client logic.

They do **not** prove:

- that Firebase rules behave identically on the live project (no emulator run);
- that a browser can complete Google sign-in or a Drive restore;
- that the gateway survives a crash/restart with data intact;
- that the UI is usable or accessible;
- that a browser session or an operator wallet completed the flow.

A production deployment **was** performed (2026-11-16) and the deployed relay was
exercised end-to-end with throwaway keys on 2026-11-17; see §1.1s and
`DEPLOYMENT_GUIDE.md` §12.

For the production state that predates this audit, see
`docs/messenger/RELEASE-READINESS.md` and `docs/mainnet/PROJECT-STATUS.md`.
