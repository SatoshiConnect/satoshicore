# CHAT_FEATURE_CHECKLIST

Module B (Real-Time Messaging) and Module C (optional decentralisation)
requirement-by-requirement status at 2026-11-16. Status vocabulary:
**COMPLETE**, **PARTIAL**, **BLOCKED**, **NOT STARTED**.

**Summary: 89 Module B requirements — 34 COMPLETE, 29 PARTIAL, 11 BLOCKED,
18 NOT STARTED. Module C (10 requirements) — 4 constraints honoured, 6 NOT
STARTED. The chat system is not complete and is not comparable to LINE.**

What exists is a working, encrypted **1:1 messenger** with SSE wake-ups plus a
polling fallback, per-device delivery, blocks, quotas, retention, encrypted
outbox/idempotency, read receipts, typing, opt-in presence, edit/reactions,
delete-for-everyone, search, an opt-in encrypted archive, and
chat-while-wallet-locked. Groups, attachments/voice, OS/web push, session
revocation, and moderation do not exist.

---

## B1. Conversations

| ID | Requirement | Status | Implementation | Verification | Limits / remaining work |
|---|---|---|---|---|---|
| B1.1 | One-to-one direct messages | **COMPLETE** | `ChatPanel.js`, `lib/chatClient.js`, `lib/e2eChat.js`, relay `/messages` | `tests/chat-relay.test.mjs`, `tests/e2e-chat.test.mjs` 7/7, `tests/chat-locked-acceptance.test.mjs`; production smoke 2026-11-17 13/13; browser UI send/receive/Read with disposable wallets | SSE wake-ups plus 15 s polling fallback; read receipts exist for text messages; no OS/web push. |
| B1.2 | Group conversations | **NOT STARTED** | None. | No group table, route, or UI. | Entire group model required. |
| B1.3 | Create conversations | **PARTIAL** | A room is implicit: a peer wallet address. Opening the composer calls `readMessages({peer})`. | `tests/chat-client.test.mjs` in the 51/51 group; `tests/chat-room-races.test.mjs` exists but was not re-run. | No persisted conversation entity, title, avatar, or explicit creation step. |
| B1.4 | List conversations by recent activity | **COMPLETE** | Conversation list in `ChatPanel.js`, ordered by last message; unread badges via `lib/chatUnread.js`. | `chat-tab-sync` 6/6 re-run; `tests/chat-unread.test.mjs` exists but was **not re-run** in this audit. UI screenshots exist but were not re-taken. | Ordering is local; a second device re-derives it from its own archive. |
| B1.5 | Join / leave groups | **NOT STARTED** | None. | — | Depends on B1.2. |
| B1.6 | Invite / remove / manage members | **NOT STARTED** | None. | — | Depends on B1.2. |
| B1.7 | Distinct conversation IDs and membership records | **PARTIAL** | Conversation key is the peer address; relay rows are keyed by sender/recipient. Membership is implicit (both addresses). | Schema + `tests/chat-relay.test.mjs`. | No membership table, no multi-party conversation id, no ACL per conversation. |

## B2. Message operations

