# API_DOCUMENTATION

Everything the frontend actually calls, as built on 2026-11-16. There are two
API surfaces:

1. **Firebase SDK calls** (Auth + Firestore) — not REST endpoints owned by this
   project; authorization is in `firestore.rules`.
2. **NSAT gateway HTTP API** — chat relay plus chain/account routes.

Anything not listed here does not exist. In particular: no registration, login,
password reset, session, group, attachment, presence, typing, admin, or
moderation endpoints are implemented.

---

## 1. Conventions

### 1.1 Origins

| Use | Origin |
|---|---|
| Chat (browser) | Same-origin `/api/v1/chat` (the web host proxies `/api` to the gateway) |
| Chain/account reads | Same-origin `/api/v1/*`, `/v1/*` |
| Direct gateway | `https://gateway.satoshicore.org` (operator/release checks) |
| Local development | `http://localhost:8787` (gateway), `http://localhost:3000` (Next) |

### 1.2 Authentication model

There are **no accounts, cookies, or bearer tokens** on the chat API. Each
request is signed:

- Identity is the wallet address (`G…`, Stellar strkey, CRC16-validated).
- The signature is Ed25519, Base64, 64 bytes, over a canonical request line.
- The timestamp is epoch ms and must be within **±120 s**.
- The nonce is 8–64 characters and must never repeat (`409` on replay). It is
  stored in SQLite for twice the freshness window, so the replay guard survives
  a gateway restart.

Signing keys:

| Version | Signed by | Request line |
|---|---|---|
| v1 | wallet key | `nsc-chat\|1\|METHOD\|path\|address\|ts\|nonce` |
| v2 | wallet key | `nsc-chat\|2\|METHOD\|path\|address\|device\|ts\|nonce` |
| v3 | delegated chat key | `nsc-chat\|3\|METHOD\|path\|address\|chatPub\|device\|ts\|nonce` |

v1/v2 are accepted for compatibility; v3 is what the current client uses, so
chat keeps working while the wallet is locked.

### 1.3 Request headers

| Header | Required | Meaning |
|---|---|---|
| `x-nsat-address` | yes | Signer's wallet address, uppercase |
| `x-nsat-ts` | yes | Epoch ms |
| `x-nsat-nonce` | yes | Random, unique |
| `x-nsat-signature` | yes | Base64 Ed25519 signature |
| `x-nsat-device` | no | 16–64 chars `[A-Za-z0-9_-]`; omitted = shared `legacy` device |
| `x-nsat-chat-pub` | v3 only | Base64 chat Ed25519 public key (32 bytes) |
| `x-nsat-chat-delegation` | v3 only | Base64 wallet signature over the delegation string (64 bytes) |

CORS allows exactly these headers:
`Content-Type, X-NSAT-Address, X-NSAT-Device, X-NSAT-Chat-Pub,
X-NSAT-Chat-Delegation, X-NSAT-Ts, X-NSAT-Nonce, X-NSAT-Signature`.

### 1.4 Common errors

| Status | Body | Cause |
|---|---|---|
| 400 | `{"error":"..."}` | Missing/invalid field, address, bundle, peer, ack ids |
| 401 | `{"error":"signature required"}` | Missing, stale, malformed, or invalid signature |
| 403 | `{"error":"envelope sender does not match the signer"}` | Spoofed sender |
| 404 | `{"error":"not found"}` | Unknown chat path |
| 404 | `{"error":"no key published"}` | No key bundle for address |
| 409 | `{"error":"replayed request"}` | Nonce reused |
| 413 | `{"error":"envelope too large"}` / `{"error":"body too large"}` | > 8 KiB envelope / > 16 KiB body |
| 429 | `{"error":"daily message limit reached"}` | > 200 stored/day/sender |
| 429 | `{"error":"recipient mailbox is full"}` | ≥ 5,000 pending for recipient |
| 429 | `{"error":"block list is full"}` | ≥ 500 blocks |
| 429 | `{"error":"rate limit exceeded","retryAfter":N}` | Per-IP transport limit. Chat is counted in three separate classes — read (`GET` mailbox/tombstones/read/presence/blocks/keys, default 300/min), write (sends, acks, typing, presence beats, block edits, default 120/min) and connect (`/chat/events`, default 30/min) — so an open conversation does not spend the wallet API allowance (default 120/min, non-chat routes). The response carries `Retry-After: N` seconds; clients must wait at least that long. |
| 500 | `{"error":"chat relay unavailable"}` | SQLite/module failure |

