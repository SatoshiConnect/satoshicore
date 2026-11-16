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
| `GET /api/v1/chat/messages?since=` | signed | read this wallet's mailbox |
| `POST /api/v1/chat/ack` | signed | drop named messages the client has stored or no longer needs |
| `GET /api/v1/chat/blocks` | signed | this wallet's own block list |
| `POST /api/v1/chat/blocks` | signed | block or unblock one address (`{ blocked, action }`) |

Rules the relay enforces on its own, because a client check is not a control:

- signature over `nsc-chat|1|METHOD|path|address|ts|nonce`, timestamp within
  ±120 s, nonce single-use (replay → 409);
- envelope sender must equal the signer (a wallet cannot post as another);
- envelope ≤ 8 KiB, mailbox ≤ 2,000 pending per recipient, retention 7 days;
- housekeeping (delete past retention, stale quota rows) runs at most once a
  minute on an incoming request, and `gc()` is exposed on the relay so an
  operator or a test can collect without waiting for traffic;
- a send runs retention first, then counts the mailbox, so expired mail can
  never make a mailbox look full to the next sender;
- key publishing keeps only the 3 most recent bundles per address;
- reading returns only rows addressed to the signer and **leaves them there** —
  the sender never keeps a server-side copy, and another device signed in with
  the same wallet can still fetch the message;
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
`services/api-gateway/data/chat.sqlite`.

### What the relay learns, and what it does not

Learns: who talks to whom, when, how many bytes, **how much one wallet sends per
day**, and **which address blocked which** (as an opaque pair — the relay never
sees a reason or a name). Does not learn: the text, the amount, the wallet
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
  key. The relay copy is the only server-side copy: clearing it removes it for
  every device at once, while a device that opted into saved chat history keeps
  its own encrypted-at-rest copy until that history is deleted on the device.

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

## Reading, unread badges and relay copies

Several devices can sign in with the same wallet, so a copy has to survive on
the relay long enough for another device to fetch it — but not forever:

- `client.peek()` fetches the mailbox (`GET /chat/messages`, `since=` plus
  `limit=`, paged up to 10 × 200) and decrypts locally. It never deletes.
- A copy leaves the relay in exactly two ways:
  1. **This device stored it in saved chat history.** The screen archives the
     decrypted message locally, then calls `client.ack({ ids })` for the ids that
     were actually written. Archiving is opt-in and idempotent; if the write
     fails, nothing is acknowledged and the relay copy stays.
  2. **The 7-day retention passes.** The relay deletes expired rows on requests
     (at most once a minute) and again on the send path before it applies the
     mailbox ceiling, so a quiet mailbox still empties itself and expired mail
     never causes a false “full”.
- Reading alone never deletes. Opening a conversation moves only this device's
  read mark; the transcript is not the relay's copy, and other rooms keep their
  badges.
- The list polls every 15 s while a wallet is unlocked, asking only for ids after
  this device's cursor. Counts and the newest preview line live in memory for the
  session; no preview text is ever written to storage.
- Per-device state (`lib/chatUnread.js`) is address → number only:
  - `scw-chat-read-v1` — per peer, the newest relay arrival time this device has
    seen;
  - `scw-chat-cursor-v1` — the highest relay id already fetched;
  - `scw-chat-unread-v1` — badge counts and the last check time, also used by the
    locked list (a locked wallet cannot sign a relay call at all, so it shows
    this snapshot and says how old it is: “checked 4m ago”).
- A message is new when its `receivedAt` is later than this device's read mark
  for that peer. Badges are therefore per device, not a global “seen” flag: the
  phone shows its own unread count even after the laptop read the room.

Consequences worth stating plainly:

- With saved history **on**, the relay copy is short-lived: this device archives
  and acknowledges every message it fetches. Another device that has not fetched
  that message yet will not find it on the relay, and history does not sync
  between devices (the Drive backup is a manual restore). A2 therefore favours
  quick cleanup on devices that have history over a long shared backlog.
- With saved history **off**, a message stays on the relay up to 7 days and is
  then gone, read or not. A device that stays offline longer than that misses it.
- The cap is 2,000 pending messages per recipient. With 7 days of retention, one
  sender at the full 200/day ceiling holds at most 1,400 rows, so the ceiling is
  a backstop for many senders rather than the normal limit. A full mailbox
  answers `429` and the screen says the mailbox is full instead of dropping a
  message.
- Paging is `since`/`limit` (max 200 per page), so the poll walks only what came
  after this device's cursor instead of re-reading the mailbox.

## Enabling it

**Enabled on production 2026-11-16** (`ccd24cd` gateway code, web built from
`75af7cb`). The steps below are what was actually run, kept as the procedure for
re-enabling after a rollback.

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
- `tests/chat-relay.test.mjs` (5) — strkey checksum, signature/staleness/replay
  rejection, key publish ownership, delivery only to the recipient, explicit ack,
  impersonation, oversize envelope.
- `tests/chat-relay-gates.test.mjs` (8) — daily quota and its reset, blocks,
  mailbox cap, 7-day retention with request-driven `gc()`, retention applied
  before the cap on send, `since`/`limit` paging, and `deleted` reporting only
  rows that existed.
- `tests/chat-client.test.mjs` (7) — over a real HTTP server: canonical string
  agreement with the relay, two wallets exchanging a message, peek not deleting,
  a second device reading what the first already read, clearing for both, no-key
  recipient reported.
- `tests/chat-unread.test.mjs` (11) — no-text snapshots, merge for a locked list,
  per-device read marks that only move forward, the fetch cursor, and unread
  counting by arrival time.
