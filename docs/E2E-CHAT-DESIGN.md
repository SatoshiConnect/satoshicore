# Encrypted chat (E2E) — design, guarantees, deployment

Status: implemented, tested, **enabled on the production gateway and web root
(2026-11-16)** — see "Enabling it" for the exact steps and the rollback.
Turning it on is one operator action, listed at the end.

## What this is

A conversation channel between two wallets, where the relay that carries the
messages cannot read them. It replaces the idea of "transfer notices carry a
message": notices stay a read-only feed of the chain, and anything a person
wants to say is a message in this channel.

- Ciphertext is produced on the sender's device with the recipient's published
  X25519 key; only the recipient's wallet seed opens it.
- The relay stores an opaque envelope: two addresses, a size, an arrival time.
- No account, cookie or session: every request carries an Ed25519 signature made
  by the wallet key, and the relay checks that signature against the address in
  the request. Holding the wallet key *is* the identity.

## Keys

The messaging key is derived from the wallet seed, not from a second secret the
user has to keep:

```
x25519_secret = clamp(SHA-512(seed32)[0..32])
```

This is exactly what libsodium's `crypto_sign_ed25519_sk_to_curve25519` computes.
`tests/e2e-chat.test.mjs` pins it against a PyNaCl (libsodium) vector:

- seed `00 01 … 1f` → secret `3894ee789ced9aad…b48e6f`, public `4701d0…ca01`
- the same test compares tweetnacl's `scalarMult` with Node's native
  `crypto.diffieHellman` for X25519, so the ECDH is not taken on trust.

Consequence, stated plainly: anyone who has the seed can derive the messaging
key. The chat does not create a new recovery problem, and it does not protect a
wallet whose seed has leaked.

## Envelope

```jsonc
{
  "v": 1,
  "from": "G…", "to": "G…",          // addresses, uppercase strkey
  "epk": "<base64 X25519 ephemeral public key>",
  "nonce": "<base64 24 bytes>",
  "ct": "<base64 sealed box>",       // XSalsa20-Poly1305 via tweetnacl
  "ts": 1794770001923,               // sender's clock
  "sig": "<base64 Ed25519 over the envelope fields>"
}
```

The signature binds the sender's address to the ciphertext: a relay or a third
party cannot re-attribute a message to another wallet, and `openMessage()`
refuses an envelope whose signature does not match `from`. A message sealed for
one address cannot be opened by another (`retarget` test).

Message text is capped at `MAX_TEXT_LENGTH` (2000 characters) before sealing, so
the size limit is a client rule, not a surprise at the relay.

## Relay