| ID | Requirement | Status | Implementation | Verification | Limits / remaining work |
|---|---|---|---|---|---|
| B2.1 | Send text messages | **COMPLETE** | `ChatPanel.js` composer → `lib/e2eChat.sealMessage` → `chatClient.sendMessage` → relay store. | `tests/e2e-chat.test.mjs` 7/7 (A→B decrypts only for B, legacy-recipient fallback), `chat-relay` 41/41, `chat-locked-acceptance` 3/3; production smoke and browser UI send/receive 2026-11-17. | Text only; no markup, attachments, or mentions. |
| B2.2 | Receive messages in real time | **COMPLETE** | Signed SSE stream wakes the leader tab; the client then fetches and decrypts. 15 s polling remains the fallback. | `tests/chat-events-http.test.mjs` 2/2 (real gateway, unsigned 401, wallet-signed wake, delegated-v3 handshake); production UI `/chat/events` 200 on 2026-11-17; `chat-tab-sync` 6/6. | No WebSocket or OS/web push; a proxy that blocks streaming falls back to ~15 s latency. |
| B2.3 | Reply to messages | **COMPLETE** | `lib/chatReply.js` versioned payload (target, bounded quote, body); `ChatPanel.js` Reply action, quoted composer bar, reply rendering, and body-aware copy/forward/preview. | `tests/chat-reply.test.mjs` 5/5 (round trip, malformed/invalid, bounds, nested quote, display text); build passes. | The quote is sender-provided context, not a verified copy; the target id is local context. The UI was not exercised in a browser here. |
| B2.4 | Edit own messages | **COMPLETE** | `lib/chatControl.js` sends an encrypted edit control to the peer; `ChatPanel.js` Edit action updates both sides and the local archive. The relay sees only another ciphertext envelope. | `tests/chat-control.test.mjs` 2/2; build passes. | Best-effort control delivery; no edit history. A device that misses the control keeps the old text until it fetches it. UI not exercised in a browser here. |
| B2.5 | Delete messages per authorization/retention | **COMPLETE** | Sender-only `POST /api/v1/chat/messages/delete` removes ciphertext and leaves an id-only tombstone; recipient and sibling devices remove the line/archive copy. Local archive delete remains separate. | `tests/chat-relay.test.mjs` (403 non-owner, tombstone visibility, ciphertext gone); `chat-relay` 41/41; build passes. | Tombstones follow the 7-day retention; a device offline longer cannot learn an old deletion. Local-only delete still exists separately. |
| B2.6 | Forward messages | **COMPLETE** | `lib/chatForward.js` recipient selection; `ChatPanel.js` Forward action and picker; sends the text as a new encrypted message through the existing client, archiving it when history is enabled. | `tests/chat-forward.test.mjs` 3/3 (current room excluded, normalization/dedupe, cap); build passes. | A forward is a new message, not a relay-level attribution or an original-message link. The picker was not exercised in a browser here. |
| B2.7 | Copy messages | **COMPLETE** | `lib/clipboard.js` `copyTextToClipboard`; `ChatPanel.js` per-message Copy for plain text, visible “Copied”/“Copy failed” and a screen-reader status; address copy uses the same helper. | `tests/clipboard.test.mjs` 3/3 (exact text, unavailable, denied); build passes. | Protocol cards are excluded on purpose. The button was not exercised in a browser here; a denied/insecure-origin clipboard is reported as failure, not success. |
| B2.8 | Emoji reactions | **COMPLETE** | Encrypted reaction controls (`👍`, `❤️`, `😂`) add/remove one reaction per message; both sides update the bubble and archive. | `tests/chat-control.test.mjs` 2/2 (round-trip, bounds); build passes. | One reaction slot per message (not per reactor); control delivery is best-effort and not a server-side reaction table. UI not exercised in a browser here. |
| B2.9 | Timestamps and stable message IDs | **COMPLETE** | Relay autoincrement `chat_messages.id`; envelope `id` and `ts`; rendered local time. | `tests/chat-relay.test.mjs` (ordering, ids), `chat-client`. | Relay id is server-local and monotonic only per database; envelope `id` is client-generated. |
| B2.10 | Message ordering rules | **COMPLETE** | Relay orders by `id ASC`; client merges by relay id and cursor. | `chat-relay` 41/41; `tests/chat-room-races.test.mjs` exists but was not re-run. | Clock skew is not used for ordering (good); multi-conversation merge is by arrival. |
| B2.11 | Prevent unauthorized edit/delete | **COMPLETE** | Delete endpoint checks the original sender (403 otherwise). A recipient ignores an edit control unless the target message's author is the control sender. | `tests/chat-relay.test.mjs` (delete 403 non-owner); `tests/chat-control.test.mjs`; build passes. | Edit authorization is enforced after decryption (the relay cannot see the target); a modified client can change only its own view, not the peer's copy. |

## B3. Delivery and read states

