# SECURITY_REVIEW

Scope: the optional Google account layer, the Firestore contact graph, the
encrypted 1:1 chat (client + relay), and the trust boundaries between them.
Reviewed against the source at 2026-11-16 (branch `feat/chat-first-wallet-ux`,
worktree). **This is a source review plus unit-test evidence, not a penetration
test, not a cryptographic audit, and not a compliance certification.**

No production system, credential, or data was touched during this review.

---

## 1. Threat model (abridged)

| Adversary | Capability assumed | Primary assets at risk |
|---|---|---|
| Network attacker | Read/modify traffic on the path | Session tokens, message content, metadata |
| Malicious relay operator | Full control of the gateway host and SQLite file | Message content, social graph metadata |
| Malicious signed-in user | Valid Google account, modified client, direct Firestore/relay calls | Other users' profiles, contact graph, discovery oracle |
| XSS / malicious script on the origin | Execute JS in the wallet origin | Wallet session, chat seed in `localStorage`, archive |
| Stolen device / browser profile | Read local storage and IndexedDB | Chat identity, archive, cached session |
| Spammer / abuser | Many wallets/accounts, scripted writes | Recipients' mailboxes, discovery endpoint |
| Compromised dependency | Code execution in the bundle or gateway | Everything the process can reach |

Out of scope: chain-level compromise, Google/Firebase infrastructure compromise,
host root compromise, legal compulsion, side channels.

---

## 2. Controls that exist and are verified

