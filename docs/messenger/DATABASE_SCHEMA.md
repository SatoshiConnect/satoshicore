# DATABASE_SCHEMA

Audit snapshot of every persistent store the application actually uses, at
2026-11-16. Three stores exist: **Firestore** (account layer), **SQLite** (chat
relay), and **browser storage** (wallet, chat identity, archive, cursors).
There is no relational application database and no server-side session table.

---

## 1. Storage inventory

| Store | Engine | Owner | Contents | Backup |
|---|---|---|---|---|
| Firestore | Google Firestore (native) | Firebase project `nsat-wallet-login` | account preferences, wallet links, profile handle, contact graph | Google-managed; no export script in repo |
| Chat relay DB | SQLite (`node:sqlite`), WAL | gateway host | public key bundles, opaque envelopes, devices, deliveries, blocks, quota | file copy in `~/nsat-ops/backups/`; integrity check after copy |
| Chat archive | IndexedDB (`scw-chat-archive-v1`) | browser | AES-GCM encrypted transcript rows and payment requests | optional encrypted Drive backup |
| Identity/cursors | `localStorage` | browser | chat seed, migration marker, unread/read/cursor maps, device id, archive prefs, session record | chat seed via encrypted Drive envelope |

---

## 2. Firestore

### 2.1 Collections and document shapes

All documents are keyed so the owning account is part of the path or the id.
Rules are deny-by-default (`match /{document=**} { allow read, write: if false }`).

#### `websitePreferences/{uid}`
| Field | Type | Notes |
|---|---|---|
| `theme` | `"light" \| "dark"` | Only field allowed (`hasOnly(['theme'])`). Owner-only read/write. |

#### `walletLinks/{uid}`
| Field | Type | Notes |
|---|---|---|
| `address` | `G…` string | Legacy single-address form; owner-only. |

#### `walletLinks/{uid}/addresses/{address}`
| Field | Type | Notes |
|---|---|---|
| `address` | `G…` string | Must equal the document id; owner-only; address is public, no spending power. |

#### `profiles/{uid}`
| Field | Type | Notes |
|---|---|---|
| `profileId` | `@[a-z0-9][a-z0-9_-]{2,19}` | Public handle. |
| `primaryAddress` | `G…` or `""` | Must be a wallet already linked by the same account. |
| `displayName` | string, ≤ 50, optional | Trimmed/collapsed by the client; may be absent or empty. |
| `bio` | string, ≤ 160, optional | Same normalization; may be empty. |
| `status` | string, ≤ 80, optional | Same normalization; may be empty. |
| `visibility` | `signed-in` \| `contacts` \| `private` | Optional in storage; missing means `signed-in` for old documents. `contacts` requires an accepted contact document to read; `private` is owner-only. |

`get` is owner-always; otherwise `visibility` decides (default `signed-in` for
missing). `list` is denied. Create/update require `email_verified`, the exact
field set, and the wallet-link proof. The three text fields and `visibility` are
validated only when present, so documents written before they existed remain
readable and updatable; the current client always writes all six.

#### `profiles/{uid}` — intentionally absent fields
No avatar URL, email, or key material. Visibility exists, but only governs
reading this document; friend-request, messaging and presence policies are not
implemented (A6.1–A6.8). Adding those is a schema change plus a rules/relay
change (see `GAP_ANALYSIS.md`).

#### `profileIds/{profileId}`
| Field | Type | Notes |
|---|---|---|
| `uid` | string ≤128, `[A-Za-z0-9_-]` | Uniqueness claim. Create-only; update denied; `list` denied (no enumeration). |

#### `contacts/{owner}/people/{peer}`
| Field | Type | Notes |
|---|---|---|
| `state` | `"friend"` | Fixed. |
| `since` | number > 0 | Epoch ms. |

Read: owner only. Create/update: the owner or the accepting peer, and only when
an **accepted** request exists in either direction. Delete: owner only.