| ID | Requirement | Status | Implementation | Verification | Limits / remaining work |
|---|---|---|---|---|---|
| B3.1 | Pending / Sending | **PARTIAL** | NSAT payment card has `phase: 'sending'`; a text send prepares ciphertext, queues it in the encrypted outbox, and shows a “Queued — retrying” bubble until the relay accepts it. | `tests/chat-outbox.test.mjs` 6/6; build passes. | The queue is outbox-level, not a full per-message state machine; UI was not exercised in a browser. |
| B3.2 | Server Accepted | **COMPLETE** | Relay returns `{ok:true}` only after SQLite insert + device delivery rows. | `tests/chat-relay.test.mjs`, `chat-relay-archive` 41/41. | Accepted ≠ delivered to a person. |
| B3.3 | Delivered (documented definition) | **PARTIAL** | Definition: stored in the relay and copied to every registered recipient device (`chat_deliveries`). | `tests/chat-relay.test.mjs` device/ack cases. | The sender is never told; UI shows one check at most. No delivery receipt event. |
| B3.4 | Read according to privacy settings | **PARTIAL** | Local read marks drive unread; `POST/GET /api/v1/chat/read` transmits the highest displayed id and the sender shows Sent/Read. | `tests/chat-relay.test.mjs` (forward-only, sender-only); production smoke read receipt `lastId` matched 2026-11-17; `chat-unread` exists but was not re-run. | No per-contact opt-out: a user cannot disable read receipts, so the privacy half of the requirement is missing (A6). |
| B3.5 | Failed | **PARTIAL** | Retryable send failures leave a queued ciphertext row and a visible “Message saved on this device” notice; permanent 4xx failures restore the draft and remove the queue row. | `tests/chat-outbox.test.mjs` 6/6; `tests/chat-client.test.mjs` error paths. | No per-item failure list or manual discard; UI not exercised in a browser. |
| B3.6 | Retry after failure | **PARTIAL** | `lib/chatOutbox.js` stores ciphertext; `ChatPanel.js` retries on mount, every 15 s, on `online`, and via “Retry now”. | `tests/chat-outbox.test.mjs` 6/6 (dedupe, cap, failure metadata); build passes. | Text sends only; no exponential backoff; payments/forwards still use the direct send path. |
| B3.7 | Deduplication and idempotency | **PARTIAL** | Client de-dupes arriving relay ids; ack is idempotent; every new send carries a random `clientId`; the relay has a unique `(sender, client_id)` index and returns the original id on retry. | `tests/chat-relay.test.mjs` 11/11 (retry returns one row; changed bytes cannot create a second); outbox 6/6. | Older clients that omit `clientId` are not deduplicated. |
| B3.8 | Avoid false Delivered/Read | **COMPLETE** | UI never claims delivered/read without a local fact; the sender gets no receipt. | `ChatPanel.js` inspection; `docs/E2E-CHAT-DESIGN.md` states this. | — |

## B4. Attachments

**Not started; blocked on storage infrastructure.** There is no upload endpoint,
bucket, signed URL issuer, transcoder, or scanner anywhere in the repo.

| ID | Requirement | Status | Notes |
|---|---|---|---|
| B4.1 | Image uploads | **BLOCKED** | Needs object storage + upload API + access control. |
| B4.2 | Video uploads | **BLOCKED** | Same, plus transcoding/size policy. |
| B4.3 | Document attachments | **BLOCKED** | Same, plus safe preview policy. |
| B4.4 | Audio attachments | **BLOCKED** | Same. |
| B4.5 | Voice recording and playback | **BLOCKED** | Needs MediaRecorder UI, storage, and playback controls. |
| B4.6 | File previews | **BLOCKED** | Depends on B4.1–B4.4. |
| B4.7 | Progress indicators | **BLOCKED** | Depends on an upload pipeline. |
| B4.8 | Upload cancellation and retry | **BLOCKED** | Depends on an upload pipeline. |
| B4.9 | File size and type restrictions | **BLOCKED** | Must be enforced server-side; no server. |
| B4.10 | Secure storage and access controls | **BLOCKED** | Needs per-conversation authorization and short-lived URLs. |
| B4.11 | Malware scanning or equivalent | **BLOCKED** | No scanner; must be added before any file is served. |

A 12th constraint applies to all of B4: attachments must not bypass E2EE without
a documented decision. Current E2EE covers text envelopes only.

## B5. Messaging UX