| # | Control | Location | Evidence |
|---|---|---|---|
| C1 | Deny-by-default Firestore rules; unknown paths denied | `firestore.rules` final `match /{document=**} { allow read, write: if false }` | Rules text asserted in `tests/profile.test.mjs` |
| C2 | Ownership enforcement on every user document | Rules use `request.auth.uid == uid/owner/from` | `tests/profile.test.mjs`, `tests/contacts.test.mjs` |
| C3 | Field allowlists (`hasOnly`) — no hidden fields | `profiles`, `requests`, `contacts`, `blocks`, `discoveryEmails` | Rules assertions |
| C4 | Verified-email requirement for writes that create identity | `verifiedEmail()` (`email_verified` token claim) | Rules assertions |
| C5 | Handle uniqueness via create-only claim document | `profileIds/{profileId}` | `tests/profile.test.mjs` (collision, rename rollback) |
| C6 | `list` denied on handles and discovery → no bulk enumeration | `profileIds`, `discoveryEmails` rules | Rules assertions |
| C7 | Friend-request state machine enforced server-side | `requests/*`, `contacts/*` rules | 42/42 profile+contacts+auth run |
| C8 | Block refuses new requests and drops queued mail | Rules `hasBlocked`; relay block handler | `tests/contacts.test.mjs`, `tests/chat-relay-gates.test.mjs` |
| C9 | Ed25519 signature on every relay request | `chat-relay.mjs` `verifyChatSignedRequest`/`verifySignedRequest` | `tests/chat-relay.test.mjs` (41/41 with E2E) |
| C10 | Freshness window (±120 s) and nonce replay rejection | relay | `tests/chat-relay.test.mjs` (409 replay) |
| C11 | Device id bound into the signed request line (v2/v3) | `chatRequestString`, `chatIdentityRequestString` | `chat-client` / relay tests assert identical strings |
| C12 | Sender must equal signer; cannot post as another wallet | relay `POST /messages` | Relay tests (403) |
| C13 | Reads/acks scoped to recipient **and** device | relay SQL | Relay tests: another wallet/device sees nothing; ack isolation |
| C14 | E2EE with vetted primitives (X25519 + XSalsa20-Poly1305, Ed25519) | `lib/e2eChat.js`, `tweetnacl` | `tests/e2e-chat.test.mjs` (relay cannot read or redirect) |
| C15 | Key-bundle signature verified against the wallet address / delegated chat key | `verifyPublicKeyBundle` | `tests/e2e-chat.test.mjs`, `chat-identity.test.mjs` |
| C16 | Delegation is a signed, address-scoped statement; relay re-verifies it | `chatDelegationString`, relay v3 verifier | `tests/chat-identity.test.mjs` |
| C17 | Quotas: 200/day/sender, 5,000 mailbox, 8 KiB envelope, 10 devices, 500 blocks, 3 keys | relay constants + handlers | `tests/chat-relay-gates.test.mjs` |
| C18 | Envelope/body size caps before parse/storage | relay + `handleChatRequest` (16 KiB body) | Relay tests (413) |
| C19 | Retention deletes mail and stale devices | relay `runGc` | Relay tests |
| C20 | Gateway security headers: `nosniff`, `DENY`, `no-referrer`, CSP `default-src 'none'; sandbox`, HSTS, `no-store` | `server.js` `securityHeaders()` | Code inspection |
| C21 | CORS allowlist (no `*` unless configured) and header allowlist | `corsHeaders()` | Code inspection |
| C22 | No wildcard proxy; explicit route allowlist | `server.js` `ROUTES` + indexer path regexes | Code inspection |
| C23 | Static artifact secret scan (tokens, private keys, connection strings) | `tests/security-scan.mjs` | Run as part of `npm test`; not separately re-run here |
| C24 | No hardcoded credentials or seeds in source | Repo inspection by the secret scan + grep | Scan rule set; no finding reported in this run |
| C25 | Chat archive encrypted with a chat-seed-derived key; wrong key fails closed | `lib/chatArchive.js`, `chatIdentityBackup.js` | `chat-identity-backup.test.mjs` (wrong key/tamper) |
| C26 | One-time local data migration is copy-first and marker-guarded | `lib/chatMigration.js` | `chat-archive-migration.test.mjs` |
| C27 | No password or wallet seed ever sent to the relay | Envelope/protocol inspection | `tests/e2e-chat.test.mjs` |
| C28 | Relay stores ciphertext only; no decrypt path on the server | `chat-relay.mjs` | Code inspection; E2E test |
| C29 | Site-wide CSP delivered as a `<meta http-equiv>` in the static export | `app/layout.js` `SITE_CSP` | Present in the built `out/index.html` (observed during this audit) |
| C30 | Passwords are never hashed, stored, logged or returned by this project; the provider owns hashing and action codes | `lib/emailAuth.js` | `tests/email-auth.test.mjs` 25/25 (no password in results/error text; reauth before update) |
| C31 | Forgot-password answers identically for unknown and known addresses | `sendPasswordReset` in `lib/emailAuth.js` | 25/25 (neutral message; network failures still surfaced) |
| C36 | An email change needs the current password and cannot lock the owner out | `changeEmail` → reauthenticate → `verifyBeforeUpdateEmail` | 25/25 (order, same/invalid address, duplicate mapping) |
| C32 | Multi-document contact changes commit atomically | `lib/contacts.js` `apply()` uses one `writeBatch` | `tests/contacts.test.mjs` failure-injection test |
| C33 | Replay guard survives a relay restart | `chat_nonces` table in `chat-relay.mjs` | `tests/chat-relay.test.mjs` restart-replay test (409) |
| C34 | Rate-limit memory is bounded under an IP flood, and the client IP is trusted only from the loopback proxy | `RATE_BUCKET_LIMIT` + `clientIp()` in `server.js` | `tests/gateway-hardening.test.mjs` 6/6 (bounded map, X-Forwarded-For from loopback only, remote spoof ignored) |
| C35 | Chat failure logs carry a code, not `error.message` | `handleChatRequest` catch | `tests/gateway-hardening.test.mjs` source assertion |
| C37 | Profile text is typed, bounded and cannot widen the profile document | `isProfileText` in `firestore.rules`; `validateProfileText` in `lib/profile.js` | `tests/profile.test.mjs` 16/16 (50/160/80 bounds, non-string, exact field set) |
| C38 | Account export is user-initiated and carries no secrets | `lib/accountExport.js` allowlists profile/contact fields | `tests/account-export.test.mjs` 4/4 (no email/seed/password/token, invalid profile becomes null) |
| C39 | A remembered sign-in has an absolute lifetime, not only an idle timeout | `startedAt` + `SESSION_ABSOLUTE_LIMIT_MS` in `lib/sessionPolicy.js` | `tests/session-policy.test.mjs` 11/11 (90-day boundary, old-record migration) |
| C40 | Profile reads honour owner/any-signed-in/contacts/private | `visibility` rules on `profiles/{uid}` | `tests/profile.test.mjs` 16/16 (closed set, default, fail-closed unknown); rules source assertions |
| C41 | A shared profile link carries no secret and no live session | `lib/profileShare.js` (`?add=` handle/address only); `ProfileCard.js` local QR | `tests/profile-share.test.mjs` 7/7 (invalid/non-http URLs rejected, no extra fields in share text) |
| C42 | A queued send stores ciphertext, not plaintext, and retries idempotently | `lib/chatOutbox.js`; relay `(sender, client_id)` unique index | `tests/chat-outbox.test.mjs` 6/6 (ciphertext-only, cap, corrupt rows); `tests/chat-relay.test.mjs` retry returns one row |
| C43 | Realtime wake-ups are authenticated and carry no conversation data | `handleChatEvents` in `server.js`; `relay.authenticate()` consumes the nonce | `tests/chat-events-http.test.mjs` (401 unsigned, signed ready, recipient wake); relay replay test |
| C44 | Read receipts are forward-only, ownership-checked and scoped to the two participants | `chat_reads` primary key `(reader, sender)`; `POST/GET /api/v1/chat/read`; POST requires a message from peer to reader | `tests/chat-relay.test.mjs` (sender-only read, backwards mark refused); build passes |
| C45 | Delete-for-everyone is sender-only and does not retain the ciphertext | `POST /api/v1/chat/messages/delete`; `chat_tombstones` stores id/parties/time only | `tests/chat-relay.test.mjs` (403 non-owner, message gone, id-only tombstone visible to both parties) |
| C46 | Edit/reaction controls stay inside E2EE and are hidden from the transcript | `lib/chatControl.js`; encrypted envelope; client applies and acks | `tests/chat-control.test.mjs` 2/2 (round-trip, malformed/oversize fail closed); build passes |
| C47 | Presence is opt-in, ephemeral, and only disclosed to a shared-history peer | `lib/chatPresence.js`; relay in-memory 45 s TTL; `chat_contacts` gate | `tests/chat-presence.test.mjs` 2/2; `tests/chat-relay.test.mjs` (known/stranger/offline) |
| C48 | Mute is local-only and hides badges/previews without leaking a setting | `lib/chatMute.js`; per-wallet localStorage | `tests/chat-mute.test.mjs` (scope, toggle, invalid peer) |
| C49 | Browser notifications are opt-in and contain no message text | `lib/chatNotify.js`; generic title/body | `tests/chat-notify.test.mjs` 2/2 (default off, no-support no-op) |
| C50 | SSE accepts the delegated chat identity without weakening request authentication | `relay.authenticate()` verifies the v3 delegation and signature, consumes the nonce, then registers the device | `tests/chat-events-http.test.mjs` 2/2 (unsigned 401, wallet-signed wake, delegated-v3 ready) |
| C51 | A relay envelope encrypted to a legacy wallet key can still be opened after the sender uses a delegated identity | `openMessage()` tries the chat key, then the wallet seed, after verifying the sender delegation and signature | `tests/e2e-chat.test.mjs` 7/7 (legacy-recipient v2 envelope) |