#### `requests/{owner}/inbox/{from}` and `requests/{owner}/outbox/{to}`
| Field | Type | Notes |
|---|---|---|
| `state` | `"pending" \| "accepted" \| "rejected"` | Terminal answer in one write. |
| `at` | number > 0 | Epoch ms. |

Inbox: recipient lists; sender may `get` the single document. Create only by the
sender, only `pending`, only if the recipient has not blocked them. Update only
by the recipient (to accepted/rejected). Delete only by the sender while pending.
Outbox mirrors this for the sender's view.

#### `blocks/{owner}/people/{peer}`
| Field | Type | Notes |
|---|---|---|
| `at` | number > 0 | Epoch ms. No reason, name, or message. |

Owner-only read/write. Used by rules (`hasBlocked`) to refuse friend requests and
by the chat relay's separate `chat_blocks` table to drop messages.

#### `discoveryEmails/{emailHash}`
| Field | Type | Notes |
|---|---|---|
| `uid` | string | The only field. |

`emailHash` is `sha256(lowercased-trimmed email)` (64 hex chars). `get` allowed
to signed-in users (exact hash only); `list` denied. Create/update require
verified email and `uid == request.auth.uid`.

### 2.2 Indexes and queries

No composite indexes are declared. The client performs only document `get`s and
subcollection `list`s scoped to the signed-in uid, which are served by
Firestore's automatic single-field indexes. `profileIds` and `discoveryEmails`
are never listed.

### 2.3 Migration and rollback (Firestore)

- **Schema is schemaless**; changes are made by adding fields and tightening
  rules. There is no in-repo migration runner.
- **Rules are the real schema enforcement.** Every rules change must be recorded
  with its ruleset id before deployment; rollback is re-publishing the previous
  ruleset id (the console keeps version history).
- Known production ruleset at the last recorded deploy:
  `e4bac944-e3f3-4765-83fd-a4583dccb127` (see
  `docs/messenger/RELEASE-READINESS.md`); previous
  `1f1bbce6-cf44-49f2-b2da-59b46b55a2e9`.
- **Gap**: the repository has no versioned migration files for Firestore data
  (backfill, field rename, handle normalization change). Any such change must
  add a documented, idempotent migration script and a rollback note. This is
  reported as PARTIAL in `MEMBERSHIP_FEATURE_CHECKLIST.md` (A4/A9).

---

## 3. Chat relay SQLite

Created by `openDatabase()` in `services/api-gateway/chat-relay.mjs`
(`CREATE TABLE IF NOT EXISTS`, `PRAGMA journal_mode = WAL`). Relative path
resolved next to the module by default; production path is under
`~/nsat-ops/gateway/`.

### 3.1 DDL

```sql
CREATE TABLE IF NOT EXISTS chat_keys (
  address     TEXT NOT NULL,           -- G… wallet address
  x25519_pub  TEXT NOT NULL,           -- Base64 public key (identity of the bundle)
  bundle      TEXT NOT NULL,           -- JSON: v, address, x25519Pub, ed25519Pub,
                                       --       chatPub, delegation, createdAt, signature…
  updated_at  INTEGER NOT NULL,        -- epoch ms
  PRIMARY KEY (address, x25519_pub)
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  sender       TEXT NOT NULL,          -- G… (must equal the request signer)
  recipient    TEXT NOT NULL,          -- G…
  envelope     TEXT NOT NULL,          -- opaque JSON ciphertext, ≤ 8 KiB
  bytes        INTEGER NOT NULL,
  received_at  INTEGER NOT NULL
);
CREATE INDEX chat_messages_inbox ON chat_messages (recipient, id);
CREATE INDEX chat_messages_peer  ON chat_messages (recipient, sender, id);
CREATE INDEX chat_messages_gc    ON chat_messages (received_at);

CREATE TABLE IF NOT EXISTS chat_devices (
  address       TEXT NOT NULL,
  device_id     TEXT NOT NULL,         -- random per browser profile, signed
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  PRIMARY KEY (address, device_id)
);
CREATE INDEX chat_devices_seen ON chat_devices (address, last_seen_at);
CREATE INDEX chat_devices_gc   ON chat_devices (last_seen_at);

CREATE TABLE IF NOT EXISTS chat_deliveries (
  message_id INTEGER NOT NULL,
  device_id  TEXT NOT NULL,
  PRIMARY KEY (message_id, device_id)
);
CREATE INDEX chat_deliveries_device ON chat_deliveries (device_id, message_id);

CREATE TABLE IF NOT EXISTS chat_blocks (
  owner   TEXT NOT NULL,
  blocked TEXT NOT NULL,
  at      INTEGER NOT NULL,
  PRIMARY KEY (owner, blocked)
);

CREATE TABLE IF NOT EXISTS chat_quota (
  address TEXT NOT NULL,
  day     INTEGER NOT NULL,            -- floor(epoch_ms / 86_400_000)
  count   INTEGER NOT NULL,
  PRIMARY KEY (address, day)
);
CREATE INDEX chat_quota_gc ON chat_quota (day);

-- Durable replay guard. A signed request's nonce is inserted before the
-- request is acted on and kept for twice the freshness window; it survives a
-- gateway restart. Expired rows are removed by GC.
CREATE TABLE IF NOT EXISTS chat_nonces (
  nonce      TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX chat_nonces_expiry ON chat_nonces (expires_at);
```

