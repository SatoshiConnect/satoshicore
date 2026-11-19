# Attachments and “forward to Saved Messages” — design

Status: **design only**. No relay route, no bucket, no client code, no feature
flag, nothing deployed. This document exists so the next change can be reviewed
before any of it is built.

Scope of this design:

1. Attaching a file in a chat, encrypted **on the device** before anything leaves
   it.
2. Forwarding a file that arrived in another chat into **Saved Messages** (the
   wallet's own room added in the previous change).
3. Where the bytes can live, and what that choice means for size, quota,
   deletion and recovery.

Groups, voice notes, thumbnails for every type and push notifications are out of
scope, as before (`docs/messenger/GAP_ANALYSIS.md`, G7).

## 1. What has to stay true

The properties the text chat already has (`docs/E2E-CHAT-DESIGN.md`) must hold
for files too, or this is a different, weaker product:

- the relay never sees plaintext, a file name, a MIME type or a content hash of
  the plaintext;
- holding the wallet key is the identity — no new account, cookie or token;
- reading never deletes by itself; deletion is explicit, per device, and
  retention is the outer bound;
- a device that has the bytes locally is the only thing that can hand them on;
- Saved Messages stays a room of one wallet: no contact, no unread badge, no
  read receipt.

## 2. What exists today, and what it forces

| Today | Value | Consequence for files |
| --- | --- | --- |
| `MAX_TEXT_LENGTH` (`lib/e2eChat.js:40`) | 2000 characters | A file cannot be base64 inside the message envelope. |
| `MAX_ENVELOPE_BYTES` (`chat-relay.mjs:30`) | 8 KiB | Same. The envelope carries a **reference**, not the bytes. |
| `MAX_BODY_BYTES` (`server.js:35`) | 64 KiB | One upload request per chunk; a per-route cap is needed for a useful chunk size. |
| `MAX_MESSAGES_PER_SENDER_PER_DAY` | 200 stored messages/day | Upload chunks must not be charged to this, or one 25 MiB file would exhaust the day. |
| `MAX_MESSAGES_PER_RECIPIENT` | 5,000 pending | Files need their own pending budget in bytes, not rows. |
| `RETENTION_DAYS` | 7 | The relay copy of an unclaimed file is gone after a week. |
| `MAX_DEVICES_PER_ADDRESS` | 10 | Any per-device delivery bookkeeping multiplies by this. |
| Archive (`docs/CHAT-ARCHIVE.md`) | IndexedDB `scw-chat-archive-v1` v2, AES-256-GCM, key = HKDF(seed32, salt=wallet, info=`nsc-chat-archive-v1`) | This is the only place a file can be “saved” in a way that survives the relay. It currently stores text rows only. |
| Drive backup | one `nsat-chat-archive.<wallet>.json`, second AES-GCM envelope, manual | Can carry pinned files later, at the cost of a much larger container. |

Two existing decisions are reused unchanged and should not be re-litigated here:

- **The message is the manifest.** A file message is ordinary signed chat text
  (`sealMessage`), so it inherits the signature, the per-device delivery, the
  ack rules and the Saved Messages/self-send behaviour already tested.
- **Ack after store.** `archiveAndClearRelay` already encodes “store locally,
  then acknowledge”; files follow the same order, once per chunk set.

## 3. Shape: a manifest message plus opaque chunks

```
device A                                            relay
  file bytes ──► content key (random 32 B)
             ──► AES-256-GCM per chunk, padded  ──► POST /chat/files  (opaque)
             ──► manifest {fileId, key, name, mime, size, sha256, chunks}
             ──► sealMessage(manifest)  ─────────► POST /chat/messages (as today)
```

- The **manifest** is small (≤ 700 characters for a 120-character name) and fits
  the existing 2000-character rule, so no envelope version bump is needed.
- The **chunks** are the only new bytes on the wire, and they are ciphertext with
  no headers: no name, no type, no original size (only a padded length).
- `fileId` is 16 random bytes, hex. It is not derived from the content, so it
  cannot be used to correlate two uploads of the same file.

Manifest body, carried in the message text after a marker:

```jsonc
{
  "v": 1,
  "fileId": "9f2c…",              // 32 hex chars, random
  "name": "statement.pdf",        // inside the ciphertext only
  "mime": "application/pdf",
  "size": 4823011,                // exact plaintext bytes
  "sha256": "b3d1…",              // plaintext hash, 64 hex chars
  "chunkSize": 524288,
  "chunks": 10,
  "key": "<base64 32 B>",         // per-file content key
  "salt": "<base64 8 B>"          // IV prefix for this file
}
```

The marker is a control-style prefix (`\u0001nsat-file-v1:`). It must be decoded
by a **new** decoder, not by `decodeControl()` — a file card has to be visible in
the transcript, whereas edit/reaction rows are hidden. Consequence: an older
build renders the manifest as text. Rollout order is therefore **decoder before
senders** (see §11).

## 4. Keys and chunk crypto

- **Content key**: 32 random bytes per file, per recipient. Never reused across
  two recipients and never reused across two uploads.
- **Cipher**: AES-256-GCM (WebCrypto) rather than tweetnacl `secretbox`, because
  files are large and native AES is one to two orders of magnitude faster than
  the JS stream cipher; it is also the primitive the archive already uses.
- **IV**: 12 bytes = 8-byte random `salt` ‖ 4-byte big-endian chunk index. The key
  is single-use per file, so an index-derived IV is safe and needs no per-chunk
  nonce storage.
- **AAD**: `nsc-file|1|<fileId>|<index>|<chunks>|<plainLength>` — a chunk cannot
  be moved to another file, another position, another file length, and the true
  length of the last (padded) chunk is authenticated.
- **Padding**: every chunk is padded to exactly `chunkSize` (zeros), so the relay
  learns `chunks × chunkSize` and nothing more about the file size.
- **Key transport**: the content key travels inside the sealed manifest, so the
  relay never has it. The recipient unwraps it with the existing X25519 path —
  no new key type, no new derivation.
- **Why not encrypt to the recipient's chat key per chunk?** Then the sender
  could not read its own upload back and a forward would always need the
  plaintext; a content key keeps one clear rule (“whoever holds the key and the
  ciphertext has the file”) and keeps multi-chunk crypto cheap.

## 5. Wire protocol (proposed, not built)

All routes signed exactly like the existing ones (`nsc-chat|…` line, ±120 s,
single-use nonce, `x-nsat-device`).

| Route | Auth | Purpose |
| --- | --- | --- |
| `POST /api/v1/chat/files` | signed | one chunk `{ fileId, to, index, chunks, ct }` |
| `GET /api/v1/chat/files?fileId=&index=` | signed, recipient only | one chunk back |
| `POST /api/v1/chat/files/delete` | signed, sender only | revoke the whole file (all chunks) |
| `GET /api/v1/chat/files/quota` | signed | bytes left in today’s upload budget |

Rules the relay must enforce itself, because a client check is not a control:

- `to` must exist in `chat_keys`; `from` is the signer (as with messages);
- every chunk of a `fileId` must carry the same `to` and `chunks`, and the first
  chunk fixes them (a later chunk cannot re-point the file);
- chunk index must be `0 ≤ index < chunks`; re-upload of the same index is
  idempotent and returns the same answer;
- a blocked pair answers `200 { stored: false }`, exactly like a message, so a
  sender cannot distinguish a block from a delivery;
- `413` when a chunk exceeds the route cap, `429` when the daily byte budget is
  spent, `507` when the relay’s own file budget is exhausted — never a silent
  drop.

`chat_messages` is untouched. New tables: `chat_files` (fileId, from, to, chunks,
padded size, created, expires) and `chat_file_chunks` (fileId, index, ct). A file
row is removed when its last chunk is removed, and both are swept by the same
`gc()` that already handles retention.

## 6. Saved Messages: what “forward” means

This is the part the previous change made possible, and it is mostly a **local**
operation. Three paths, one rule.

**6.1 Attach directly in Saved Messages.** There is no second party, so nothing
is uploaded at all. The file is encrypted at rest with the archive key and
written to the local blob store (§7, option A). Zero network bytes, no relay
row, no retention clock.

**6.2 Forward a received file into Saved Messages.** The bytes are already on this
device (they were downloaded to be shown) and the content key is already in the
received manifest. Forwarding:

1. pins the blob locally — one encrypt-at-rest copy keyed by `fileId`;
2. writes one archive row under `peer = own address` whose body is a file card;
3. acknowledges nothing until step 1 is committed (the existing
   archive-before-ack rule; otherwise a 7-day expiry or another device’s ack
   could remove the only copy).

No re-encryption, no second upload, no new manifest for a peer. The original chat
keeps its own card; deleting one card does not delete the other (blob refcount).

**6.3 Forward a file this wallet sent.** The sender cannot decrypt its own sent
ciphertext unless it kept the plaintext, so forwarding a sent file needs a local
copy. Rule: outgoing files are kept in a bounded LRU cache (default 50 MiB) so
“forward to Saved Messages” works right after sending; once the entry is evicted,
the action is disabled and says why (“this file is not on this device any more”).
No attempt is made to reconstruct a file from ciphertext addressed to someone
else — that is impossible by design, and pretending otherwise would be a lie in
the UI.

**6.4 Forward out of Saved Messages to a friend.** Always a real upload: fresh
`fileId`, **fresh content key**, encrypted for that friend. Reusing the original
file and key would let the relay link the two recipients and would let one
recipient decrypt what the other received. The local pinned copy is the source,
so this works even after the original relay copy expired.

**6.5 What stays unchanged.** Saved Messages still has no unread badge and no
read receipt (the previous change). A file card there is marked `own` like any
other line in that room.

## 7. Where the bytes can live

| | A. Local device (recommended for Saved Messages) | B. Existing gateway SQLite (recommended for delivery) | C. Object storage (deferred) | D. Google Drive appdata (backup only) |
| --- | --- | --- | --- | --- |
| Who holds bytes | this browser profile only | this operator's `chat.sqlite` | a bucket | the user's own Drive |
| Encryption | AES-256-GCM under HKDF(seed32) archive key; `fileId`, peer, time in the clear | client-side ciphertext; relay has no key | same as B if the client encrypts first | archive container + second AES-GCM layer |
| Max per file | 25 MiB (self-imposed) | 25 MiB (`chunks × 512 KiB`) | provider limit (5 GiB PUT) | whole container, not per file |
| Quota | browser origin quota; eviction possible | per-sender 50 MiB/day, per-recipient 100 MiB pending, operator disk cap | plan quota + egress cost | the user's Drive quota (15 GB free tier shared) |
| Deletion | delete card ⇒ blob at refcount 0; `clearArchivedWallet`; wipe-on-lock | 7-day retention; sender revoke; whole-file only | signed DELETE or lifecycle rule | user deletes one JSON file |
| Recovery | survives reload/unlock; lost with site data or eviction | only within 7 days, and only if not revoked | same as B plus provider versioning if enabled | the only path that survives losing the device, needs the seed to restore |
| Ops cost | none | one SQLite file, backup is the operator's job | new service, credentials, presign flow | none beyond the existing OAuth grant |
| Leaks to third party | nothing | size bucket, timing, pair | same as B plus provider logs | file size, timing, Google account |
| Used in v1 | yes | yes | no | optional, after v1 |

Rejected: IPFS/public pinning (a public pin is a public file), and “encrypt with
the relay key then store” (that is not E2E any more).

Why not just put Saved Messages files in B as well: the relay is a 7-day post
office, not a drive. A file “saved” there disappears in a week and shows up in
the operator's disk and backup. A room called Saved Messages that quietly empties
itself would be worse than no feature.

## 8. Limits, in one place

| Limit | v1 value | Enforced by |
| --- | --- | --- |
| Chunk plaintext | 512 KiB, padded | client; relay recomputes from `ct` length |
| Upload request body | 768 KiB (base64 of 512 KiB + tag + JSON) | per-route relay cap, not the 64 KiB global default |
| File size | 25 MiB (50 chunks) | client refuses; relay refuses `chunks × 512 KiB` above the cap |
| Files per message | 1 | client |
| Sender upload budget | 50 MiB / wallet / UTC day | relay, separate counter from the 200-message quota |
| Pending files per recipient | 100 MiB or 200 manifests | relay |
| Relay total file bytes | operator setting, plus a free-disk floor | relay (`507`) |
| Retention | 7 days, same sweep | relay `gc()` |
| Local per file | 25 MiB | client |
| Local per wallet | 250 MiB | client, checked against `navigator.storage.estimate()` |
| Outgoing LRU cache | 50 MiB | client |
| Name / MIME | 120 chars / allowlist for inline preview only | client |

The local wallet budget is deliberately larger than the relay’s daily budget: a
Saved Messages file is meant to outlive the relay copy.

If `navigator.storage.estimate()` shows the budget cannot be met, the attachment
is refused **before** the first chunk is uploaded, so a user never ends up with
half a file on the relay and no room for it at home. `navigator.storage.persist()`
is requested before the first file is written, and the result is shown in
Settings; a browser that refuses persistence says “files may be removed by the
browser when the disk is low” rather than pretending.

## 9. Deletion

| Action | Effect |
| --- | --- |
| Recipient deletes the card in a normal chat | local row dropped; relay copy untouched; expiry/revoke still applies |
| Recipient deletes the card in Saved Messages | local blob dropped when its refcount reaches 0 (the original chat's card may still point at it) |
| Sender “delete for everyone” on a file message | existing tombstone hides the card on both sides **and** `files/delete` revokes the chunks, so an undownloaded copy disappears |
| Already downloaded by the peer | **cannot be recalled.** Any design that claims otherwise is wrong; the UI says “deleted for you and removed from the relay”. |
| Wallet lock with wipe-on-lock | archive rows and blobs for that wallet are deleted; other wallets on the same origin are untouched (same rule as text) |
| Relay retention | chunks deleted 7 days after upload, acked or not |
| Block | a later `POST /files` for a blocked pair stores nothing, and already-stored chunks of that pair are deleted with the queued mail, matching the existing block behaviour |

“Delete” is a delete, not a forensic erase: flash storage and copy-on-write
filesystems may keep blocks. Clearing site data is the stronger action, as
already documented for the archive.

## 10. Recovery

- **Reload / restart / lock-unlock**: local blobs are readable again after the
  seed derives the archive key. The manifest inside the message row holds
  everything needed to name and verify the file offline.
- **Device lost**: only the Drive container can help, and only if the user
  enabled “include attachments” (opt-in, cap 50 MiB, one container, manual
  upload). Without it, a Saved Messages attachment is gone — which is the same
  guarantee the text archive has today, and must be said in the UI before the
  first file is saved.
- **Seed lost**: nothing is recoverable, exactly as for messages. The file key
  lives inside a sealed message; the local copy lives under a seed-derived key.
  There is no second recovery path, and adding one would mean storing a key
  somewhere else.
- **Relay copy expired before a device fetched it**: the file is gone for that
  device. This is why 6.2 pins before acking, and why the message card says
  “available on the relay for 7 days” until it is pinned.
- **Corrupt or partial download**: every chunk is AEAD-verified and the whole
  file is checked against `sha256`; a mismatch shows “incomplete — ask the sender
  to resend” and is never written into the archive. Re-`GET` is safe because
  chunks are idempotent and index-addressed.
- **Resume**: an interrupted upload resumes by index; a finished chunk is never
  re-encrypted with a new IV, because the IV is derived from the file salt and
  index.

## 11. Rollout order (when implementation is approved)

1. Decoder + card rendering behind `NEXT_PUBLIC_CHAT_FILES=1`, with no sender
   path. Old clients already show the raw text, so no old build can be broken by
   a new one if this ships first.
2. Local-only path: attach and forward inside Saved Messages. No relay route, so
   it can be reviewed and used without a server change.
3. Relay chunk routes behind `NSAT_CHAT_FILES=1`, installed **before** the web
   build that uploads (same “relay first” rule as per-device delivery). Off means
   the routes do not exist.
4. Rollback: unset the web flag first (cards stop being offered), then the relay
   flag; `chat.sqlite` keeps unclaimed chunks, which the request-driven retention
   sweep (`gc()`) removes once the flag is on again, or an operator deletes the
   two tables. Nothing else references them.

## 12. Tests this design will need (not written yet)

- crypto: chunk IV/AAD binding (a chunk moved to another index, file or length
  fails), padding round-trip, `sha256` mismatch rejected, 50-chunk file
  round-trips, 25 MiB + 1 byte refused;
- relay: oversize chunk `413`, wrong-`to` re-point refused, idempotent re-upload,
  daily byte budget `429`, blocked pair `stored:false`, revoke deletes all
  chunks, retention sweep removes chunks and the file row, `507` on the operator
  cap;
- client: manifest decode of a legacy/unknown version is inert, upload resumes
  after a dropped chunk, delete-for-everyone revokes, download verifies before
  pinning;
- Saved Messages: attach never calls the relay, forward-from-chat pins before
  ack, delete of one card keeps the other's blob, forward-out re-keys and does
  not reuse `fileId`, and the room still produces no unread badge and no receipt
  (regression on the previous change).

## 13. What this design deliberately does not solve

1. **No server-side malware scanning.** A plaintext scanner would require the
   relay to see files, which is the whole thing being avoided. Mitigation is
   render-time: no inline HTML/SVG, PDFs and everything else download as an
   attachment, previews only for a small image allowlist decoded by the browser.
   A recipient-side scanner (on the decrypted bytes, before “open”) is the honest
   place for it, and is not built.
2. **No forwarding secrecy.** Seed compromise reads saved files, as it reads
   messages. Same documented limitation, not a new one.
3. **No multi-device file sync.** Another device fetches from the relay while the
   copy exists, or restores from Drive; blobs are not synced like contacts.
4. **No streaming or range requests** in v1: whole-file download, whole-file card.
   Audio/video playback and thumbnails are later work.
5. **No proof that a peer kept or deleted anything.** “Delete for everyone”
   removes the relay copy and the peer's card, nothing more.

## 14. Open decisions before implementation

1. Daily upload budget: 50 MiB (this document) vs 100 MiB. 50 MiB keeps one
   sender's weekly worst case near 350 MiB on the operator's disk.
2. Whether outgoing files are cached automatically (recommended, 50 MiB LRU) or
   only when the user asks to keep them.
3. Whether the Drive container grows to carry attachments (v3) or attachments
   stay device-only in v1.
4. Image allowlist for inline preview: PNG/JPEG/WebP only, or also GIF (animation
   is an execution surface, decoding is not).