---

## 3. Authorization matrix

| Resource | Anonymous | Signed-in account (other) | Signed-in owner | Wallet signer | Other wallet | Relay operator |
|---|---|---|---|---|---|---|
| `websitePreferences/{uid}` | deny | deny | read/write own | n/a | n/a | n/a |
| `walletLinks/{uid}` | deny | deny | read/write own | n/a | n/a | n/a |
| `profiles/{uid}` | deny | **get allowed** (handle + primary address) | read/write own | n/a | n/a | n/a |
| `profileIds/{id}` | deny | get allowed, list denied | claim/delete own | n/a | n/a | n/a |
| `contacts/{owner}/*` | deny | deny | read/write own | n/a | n/a | n/a |
| `requests/{owner}/inbox/{from}` | deny | get if sender, list denied | list, answer | n/a | n/a | n/a |
| `blocks/{owner}/*` | deny | deny | read/write own | n/a | n/a | n/a |
| `discoveryEmails/{hash}` | deny | **get allowed**, list denied | write/delete own | n/a | n/a | n/a |
| Chat public key bundle | read (public by design) | read | read | publish | read | read |
| Chat messages (read) | deny | deny | n/a | own mailbox + own device | deny | ciphertext + metadata |
| Chat messages (write) | deny | deny | n/a | own address only | deny | ciphertext |
| Block list (relay) | deny | deny | n/a | owner only | deny | owner only (DB) |
| Local archive | deny | deny | n/a | device with chat seed | deny | no access |

