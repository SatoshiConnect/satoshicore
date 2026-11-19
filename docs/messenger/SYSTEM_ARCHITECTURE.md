# SYSTEM_ARCHITECTURE

Status of this document: **audit snapshot, 2026-11-16**, of branch
`feat/chat-first-wallet-ux` (HEAD `d63d6ff` plus uncommitted work in the
worktree). It describes what is actually built, not what is planned. Where a
capability does not exist, the section says so.

Related: `GAP_ANALYSIS.md`, `DATABASE_SCHEMA.md`, `API_DOCUMENTATION.md`,
`MEMBERSHIP_FEATURE_CHECKLIST.md`, `CHAT_FEATURE_CHECKLIST.md`,
`SECURITY_REVIEW.md`, `TEST_RESULTS.md`, `DEPLOYMENT_GUIDE.md`.

---

## 1. What the application is

SatoshiCore (NSAT) is a **statically exported Next.js 14 web wallet** with an
optional Google account layer and a **1:1 encrypted chat relay**. There is no
application server that renders pages, owns accounts, or stores user sessions.
Three independent backends exist:

1. **Firebase Authentication + Firestore** — optional website account, profile
   handle, contact graph, friend requests, blocks, opt-in email discovery.
2. **NSAT API gateway** (`services/api-gateway/server.js`, deployed as a Node
   service) — chain reads, transaction submission, sponsorship, and the
   encrypted chat relay mounted at `/api/v1/chat/*`.
3. **NSAT core node** — the chain itself, reached by the gateway; never called
   from the browser directly.

The wallet keys live only in the browser (encrypted keystore) or the desktop
app. Firestore never receives a seed, password, or private key; the gateway
never receives a message body it can read.

---