A boot-time backfill inserts a `legacy` delivery row for any pre-device message
that has none, so older mail stays readable by exactly one client.

### 3.2 Retention and garbage collection

`runGc()` runs at most every 15 s on request:

- delete deliveries and messages with `received_at < now - 7 days`;
- delete devices not seen within 7 days (and their pending deliveries);
- delete quota rows older than one day;
- delete nonce rows whose `expires_at` has passed (twice the ±120 s freshness
  window).

`trimDevices()` keeps at most 10 devices per address, dropping the least
recently seen and its pending copies, so the mailbox stays bounded.

### 3.3 Integrity rules enforced by code

| Rule | Where |
|---|---|
| Envelope sender must equal the signing address | `POST /messages` |
| Recipient must be a valid strkey `G…` (CRC16 checked) | `decodeAddress()` |
| Envelope ≤ 8 KiB | `POST /messages` |
| ≤ 200 stored messages per sender per day | `chat_quota` |
| ≤ 5,000 pending envelopes per recipient | `chat_messages` count |
| ≤ 10 devices per address | `trimDevices()` |
| ≤ 500 blocks per owner | `POST /blocks` |
| ≤ 3 published key bundles per address (newest kept) | `POST /keys` |
| A block drops already-queued mail from that sender | `POST /blocks` |
| Ack only removes the signer's device copy | `POST /ack` |
| A nonce is accepted once, including across a process restart | `chat_nonces` primary key |

### 3.4 Versioning and migration

- **No schema-version table.** All DDL is additive `IF NOT EXISTS`, which makes
  upgrades idempotent but gives no downgrade path and no record of which version
  a file is at.
- A destructive change (column rename, new NOT NULL, table split) currently
  requires a manual, unversioned procedure. **This is a PARTIAL against Global
  Rule 8 and is listed in `CHAT_FEATURE_CHECKLIST.md` (B9.6).**
- The repository *does* have one versioned **client-side data migration**:
  `lib/chatMigration.js` re-encrypts old wallet-seed-derived archive and payment
  inbox rows under the chat identity, guarded by
  `scw-chat-identity-migrated-v1:<ADDRESS>`. It is copy-first: new rows are
  written before the marker, and the marker is only set after both migrations
  succeed. Tests: `tests/chat-archive-migration.test.mjs`.

### 3.5 Backup and restore

- Before gateway deploys, the SQLite file is copied to
  `~/nsat-ops/backups/gateway-v2-<timestamp>/` and `PRAGMA integrity_check` is
  run (recorded in `docs/messenger/RELEASE-READINESS.md`).
- **Restore is documented but has not been drilled as a test.** Stop the gateway,
  restore the file, restart, verify `/health` and a signed read. This is a
  PARTIAL in B9.6 and `DEPLOYMENT_GUIDE.md`.