| ID | Requirement | Status | Implementation | Verification | Limits / remaining work |
|---|---|---|---|---|---|
| B5.1 | Typing indicators | **COMPLETE** | `POST /api/v1/chat/typing` emits an ephemeral SSE frame with a 5 s expiry and a 2 s cooldown; the room shows “is typing…”. | `tests/chat-relay.test.mjs` (addressed, cooldown, stop frame); build passes. | Best-effort only; a lost frame expires. No privacy opt-out yet. |
| B5.2 | Unread message counts | **COMPLETE** | `lib/chatUnread.js` per owner+device, localStorage + `storage` events, leader-tab polling. | `chat-tab-sync` 6/6 re-run; `tests/chat-unread.test.mjs` exists but was not re-run in this audit. | Counts are per device; a second device has its own counts by design. |
| B5.3 | Conversation search | **COMPLETE** | `lib/chatSearch.js` local matcher; `ChatPanel.js` search field over the existing chat list, matching display name, @handle or wallet address while preserving pinned order. | `tests/chat-search.test.mjs` 4/4 (case-insensitive name/handle/address, empty query, order); build passes. | Local list only (no server-side/archive-wide search). The field was not exercised in a browser here. |
| B5.4 | Message search with access restrictions | **NOT STARTED** | None. | — | Must be local/encrypted only unless server-side E2EE search is designed. |
| B5.5 | Load older messages with pagination | **PARTIAL** | Relay `since` + `limit` (≤200); archive stores rows for later rendering. | `tests/chat-relay.test.mjs` pagination cases. | No explicit "load older" control; relay only holds 7 days, so "older" beyond that exists only in the local archive. |
| B5.6 | Pin conversations | **COMPLETE** | `lib/chatPins.js` per-wallet localStorage list (uppercase, deduplicated, capped at 100); `ChatPanel.js` Pin/Unpin control with `aria-pressed` and pinned-first ordering. | `tests/chat-pins.test.mjs` 5/5 (toggle, per-wallet isolation, normalization, cap, corrupt/blocked storage); build passes. | Local to this browser only; not synced across devices. The control was not exercised in a browser here. |
| B5.7 | Pin messages with permissions | **NOT STARTED** | None. | — | Needs message model + group roles. |
| B5.8 | Mute conversations | **COMPLETE** | `lib/chatMute.js` per-wallet mute list; `ChatPanel` hides badges/previews for muted peers and offers Mute/Unmute in details. | `tests/chat-mute.test.mjs` (per-wallet, toggle, invalid peer); build passes. | Local to this browser; it does not tell the relay or suppress OS push (there is no OS push yet). |
| B5.9 | Archive conversations | **COMPLETE** | Opt-in encrypted IndexedDB archive (`lib/chatArchive.js`), `ChatArchiveCard.js`, migration from wallet-seed to chat-seed, encrypted Drive backup. | `chat-archive-migration` and `chat-identity-backup` passed in the 51/51 group; `tests/chat-archive.test.mjs` exists but was **not re-run** in this audit. | Opt-in only; with it off, messages are not retained locally. Drive backup/restore has unit tests but no live Drive round-trip here. |
| B5.10 | Message notifications | **PARTIAL** | In-app unread badges plus opt-in browser notification while the tab is open; mute suppresses both. | `tests/chat-notify.test.mjs` 2/2 (preference/default/no-support); build passes. | No service-worker/OS push when the browser is closed; notifications are generic and contain no message text. |
| B5.11 | Responsive mobile and desktop | **PARTIAL** | Mobile-first 430 px shell; desktop layout uses the same shell. | CSS inspection; screenshots exist from earlier work but were not re-verified. | No systematic viewport testing in this audit. |
| B5.12 | Keyboard accessibility / screen readers | **PARTIAL** | Semantic buttons/inputs and visible focus styles; no formal audit. | Not audited. | Needs keyboard-only and screen-reader pass; report as unverified, not done. |
| B5.13 | Localized date and time | **PARTIAL** | `toLocaleTimeString` for message times. | Code inspection. | Only time-of-day; no date separators, locale selection, or relative dates. |

## B6. Groups and permissions

Groups do not exist. All ten requirements are **NOT STARTED**; there is no
group table, membership record, role enum, or group route.

