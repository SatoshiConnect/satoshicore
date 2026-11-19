# Saved chat history on this device (opt-in)

Status: implemented. Off by default. The chat itself still keeps the transcript in
the session only; this is an explicit choice a person makes in Settings →
“Chat history on this device”.

## Why it is opt-in

The messenger's original rule is that losing the tab loses the transcript, because
a plaintext conversation left on a shared device is worse than a lost one. That
rule stays the default. Someone who wants history has to turn it on for the device,
and can additionally have it wiped whenever the wallet locks.

## What is stored, and how

```
IndexedDB  scw-chat-archive-v1       (one database, per origin, schema v2)
store      messages
key        `${wallet}|${peer}|${messageId}`
row        { key, owner, peer, id, at, iv, ct }        ← owner/peer/at are clear
store      requests
key        `${wallet}|${requestKey}`
row        { key, owner, peer, requestKey, createdAt, iv, ct }
```

- `ct` / `iv` are AES-256-GCM over `{ own, text }` with a fresh 12-byte IV.
- Additional authenticated data binds the record to its wallet, peer, message id
  and timestamp: `nsc-archive|1|<wallet>|<peer>|<id>|<at>`. A copied row cannot be
  re-opened under another conversation, id or time, and a tampered body fails.
- The key is `HKDF-SHA256(seed32, salt = wallet address, info = "nsc-chat-archive-v1")`
  → AES-256-GCM, non-extractable. It is cached in memory for the session and
  dropped by `forgetArchiveKeys()` on every lock. Nothing is persisted: no extra
  password, no wrapped key, no key export.
- Writes are idempotent by message id, so re-reading the relay or restoring a
  backup cannot duplicate a line.

### Keep (per message)

Automatic history is all-or-nothing per device; **Keep** is the explicit action
on one line. Pressing it writes that line into this archive, copies it into
Saved Messages (a second row under this wallet as the peer, marked `own`), and
only then acknowledges this device's relay copy (`lib/chatKeep.js`). If either
write fails, nothing is acknowledged and the relay copy stays, so the 7-day
retention is still the fallback rather than the loss path.

It works with the automatic toggle **off**: turning history off means “do not
archive everything”, not “never store anything I asked you to keep”. The room
loads its archived rows even when the toggle is off, which is also what makes a
Saved Messages copy visible after a reload. Lines that are neither kept nor
automatically archived show their relay countdown (“expires in 3d”).

