# P3 — payment requests and verified transaction cards

Status: **deployed to production 2026-11-16** from commit `7d6ad99`
(`satoshicore-webroot-messenger-p3fix-7d6ad99`). The hashing/verification path
has been checked against real Mainnet reads, the deployed gateway and synthetic
wallets. The two-wallet browser acceptance also passed on production: the
recipient saw the exact `9007199254740993` NSAT request, **Review payment**
prefilled the exact destination and amount, and the confirmation button stayed
disabled because neither disposable wallet had funds. No transaction was
broadcast, no real funds were used, and no ledger state changed. Deployment
evidence and rollback are in `RELEASE-READINESS.md`.

## Payment request

`lib/chatPaymentRequest.js` creates one versioned plaintext payload:

```
NSAT-PAY-REQUEST/1\n{"amount":"…","address":"G…"}
```

It is sent through the existing `createChatClient.send()` path, so the relay
receives ciphertext only. The receiving address must match the decrypted
message's authenticated envelope sender; amount is a positive integer string
with no float or exponent parsing and is bounded to `2^127 - 1`, following the
real `NativeAmount128` encoding in `lib/nsatCodec.js` (signed i64 high limb +
unsigned u64 low limb). The request cannot send money. The recipient's **Review
payment** button fills the normal wallet Send form, fixes the destination to the
request address, and routes through its existing explicit review, network
identity and local signing checks.

The imported payment-request code was only in the dirty main worktree; it has
been recreated in this isolated P3 branch, reviewed, hardened to the actual
signed-128-bit codec range, and pinned with a 6-test file. Nothing else from the
worktree was copied.

## Transaction card

A transaction card is a structured, encrypted chat pointer, not a verdict:

```
NSAT-TX/1\n{"hash":"64 lowercase hex","amount":"integer","to":"G…"}
```

The sender address comes from `openMessage()`'s verified Ed25519 envelope; it
is never trusted from JSON. In the thread, cards are rendered only when their
sender equals the authenticated envelope sender and the sender/destination are
the two wallets in the current thread.

`components/ChatTransactionCard.js` begins with **Checking exact transaction…**
then calls `verifyTransactionCard()`; there is no polling loop. It first calls
`getConfirmation(hash, submittedAt)` and respects that exact-hash result:
`pending` is shown as pending; `unknown`/`not_found` remain unknown. The message
time is passed only as `submitted_at`, which the indexer may use to downgrade an
unobserved hash to `not_found` after its window; it can never create a
confirmation. Only a `confirmed`/`failed` verdict proceeds to
`GET /v1/tx/{hash}`, where the detail has to agree. It shows
**Verified · Finalized** only when all these conditions hold:

1. `verifyNetworkIdentity()` returned `ok` and the exact configured network ID;
2. `getConfirmation(hash)` returned this exact hash with `confirmed`;
3. `GET /v1/tx/{hash}` returned the same hash and a structurally valid closed
   ledger record, with the same ledger and result code as the confirmation when
   those fields are present;
4. one operation is a native `payment` with exact sender, destination and
   exact integer amount matching the authenticated card;
5. transaction success agrees with the result code (`true + txSUCCESS`, or
   `false + non-txSUCCESS`).

A hash not yet indexed, malformed/incomplete detail, wrong network, a mismatch,
or an unavailable indexer yields **Unverified · status unknown**. The UI labels
the amount as *claimed* until verification succeeds; self-reported text such as
"confirmed" is never displayed as a verified card. A failed on-chain result is
shown as **Verified · Failed** with its ledger and result code, never as paid.
The card links to the existing `/explorer/?q=<hash>` route and provides a manual
Recheck (one request per tap; no independent polling loop per bubble).

The indexer detail path already verifies the running core identity in the
Gateway before proxying. `getTxDetail()` now uses `cache: 'no-store'` so an
interim 404 cannot be cached as a final verdict.

## Local wallet-send safety carried into this phase

The existing main worktree had a P2 safety patch not present in its committed
HEAD. This P3 branch includes the narrow chat-send guards needed for payment
requests/cards: chat overrides must be a positive integer, self-payment is
refused, and `createOverride: false` prevents a stale CREATE-account checkbox
from changing a regular chat payment into a failing CREATE operation. The send
still goes through the existing fee, network and local signing pipeline; no
signing logic was added to chat or the relay.

## Tests

```
node --test tests/chat-payment-request.test.mjs \
  tests/chat-transaction.test.mjs tests/chat-client.test.mjs
  tests 21  pass 21  fail 0  (exit 0)
```

* payment-request exact integer / sender binding / malformed marker / range
* card payload strictness and authenticated envelope sender
* exact confirmation status + exact indexer hash + native op + amount + addresses → finalized
* exact matching failed result → failed, never finalized
* pending exact-hash verdict → pending without fetching transaction details
* wrong network/hash/party/amount/operation/asset or inconsistent result → unknown
* indexer outage → unknown
* message time reaches the indexer only as a freshness hint; malformed clocks are
  not sent
* two synthetic wallets publish keys, exchange encrypted request and card through
  a local HTTP relay, decrypt at recipient, and compare the authenticated sender

No live gateway, Google account, Firestore, Mainnet signing key or transaction
was used by the unit/integration tests. A separate read-only check does use real
Mainnet data:

```
node scripts/verify-messenger-p3.mjs
  PASS exact network identity
  PASS known Mainnet transfer finalizes from its exact hash
  PASS same hash with a different amount stays unknown

NSAT_GATEWAY_URL=http://127.0.0.1:8798 node scripts/verify-messenger-p3.mjs --require-relay-gates
  PASS network identity
  PASS exact historical transfer → finalized (ledger 301705)
  PASS mismatched amount → unknown (transaction_mismatch)
  PASS P2 block gate served by the shadow gateway
  4/4 passed; no key published, no message stored, no transaction submitted
```

The known transaction is `6de0ea9e…fe4d` (10,000 NSAT, ledger 301705), read from
the production confirmation/detail endpoints through the shadow gateway. The
script is read-only and never imports a funded key.

## Limits

* Cards verify one exact hash on demand; they are not notifications or payment
  requests. The actual recipient address has to match the indexed native payment
  operation.
* The sender's claim is still not proof; a forged but well-formed card remains
  labeled **Unverified** if there is no exact matching ledger transaction.
* No persistence or status reconciliation after closing the chat. The thread is
  still session-only. No scheduler or per-conversation polling was introduced.
* `node --test` validates these units and the local relay path; it is not a
  live-indexer account-isolation test and it does not demonstrate a newly sent
  Mainnet payment.
* The deployed gateway now serves the P2 block route; the public checker passes
  4/4. See `RELEASE-READINESS.md` for the deployed hashes and rollback.
* The browser acceptance used two independent, unfunded, standalone wallets
  (no Google sign-in). It did not exercise a Google-linked account flow.
* The live UI still logs a pre-existing 404 for `/wallet/sw.js`: the service
  worker is served at the site root, while registration resolves it relative to
  `document.baseURI`. This does not affect chat or payments and is tracked
  separately.