`services/api-gateway/chat-relay.mjs`, mounted by `server.js` under
`/api/v1/chat/*` **only when `NSAT_CHAT_RELAY=1`**. With the flag off the routes
do not exist (verified on production: 404, and no database file is created).

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /api/v1/chat/keys?address=G…` | none | the published bundle for an address (public information) |
| `POST /api/v1/chat/keys` | signed | publish/replace this wallet's bundle |
| `POST /api/v1/chat/messages` | signed | hand one envelope to the recipient |
| `GET /api/v1/chat/messages?since=` | signed | read this device's pending mail |
| `POST /api/v1/chat/ack` | signed | drop this device's copies of the named messages |
| `GET /api/v1/chat/blocks` | signed | this wallet's own block list |
| `POST /api/v1/chat/blocks` | signed | block or unblock one address (`{ blocked, action }`) |

Rules the relay enforces on its own, because a client check is not a control:

- signature over `nsc-chat|2|METHOD|path|address|device|ts|nonce` when the
  request carries `x-nsat-device`, or the v1 line without a device for older
  clients; timestamp within ±120 s, nonce single-use (replay → 409);
- **per-device delivery**: each device that identifies itself gets its own
  delivery row, and `ack` removes only that row. A message is deleted when no
  delivery remains (every registered device acked) or at retention. Mail that
  predates the device table is backfilled to the `legacy` device; a device that
  registers later is backfilled with what is still pending;
- envelope sender must equal the signer (a wallet cannot post as another);
- envelope ≤ 8 KiB, mailbox ≤ 5,000 pending per recipient (configurable with
  `NSAT_CHAT_MAX_PENDING`), retention 7 days;
- housekeeping (delete expired envelopes and deliveries, stale quota rows)
  runs at most every 15 s on an incoming request, and `gc()` is exposed on the
  relay so an operator or a test can collect without waiting for traffic;
- a send runs retention first, then counts the mailbox, so expired mail can
  never make a mailbox look full to the next sender;
- key publishing keeps only the 3 most recent bundles per address;
- reading returns only this device's deliveries and **leaves them there** — the
  sender never keeps a server-side copy, and another device signed in with the
  same wallet keeps its own delivery;
- **per-sender quota**: 200 *stored* messages per wallet per UTC day (a
  constructor option, so tests can lower it). A message that is dropped by a
  block costs nothing, so blocking cannot be used to burn a stranger's quota;
- **blocks**: one wallet's block list holds up to 500 addresses, is readable and
  writable only by its owner, and applies in both directions. Adding a block
  also deletes that sender's queued mail for the owner.

A blocked message is **not refused**: the relay answers `200 {ok:true,
stored:false}`, exactly like a delivery, so a sender cannot tell a block from a
successful send. That is a deliberate privacy choice, and it means the honest
claim is "blocked mail is not stored", not "the sender is told to stop".

Storage is SQLite (`node:sqlite`), path from `NSAT_CHAT_DB`, default
`services/api-gateway/data/chat.sqlite`. The chat tables are `chat_keys`,
`chat_messages`, `chat_devices`, `chat_deliveries`, `chat_blocks` and
`chat_quota`. The device/delivery tables are additive; on open, existing mail
with no delivery is assigned to the `legacy` device.

### What the relay learns, and what it does not

Learns: who talks to whom, when, how many bytes, a random per-browser device id
(not a fingerprint), **how much one wallet sends per day**, and **which address
blocked which** (as an opaque pair — the relay never sees a reason or a name). Does not learn: the text, the amount, the wallet
password, the seed. The ciphertext in the database contains
no plaintext — checked with `strings` on a live dev database after a real message
was sent (`0` matches for the message text).

If hiding *who talks to whom* matters, this design is not enough: that needs
padding and cover traffic, which is not built.

## Cryptography honesty

This is a per-message sealed box, not a Double Ratchet. Therefore:

- **No forward secrecy against the seed.** If the seed is compromised, every
  envelope stored on the relay can be decrypted (for up to the 7-day retention).
- **No post-compromise recovery**: there is no ratchet to re-key past a
  compromise.
- **Ephemeral per message**, so two messages to the same person do not share a
  key. The relay copy is the only server-side copy: acknowledging it removes
  this device's delivery only, and the envelope goes when every registered
  device has acknowledged or retention expires. A device that opted into saved
  chat history keeps its own encrypted-at-rest copy until that history is
  deleted on the device.

Building a real ratchet was rejected deliberately: hand-rolled ratchet state
(header keys, skipped-message keys, out-of-order handling) is where real
messengers get broken, and an audited library for it is not in this stack yet.
The trade-off is documented rather than hidden, and it is the main item to
revisit before calling this "secure as Signal".

## Client

`lib/chatClient.js` signs every request, publishes the wallet's bundle, fetches
and verifies the recipient's, seals on send, and opens on read. Reading never
deletes; `ack()` removes exactly the ids this device has stored in saved chat
history (or that the relay drops at its retention boundary):

- a bundle is accepted only if its own signature verifies and its address is the
  one asked for (`verifyPublicKeyBundle`);
- an inbox entry that cannot be opened is **not** acknowledged — it stays on the
  relay and is reported, so a message for another wallet is not lost;
- undecryptable entries surface as a count in the UI, never as silence.

`components/ChatPanel.js` is the screen. Contacts come from two places: the
wallet's own indexed transfers, and a friend list the person adds by hand with
an `@profile` ID or a `G…` address. Without the second, the only way to say
hello was to send someone money first.

- An `@id` is resolved through `profiles`: `profileIds/@id` gives the owner's
  uid and `profiles/{uid}` gives the chosen primary address. Both are reads the
  rules allow one document at a time for a signed-in account (`allow get`, never
  `list`), so a handle can be looked up but the directory cannot be scraped. A
  profile with no primary wallet yet is reported as such instead of guessing an
  address.
- The friend list stores **public wallet addresses only**, per wallet, under
  `scw-chat-friends-<wallet address>` (`lib/chatFriends.js`, capped at 50). No
  name, email or message text is ever written there. The transcript lives in the
  session only, and reading leaves the ciphertext on the relay for the other
  devices until the 7-day retention. Saving chat history is a separate, opt-in
  archive (`docs/CHAT-ARCHIVE.md`) — and, because this device then has a copy,
  it also lets the relay forget the message early.
- A friend who is also a past counterparty appears once, with the “friend”
  badge; “Remove” only forgets the name, never anything on the relay.
- The thread itself is the hand-off point for paying someone: it shows the full
  wallet address (selectable, with a copy button), the `@id` when that is what
  you added, and **Send NSAT to this address**, which fills the wallet's send
  form with it. The address is enough to send — nothing else is needed, and no
  address is ever taken from the relay or from the message contents.
- **Sending coins from the conversation** works like sending a sticker, with
  one deliberate difference: the amount goes through a confirmation step before
  anything is signed. The chat calls the wallet's own pipeline
  (`submitSend({ toOverride, amountOverride })`), so the network-identity check,
  fee estimate, reserve check, seed zeroing and ledger confirmation are exactly
  the ones the Send page uses — no signing logic lives in the chat. A payment is
  a chain operation, not a message: the bubble reports what the ledger said
  (`Sent`, `failed on-chain`, or `submitted (status)`), and a one-line encrypted
  note with the transaction hash is sent to the conversation afterwards (best
  effort; a failed note loses no money).
- **Email is deliberately not part of this.** The site stores no email anywhere
  (the profile keeps an `@id` and a public address; verification is the
  provider's claim), so a friend's email can only come from the friend. The
  screen says so instead of showing a field that would always be empty.

## Payment requests as an inbox

A payment request is still ordinary signed chat text. The marker is only
actionable after decryption and after its claimed address matches the
authenticated sender; it never signs or submits a transaction. **Review
payment** fills the existing Send page, and the wallet's normal local approval
path remains the only thing that can move funds.

What is different is that reading is not the same as finishing:

- When a decrypted request arrives, `lib/chatPaymentInbox.js` writes one local
  record before the relay copy is acknowledged. The record lives in the same
  `scw-chat-archive-v1` database as saved history, in the `requests` store, and
  is AES-256-GCM encrypted with the same seed-derived archive key. Its amount,
  requester, direction and status are inside the ciphertext; only the wallet,
  peer, request key and timestamp are clear, as with archived messages.
- The lifecycle is `pending → paid | declined | expired`. A matching encrypted
  transaction card can settle a pending request (exact payer, payee and integer
  amount); otherwise the person can mark it paid after using the Send page, or
  decline it. A request becomes `expired` at `createdAt + 7 days`; the expiry is
  materialized when the inbox is read, so no background job is required.
- The Chats list shows a **Waiting to pay** queue containing this wallet's
  incoming pending requests. A request stays there after the room is read or its
  relay delivery is acknowledged. The queue removes it on paid/declined and
  after expiry. A request within 48 hours of expiry is shown in the warning
  colour, and the queue header calls out how many are in that window.
- A compact **Recent payment requests** list keeps the last five settled or
  lapsed records visible (paid, declined or expired) so a status does not become
  invisible after the queue row is removed. It is reference-only; the pending
  queue rows are the actionable ones, and neither list marks the request as read.
- Status changes are local bookkeeping, not a second wire protocol. Other
  devices and the other wallet do not receive a “declined” or “paid” receipt;
  they see the request text and their own local status. The ledger remains the
  authority for whether a payment actually happened.
- If the local request write fails, the poll/open path stops before `ack` so
  the relay copy is not consumed. Ordinary messages can still be read; a failed
  inbox write only costs the early relay cleanup and is retried on the next read.
- The request ledger is written even when saved chat history is off: it is a
  small encrypted obligation record, not a transcript. It is not included in
  the Drive transcript backup, and deleting saved history does not delete it.

## Reading, unread badges and relay copies

Several devices can sign in with the same wallet, so a copy is delivered to each
known device instead of one shared mailbox:

- Every signed request carries `x-nsat-device`, a random id stored in this
  browser (`scw-chat-device-v1`). The signature line includes it
  (`nsc-chat|2|METHOD|path|address|device|ts|nonce`); a client without the
  header keeps the v1 line and is treated as one shared `legacy` device.
- The relay registers a device on first contact, copies new envelopes to every
  registered device of the recipient, and backfills a late device with what is
  still pending. At most 10 devices are kept per wallet; the least recently seen
  one is dropped first, and a device unseen for the full retention window is
  pruned (a returning device registers again and is backfilled).
- `client.peek()` fetches only this device's deliveries (`GET /chat/messages`,
  `since=` plus `limit=`, paged up to 10 × 200) and decrypts locally. It never
  deletes. The list passes its own `since` cursor; opening a room also passes
  `peer=` so the relay returns only that conversation's pending mail.
- A device's copy leaves the relay in exactly three ways:
  1. **This device stored it in saved chat history.** The screen archives the
     decrypted message locally, then calls `client.ack({ ids })` for the ids that
     were actually written. Archiving is opt-in and idempotent; if the write
     fails, nothing is acknowledged and this device's delivery stays.
  2. **The message was read in the open room.** A line merged into the room on
     screen is read here, so it is acknowledged (after the archive step above
     when history is on). Only this device's delivery is removed; another
     device's copy remains until that device reads or retention expires.
  3. **The 7-day retention passes.** The relay deletes expired envelopes and
     their deliveries on requests (at most every 15 s, `NSAT_CHAT_GC_MS`) and
     again on the send path before it applies the mailbox ceiling, so a quiet
     mailbox still empties itself and expired mail never causes a false “full”.
- The envelope row is deleted when its last delivery is acknowledged. The ack
  response reports `acked` deliveries and `deleted` envelopes; `deleted: 0` is
  normal while another device still has a copy.
- Async work follows two generations (`lib/chatRoomGuards.js`): opening or
  leaving a room invalidates an in-flight poll, and starting another room read
  invalidates the previous one; a later poll does not cancel a room already on
  screen. Acknowledgements run through one serialized queue, and the guard is
  checked again immediately before the ack side effect, so a read that became
  stale while waiting cannot delete a newer room's copy.
- A message that arrived while another room was open keeps its badge; opening
  its room clears that badge and this device's delivery.
- The bottom **Chats** tab shows the same total: it subscribes to snapshot writes
  from `lib/chatUnread.js` (an in-memory listener, no new storage) and reads the
  open wallet's counts, or the merged per-wallet snapshot while locked — the
  same rule the list uses, so the two cannot disagree. No message text is
  involved, and the listener is dropped when the screen unmounts.
- The list polls every 15 s while a wallet is unlocked, asking only for ids after
  this device's cursor (a `since=` read, never a full mailbox walk). Counts and
  the newest preview line live in memory for the session; no preview text is
  ever written to storage.
- Per-device state (`lib/chatUnread.js`) is address → number only:
  - `scw-chat-read-v1:<deviceId>` — per peer, the newest relay arrival time this
    device has seen;
  - `scw-chat-cursor-v1:<deviceId>` — the highest relay id already fetched by
    this device;
  - `scw-chat-unread-v1` — badge counts and the last check time, also used by the
    locked list (a locked wallet cannot sign a relay call at all, so it shows
    this snapshot and says how old it is: “checked 4m ago”).
  - The unprefixed read/cursor keys are read as a one-time fallback for state
    written before device ids existed; new writes use the scoped key.
- A message is new when its `receivedAt` is later than this device's read mark
  for that peer. Badges are therefore per device, not a global “seen” flag: the
  phone shows its own unread count even after the laptop read the room.

Consequences worth stating plainly:

- Reading or archiving on one device removes only that device's delivery. The
  other device still finds the message until it acks it; then the envelope is
  removed. History does not sync between devices (the Drive backup is a manual
  restore).
- A device that has never contacted the relay is not known yet. If every known
  device acks a message before that device registers, the envelope is removed;
  retention is the outer bound. Once a device opens the app it is registered and
  late mail is delivered to it.
- With saved history **on**, a device acknowledges as soon as its local copy is
  stored; with it **off**, it acknowledges when the room is opened. Either way
  the other devices keep their own pending copy until they read or 7 days pass.
- The cap is 5,000 pending messages per recipient — about 40 MB at the 8 KiB
  envelope ceiling — and can be raised per operator with
  `NSAT_CHAT_MAX_PENDING`. With 7 days of retention, one sender at the full
  200/day ceiling holds at most 1,400 rows, so an unopened room cannot fill the
  shared mailbox on its own. A full mailbox answers `429` and the screen says the
  mailbox is full instead of dropping a message; expired rows are collected
  before the ceiling is applied, so the count comes back down without a manual
  step.
- Paging is `since`/`limit` (max 200 per page). The list poll reads only what
  came after its cursor, and opening a room narrows the read with `peer=` — no
  screen pages the whole mailbox on a timer.

## Enabling it

**Enabled on production 2026-11-16** (`ccd24cd` gateway code, web built from
`75af7cb`). The steps below are what was actually run, kept as the procedure for
re-enabling after a rollback.

Order matters for per-device delivery: install the relay first. A build that
sends `x-nsat-device` signs the v2 line, which an older relay rejects; the new
relay still accepts v1 clients that omit the header.

1. Gateway. The flag lives in the launchd job, not the wrapper, so it survives a
   wrapper edit and is visible in one place:

   ```
   /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:NSAT_CHAT_RELAY string 1" \
     ~/Library/LaunchAgents/org.satoshicore.gateway.plist
   /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:NSAT_CHAT_DB string \
     /Users/migssa-ngakhaonu/nsat-ops/gateway/data/chat.sqlite" \
     ~/Library/LaunchAgents/org.satoshicore.gateway.plist
   launchctl bootout gui/$(id -u)/org.satoshicore.gateway
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/org.satoshicore.gateway.plist
   ```

   `server.js` and `chat-relay.mjs` are copied from the reviewed commit
   (`install -m 0644`, or `git show HEAD:services/api-gateway/…`), never edited in
   place. The relay loads `chat-relay.mjs` from its own directory and creates the
   SQLite file on first use.
2. Web: build with `NEXT_PUBLIC_CHAT_RELAY=1` **and** `NEXT_PUBLIC_API_SAME_ORIGIN=1`
   and deploy the static root as usual. Without the flag the Messages entry is
   absent (`chatEnabled:!1` in the bundle). Caddy already proxies `/api/*` on
   satoshicore.org to the gateway, so the browser talks to its own origin and no
   CORS preflight is involved; `gateway.satoshicore.org` also works because the
   server now allows the `X-NSAT-*` headers.
3. Check, in order: gateway `200` on `/api/v1/network/status`, `/v1/health`, and
   `/api/v1/chain/info`; `400 address required` on `/api/v1/chat/keys`; `401
   signature required` on an unsigned `POST /api/v1/chat/messages`; then the
   ephemeral round trip (`publish → send → inbox → ack`) against the public
   origin. A smoke test writes one key row and one message, reads both back,
   then clears the message explicitly.
4. Rollback, in this order (so the UI never shows a button that cannot work):

   ```
   # web first: rebuild/deploy the previous webroot without the flag
   ln -sfn satoshicore-webroot-profile-ccd24cd ~/nsat-ops/satoshicore-webroot
   # then the gateway: remove the two keys and restart
   /usr/libexec/PlistBuddy -c "Delete :EnvironmentVariables:NSAT_CHAT_RELAY" \
     ~/Library/LaunchAgents/org.satoshicore.gateway.plist
   /usr/libexec/PlistBuddy -c "Delete :EnvironmentVariables:NSAT_CHAT_DB" \
     ~/Library/LaunchAgents/org.satoshicore.gateway.plist
   launchctl bootout gui/$(id -u)/org.satoshicore.gateway
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/org.satoshicore.gateway.plist
   ```

   Routes disappear (404) and `~/nsat-ops/gateway/data/chat.sqlite` is left in
   place: undelivered ciphertext survives, so a re-enable does not lose pending
   messages. To also drop the data, move the file aside; nothing else references
   it.

The gateway stores no key material, so enabling or disabling the relay never puts
a seed or a wallet file on the server.

## Tests

`npm test` includes the chat files:

- `tests/e2e-chat.test.mjs` (6) — libsodium vector, ECDH cross-check, round
  trip, retarget/tamper/forge rejection, bundle binding, length limits.
- `tests/chat-relay.test.mjs` (9) — strkey checksum, v1/v2
  signature/staleness/replay rejection, key publish ownership, delivery only to
  the recipient, per-device ack leaving another device's copy, recipient-scoped
  ack for a browser holding two wallets, a late device's backfill, impersonation,
  oversize envelope.
- `tests/chat-relay-gates.test.mjs` (9) — daily quota and its reset, blocks,
  mailbox cap, 7-day retention with request-driven `gc()`, retention applied
  before the cap on send, `since`/`limit` paging, `peer=` narrowing a read to one
  conversation, and `deleted` reporting only rows that existed.
- `tests/chat-client.test.mjs` (9) — over a real HTTP server: canonical v1/v2
  string agreement with the relay, two wallets exchanging a message, peek not
  deleting, ack on one device leaving the other device's copy, a message read in
  the open room leaving no badge or queued copy, a room read fetching only its
  own conversation, no-key recipient reported.
- `tests/chat-payment-request.test.mjs` (6) — exact integer amounts, address
  normalization, sender binding, inert malformed markers and creation limits.
- `tests/chat-payment-inbox.test.mjs` (6) — incoming/outgoing request records,
  relay/thread id normalization, seven-day expiry with the 48-hour warning, and
  exact payer/payee/amount matching for transaction cards.
- `tests/chat-room-races.test.mjs` (6) — deterministic fake relay + fake poll
  timer coverage for switching rooms during a poll, opening a room during a
  poll, opening another room during an in-flight read, overlapping and stale
  acks, newer-poll invalidation, and the ChatPanel guard wiring.
- `tests/chat-unread.test.mjs` (18) — no-text snapshots, merge for a locked list,
  per-device read marks and cursor with a legacy-key fallback, stable device id,
  unread counting by arrival time, the open-room rule (no badge for the room on
  screen, even after going back to the list or rebuilding from the mailbox), and
  the subscribe/notify signal behind the bottom-nav badge.
- `tests/chat-relay-archive.test.mjs` (10) — the poll's archive-before-ack rule:
  store every peer group first, never acknowledge a write that failed or is
  still pending, and skip rows that cannot be archived.