| ID | Requirement | Status |
|---|---|---|
| B6.1 | Group Owner role | **NOT STARTED** |
| B6.2 | Group Administrator role | **NOT STARTED** |
| B6.3 | Group Moderator role | **NOT STARTED** |
| B6.4 | Member role | **NOT STARTED** |
| B6.5 | Member invitation permissions | **NOT STARTED** |
| B6.6 | Membership removal | **NOT STARTED** |
| B6.7 | Group details, name, avatar, description | **NOT STARTED** |
| B6.8 | Group announcements | **NOT STARTED** |
| B6.9 | Group-level notification controls | **NOT STARTED** |
| B6.10 | Permission enforcement on every protected operation | **NOT STARTED** |

## B7. Offline and multi-device

| ID | Requirement | Status | Implementation | Verification | Limits / remaining work |
|---|---|---|---|---|---|
| B7.1 | Reconnect automatically | **COMPLETE** | Authenticated SSE reconnects after a 3 s delay, including clean closes; 15 s polling remains the fallback and resumes on visibility/focus. | `tests/chat-events-http.test.mjs` (real gateway handshake + wake-up); `ChatPanel.js` timers; build passes. | Fixed 3 s delay rather than exponential backoff; no explicit online/offline event handling. |
| B7.2 | Retrieve missed messages | **COMPLETE** | `since` cursor per owner+device; a device that registers late is backfilled from undelivered rows. | `tests/chat-relay.test.mjs` (backfill, device isolation). | Missed = still in relay (≤7 days); older messages are gone unless archived. |
| B7.3 | Queue outgoing messages securely | **PARTIAL** | `lib/chatOutbox.js` stores only the prepared ciphertext envelope, scoped per wallet, capped at 50; plaintext is never written. | `tests/chat-outbox.test.mjs` 6/6 (ciphertext, scope, cap, corrupt rows). | Text sends only; queued messages cannot be rendered after reload because their body is not stored; no OS-level background worker. |
| B7.4 | Retry without duplicates | **COMPLETE** | Outbox retries reuse `clientId`; relay’s unique index returns the original row rather than storing a duplicate. | `tests/chat-relay.test.mjs` 13/13; outbox 6/6. | Retry cadence is fixed at 15 s; that is a scheduling limit, not a duplicate-delivery gap. |
| B7.5 | Synchronize conversation history | **PARTIAL** | Per-device cursor; archive restore from Drive; relay copies to every device. | `tests/chat-identity-backup.test.mjs`, `chat-relay` device tests. | No cross-device merge of locally archived history; read receipts synchronise but the local unread badge is still per device. |
| B7.6 | Synchronize read states | **COMPLETE** | `chat_reads` stores the highest displayed id per reader/sender; `POST/GET /api/v1/chat/read`; own bubbles show Sent/Read. | `tests/chat-relay.test.mjs` (forward-only, sender-only visibility); build passes. | No per-contact opt-out or privacy setting yet; receipts are visible to the peer by design. |
| B7.7 | Concurrent connections on multiple devices | **COMPLETE** | `chat_devices` + `chat_deliveries`; acks are device-scoped; tab leader election. | `tests/chat-relay.test.mjs`, `chat-tab-sync` 6/6, `chat-locked-acceptance` 3/3. | No session list/revocation (A7). |
| B7.8 | No loss of acknowledged messages on reconnect | **PARTIAL** | Relay persists with SQLite/WAL before responding; deletes only after every device acks or after 7 days. | `tests/chat-relay.test.mjs`, `chat-relay-archive.test.mjs`. | A full process-kill/restart durability test was not run; SQLite durability is assumed, not measured. |
| B7.9 | Defined behaviour when device/server unavailable | **COMPLETE** | `lib/chatRelayStatus.js` classifies offline/server failures; retryable text sends leave an encrypted outbox row with a queued notice, permanent failures restore the draft, and last loaded messages/counts stay visible. | `tests/chat-relay-status.test.mjs` 4/4; outbox 6/6; build passes. | The older “nothing was queued” wording remains correct for non-text actions; the outbox has no background worker. UI not exercised in a browser. |

