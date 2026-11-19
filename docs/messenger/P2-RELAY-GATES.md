# P2 — relay gates: per-sender quota and recipient blocks

Status: **implemented and tested, not deployed.** The relay code is in this
branch; the running gateway still serves the previous `chat-relay.mjs` until an
owner-approved deploy copies it into `~/nsat-ops` and restarts the launchd job.

## Why this phase exists

The P0 audit found that the relay authenticated a wallet but did not decide
whether that wallet may speak to you: any address could post to any address, and
the account-level block from P1 never reached the relay, so blocked mail still
arrived and sat in the mailbox. Two gates close most of that gap without adding
a service, a credential or a second database.

## What was added

| Gate | Rule | Where |
| --- | --- | --- |
| Daily quota | 200 stored messages per sender per UTC day | `chat_quota`, checked before insert |
| Block list | ≤ 500 addresses per owner, both directions | `chat_blocks`, `GET/POST /api/v1/chat/blocks` |
| Block clears queued mail | the sender's pending rows for that owner are deleted | `POST /blocks` with `action:"add"` |

Both are server-side because the client is not a control: a modified page could
skip its own check, but it cannot skip the relay's.

## The privacy trade-off, stated plainly

A blocked message is **accepted and dropped**, not refused:

```
POST /api/v1/chat/messages  →  200 { ok: true, stored: false }
```

The sender sees the same answer a delivery produces, so the relay never becomes
the place where somebody learns they were blocked. The cost is that a block is
not a message to the other person — it is a storage rule — and a determined
sender can still tell nothing from the response. Quota is not consumed by a
dropped message, so blocking cannot be used to exhaust somebody's daily
allowance.

## Client side

* `lib/chatClient.js` gains `blocks()`, `block()` and `unblock()`; both mutators
  validate the address shape locally so an obvious typo fails before a request.
* `components/ChatPanel.js` reads the block list when a thread opens (not from
  component state), shows **Block this address** / **Unblock this address**, and
  disables the composer while blocked with an explanation. An unreadable block
  list is reported, never rendered as "not blocked".

## Tests

```
node --test tests/chat-relay-gates.test.mjs     # 4 tests, exit 0
node --test tests/chat-relay.test.mjs tests/chat-client.test.mjs tests/e2e-chat.test.mjs
                                                # 16 tests, exit 0
```

The new file drives the relay directly and asserts stored rows, not client
beliefs: quota refusal at the ceiling and reset on the next UTC day; a quota that
is per sender, not global; block clearing queued mail; silent drop in both
directions; block list scoping (another wallet sees an empty list); unblock
restoring delivery; a dropped message costing no quota; and the unsigned /
forged / invalid-address / self-block / full-list refusals.

One bug was found by writing the tests: re-blocking an address while the list was
at its ceiling answered `429 list is full` instead of being an idempotent no-op.
That is fixed, and the test pins it.

## What this still does not do

* **A stranger can still open a thread.** Quota bounds the volume, not the
  permission: an unknown wallet can send up to its daily allowance until you
  block it. The account-level contact graph (P1) is not consulted by the relay —
  it has no way to read Firestore without a new credential, which is the decision
  `ARCHITECTURE.md` §5 leaves to the owner.
* **The two block lists are separate.** A block made in Contacts (Firestore) and
  a block made in the chat (relay) are different records. Unifying them means the
  client publishes the account block list to the relay on change; until then the
  chat's own button is the one that stops mail.
* **No history, unread state or groups** — unchanged from P1.
* **Not deployed**, so the live gateway still behaves as it did before this
  branch.

## Deploy gate (needs owner approval)

1. copy `services/api-gateway/chat-relay.mjs` from this branch with
   `install -m 0644` (never edit the live copy in place);
2. restart `org.satoshicore.gateway` through launchd;
3. check `GET /api/v1/chat/blocks` unsigned → `401`, then one wallet's own list →
   `200 {blocked:[]}`, and that an existing conversation still round-trips;
4. keep the current file as the rollback (the new tables are additive, so a
   rollback needs no data change).