---

## 4. Browser storage

### 4.1 `localStorage`

| Key | Shape | Purpose | Secret? |
|---|---|---|---|
| `scw-chat-identity-v1:<ADDRESS>` | JSON `{ seed32: base64, delegation, … }` | 32-byte chat seed + wallet delegation | **Yes** — unencrypted on device, protected only by device access |
| `scw-chat-identity-migrated-v1:<ADDRESS>` | `"1"` | Migration marker | No |
| `scw-chat-device-v1` | 16–64 char id | Relay device identity | No (signed, not secret) |
| `scw-chat-archive-prefs-v1` | `{ enabled: boolean }` | Opt-in archive flag | No |
| `scw-chat-unread-v1` | owner/device → counts | Badge counts | No |
| `scw-chat-read-v1` | owner/device → read map | Read state | No |
| `scw-chat-cursor-v1` | owner/device → last id | Poll cursor | No |
| `nsat-web-session-v1` | `{ uid, lastSeenAt }` | Idle-session policy | No |
| `nsat-session-expired-v1` | flag | Shows "session ended" on the gate | No |

Wallet keystore and wallet metadata keys are defined in `lib/keystore.js` and
`lib/nsatWallet.js`; seeds there are AES-GCM ciphertext derived from the wallet
password/passkey.

### 4.2 IndexedDB — `scw-chat-archive-v1` (version 2)

| Object store | Key | Indexes | Value |
|---|---|---|---|
| `messages` | `key` | `owner_peer` (`[owner, peer]`), `owner` | AES-GCM ciphertext (nonce + ciphertext), owner, peer, timestamp |
| `requests` | `key` | `owner` | Encrypted payment-request obligations (added in v2) |

- The encryption key is HKDF-derived from the **chat seed** with a scope
  (`deriveArchiveKey(seed32, address, scope)`), not from the wallet seed, so the
  archive opens while the wallet is locked. `ChatPanel.js` passes
  `chatIdentity.seed32` with scope `'chat'`.
- The archive is opt-in. With it off, messages are not persisted locally and are
  lost when the relay copy is acked or expires.
- Restore from Drive writes rows idempotently by key
  (`restoreArchiveRows`), so a repeated restore does not duplicate.

---

## 5. Referential integrity

There are no foreign keys in SQLite and no cross-document transactions in
Firestore beyond the profile-handle claim.

| Relationship | Enforced by |
|---|---|
| Contact ↔ accepted request | Firestore rules (`requestIsAccepted`) |
| Profile ↔ owned wallet link | Firestore rules (`get()` on `walletLinks`) |
| Handle ↔ account | Transactional create of `profileIds` + profile write; delete releases the id |
| Message ↔ device delivery | Relay code; delivery rows deleted with the message |
| Device ↔ address | Composite primary key |
| Chat seed ↔ address | Key suffix; a seed for another address is ignored |

**Orphan risk**: deleting an account (not implemented) would leave
`profileIds`, `contacts`, `requests`, `blocks`, `discoveryEmails`, and Drive
backups behind. Any future deletion flow must delete the handle claim, both
sides of the contact graph, pending requests, blocks, the discovery hash, and
the Drive app-data files. This is why A9 is NOT STARTED rather than PARTIAL.

---

## 6. Data classification

| Data | Classification | At rest |
|---|---|---|
| Wallet seed | Critical secret | AES-GCM keystore, device only |
| Chat seed | Critical secret | `localStorage` Base64, device only (known weakness) |
| Message plaintext | Private | IndexedDB AES-GCM; otherwise memory only |
| Message ciphertext | Confidential | SQLite, 7-day retention |
| Block list | Private | Firestore rules owner-only; relay table server-only |
| Email address | Personal | Never stored; only SHA-256 hash, opt-in |
| Wallet address | Public | Firestore, relay metadata |
| Handle | Public | Firestore |
| Session metadata | Personal | Browser `localStorage` (`uid`, timestamp) |