## B8. Security and abuse prevention

| ID | Requirement | Status | Implementation | Verification | Limits / remaining work |
|---|---|---|---|---|---|
| B8.1 | Authenticate every connection | **COMPLETE** | Ed25519 signature over canonical request line; ±120 s freshness; nonce replay guard persisted in `chat_nonces`. | `tests/chat-relay.test.mjs` (401/409 cases, including replay after a relay restart), `chat-relay-gates`; 41/41. | No TLS client cert; auth is per request, not per connection. |
| B8.2 | Authorize access to conversations and attachments | **PARTIAL** | Reads scoped to recipient + device; sender must equal signer; blocks enforced. | `tests/chat-relay.test.mjs` cross-wallet/multi-device cases. | There is no conversation ACL beyond the address pair; attachments do not exist. |
| B8.3 | Encrypt data in transit | **COMPLETE** | Production HTTPS via Caddy; same-origin `/api`; no plaintext HTTP in production. | Operational (production release records); local tests use loopback HTTP. | Not re-verified with TLS tooling in this audit. |
| B8.4 | Use vetted E2EE libraries | **COMPLETE** | `tweetnacl` box (X25519 + XSalsa20-Poly1305) and `sign` (Ed25519); no custom crypto. | `tests/e2e-chat.test.mjs` (relay learns nothing, cannot redirect), 41/41. | No formal cryptographic review; no Double Ratchet / forward secrecy. |
| B8.5 | Device verification and key recovery | **PARTIAL** | Encrypted chat-identity backup to Google Drive app data folder; restore requires wallet seed. | `tests/chat-identity-backup.test.mjs` (wrong key rejected, tamper rejected). | No device fingerprint/verification, no key-transparency, no revocation. Live Drive round-trip not run here. |
| B8.6 | Block and report users | **PARTIAL** | Block in Firestore + relay (drops queued and future mail). Report: none. | `tests/contacts.test.mjs`, `chat-relay-gates` block tests. | No report model, endpoint, UI, or moderator queue (A8.5). |
| B8.7 | Rate limits: messages, invitations, attachments | **PARTIAL** | 200 stored messages/sender/day; 5,000 mailbox cap; 8 KiB envelope; 10 devices; 500 blocks; gateway IP limit. | `tests/chat-relay-gates.test.mjs` 41/41. | Invitations and attachments do not exist, so they are unrated and unimplemented. |
| B8.8 | Prevent cross-conversation data access | **COMPLETE** | Recipient + device scoping on read and ack; sender match on write; key fetch is public by design. | `tests/chat-relay.test.mjs` (other wallet sees nothing). | Relay still sees metadata (sender, recipient, size, time) — documented. |
| B8.9 | Injection, XSS, CSRF, unsafe files | **PARTIAL** | React escapes message text; no `dangerouslySetInnerHTML` for chat; no file handling; chat API has no cookies (CSRF N/A); envelope JSON parsed, size-bounded. | Code inspection; `tests/chat-relay.test.mjs` malformed input. | No automated XSS/injection test suite; payment card parser is strict but message rendering has no dedicated security tests. |
| B8.10 | Retention and deletion policies | **PARTIAL** | 7-day relay retention, ack-based deletion, block clears queued mail, device trimming. | `tests/chat-relay.test.mjs` GC/ack/block cases. | No account-level deletion (A9.3); no user-visible retention control; local archive is user-controlled. |
| B8.11 | Do not log private messages, passwords, secrets | **PARTIAL** | Relay logs only error messages (`chat_relay_failed` with `error.message`); no envelope body logged. Client logs were not centrally audited. | Code inspection of `server.js` chat handler. | No automated log-scrubbing test; a thrown parser error could include input in a future change. |

## B9. Reliability