## 2. Component map

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Browser (static export served by Caddy at https://satoshicore.org)       │
│                                                                          │
│  app/ (Next.js App Router, `output: 'export'`)                           │
│   /            marketing + account gate                                  │
│   /wallet      WalletPanel, ProfileCard, ContactsCard, ChatPanel,        │
│                ChatArchiveCard, DriveBackupCard                          │
│   /dashboard /explorer /status /docs /download /privacy /security /terms │
│                                                                          │
│  Wallet engine      lib/nsatWallet.js, lib/keystore.js (AES-GCM keystore)│
│  Account layer      lib/firebaseAuth.js, lib/emailAuth.js,               │
│                     lib/sessionPolicy.js, components/EmailAccount.js     │
│  Profile/contacts   lib/profile.js, lib/contacts.js                      │
│  Chat client        lib/chatIdentity.js, lib/e2eChat.js, lib/chatClient  │
│                     lib/chatArchive.js (IndexedDB, AES-GCM)              │
│                     lib/chatPaymentInbox.js, lib/chatPaymentRequest.js   │
│                     lib/chatUnread.js, lib/chatTabSync.js, lib/chatDevice│
│  Backup/recovery    lib/chatIdentityBackup.js, lib/chatArchiveBackup.js  │
└───────────┬─────────────────────────────┬────────────────────────────────┘
            │ Firebase JS SDK             │ fetch, Ed25519-signed requests
            │ (HTTPS, ID token)           │ (no cookie, no session)
            ▼                             ▼
┌───────────────────────────┐   ┌──────────────────────────────────────────┐
│ Firebase                  │   │ NSAT API gateway (Node, launchd)         │
│  Auth (Google provider)   │   │  /health, /api/v1/network/status,        │
│  Firestore                │   │  /api/v1/tx/*, /v1/sponsor/*,            │
│   websitePreferences      │   │  /api/v1/chat/{keys,messages,ack,blocks} │
│   walletLinks             │   │                                          │
│   profiles / profileIds   │   │  chat-relay.mjs → SQLite (WAL)           │
│   contacts / requests     │   │   opaque ciphertext envelopes only       │
│   blocks / discoveryEmails│   └───────────────┬──────────────────────────┘
│  Security rules (deny-by-│                   │ HTTP (localhost/private)
│  default)                 │                   ▼
└───────────────────────────┘        ┌──────────────────────────┐
                                     │ nsat-core node           │
                                     │ chain state, ledger,     │
                                     │ tx submission            │
                                     └──────────────────────────┘
```

### 2.1 Frontend

- **Framework**: Next.js `14.2.15`, App Router, `output: 'export'`,
  `trailingSlash: true`. All 14 routes are prerendered static HTML. There is no
  server-side rendering and no Next API route (the export would reject one).
- **Reason**: the site is served by a static webroot behind Caddy; the
  application must keep working without a Node process on the web host.
- **State**: React hooks in a small number of client components. No global store.
- **Styling**: hand-written CSS (`styles.css`, `app/globals.css`), mobile-first
  430 px shell, light/dark themes, contrast checked by
  `tests/theme-contrast.test.mjs` and `scripts/theme-audit.mjs`.

### 2.2 Account layer (Firebase)

- **SDK**: `firebase@12.14.0` (modular), loaded lazily in `lib/firebaseAuth.js`
  so the marketing pages do not pay for it.
- **Providers**: Google OAuth and email/password, both through Firebase
  Authentication. The email/password flow is a tested client service
  (`lib/emailAuth.js`) over a thin Firebase adapter; no server-side Admin SDK
  code exists in this repo. Email/password is **not configured** in this
  environment, so the live flow is unverified.
- **Session**: the Firebase JS SDK persists the session in the browser. When
  "remember this device" is off, the session uses in-memory persistence and ends
  with the tab; when on, it survives a restart.
  `lib/sessionPolicy.js` adds a browser-local idle limit of 30 days and records
  only `{uid, lastSeenAt}` — never a token.
- **Identity**: the Firebase `uid` is the immutable internal user id and the
  document key for everything user-owned.
- **Authorization**: `firestore.rules`, deny-by-default, enforces ownership,
  verified email (`email_verified` token claim), handle uniqueness, the
  friend-request state machine, and blocks. Client checks are advisory only.

### 2.3 Chat client

- **Identity** (`lib/chatIdentity.js`): each wallet address gets a dedicated
  32-byte chat seed (Ed25519 signing + X25519 encryption). It is created once and
  stored in `localStorage` under `scw-chat-identity-v1:<ADDRESS>` as JSON holding
  the Base64 seed and the wallet-signed delegation. The delegation lets the chat
  key sign relay requests while the wallet is locked. Chat identity is
  deliberately separate from the wallet seed.
- **Encryption** (`lib/e2eChat.js`): `tweetnacl` `box` (X25519 +
  XSalsa20-Poly1305). The sender fetches the recipient's published bundle, signs
  the envelope with the chat Ed25519 key, and posts opaque ciphertext.
- **Transport** (`lib/chatClient.js`): `fetch` to `/api/v1/chat/*` with headers
  `x-nsat-chat-*`, a timestamp, a device id and a nonce; every request is
  Ed25519-signed (protocol versions v1 wallet-signed, v2 wallet+device,
  v3 delegated chat key).
- **Persistence**: opt-in encrypted transcript archive in IndexedDB
  (`lib/chatArchive.js`, AES-GCM rows keyed by conversation). Unread/read
  cursors live in `localStorage` (`scw-chat-unread-v1`, `scw-chat-read-v1`,
  `scw-chat-cursor-v1`).
- **Multi-tab**: `lib/chatTabSync.js` elects one polling leader through the
  Web Locks API so several tabs do not duplicate reads/acks.
- **Offline**: none. There is no outgoing queue; a send either returns HTTP 200
  or surfaces an error. Polling runs about every 15 seconds while the tab is
  visible.
- **Backup**: `lib/chatIdentityBackup.js` wraps the chat seed in an envelope
  encrypted with a wallet-seed-derived key and uploads it to the Google Drive
  **app data folder**; `lib/chatArchiveBackup.js` does the same for the archive.
  Restore requires the wallet seed, so the wallet remains the recovery root.

### 2.4 Chat relay (gateway)

- **Module**: `services/api-gateway/chat-relay.mjs` (635 lines), mounted by
  `server.js` at `CHAT_PREFIX = '/api/v1/chat/'`.
- **Storage**: `node:sqlite` `DatabaseSync`, WAL mode, tables `chat_keys`,
  `chat_messages`, `chat_devices`, `chat_deliveries`, `chat_blocks`,
  `chat_quota`, `chat_nonces`. See `DATABASE_SCHEMA.md`.
- **Authentication**: no accounts, no cookies, no Google tokens. A request is
  accepted only with a valid Ed25519 signature over a canonical request line, a
  timestamp inside a 120 s freshness window, and a nonce not seen before. The
  nonce is recorded in SQLite, so the guard survives a gateway restart.
- **Authorization**: the signer's address must equal the envelope sender; reads
  return only rows delivered to the signing address *and* device; acks are
  scoped the same way; block lists are owner-only.
- **What the relay can see**: sender address, recipient address, envelope size,
  arrival time. It cannot decrypt message bodies.
- **Delivery semantics**: a message is stored once and copied to every
  registered device of the recipient (`chat_deliveries`). A device ack removes
  only its own copy; the message row is deleted when no device still holds it,
  or after 7 days.
- **Gates**: per-sender 200 stored messages/day, 5,000 pending envelopes per
  mailbox, 8 KiB per envelope, max 10 devices per address, max 500 blocks,
  max 3 published keys per address.

### 2.5 Not present in the architecture

The following do **not** exist and are not implied by any UI:

- An account server, email delivery, or a live Email/Password provider. The
  client flow exists, but no email has been delivered and no reset/verification
  token has been issued or redeemed in this environment. Password hashing and
  token issuance are provider-side by design; the project never hashes or stores
  a password.
- Session/device administration, "log out all devices", role-based admin.
- Group conversations, membership records, group roles.
- Attachments, object storage, upload pipeline, malware scanning, voice notes.
- OS/web push, presence, typing, and a WebSocket option; SSE already provides
  in-app wake-ups and read receipts are implemented.
- Push notifications, moderation/reporting backend, account deletion/export.
- Federation (Matrix or otherwise). The product is not federated.

---

## 3. Trust boundaries and data flow

| Boundary | What crosses it | Protection |
|---|---|---|
| Browser ↔ Firebase Auth | Google OAuth credential or email+password, Firebase ID token | HTTPS, provider-side hashing and action codes, Firebase SDK session storage |
| Browser ↔ Firestore | uid, profile handle, display name/bio/status, profile visibility, wallet **address**, contact graph, block list, email **hash** | Security rules; verified email required; profile reads follow visibility; no seed/password/message |
| Browser ↔ gateway | signed request headers, opaque encrypted envelope, public key bundle, block list | Ed25519 signature, freshness window, nonce replay guard, per-sender quotas |
| Gateway ↔ SQLite | ciphertext envelope + metadata | Local file permissions; no plaintext content at rest |
| Browser ↔ Google Drive | encrypted chat-identity/archive envelope in app data folder | AES-GCM with wallet-seed-derived key; Drive scope limited to app data |
| Gateway ↔ nsat-core | signed transaction envelopes, read requests | Allowlisted routes, no wildcard proxy |

**Wallet seed** never leaves the device except as an AES-GCM backup blob the
user explicitly creates. **Chat seed** never leaves the device except inside an
encrypted backup envelope. **Message plaintext** never leaves the browser.

### 3.1 Message send path (1:1, wallet locked)

1. Sender opens a room; `lib/chatClient.js` resolves the recipient's key bundle
   (`GET /api/v1/chat/keys?address=G…`, public).
2. Sender encrypts with the recipient's X25519 key and signs the envelope with
   its chat Ed25519 key (delegated earlier by the wallet). `prepare()` returns
   the ciphertext before any network write.
3. `lib/chatOutbox.js` stores only that ciphertext under a random `clientId`
   (per wallet, capped at 50). `sendPrepared()` posts it; a retry reuses the
   same id, so the relay's unique `(sender, client_id)` index returns the
   original row instead of creating a duplicate.
4. Relay verifies the signature, freshness and nonce, checks sender == signer,
   checks both directions of the block table, enforces quota, stores the
   envelope, and copies it to the recipient's registered devices.
5. Recipient's signed SSE stream (`GET /api/v1/chat/events`) wakes the tab on
   new mail, then the poll (`GET /api/v1/chat/messages?since=…` or `?peer=…`)
   returns this device's copies. The stream carries only `{id}`; the client
   decrypts locally and stores plaintext in the encrypted IndexedDB archive if
   opted in. A 15 s poll remains as the fallback.
6. If the archive stored it, the client acks (`POST /api/v1/chat/ack`); the
   relay removes the device copy and deletes the message when no other device
   needs it.
7. A sender can call `POST /api/v1/chat/messages/delete`; the relay drops the
   ciphertext and keeps an id-only tombstone. Recipients and sibling devices
   fetch/observe it and remove their local/archive copy.
8. Edit/reaction controls are encrypted envelopes with a reserved plaintext
   prefix; the client applies and acknowledges them instead of rendering a row.
9. The reader posts `POST /api/v1/chat/read` with the highest displayed id;
   the sender reads it with `GET /api/v1/chat/read?peer=…` and shows Sent/Read.
   Local unread badges remain per device (`scw-chat-unread-v1`).

### 3.2 Account/profile path

`GoogleAccount.js` → `lib/firebaseAuth.js` (popup/redirect, persistence
choice) → `ProfileCard.js` → `lib/profile.js` → Firestore
`profiles/{uid}` (handle, primary wallet, optional display name/bio/status and
visibility) +
`profileIds/{profileId}` (transactional claim) with rules
requiring `email_verified`. Contact operations go through
`lib/contacts.js` → `createFirestoreContactsStore()` → the four collections in
`DATABASE_SCHEMA.md`.

Profile sharing is deliberately stateless: `lib/profileShare.js` builds a
`/wallet/?add=@handle` (or `?add=G…`) link, `ProfileCard.js` renders it and a
locally generated QR, and the receiver's `ChatPanel.js` pre-fills its add field
when the link is opened later. No sender socket, session, or running app is
needed at share time, and no new database document is created.

---

## 4. Chat identity and key management

- A chat identity is **per wallet address**, not per Google account, so chat is
  available to wallet-only users (no account required).
- Generation is guarded by the Web Locks API (`chatIdentity.js`), preventing two
  tabs from creating two identities for the same address.
- The delegation is signed once by the wallet and posted inside the published
  key bundle (`v2`); relay requests then carry the chat key (`v3`).
- Recovery: `chatIdentityBackup.js` produces an envelope encrypted with a key
  derived from the wallet seed; restore requires unlocking the wallet. There is
  no separate recovery code and **no device-verification / fingerprint flow**.
- Revocation of a chat identity is not implemented; deleting the browser's
  `localStorage` entry loses the identity unless a backup was made.

---

## 5. Deployment topology (as operated today)

| Component | Where | How |
|---|---|---|
| Static site | Caddy webroot on the host | `npm run build` → `out/` → versioned webroot dir → symlink swap |
| API gateway | `~/nsat-ops/gateway/` under launchd `org.satoshicore.gateway` | Node process, `server.js` + `chat-relay.mjs` |
| Chat database | SQLite file on the gateway host | WAL, backed up before deploys |
| Firebase | Google Cloud project `nsat-wallet-login` | Auth + Firestore rules deployed from `firestore.rules` |

Production record and rollback values are in `DEPLOYMENT_GUIDE.md`. Nothing in
this audit was deployed.

---

## 6. Architectural gaps that block the requested scope

| Requested area | Architectural blocker |
|---|---|
| Email/password live verification, reset delivery | Code and unit tests exist; Firebase Email/Password provider, authorized domains, email templates/delivery and public web config are not available here. Admin-only actions (logout-all, deletion) additionally need the Admin SDK. |
| Multi-device session admin, logout-all, revocation | Requires Firebase Admin SDK (`revokeRefreshTokens`) or an equivalent session store; neither exists here |
| Groups, invites, roles | No conversation/membership schema anywhere; relay is address→mailbox only |
| Attachments | No object storage, upload service, scanning, or signed-URL issuer |
| Real-time | Authenticated SSE stream for wake-ups + 15 s polling fallback; no WebSocket and no OS/web push |
| Moderation/admin | No roles, no admin API, no report store |
| Account deletion/export | No server-side account authority; Firestore docs are user-owned but Auth deletion needs Admin SDK |
| Federation | Deliberately not implemented; no homeserver, no federation protocol |

These are infrastructure and credential gaps, not UI gaps. They are repeated per
requirement in the two checklists.
