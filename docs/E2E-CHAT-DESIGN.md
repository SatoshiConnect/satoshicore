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
| `POST /api/v1/chat/ack` | signed | delete messages that were actually read |

Rules the relay enforces on its own, because a client check is not a control:

- signature over `nsc-chat|1|METHOD|path|address|ts|nonce`, timestamp within
  ±120 s, nonce single-use (replay → 409);
- envelope sender must equal the signer (a wallet cannot post as another);
- envelope ≤ 8 KiB, mailbox ≤ 500 pending per recipient, retention 30 days;
- key publishing keeps only the 3 most recent bundles per address;
- reading returns only rows addressed to the signer — the sender never keeps a
  server-side copy.

Storage is SQLite (`node:sqlite`), path from `NSAT_CHAT_DB`, default
`services/api-gateway/data/chat.sqlite`.

### What the relay learns, and what it does not

Learns: who talks to whom, when, how many bytes. Does not learn: the text, the
amount, the wallet password, the seed. The ciphertext in the database contains
no plaintext — checked with `strings` on a live dev database after a real message
was sent (`0` matches for the message text).

If hiding *who talks to whom* matters, this design is not enough: that needs
padding and cover traffic, which is not built.

## Cryptography honesty

This is a per-message sealed box, not a Double Ratchet. Therefore:

- **No forward secrecy against the seed.** If the seed is compromised, every
  envelope stored on the relay can be decrypted (for up to the 30-day retention).
- **No post-compromise recovery**: there is no ratchet to re-key past a
  compromise.
- **Ephemeral per message**, so two messages to the same person do not share a
  key; deleting a message from the relay does delete it from the only copy.

Building a real ratchet was rejected deliberately: hand-rolled ratchet state
(header keys, skipped-message keys, out-of-order handling) is where real
messengers get broken, and an audited library for it is not in this stack yet.
The trade-off is documented rather than hidden, and it is the main item to
revisit before calling this "secure as Signal".

## Client

`lib/chatClient.js` signs every request, publishes the wallet's bundle, fetches
and verifies the recipient's, seals on send, opens and acknowledges on read:

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
  name, email or message text is ever written there — the transcript still lives
  in the session only, and reading a message deletes it from the relay, because
  a plaintext chat left on a shared device is worse than a lost one.
- A friend who is also a past counterparty appears once, with the “friend”
  badge; “Remove” only forgets the name, never anything on the relay.

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
   origin. A smoke test writes one key row and one message and deletes both.
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

`npm test` includes all four files:

- `tests/e2e-chat.test.mjs` (6) — libsodium vector, ECDH cross-check, round
  trip, retarget/tamper/forge rejection, bundle binding, length limits.
- `tests/chat-relay.test.mjs` (5) — strkey checksum, signature/staleness/replay
  rejection, key publish ownership, delivery only to the recipient, ack,
  impersonation, oversize envelope.
- `tests/chat-client.test.mjs` (5) — over a real HTTP server: canonical string
  agreement with the relay, two wallets exchanging a message, empty mailbox after
  ack, no-key recipient reported, already-read messages not re-delivered.