---

## 2. Chat relay API

Mounted only when `NSAT_CHAT_RELAY=1`. Database path from `NSAT_CHAT_DB`
(default `./data/chat.sqlite` next to the gateway module). Tunables:
`NSAT_CHAT_MAX_PENDING`, `NSAT_CHAT_GC_MS`.

### 2.1 `GET /api/v1/chat/keys`

Public. No signature required (a published key is public information).

**Query**: `address=G…`

**200**
```json
{
  "bundle": {
    "v": 2,
    "address": "G…",
    "x25519Pub": "base64",
    "ed25519Pub": "base64",
    "chatPub": "base64",
    "delegation": "base64",
    "createdAt": 1760000000000,
    "signature": "base64"
  }
}
```

Returns the newest bundle for the address. **404** if none.

Client: `lib/chatClient.js` `fetchPublicKey()`; bundle signature is verified by
`lib/e2eChat.js` `verifyPublicKeyBundle()` before use.

### 2.2 `POST /api/v1/chat/keys`

Publish a key bundle. Signature required.

**Body**
```json
{ "bundle": { "v": 2, "address": "G…", "x25519Pub": "base64", "…": "…" } }
```

Validation: bundle address must equal the signer; for `v === 2`, `chatPub` and
`delegation` must match the request headers; `x25519Pub` must be 40–60 Base64
chars. Upsert on `(address, x25519Pub)`; only the newest 3 bundles per address
are kept.

**200** `{"ok":true}`

Client: `publishChatKey()`.

### 2.3 `POST /api/v1/chat/messages`

Send one encrypted envelope. Signature required.

**Body**
```json
{
  "envelope": {
    "v": 1,
    "from": "G…",
    "to": "G…",
    "id": "client message id",
    "ts": 1760000000000,
    "nonce": "base64",
    "box": "base64 ciphertext",
    "sig": "base64 Ed25519 signature over the envelope"
  },
  "clientId": "opaque idempotency key (8–80 chars, optional)"
}
```

- `clientId` is reused by a retry; a unique `(sender, client_id)` index makes
  the second POST return the original id instead of storing another row.
- `from` must equal the signer (`403` otherwise).
- `to` must be a valid strkey.
- Serialized envelope ≤ 8 KiB.
- If either side blocked the other, the call returns **200** `{"ok":true,
  "stored":false}` and stores nothing. The sender cannot distinguish this from
  success — deliberate, so the relay does not reveal a block.
- Quota: 200 stored messages per sender per UTC day.

**200** `{"ok":true,"id":123}`; a retry also returns `{"duplicate":true}`.
Blocked mail returns `{"ok":true,"stored":false}`.

Client: `prepare()` encrypts and signs via `lib/e2eChat.js`; `sendPrepared()`
posts the ciphertext with a `clientId`. `lib/chatOutbox.js` stores only that
ciphertext for a retry; it never stores the plaintext.

### 2.4 `GET /api/v1/chat/messages`

Read this device's pending copies. Signature required.

**Query**
| Param | Meaning |
|---|---|
| `since` | Return messages with relay id `> since` (default 0) |
| `limit` | 1–200, default 100 |
| `peer` | Optional `G…`; narrows to one sender (used when opening a room) |

**200**
```json
{
  "messages": [
    { "id": 42, "receivedAt": 1760000000000, "envelope": { "…": "…" } }
  ]
}
```

Rows are scoped to `recipient = signer` **and** `device_id = this device`, so a
second device cannot consume another device's copy. Ordered by `id` ascending.

Client: `readMessages()`; `lib/chatUnread.js` keeps the `since` cursor.

### 2.5 `POST /api/v1/chat/ack`

Acknowledge stored copies for this device only. Signature required.