Keep is available only while the message still exists on the relay or in the
room: it stores what this device already has, so a message that retention (or
another device's ack) already removed cannot be recovered by pressing it.

### Payment-request ledger

The `requests` store is the local inbox behind **Waiting to pay**. Each row is a
payment request plus its lifecycle status (`pending`, `paid`, `declined`,
`expired`), AES-256-GCM sealed under the same archive key. The amount, requester,
direction and status are encrypted; `owner`, `peer`, `requestKey`, `createdAt`
and a monotonic `revision` are clear so the queue can be loaded without
decrypting and expiry writes can compare-and-set. AAD includes the request key
and creation time, so a row cannot be moved to another wallet, peer or time.
Expiry materialization checks the clear `revision` inside a write transaction; a
concurrent paid/declined update bumps it and wins.

This ledger is written whenever a request is decrypted, even when the transcript
archive toggle is off. It is not the transcript: it exists so reading a request
does not make the obligation disappear. It is not part of the Drive transcript
backup, and deleting saved message history (`clearArchivedWallet`) leaves it
alone. It is still protected by the wallet seed and is dropped from memory when
the wallet locks; pending rows remain encrypted on disk for the next unlock.

Expiry is computed from `createdAt + 7 days`; `readPaymentRequests()` materializes
a pending row as `expired` once that point is reached. A 48-hour warning window
is shown in the queue and in the request bubble. Status changes are local
bookkeeping only — no payment is signed or submitted by the inbox.

## Backup to Google Drive

- Reuses the wallet's existing OAuth grant and `drive.appdata` scope
  (`lib/driveBackup.js`), one file per wallet:
  `nsat-chat-archive.<walletaddress>.json`.
- The file is the raw encrypted rows inside a second AES-GCM envelope, so Drive
  cannot read even the peer list or timestamps. Readable parts: the app marker,
  format version, the wallet address, the creation time and the row count.
- Restore needs the same wallet seed. A file for another address, another seed,
  a newer format version or a foreign file is refused with a specific message,
  never “restored anyway”.
- Backups are manual (a button), because an upload on its own reveals timing to
  Google; there is no background auto-upload.

## Limitations (stated, not hidden)

1. **Seed compromise reads the archive.** The key comes from the seed, so an
   attacker with the seed reads this history (and the relay's 7-day envelopes).
   There is no forward secrecy here, exactly as documented for the chat itself.
2. **Metadata is in the clear on the device.** `owner`, `peer` and `at` are
   readable from IndexedDB without the key; they are what allows the list and
   ordering to work while the wallet is locked. Message text is not.
3. **The origin can read it while the wallet is unlocked.** Any script running on
   this origin (an XSS, a malicious extension, a debugger) can ask the page to
   decrypt. It protects the disk, not a live unlocked session.
4. **Wipe-on-lock is a delete, not a forensic erase.** Flash storage and
   copy-on-write filesystems may keep old blocks until they are overwritten.
   Clearing site data or the browser profile is the stronger action.
5. **Drive backup is not protected from Google's account metadata.** Google sees
   which account uploaded a file, its size and when; it cannot read the contents.
   A hostile Drive account holder can delete or replace the file — the restore
   path refuses anything that does not decrypt with this wallet's key, so a
   replaced file fails instead of installing attacker-chosen history.
6. **No multi-device sync.** The archive is per browser profile. The relay is
   what lets a second device see recent mail; restoring saved history there is a
   manual pull from Drive and needs the wallet seed on that device.
7. **Not covered:** attachments (none exist yet), messages that were never kept
   and are no longer on the relay (older than its 7-day retention, or already
   acknowledged by every registered device), and messages from a blocked sender
   (the relay never stored them). Turning the archive on picks up what the relay
   still holds, up to the mailbox cap — the archive does not backfill from
   another device, and Keep cannot resurrect what is already gone.
8. **Saving here shortens this device's relay copy.** Once a message is in this
   archive, the relay is asked to delete this device's delivery. Another device
   that has registered with the relay keeps its own copy until it reads or
   acknowledges it (or 7-day retention passes), so archiving on the laptop does
   not remove the message the phone has not seen. Reading a message in its room
   follows the same per-device rule even without history.
9. **Payment-request status is not in the Drive backup.** The transcript backup
   copies the `messages` store only. A restore brings back the request message
   text but not its local paid/declined bookkeeping; a fresh device rebuilds a
   pending record when it reads a request that is still on the relay.

## Implementation

- `lib/chatArchive.js` — preferences, key derivation, record crypto, IndexedDB
  operations (`archiveMessages`, `readArchivedThread`, `readArchivedRows`,
  `restoreArchivedRows`, `countArchivedMessages`, `clearArchivedWallet`,
  `clearAllArchives`, `forgetArchiveKeys`).
- `lib/chatPaymentInbox.js` — encrypted request records, expiry/status logic and
  matching a transaction card to a pending obligation; a card settles only after
  `verifyTransactionCard()` returns `finalized`.
- `lib/chatArchiveBackup.js` — the Drive container (`sealArchiveBackup`,
  `openArchiveBackup`, `archiveBackupFileName`).
- `components/ChatArchiveCard.js` — Settings → “Chat history on this device”.
- `components/ChatPanel.js` — loads saved history when a conversation opens and
  saves both directions as they happen; every write is best-effort, so a blocked
  or full store never stops a send.
- `components/WalletPanel.js` — on lock: drop the derived key, and wipe this
  wallet's saved history when that preference is on.
- `lib/driveBackup.js` — `uploadBackup` / `downloadBackup` take an optional
  `fileName`, so the chat archive rides the existing Drive plumbing unchanged.

## Tests

`tests/chat-archive.test.mjs` (7): preferences default off and reset when the
archive is turned off; key derivation is stable per seed+address and different for
another wallet; a sealed line is bound to wallet/peer/id/time and rejects tamper;
the Drive container round-trips, keeps text and peer addresses out of the clear,
and refuses another wallet, a wrong seed, a newer version or a foreign file.