| ID | Requirement | Status | Implementation | Verification | Limits / remaining work |
|---|---|---|---|---|---|
| B9.1 | Persistent message storage | **COMPLETE** | SQLite `chat_messages`, WAL. | `tests/chat-relay.test.mjs` write/read; `chat-relay-archive`. | See B7.8 for restart durability caveat. |
| B9.2 | Database indexes for common queries | **COMPLETE** | `chat_messages_inbox`, `_peer`, `_gc`, `chat_devices_seen/_gc`, `chat_deliveries_device`, `chat_quota_gc`. | DDL inspection; query plans not measured. | No `EXPLAIN QUERY PLAN` evidence; index choices are reasoned, not profiled. |
| B9.3 | Message pagination | **COMPLETE** | `since` + `limit` (1–200), `peer` filter. | `tests/chat-relay.test.mjs`. | Cursor is relay id; no time-based pagination. |
| B9.4 | Connection health monitoring | **PARTIAL** | Gateway `GET /health` (service + core configured); client handles poll errors and keeps last counts. | `/health` route inspection. | No relay-specific health (DB writable, queue depth); no client connectivity indicator. |
| B9.5 | Structured error logging without sensitive content | **PARTIAL** | Gateway uses a `log(level, event, fields)` helper. | Code inspection. | No retention, rotation, or alerting documented; no test asserting no-sensitive-fields. |
| B9.6 | Backup and tested restore | **PARTIAL** | Pre-deploy SQLite copy + `integrity_check`; Firestore ruleset version history. | Backup record in `docs/messenger/RELEASE-READINESS.md`. | No restore drill; no automated backup schedule in the repo. |
| B9.7 | Graceful handling of service restarts | **PARTIAL** | WAL, idempotent `CREATE TABLE IF NOT EXISTS`, lazy module import, no in-memory-only message state. | Design inspection; tests open/close relay instances. | No supervised restart/failover test; in-flight requests are dropped on restart. |
| B9.8 | Monitoring for delivery failures | **NOT STARTED** | None. | — | Needs metrics/alerting; no metrics endpoint for the relay. |
| B9.9 | Clear operational health checks | **PARTIAL** | `GET /health`, `GET /api/v1/network/status`. | Route inspection; production checks in release docs. | Chat relay health is not separately reported. |

---

## Module C — Optional decentralisation

**The application is not federated.** No homeserver, no Matrix, no federation
protocol, no cross-server identity. The messaging relay is a single operator-run
service. Nothing in the UI claims otherwise.

| ID | Requirement | Status | Note |
|---|---|---|---|
| C1 | Identities on independently operated homeservers | **NOT STARTED** | No homeserver concept. |
| C2 | Cross-homeserver communication | **NOT STARTED** | — |
| C3 | Federation authentication/authorization | **NOT STARTED** | — |
| C4 | Authorized room event synchronisation | **NOT STARTED** | — |
| C5 | Remote server outage / delayed sync handling | **NOT STARTED** | — |
| C6 | Compatible E2EE and key management across servers | **NOT STARTED** | Current E2EE is single-relay only. |
| C7 | Do not invent a new messaging encryption protocol | **COMPLETE (constraint honoured)** | Uses `tweetnacl` primitives; no bespoke cipher. |
| C8 | Document dependencies on identity/push/federation infrastructure | **COMPLETE (constraint honoured)** | `SYSTEM_ARCHITECTURE.md` lists Firebase, gateway, and the absence of push/federation. |
| C9 | Do not call one host "fully fault-tolerant decentralisation" | **COMPLETE (constraint honoured)** | No such claim exists. |
| C10 | Do not claim account portability | **COMPLETE (constraint honoured)** | No portability is claimed; chat identity is per wallet and not portable between providers. |

If federation is later required, the correct move is to integrate Matrix
(homeserver + client SDK) rather than extend this relay. That is a new project
with new infrastructure, not a refactor.

---

## What a user can actually do today (chat)

1. Open a wallet (locked or unlocked) and get a chat identity on first use.
2. Find a peer by wallet address or `@handle`.
3. Send encrypted text; the relay stores only ciphertext.
4. Receive on another device that has registered for the same wallet, without
   one device's read erasing the other's copy.
5. Block a peer; queued and future mail from that peer is dropped.
6. Opt in to an encrypted local archive, back it up (and the chat identity) to
   Drive, and restore it with the wallet seed.
7. Exchange payment requests and verified transaction cards inside a chat.

Missing for a LINE-class product: groups, attachments/voice, OS/web push,
multi-device session management/revocation, moderation, and account lifecycle.