**Body** `{ "ids": [42, 43] }` (1–200 unique positive integers)

**200**
```json
{ "ok": true, "acked": 2, "deleted": 1 }
```

- Removes only delivery rows for `(this device, this recipient)`.
- Deletes the message row only when no device still holds a delivery.
- Returns `acked: 0` for ids owned by another device or wallet (no error, no
  information leak).

Client: `ackMessages()`, called after the encrypted archive stored the message.

### 2.5a `POST /api/v1/chat/messages/delete`

Delete-for-everyone. Signature required; only the original sender may call it.
Body `{ "id": 42 }`. The ciphertext and delivery rows are removed and an
id-only tombstone is written. `403` for another wallet, `404` for an unknown
id. The recipient — and the sender's other devices — remove the line on the
next SSE frame or tombstone fetch.

### 2.5b `GET /api/v1/chat/tombstones`

`?since=<ms>&peer=G…` returns `{ "deletions": [{ "id", "at", "peer" }] }`
for messages the caller sent or received. No message text or ciphertext is
retained. Client: `deleteMessage()`, `tombstones()`.

### 2.5c Opt-in presence

`POST /api/v1/chat/presence` body `{ "online": true | false }` writes an
in-memory heartbeat (45 s TTL); it is never a profile field. `GET
/api/v1/chat/presence?peer=G…` returns `{ online, lastSeen, known }` only when
the caller and peer have a shared message/contact row. The client enables it
with `readPresencePref`/`writePresencePref`, default off. There is no last-seen
history beyond the current heartbeat.

### 2.5d Edit and reaction controls

Edit and reaction are not plaintext relay operations. The client encrypts a
control envelope with the same E2EE path and sends it as a normal message:

```text
\u0001nsat-control-v1:{"kind":"edit","id":42,"text":"new"}
\u0001nsat-control-v1:{"kind":"reaction","id":42,"emoji":"👍"}
```

The recipient decrypts, applies the control, hides the control row and
acknowledges it. The relay sees only another ciphertext envelope. There is no
server-side edit history or per-reactor reaction table; controls follow normal
message retention. Client: `lib/chatControl.js`.

### 2.6 `POST /api/v1/chat/read` and `GET /api/v1/chat/read`

Read receipts. Signature required.

`POST` body `{ "peer": "G…", "id": 42 }` records the highest message id this
wallet has displayed from `peer`; the id must be a stored message from `peer`
to the caller (`404` otherwise), so a reader cannot inflate a sender's status.
`GET ?peer=G…` returns how far that peer has read messages this wallet sent:

```json
{ "peer": "G…", "lastId": 42, "at": 1760000000000 }
```

`lastId` never moves backwards; only the sender can read the receipt for their
own mail. Client: `markRead()`, `readReceipt()`.

### 2.7 `GET /api/v1/chat/events`

Authenticated Server-Sent Events stream. Same signature headers as other calls
(including `X-NSAT-Device`). The handshake consumes a nonce and cannot be
replayed. Frames are wake-up signals only:

```text
event: ready
data: {}

event: message
data: {"id":43}
```

The frame contains no address or ciphertext; the client still calls
`GET /api/v1/chat/messages` and decrypts locally. A keep-alive comment is sent
every 25 s. Client: `subscribe()`; `ChatPanel` reconnects after 3 s and keeps
15 s polling as a fallback.

### 2.8 `GET /api/v1/chat/blocks`

Owner-only block list. Signature required.

**200** `{"blocked":["G…","G…"]}` (max 500)

### 2.9 `POST /api/v1/chat/blocks`

Add or remove a block. Signature required.

**Body** `{ "blocked": "G…", "action": "add" | "remove" }`

- `add`: upserts the block and deletes all already-queued mail from that sender
  to the signer. Returns `{"ok":true,"blocked":true,"cleared":N}`.
- `remove`: deletes the block. Returns `{"ok":true,"blocked":false}`.
- Cannot block yourself (`400`).

Client: `listBlocks()`, `blockAddress()`, `unblockAddress()`.

### 2.10 `POST /api/v1/chat/push`

Register this device for background alerts. Signature required.

