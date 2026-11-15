# Transfer notices — what the wallet announces, and what it does not

Date: 2026-11-16. Scope: `satoshicore-web` (the PWA wallet on satoshicore.org).
No protocol, ledger or gateway change; nothing is written to any server.

## What exists now

After a payment is included in a closed ledger, the wallet announces it — to the
sender and to the recipient — in two places:

- **A toast** in the wallet: `Received 100 NSAT — from GDAIL…QB55 · ledger 313951`.
- **A "Transfer notices" list** at the top of Activity: newest first, capped at
  20 per session, with direction, exact amount, counterparty and ledger.

Both are built from one source: the indexer's `event: tx` row, which it writes
**only after the ledger result is attached**, and writes for **the source account
and the destination account** (`nsat-indexer/src/db.rs`, `add_account` for
`op.source` and `op.destination`; stream in `src/api.rs`). So:

- a payment the node merely accepted but the ledger rejected is announced as
  *failed* (`Payment failed (tx…) · … · only the fee moved`), never as a payment;
- the recipient is announced when their wallet (or a watch-only linked address)
  is open on a device, not only the sender;
- nothing is announced from a balance change, an account sequence change, or a
  `PENDING` answer from the node.

Exactness: amounts are the ledger's integer strings, grouped for display and
never parsed as floating point (`lib/transferNotice.js`, `tests/transfer-notice.test.mjs`).

## Surviving the lock

The wallet locks the moment the app leaves the foreground — on a phone, every
time the person switches apps — and locking throws away screen state. A notice
that vanished with the lock would never be read by the recipient, so the last 20
notices for an address are kept in `sessionStorage` (one tab, not the whole
browser) and restored when that address is opened again. They are the same
public chain rows Activity shows; no seed, key or password is written, and
signing out clears them. Verified in the browser: 8 notices were restored after
a reload + unlock, with no duplicate toast for the rows already announced.

## Dedupe and "every time"

`EventSource` reconnects and replays from its cursor, so the same row can be
delivered more than once. A notice is announced once per address per row
(key `address:hash`), and rows at or below the newest ledger the wallet already
shows are not announced at all. Verified in the browser: five distinct stub
ledgers produced five notices and five toasts, newest first, no duplicates
(`tmp-tools/stub-indexer-notices.mjs`, dev origin only).

## What this is NOT (blocked, with the reason)

1. **No chat.** There is no message collection, no thread, no recipient inbox.
   `firestore.rules` allows only `websitePreferences/{uid}` and
   `walletLinks/{uid}/addresses/{address}` and denies everything else, so a
   client-side messages collection is rejected by design.
2. **No cross-device delivery.** The notice is built on the device that has the
   wallet/address open. Telling the other party while their wallet is closed
   needs an authenticated backend plus a push service (FCM + Admin SDK or
   equivalent), which this project does not have, and which would also need a
   verified address → account mapping. Only addresses a person linked to their
   own Google account (`walletLinks`) have such a mapping.
3. **No amount is ever published.** Publishing transfer amounts keyed by address
   to a shared collection would leak financial history, so it was not done.

## Evidence

| Check | Result |
|---|---|
| `node --test tests/transfer-notice.test.mjs` | 10/10 pass (stream `amount_stroops` and history `amount`, failed rows, replay gate, dedupe, cap, secret scan of notice text) |
| `NEXT_PUBLIC_API_SAME_ORIGIN=1 npm run build` | exit 0 |
| `npm test` | exit 0, 0 failing |
| Browser (dev origin + local stub indexer, no chain writes) | 5 rows → 5 notices + 5 toasts, one per ledger, newest first; 8 notices restored from `sessionStorage` after reload + unlock with no duplicate toast |
| Lock behaviour | Leaving the foreground clears the on-screen list (screen state dies with the lock) but not the stored notices; the next unlock shows them again |

## Not tested here

- A real Mainnet transfer (the directive forbids sending one for a test), so the
  production path is verified by code + stub, not by a live payment.
- Behaviour with the app closed (impossible by design, see 2).
- Multiple devices signed in to the same Google account (no test account).
