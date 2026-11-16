# P1 — contacts, requests, blocks and consent-first discovery

Status: **implemented, unit-tested and wired into a screen, not deployed.** The
Firestore rules in this branch are not released, so the card will report a rules
refusal on the live site until an owner approval covers the deploy. See "What
this does not do" before reading the module as a finished feature.

This is the first messenger phase that writes to a database. It is deliberately
limited to the social graph: no message, no wallet address and no key is stored
here, and nothing in this phase can start a conversation or move funds.

## Model

| Document | Shape | Written by |
| --- | --- | --- |
| `contacts/{owner}/people/{peer}` | `{ state: "friend", since }` | each side holds its own; only after a request is `accepted` |
| `requests/{to}/inbox/{from}` | `{ state: "pending"\|"accepted"\|"rejected", at }` | created by `from`, answered by `to`, withdrawn by `from` |
| `requests/{from}/outbox/{to}` | same shape | mirror so each side can list its own half |
| `blocks/{owner}/people/{peer}` | `{ at }` | owner only |
| `discoveryEmails/{sha256(email)}` | `{ uid }` | owner only, opt-in |

`lib/contacts.js` builds every write as a **plan** (`planSendRequest`,
`planAcceptRequest`, `planRejectRequest`, `planCancelRequest`,
`planRemoveContact`, `planBlock`, `planUnblock`, `planEmailDiscovery`) and the
store executes the plan's operations. Tests assert the operations, which is what
keeps the rules and the client from drifting apart.

## Why an inbox *and* an outbox

Firestore cannot list another user's subcollection, so a single document inside
the recipient's tree would leave the sender unable to see whether they were
accepted. Two mirrored documents cost one extra write and let both screens read
their own tree with a plain collection list. The accepting plan writes both
states plus both friendship documents in one sequence, so the two halves cannot
disagree for longer than one failed write.

## Consent-first discovery

* The plaintext address is never stored. The key is `sha256(lowercased, trimmed
  email)`, computed on the device with Web Crypto (`emailHashHex`, pinned in the
  tests).
* A lookup that finds nothing answers `NO_CONSENT` whether the address has no
  account or an account that never opted in: one answer for both, so the lookup
  cannot be used to test whether somebody has an account here.
* `list` is denied on the collection, so the set of people who opted in cannot
  be enumerated; a caller must already know one address to ask about it.
* Lookups are braked to one per 1.2 s per store instance. That is a client-side
  delay, not a server control.

## Blocking

`planBlock` writes the block document, drops my copy of the friendship, withdraws
a request I sent, and refuses a request they sent. The rules separately refuse a
new request from a blocked account (`!hasBlocked(owner, from)`), which is the
half a client cannot fake.

A block is **not broadcast**: the other side keeps its own contact document and
is not told. Removing a contact is likewise one-sided. Both are deliberate — and
both mean "they still see you" until the relay learns to drop their mail, which
is P2.

## Rules

`firestore.rules` gains five `match` blocks and four helper functions. Every one
of them keeps the existing discipline: `hasOnly()` shapes, `request.auth.uid`
checks, no `list` on anything discoverable, and the deny-all fallback intact.

Not deployed. The rules were **not** compiled by the Firebase CLI in this phase
(no deploy was authorised), so the first review step before release is a rules
compile/deploy in the console with the owner's approval, followed by the same
verification the profile rules got: create → reload → edit with a real account.

## Tests

```
node --test tests/contacts.test.mjs        # 18 tests, exit 0
npm test                                   # whole suite, includes it
```

Covers: search-field classification, hash folding and pinned vectors, document
shapes and read-back guards, block precedence in the UI state, every plan's exact
operations, every refusal code and its wording, a two-account request/accept/
block lifecycle over a fake Firestore, discovery consent on/off, the throttled
lookup, the SDK/deadline guards, and assertions on the rules text.

## Screen

`components/ContactsCard.js` is a page (`page === 'contacts'`), reached from
**Settings → Contacts → Manage contacts**; the tab bar stays a wallet, and the
app bar's Back returns to the overview. It renders, from the same store:

* one search field — `@profile` (handle → uid + primary address), `G…` (an
  address, shown as a payment destination with no contact actions) and email
  (only when the owner consented);
* requests to answer (accept / refuse), requests waiting for an answer
  (withdraw), contacts (Send NSAT / Remove / Block) and the block list
  (unblock);
* the discovery switch, off by default, with the honest explanation that only a
  hash is stored — and the current state read back from the database rather than
  remembered in the page.

Signed out, the card says contacts need an account and links to Settings; the
wallet keeps working without one. `npm run build` passes with the page in place
(14/14 static pages). The screen has **not** been opened in a browser against a
deployed ruleset: that needs the rules release plus a signed-in account.

## What this does not do

* the chat's "Add friend" (`lib/chatFriends.js`) still writes a device-local
  list. It is deliberately untouched in this phase: a wallet with no Google
  account can start a conversation, and that must keep working. Unifying the two
  (local quick-add vs account contact graph) is a P2 decision, not a silent
  migration — an address and a uid are not the same key.
* no relay enforcement: blocking does not stop ciphertext from arriving until P2
  adds the per-sender quota and read-time drop.
* no profile fields (display name, bio, avatar). The profile is still the two
  fields `PROFILE.md` documents; adding fields is a rules change with its own
  review.
* no group model, no notifications, no push.

## Residual risks (to add to `docs/security/RESIDUAL-RISKS.md` on release)

| Risk | Level | Note |
| --- | --- | --- |
| Email hash is unsalted SHA-256: a caller holding a list of addresses can test membership | MEDIUM | Only for addresses whose owner opted in; exact-address knowledge required; client brake only until a server quota exists |
| Blocking is not broadcast and does not stop relay delivery | MEDIUM | Closed by P2 (quota + read-time drop); until then "block" hides, it does not bar |
| Rules cannot rate-limit request creation | MEDIUM | A signed-in account can send many requests; the block check and the client cap are the only brakes |
| Removing a contact is one-sided | LOW | By design; documented rather than synchronised |