**Body** `{ "subscription": { "endpoint": "https://…", "keys": { "p256dh": "…", "auth": "…" } } }`

- Upserts by `(address, endpoint)`; a re-installed browser replaces its old entry.
- At most **5** subscriptions per wallet; the oldest device is evicted rather
  than refusing the new one.
- **503** `{"error":"push is not configured"}` when the gateway has no VAPID
  keypair — the client hides the opt-in in that case.
- **400** for a non-https endpoint or malformed keys.
- Nothing about a message is stored or returned. The relay only learns how to
  wake this device.

### 2.11 `POST /api/v1/chat/push/remove`

Drop one device subscription. Signature required.

**Body** `{ "endpoint": "https://…" }` → **200** `{"ok":true,"removed":N}`.

The browser is unsubscribed first; this call cleans up the relay side. Both
steps also drop the queue row, so a wallet that opts out is never woken again.

### Not implemented

Groups, attachments/media, server-side search, report. No such handler exists;
an unknown chat path returns `404`.

---

## 3. Gateway non-chat API (unchanged by this work)

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Gateway liveness, version, whether core is configured |
| GET | `/api/v1/chain/info` | Read-only chain info via core `/info` |
| GET | `/api/v1/network/status` | Chain network/ledger from core, fail-closed |
| GET | `/api/v1/account` | Account/balance view |
| GET | `/api/v1/explorer/snapshot` | Explorer aggregate |
| GET | `/api/v1/sponsorship/policy` | Sponsorship policy |
| POST | `/api/v1/tx` | Submit an already-signed transaction envelope |
| GET | `/v1/health`, `/v1/mint`, `/v1/tx/{hash}`, `/v1/accounts/{G…}/{events,transactions}`, `/v1/confirmations/{hash}` | Indexer passthrough (allowlisted, GET only) |

These routes are not part of the membership/messaging scope and were not
modified.

---

## 4. Firebase operations used by the frontend

These are SDK calls, not project-owned REST. Paths are enforced by
`firestore.rules`.

### 4.1 Authentication (`lib/firebaseAuth.js`, `lib/emailAuth.js`)

| Operation | Implementation |
|---|---|
| Google sign-in | `signInWithPopup` / `signInWithRedirect` with `GoogleAuthProvider` |
| Email registration | `createUserWithEmailAndPassword` via `createFirebaseEmailAuthProvider`; policy checked first |
| Email sign-in | `signInWithEmailAndPassword`; returns `needsVerification` when the address is unverified |
| Email verification | `sendEmailVerification` (register + resend); `reload(user)` refreshes the flag |
| Forgot password | `sendPasswordResetEmail`; always answers with neutral text on a missing account |
| Reset completion | `confirmPasswordReset(code, newPassword)` in the service (provider-hosted page by default) |
| Change password | reauthenticate with `EmailAuthProvider.credential` → `updatePassword` |
| Change email | reauthenticate → `verifyBeforeUpdateEmail` (link goes to the new address; old one stays active) |
| Sign-out | `signOut(auth)`, then local cleanup and `nsat:account-signed-out` event |
| Persistence | `setPersistence(auth, browserLocalPersistence \| browserSessionPersistence)` |
| Session restore | `onAuthStateChanged` on load |
| Idle policy | `lib/sessionPolicy.js` (30-day browser-local limit) |

**Service contract** (`createEmailAuth({ provider })`): `register`, `signIn`,
`signOut`, `refreshVerification`, `resendVerification`, `sendPasswordReset`,
`confirmPasswordReset`, `changePassword`, `changeEmail`. The Firebase adapter is
`createFirebaseEmailAuthProvider({ auth, authSdk })`; tests inject a fake
provider, so no Firebase project is needed to run them.

Not implemented: direct `updateEmail` (without verification), `deleteUser`,
multi-factor enrollment, account linking, and custom action-code handling.

### 4.2 Firestore (`lib/profile.js`, `lib/contacts.js`, `lib/accountExport.js`)