The two `get`-allowed rows are deliberate (public handle lookup, consent-based
email discovery) and are the main enumeration surface; see F3.

---

## 4. Findings

Severity reflects impact × likelihood in the current deployment. Status is one
of: **OPEN**, **MITIGATED**, **ACCEPTED/DOCUMENTED**, **BLOCKED**.

| ID | Severity | Finding | Status | Evidence | Recommendation |
|---|---|---|---|---|---|
| F1 | **HIGH** | The chat seed is stored **unencrypted** in `localStorage` as JSON (`scw-chat-identity-v1:<ADDRESS>` holds the Base64 32-byte seed plus the delegation). Any XSS on the origin, or anyone with the browser profile, can impersonate the wallet in chat, decrypt the relay mailbox, and (because the archive key is HKDF-derived from the same seed) decrypt the local archive. It cannot spend funds. | ACCEPTED/DOCUMENTED | `lib/chatIdentity.js`; `SYSTEM_ARCHITECTURE.md`; noted in prior wallet reviews | Move to a non-extractable `CryptoKey` in IndexedDB where WebCrypto supports the primitive, or wrap the seed with a passkey/password-derived key. Until then, add a strict CSP (F6) and treat origin XSS as critical. |
| F2 | **MEDIUM** | **No forward secrecy.** Static X25519 identity keys encrypt every envelope. Compromise of a chat seed decrypts all ciphertext still held (≤7 days on the relay) and, with the archive, all history. | ACCEPTED/DOCUMENTED | `lib/e2eChat.js` (`nacl.box`) | A Double Ratchet or an audited E2EE library (e.g. libsignal) is required for forward secrecy. Do not hand-roll one. |
| F3 | **MEDIUM** | **Email-discovery oracle.** `discoveryEmails/{sha256(email)}` allows `get` to any signed-in user, and the hash is unsalted. An attacker with a list of candidate emails can compute hashes and test which accounts opted in, despite `list` being denied. The UI returns one `NO_CONSENT` answer for both miss cases, but a modified client bypasses the UI. | OPEN | `firestore.rules` lines for `discoveryEmails`; `lib/contacts.js` `discoverEmail` | Salt the hash with a per-deployment pepper (server-side lookup) or route discovery through a rate-limited backend that returns only a handle, never an existence bit. Document the residual until then. |
| F4 | **MEDIUM** | The 1.2 s discovery throttle is **client-side only**; Firestore has no per-user read quota, so a modified client can hammer the endpoint. | OPEN | `lib/contacts.js` `DISCOVERY_MIN_INTERVAL_MS`, `lastLookupAt` | Backend rate limit or App Check; a client throttle is not a control. |
| F5 | **MEDIUM** | **Contact writes were not atomic.** The store used sequential `setDoc`/`deleteDoc`, so `accept()` could update one side and fail before the other. | **FIXED (source; rules deploy pending)** | `lib/contacts.js` `apply()` now uses a single `writeBatch`; `firestore.rules` `requestIsAccepted()` now uses `existsAfter()`/`getAfter()` so the rule sees the accepted request inside the same batch. `tests/contacts.test.mjs` injects a failed commit (no half-accepted friendship) and asserts the rule uses the post-batch accessors. | Rules were **not** emulator-tested or deployed. A batched write evaluated with the old `get()` would be denied, so deploy the rules before the client that batches. |
| F6 | **MEDIUM** | **The site CSP is weakened by `script-src 'unsafe-inline'`.** A `<meta http-equiv="Content-Security-Policy">` is present in `app/layout.js` and in the built HTML, with `default-src 'self'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'none'`, and explicit frame/connect origins. However `script-src` must allow inline scripts for the Next static export, so an injected inline `<script>` is not blocked, which matters because of F1. `frame-ancestors` is ignored in meta delivery, and HSTS/`X-Frame-Options`/`X-Content-Type-Options` for the static host are not verifiable from this repo (Caddy config is not included). | PARTIAL / OPEN | `app/layout.js` lines 26–78; `out/index.html` CSP meta | Add response headers at the web server: `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, HSTS. Migrate to hash/nonce-based `script-src` when the export permits, so injected inline scripts are blocked. This is the main compensating control for F1. |
| F7 | **LOW–MEDIUM** | **Metadata exposure.** The relay knows sender, recipient, envelope size, arrival time, and device id. Sealed-sender is not implemented. | ACCEPTED/DOCUMENTED | `chat-relay.mjs` header comment; `docs/E2E-CHAT-DESIGN.md` | Documented as a residual; a private-information-retrieval design would be a new project. |
| F8 | **LOW** | **Nonce replay guard was in memory.** After a restart, a captured request could be replayed inside the freshness window. | **FIXED** | `chat_nonces` table (primary key `nonce`, `expires_at`) with GC; `tests/chat-relay.test.mjs` reopens the relay on the same database and a replayed request gets `409`. | Keep one gateway process per SQLite file; a failed request spends its nonce, so clients must retry with a fresh one. |
| F9 | **LOW** | Published key bundles are only **shape-checked** by the relay; signature verification happens in the client. A malicious publisher can store a bad bundle that wastes a recipient's time. | MITIGATED | Relay `POST /keys`; `verifyPublicKeyBundle` | Optional: verify the bundle signature server-side as defense in depth (cheap, no key custody). |
| F10 | **LOW** | **Rate-limit map could grow without bound** under a spoofed-IP flood; only expired buckets were pruned. | **FIXED** | `rateLimited()` now evicts expired buckets first and then oldest entries, hard-capped at `RATE_BUCKET_LIMIT`; `tests/gateway-hardening.test.mjs` floods 10,250 addresses and proves the bound. | Evicted IPs simply start a fresh window. A distributed limiter would still be better at the edge. |
| F11 | **LOW** | **The chat failure path logged `error.message`**, which could eventually carry input fragments. | **FIXED** | The catch logs `{ code }` (`error.code || error.name || 'unknown'`); `tests/gateway-hardening.test.mjs` asserts the source cannot log a `message` field for this event. | Add a correlation id when a log store exists; keep raw provider messages off the disk. |
| F12 | **HIGH (roadmap)** | **No account deletion, export, or retention control.** Users cannot remove their account or data; `profileIds`, both sides of the contact graph, blocks, discovery hash, and Drive files persist indefinitely. | BLOCKED | `MEMBERSHIP_FEATURE_CHECKLIST.md` A9 | Implement with Admin SDK; define the cascade in `DATABASE_SCHEMA.md`. |
| F13 | **MEDIUM (roadmap)** | **No session revocation, device list, MFA, or suspicious-login detection.** A stolen browser session persists until idle expiry. | BLOCKED | A2.7/A2.8/A7/A3.5 | Admin SDK + server session authority. |
| F14 | **HIGH (roadmap)** | **No moderation, reporting, roles, or audit trail.** Abuse can only be blocked locally; there is no operator review path. | NOT STARTED | A8, B8.6 | Needs role claims, report store, append-only audit. |
| F15 | **LOW** | Public key bundle retrieval is unauthenticated by design; an attacker can learn who has published a key (wallet addresses are public). | ACCEPTED | Relay `GET /keys` | Accept; address is already public on-chain. |
| F16 | **MEDIUM (unverified)** | The 12-character password policy, “not the email name” rule and breach hook run **client-side**. A modified client can bypass them and call the provider directly; only the provider's own password policy is a real control. No breach API is configured. | OPEN | `lib/emailAuth.js` `validatePassword`; tests inject `breachCheck` | Enable the provider's password policy and a server-side breach check (or an Identity Platform blocking function) before describing passwords as “strong”. |
| F17 | **MEDIUM (unverified)** | No email/password brute-force or credential-stuffing control exists in this app. Firebase may throttle per project/IP, but that has not been observed or tested. | BLOCKED | No login rate limit in the client (correctly) and no server | Verify provider throttling; consider Identity Platform/App Check and a server-side lockout for high-value accounts. Do not add a client-only lockout and call it protection. |

---

## 5. E2EE verification status (Module D extras)

| Check | Status | Evidence / gap |
|---|---|---|
| Device verification (fingerprints/safety numbers) | **NOT IMPLEMENTED** | No UI or protocol. Users cannot verify a peer's key out of band. |
| Encrypted messages across a user's devices | **PARTIAL** | Relay delivers to every registered device; decryption requires the chat identity, which must be restored on the second device from the encrypted Drive backup. Unit tests cover the envelope; no two-browser E2E was run here. |
| Behaviour when an encryption key is missing | **PARTIAL** | `openMessage` fails; `chatIdentityBackup` tests reject wrong key/tamper. No dedicated test of "recipient has no published bundle" at the UI level. |
| Secure key recovery | **PARTIAL** | `lib/chatIdentityBackup.js` encrypts with a wallet-seed-derived key; restore needs the wallet seed. No live Google Drive round-trip was performed. |
| Behaviour after device revocation | **NOT STARTED** | No revocation mechanism exists. Removing local storage silently loses the identity. |

---

## 6. Security testing performed / not performed

**Performed (this audit):**

- Focused suites: 42/42 auth+profile+contacts, 25/25 email/password service and
  Firebase adapter, 41/41 relay+E2E+archive, 5/5 gateway hardening,
  51/51 payments+client+identity, 6/6 tab sync, 3/3 locked-wallet acceptance.
- Source review of `firestore.rules`, `chat-relay.mjs`, `server.js`,
  `lib/e2eChat.js`, `chatIdentity.js`, `chatIdentityBackup.js`, `chatClient.js`,
  `contacts.js`, `profile.js`.
- Existing static-artifact secret scan (`tests/security-scan.mjs`) is part of
  `npm test`; it was **not re-run separately** in this audit.

**Not performed (and therefore not claimed):**

- Firestore emulator or live rules tests; no Firebase credentials here.
- Browser E2E for XSS, CSP, or click-jacking; Playwright/browser tooling for the
  app was not run.
- Penetration test, fuzzing, dependency vulnerability audit (`npm audit`),
  TLS configuration scan, or load/DoS testing.
- Cryptographic review by a specialist.
- Log review on the production host.
- Google Drive OAuth round-trip for backup/restore.

---

## 7. Residual risk statement

The messaging design is sound for **confidentiality against the relay** (it
stores only ciphertext and cannot decrypt). It is **not** a hardened
LINE-class security posture yet:

- the chat seed is extractable from browser storage (F1);
- there is no forward secrecy (F2);
- there is an email-enumeration oracle and only a client-side throttle (F3/F4);
- there is no CSP configured for the site in-repo (F6);
- there is no account lifecycle, session authority, or moderation (F12–F14);
- profile display name, bio, status and primary wallet follow the profile
  `visibility` rule (source only; not deployed/emulator-tested) and are not
  moderated; friend-request, messaging, presence and last-seen policies remain
  unimplemented (A6);
- a profile share link contains a public handle or wallet address, has no expiry
  or revocation, and can be forwarded indefinitely; it grants no signing power
  and a limited profile still requires the viewer to pass the rules;
- the new email/password flow has never completed a live round trip, and its
  policy and brute-force posture are unverified (F16/F17).

F1 and F6 together are the most important near-term items: a single XSS on the
origin currently yields the chat identity, and the CSP's `'unsafe-inline'`
script allowance does not stop an injected inline script. Until F1 is fixed,
header-level CSP/hardening and third-party script minimization are the
compensating controls.