| Operation | Path | Caller |
|---|---|---|
| Read own profile | `profiles/{uid}` | `readMyProfile()` |
| Build a shareable profile link/QR | no database write; `/wallet/?add=@handle` or `?add=G…` | `buildProfileShareUrl()` (public profiles prefer the handle; limited profiles prefer the address) |
| Create profile + claim handle | `profiles/{uid}` + `profileIds/{profileId}` (transaction), optional display name/bio/status/visibility | `createProfileForUser()` |
| Rename handle | delete old claim, create new, update profile | `renameProfileIdForUser()` |
| Resolve handle | `profileIds/{profileId}` get | `resolveProfileHandle()` |
| Save profile fields | `profiles/{uid}` update (handle, wallet, display name ≤50, bio ≤160, status ≤80, visibility) | `saveMyProfile()` |
| Send friend request | `requests/{me}/outbox/{peer}` + `requests/{peer}/inbox/{me}` | `createFirestoreContactsStore().sendRequest()` |
| Accept/reject | update both inbox and outbox | `acceptRequest()` / `rejectRequest()` |
| Cancel | delete own outbox + peer inbox while pending | `cancelRequest()` |
| Add contact | `contacts/{me}/people/{peer}` (rules require accepted request) | `acceptRequest()` |
| Remove contact | delete own `contacts/{me}/people/{peer}` | `removeContact()` |
| Block / unblock | `blocks/{me}/people/{peer}` set/delete, plus contact cleanup | `block()` / `unblock()` |
| Opt in to email discovery | `discoveryEmails/{sha256(email)} = { uid }` | `setEmailDiscovery(true)` |
| Look up by email | `discoveryEmails/{sha256(email)}` get, only when verified + opted in | `findByEmail()` |
| Export account data | read `profiles/{uid}`, own contacts/requests/blocks; JSON download | `downloadAccountExport()` (profile, contacts, requests, blocks; no transcripts/Auth) |

`profileIds` and `discoveryEmails` are never listed (rules deny `list`), which is
the anti-enumeration control.

---

## 5. Client SDK reference (selected)

| Module | Exported operation | Contract |
|---|---|---|
| `lib/chatIdentity.js` | `getOrCreateChatIdentity(address, {walletSeed32, storage})` | Returns `{seed32, chatPub, ed25519Pub, x25519Pub, delegation, created}`; serialized under Web Locks |
| `lib/e2eChat.js` | `sealMessage`, `openMessage`, `publicKeyBundle`, `chatPublicKeyBundle`, `verifyPublicKeyBundle` | tweetnacl box + Ed25519 signatures |
| `lib/chatClient.js` | `createChatClient({origin, fetchImpl, now, deviceId})` → `fetchPublicKey`, `publishChatKey`, `sendMessage`, `readMessages`, `ackMessages`, `listBlocks`, `blockAddress`, `unblockAddress` | Every call signs; throws on non-2xx with the server error |
| `lib/chatArchive.js` | `saveMessage`, `listMessages`, `deleteMessage`, `restoreArchiveRows`, `migrateArchiveData` | AES-GCM IndexedDB; opt-in |
| `lib/chatPaymentRequest.js` | `encodePaymentRequest`, `parsePaymentRequest` | Exact integer amounts, authenticated sender |
| `lib/chatPaymentInbox.js` | `migratePaymentRequests`, request store | Encrypted local obligation store |
| `lib/chatUnread.js` | `readUnread`, `markRead`, `readCursor`, `writeCursor` | Per owner+device |
| `lib/chatTabSync.js` | `leadChatPolling` | Web Locks leader election |
| `lib/chatIdentityBackup.js` | `buildIdentityEnvelope`, `openIdentityEnvelope` | AES-GCM with wallet-seed-derived key |

---

## 6. Versioning and compatibility

| Surface | Compatibility rule |
|---|---|
| Chat protocol v1/v2/v3 | Relay accepts all three; client emits v3; removing v1/v2 requires a client-version gate |
| Key bundle `v` | `v: 2` adds chat identity; `v: 1` legacy wallet-signed bundle still shape-checked |
| OpenAPI | **Not produced.** This document is the contract; handlers are small and tested. |
| Breaking changes | Must bump a protocol version and keep the old verifier until clients migrate |
