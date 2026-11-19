# MEMBERSHIP_FEATURE_CHECKLIST

Module A (Membership & Authentication) requirement-by-requirement status at
2026-11-16. Status vocabulary is exactly: **COMPLETE**, **PARTIAL**, **BLOCKED**,
**NOT STARTED**.

Rules applied to this audit:

- COMPLETE means implemented **and** verified with repeatable evidence, not just
  a screen or a table.
- PARTIAL means some required behaviour exists but at least one required
  behaviour or verification is missing.
- BLOCKED means work cannot proceed here without credentials, infrastructure,
  provider configuration, or production authorization that is not available.
- NOT STARTED means nothing was implemented for the requirement.

**Summary: 66 requirements — 15 COMPLETE, 26 PARTIAL, 9 BLOCKED, 16 NOT STARTED.
The module is not complete.** It must not be reported as 100%.

**Phase 0 update (2026-11-16):** email/password registration, verification
request/resend, sign-in, forgot-password request, reset completion and
change-password now exist in `lib/emailAuth.js` with a provider interface and 22
tests. Every live path (actual account creation, delivered email, clicked link,
reset page, change-password round trip) is **unverified** because this
environment has no Firebase public config, no Email/Password provider and no
inbox. Those rows are PARTIAL, not COMPLETE.

Evidence commands and counts are in `TEST_RESULTS.md`. Architecture is in
`SYSTEM_ARCHITECTURE.md`; schema in `DATABASE_SCHEMA.md`.

---

## A1. Registration

| ID | Requirement | Status | Implementation | Verification | Limits / remaining work |
|---|---|---|---|---|---|
| A1.1 | Email + password registration | **PARTIAL** | `lib/emailAuth.js` (`createEmailAuth`, `createFirebaseEmailAuthProvider`), `components/EmailAccount.js` (gate form), `components/GoogleAccount.js` | `tests/email-auth.test.mjs` **25/25**: normalization, duplicate mapping, verification request, password never returned. Live production: Email/Password enabled 2026-11-17; two accounts created and signed in; verification emails requested. | Accounts are **unverified** (links not clicked); duplicate-email and verification-delivery behavior still need a live inbox test. |
| A1.2 | Google OAuth / OIDC sign-in | **COMPLETE** | `lib/firebaseAuth.js` (`loadGoogleAuth`, popup/redirect, persistence), `components/GoogleAccount.js` | `tests/firebase-auth.test.mjs` in the 42/42 run; production sign-in documented in `docs/GOOGLE-SIGN-IN.md` | Browser E2E could not be re-run here: `NEXT_PUBLIC_FIREBASE_*` is absent in this environment, so the local build has no account gate. |
| A1.3 | Email verification | **PARTIAL** | `lib/emailAuth.js` sends/resends verification and reloads the provider record; `EmailAccount.js` shows the unverified state; `firestore.rules` (`verifiedEmail()`) enforces the claim for writes. | `tests/email-auth.test.mjs` 25/25 (send, resend, already-verified, refresh); rules text asserted by `tests/profile.test.mjs`. | Delivery, link click, code expiry and the post-verification token refresh are provider-side and **unverified** here; no Firestore emulator test. |
| A1.4 | Duplicate-account prevention | **PARTIAL** | Handle uniqueness via create-only `profileIds/{profileId}` transaction; email duplicates mapped from `auth/email-already-in-use` to `EMAIL_IN_USE`. | `tests/profile.test.mjs` 42/42; `tests/email-auth.test.mjs` 25/25. | Email uniqueness is enforced by the provider and cannot be tested until the provider is enabled; no cross-provider account merge. |
| A1.5 | Argon2id password hashing | **PARTIAL** | No application-side hashing or storage: `lib/emailAuth.js` passes the password to the provider and never keeps it. | Tests prove the password is not returned in results or error text (`tests/email-auth.test.mjs` 25/25). | The provider's algorithm/parameters are not verifiable here and are not Argon2id (Firebase uses its own scrypt-based scheme). Satisfying the literal Argon2id requirement needs a controlled backend. |
| A1.6 | Strong password policy + compromised-password checks | **PARTIAL** | `lib/emailAuth.js` `validatePassword`: 12–128 chars, letter + digit, no edge spaces, not containing the email name; optional `breachCheck` hook. | `tests/email-auth.test.mjs` 25/25 (weak/short/long/whitespace/email-name, breach refusal, breach-service outage). | No live breach API/key is configured; a client policy is not a server control, and provider-side password/credential-stuffing protection is unverified. |
| A1.7 | Validation and understandable errors | **PARTIAL** | `lib/emailAuth.js` (`validateEmail`, `validatePassword`, `mapEmailAuthError`, `describeEmailAuthError`); `lib/profile.js` and `lib/contacts.js` validators; UI error text in `EmailAccount.js`. | `tests/email-auth.test.mjs` 25/25 (mapped provider errors, safe text, no password echo); profile/contacts 42/42. | Only the stable error codes covered by tests are mapped; live provider variants are unverified. |
| A1.8 | Safe account-linking across login methods | **NOT STARTED** | None. | No linking code, no `linkWithCredential`. | Needs a second provider and a verified-email linking policy before implementation. |

## A2. Authentication

| ID | Requirement | Status | Implementation | Verification | Limits / remaining work |
|---|---|---|---|---|---|
| A2.1 | Login and logout | **COMPLETE** | `lib/firebaseAuth.js` (shared `loadAuthClient`, `signOutGoogleSession`), `lib/emailAuth.js` (`signIn`, `signOut`), `EmailAccount.js` | `tests/firebase-auth.test.mjs` 7/7; `tests/email-auth.test.mjs` 25/25; sign-out ordering covered. | Google is production-verified; email sign-in has no live provider test. |
| A2.2 | Persistent sessions / Remember Device | **COMPLETE** | `shouldRememberGoogleSession`, `setRememberGoogleSession`, `setGoogleSessionPersistence` (`browserLocal` vs `browserSession`) | 42/42 auth tests; `hooks` assert persistence choice. | Storage is browser storage; no OS keychain on web. |
| A2.3 | Automatic session restoration | **COMPLETE** | `onAuthStateChanged` restore path; `lib/sessionPolicy.js` idle record. | `tests/firebase-auth.test.mjs` in the 42/42 run. | Not re-verified in a live browser here (no Firebase env). `tests/session-policy.test.mjs` covers idle expiry but was not re-run in this audit. |
| A2.4 | Session rotation and expiration | **PARTIAL** | Firebase ID-token auto-refresh; `lib/sessionPolicy.js` now enforces a 30-day idle limit **and** a 90-day absolute limit from the first sign-in (`startedAt`), migrating older records. | `tests/session-policy.test.mjs` **11/11** (idle, absolute boundary, old-record migration, `startedAt` preservation across touches, notice behaviour). | Browser-local only: no server-enforced expiry, no session list/revoke, and rotation remains provider-owned. No live browser run. |
| A2.5 | Refresh-token rotation | **PARTIAL** | Delegated entirely to the Firebase SDK; no app code. | None specific. | Cannot be verified from this repo; no Admin SDK to inspect or revoke refresh tokens. |
| A2.6 | Logout from current device | **COMPLETE** | `signOutGoogleSession` → `signOut(auth)` then local cleanup. | `tests/firebase-auth.test.mjs` 42/42. | — |
| A2.7 | Logout from all devices | **BLOCKED** | None. | No code. | Requires Firebase Admin SDK `revokeRefreshTokens(uid)` on a server, plus credentials/service account. `docs/GOOGLE-SIGN-IN.md` states this limitation. |
| A2.8 | Revocation after sensitive account changes | **BLOCKED** | None. | No code. | Same Admin SDK dependency; also needs a list of "sensitive" events, which requires an audit store. |
| A2.9 | Brute-force / credential-stuffing protection | **BLOCKED** | Gateway has a coarse IP rate limit for non-chat routes (`rateLimited`), not auth. | `tests/chat-relay-gates.test.mjs` covers relay limits, not login. | Needs Identity Platform/App Check configuration or a server login endpoint with lockout/backoff; no such backend. |
| A2.10 | CSRF protection | **COMPLETE (vacuous)** | No cookie-based authentication exists; Firebase uses SDK-managed bearer tokens; chat uses signed requests. | Code inspection: no `Set-Cookie`, no cookie auth. | If cookie sessions are added later, CSRF tokens become mandatory. |

## A3. Account recovery

| ID | Requirement | Status | Implementation | Verification | Limits / remaining work |
|---|---|---|---|---|---|
| A3.1 | Forgot password | **PARTIAL** | `lib/emailAuth.js` `sendPasswordReset`; `EmailAccount.js` forgot mode. | `tests/email-auth.test.mjs` 25/25 (normalization, neutral response for unknown account, network failure surfaced). | No email delivery or provider-hosted reset page was exercised; live behavior is unverified. |
| A3.2 | Short-lived, single-use reset tokens | **PARTIAL** | Provider owns code issuance; `lib/emailAuth.js` `confirmPasswordReset` consumes a code and maps expired/used errors. | `tests/email-auth.test.mjs` 25/25 (malformed code, expired/used mapping). | Expiry and single-use semantics are provider-side; no live code was issued or redeemed, so they remain unverified. |
| A3.3 | Change password | **PARTIAL** | `lib/emailAuth.js` `changePassword` (reauthenticate with current password → `updatePassword`); `EmailAccount.js` settings form. | `tests/email-auth.test.mjs` 25/25 (reauth-before-update order, wrong current password, unchanged/weak password). | No live reauthentication or password update was run; browser behavior is unverified. |
| A3.4 | Recovery when a provider is unavailable | **BLOCKED** | None. | No code. | Requires a second verified recovery method (e.g. verified email + recovery code) and a backend to enforce it. |
| A3.5 | No MFA/identity bypass during recovery | **BLOCKED** | No MFA exists at all. | No code. | Must be designed together with MFA; cannot be "verified" in a system without MFA. |
| A3.6 | Notify owner of sensitive changes | **BLOCKED** | None. | No code. | Needs transactional email delivery; no provider configured. |

## A4. User profile

| ID | Requirement | Status | Implementation | Verification | Limits / remaining work |
|---|---|---|---|---|---|
| A4.1 | Unique, immutable internal user ID | **COMPLETE** | Firebase `uid`; used as every document key (`profiles/{uid}`, `walletLinks/{uid}`, etc.). | `firestore.rules` ownership checks; `tests/profile.test.mjs`; `tests/contacts.test.mjs`. | UID is provider-owned; migration between providers would change it (no linking). |
| A4.2 | Unique public username + normalization | **COMPLETE** | `lib/profile.js` `normalizeProfileId` (`@`, 3–20, `[a-z0-9_-]`), create-only `profileIds` claim, transactional rename. | `tests/profile.test.mjs` 42/42 (normalization, claim collision, failed rename rollback). | Rename changes the public handle; old links break (documented, no alias table). |
| A4.3 | Display name | **PARTIAL** | `lib/profile.js` (`DISPLAY_NAME_MAX=50`, `normalizeProfileText`, `validateProfileText`, `profileDocument`, `profileDisplayLabel`); `ProfileCard.js` create/edit/view; `ContactsCard.js` labels/search; `ChatPanel.js` add/header/list; `firestore.rules` `isProfileText(..., 50)`. | `tests/profile.test.mjs` 16/16 (bounds, round trip, rename preservation, display-name → handle → fallback label); rules source asserted. | Rules not deployed or emulator-tested, so a live write is unverified. Text is public to any signed-in reader and unmoderated; names appear only where the peer profile was already resolved (not for offline/persisted chats). |
| A4.4 | Profile picture | **NOT STARTED** | None; no object storage. | — | Blocked on storage/upload pipeline as well as schema. |
| A4.5 | Biography / About | **PARTIAL** | `lib/profile.js` (`BIO_MAX=160`, optional `bio`); `ProfileCard.js` create/edit/view; rules `isProfileText(..., 160)`. | `tests/profile.test.mjs` 16/16 (bound, empty allowed, over-long dropped). | Rules not deployed/emulator-tested; no moderation or visibility control. |
| A4.6 | Public status message | **PARTIAL** | `lib/profile.js` (`STATUS_MAX=80`, optional `status`); `ProfileCard.js` create/edit/view; rules `isProfileText(..., 80)`. | `tests/profile.test.mjs` 16/16 (bound, optional, round trip). | Rules not deployed/emulator-tested. Visibility is still all signed-in readers, so it is not yet a privacy-aware status. |
| A4.7 | Profile editing and validation | **PARTIAL** | Handle, primary wallet, display name, bio, status and visibility editable in one form (`saveMyProfile`); validation and Thai/English error text; rename and primary-wallet changes preserve every field. | `tests/profile.test.mjs` 16/16; auth+profile+contacts 42/42. | Rules not deployed/emulator-tested; no avatar (A4.4), no moderation. |
| A4.8 | Default profile visibility controls | **PARTIAL** | `visibility` on `profiles/{uid}`: `signed-in` (default; old documents too), `contacts`, `private`; `ProfileCard.js` selector; rules enforce owner/any-signed-in/accepted-contact/owner-only reads. | `tests/profile.test.mjs` 16/16 (closed set, default, fail-closed unknown value, preservation through rename); rules source assertions; suite 42/42. A live save of `private` was rejected by the deployed rules on 2026-11-16. | Rules not deployed or emulator-tested; the live rejection confirms this. It governs profile-document reads only, not claim lookup, friend requests, messaging, presence or last-seen (A6.1–A6.8). |

## A5. Friends and contacts

| ID | Requirement | Status | Implementation | Verification | Limits / remaining work |
|---|---|---|---|---|---|
| A5.1 | Search users by username | **COMPLETE** | `resolveProfileHandle()` → `profileIds/{profileId}` get; `list` denied. | `tests/profile.test.mjs`, `tests/contacts.test.mjs` 42/42; rules assertions. | Search is exact-handle only (no fuzzy/prefix search). A contacts-only/private profile returns a clear “not public” message instead of its details. |
| A5.2 | Opt-in email discovery after verified ownership | **PARTIAL** | `lib/contacts.js` `planEmailDiscovery`, `emailHashHex`, `discoveryEmails/{sha256}`; rules require `email_verified` and `uid == auth.uid`. | `tests/contacts.test.mjs` (opt-in, hashing, throttling) 42/42. | No Firestore emulator or live rules test; hash is unsalted (enumeration of known emails is possible for anyone who can compute the hash — mitigated only by `get`-only/verified-email, not eliminated). |
| A5.3 | QR code / profile link | **COMPLETE** | `lib/profileShare.js` builds `/wallet/?add=…` from the current page (base-path safe), prefers a handle only for public profiles and an address for limited ones; `ProfileCard.js` shows a locally generated QR, Copy link, native Share with copy fallback, and a warning for a limited profile or a missing primary wallet; `ChatPanel.js` pre-fills the add field from `?add=`. The receiver can open it later, with no app open at share time. | `tests/profile-share.test.mjs` 7/7 (public/limited/address-only, base path, invalid URL, share text); `npm run build` 14/14. | Real-account browser check on 2026-11-16: `@satoshi` rendered the link and 220×220 QR; Copy link put exactly `…/wallet/?add=%40satoshi` on the clipboard; `Share…` used the copy fallback because desktop Chromium has no share sheet; a fresh incognito tab kept the query and showed sign-in; after sign-in, `?add=` pre-filled the add field. A live attempt to save `private` was **refused by the deployed rules** (“The database refused this change”), confirming the new visibility rules are not deployed; private/no-primary messages were therefore checked by injecting component state, not persisted. A second account, mobile native share and an actual QR scan remain untested. |
| A5.4 | Send friend request | **COMPLETE** | `planSendRequest` + Firestore store writes outbox and inbox atomically; rules require pending + no block. | `tests/contacts.test.mjs` 42/42. | — |
| A5.5 | Accept, reject, cancel, remove | **COMPLETE** | `planAcceptRequest`, `planRejectRequest`, `planCancelRequest`, `planRemoveContact`, `createFirestoreContactsStore`. | `tests/contacts.test.mjs` 42/42; rules state machine. | One Firestore `writeBatch` commits both sides; a denied or failed commit leaves the previous state (failure-injection test). `firestore.rules` now uses `getAfter()`/`existsAfter()` for a batched accept; that rules change is **not deployed or emulator-tested** here. |
| A5.6 | View friends and pending requests | **COMPLETE** | `ContactsCard.js`, inbox/outbox queries in `lib/contacts.js`. | 42/42 tests; UI not visually re-inspected in this audit. | — |
| A5.7 | Block and unblock | **COMPLETE** | Firestore `blocks/{owner}/people/{peer}`; relay `chat_blocks`; UI in `ContactsCard.js` / `ChatPanel.js`. | `tests/contacts.test.mjs`; `tests/chat-relay-gates.test.mjs` (blocked mail dropped, queued mail cleared) in 41/41 relay run. | Two block stores (Firestore for social actions, relay for mail) must be kept in sync by the client; a failure between the two calls can leave one side stale. |
| A5.8 | Prevent blocked users from prohibited interactions | **PARTIAL** | Rules refuse a friend request from a blocked uid; relay drops messages in either direction and clears queued mail. | `tests/contacts.test.mjs`; relay gate tests 41/41. | Blocks are not checked against profile `get` (a blocked user can still resolve a handle), and there is no global "blocked" enforcement for future features (groups, calls). |
| A5.9 | Prevent mass email enumeration | **COMPLETE** | `list` denied on `discoveryEmails`; exact-hash `get` only; verified email required; `DISCOVERY_MIN_INTERVAL_MS = 1200` client throttle. | `tests/contacts.test.mjs`; rules assertions in `tests/profile.test.mjs`. | Throttle is client-side; Firestore itself does not rate-limit reads, so a modified client can still probe hashes of emails it already knows. Server-side quota would need a backend. |

## A6. Privacy

| ID | Requirement | Status | Implementation | Verification | Limits / remaining work |
|---|---|---|---|---|---|
| A6.1 | Who can find my account | **NOT STARTED** | No setting; handle lookup is open to any signed-in user. | — | Needs profile privacy document + rules branches. |
| A6.2 | Who can send friend requests | **NOT STARTED** | Only a block is honoured. | — | Rules branch per setting. |
| A6.3 | Who can message me | **NOT STARTED** | Relay accepts any valid address unless blocked. | — | Relay would need a per-address policy enforced server-side. |
| A6.4 | Who can view profile details | **PARTIAL** | `profiles/{uid}.visibility` with rules: owner always; `signed-in` any authenticated account; `contacts` only with an accepted contact document; `private` owner-only. | `tests/profile.test.mjs` 16/16; rules source assertions. A live `private` save was refused by the deployed rules, so the restriction is not active in production. | Rules not deployed/emulator-tested. Only the profile document is governed; this is not a full privacy model. |
| A6.5 | Who can see online status | **NOT STARTED** | No presence system exists. | — | Depends on realtime infrastructure. |
| A6.6 | Who can see last-seen | **NOT STARTED** | No last-seen system exists. | — | Same. |
| A6.7 | Privacy-preserving defaults | **NOT STARTED** | Current defaults happen to be narrow (exact handle only, no listing, no email stored), but there is no configurable privacy model. | — | Must be designed with A6.1–A6.6. |
| A6.8 | Backend enforcement, not UI-only | **PARTIAL** | Blocks and discovery constraints are enforced in `firestore.rules` and in the relay, not only in React. | Rules assertions + relay tests 41/41. | Only those two policies exist; the six privacy controls above have no backend to enforce. |

## A7. Multi-device sessions

| ID | Requirement | Status | Implementation | Verification | Limits / remaining work |
|---|---|---|---|---|---|
| A7.1 | View active devices | **NOT STARTED** | `chat_devices` exists for message delivery, but no session list and no UI. | — | Needs Admin SDK session data or a server session store. |
| A7.2 | Approximate device/session information | **PARTIAL** | Relay records `device_id`, `first_seen_at`, `last_seen_at` in `chat_devices`. | `tests/chat-relay.test.mjs` (device registration, trimming) in 41/41. | Not exposed to the user; device id is a random string, not a parsed user agent. |
| A7.3 | Revoke selected sessions | **BLOCKED** | None. | — | Admin SDK `revokeRefreshTokens` + a server endpoint; not available. |
| A7.4 | Detect suspicious new sign-ins | **BLOCKED** | None. | — | Needs server-side auth event history; Firebase client SDK does not provide it. |
| A7.5 | Platform-appropriate credential storage | **PARTIAL** | Firebase SDK persistence (IndexedDB/localStorage); remember-device toggle; no tokens written by app code. | 42/42 auth tests. | Web has no OS keychain; a compromised origin or XSS can read the SDK session. Desktop app has separate storage (out of this audit). |

## A8. Administrative controls

| ID | Requirement | Status | Implementation | Verification | Limits / remaining work |
|---|---|---|---|---|---|
| A8.1 | User / Moderator / Administrator roles | **NOT STARTED** | No role field, no claims, no admin UI. | — | Needs custom claims (Admin SDK) or a server role store. |
| A8.2 | Server-enforced RBAC | **NOT STARTED** | None. | — | Rules could read a custom claim once one exists. |
| A8.3 | View account status and security events | **NOT STARTED** | None. | — | Needs audit store + admin API. |
| A8.4 | Suspend / reactivate accounts | **NOT STARTED** | None. | — | Needs Admin SDK (`disabled` flag) + admin authorization. |
| A8.5 | Review abuse reports | **NOT STARTED** | No report model, endpoint, or UI. | — | Also blocks B8 "report user". |
| A8.6 | Audit administrative actions | **NOT STARTED** | None. | — | Append-only store with tamper resistance required. |
| A8.7 | Admins cannot access credentials or encrypted content | **PARTIAL (vacuous)** | No administrator exists. The relay has no decryption path and stores ciphertext only; wallet/chat seeds never leave the device. | Code inspection; `docs/E2E-CHAT-DESIGN.md`. | The requirement cannot be fully satisfied until roles exist *and* are tested against these limits. |

## A9. Account management

| ID | Requirement | Status | Implementation | Verification | Limits / remaining work |
|---|---|---|---|---|---|
| A9.1 | Update email with verification | **PARTIAL** | `lib/emailAuth.js` `changeEmail` (reauthenticate → `verifyBeforeUpdateEmail`); `EmailAccount.js` settings form. | `tests/email-auth.test.mjs` 25/25 (reauth first, same/invalid address rejected, duplicate mapped, old address stays until verified). | No live email change or link was exercised; provider/email delivery is not configured. |
| A9.2 | Account deactivation | **NOT STARTED** | None. | — | Needs a status field/rules and a reactivation path. |
| A9.3 | Account deletion + associated-data handling | **BLOCKED** | None. | — | Full deletion needs Admin SDK to delete the Auth user and to clear the handle claim and peers' contact/request documents that rules forbid the user from touching. Client-only deletion would orphan data. |
| A9.4 | Personal data export | **PARTIAL** | `lib/accountExport.js` builds/serializes/downloads a versioned JSON file from the profile, contact graph, requests and blocks; `ProfileCard.js` “Download my data”. | `tests/account-export.test.mjs` 4/4 (shape, sorting, invalid profile, no email/seed/password/token, filename); build passes. | Chat transcripts and Auth/session records are not included. No live Firestore read or browser download was exercised; full export needs a backend. |
| A9.5 | Retention and deletion documentation | **PARTIAL** | Chat retention is documented: 7 days, ack-based deletion, `docs/E2E-CHAT-DESIGN.md`, `docs/messenger/P2-RELAY-GATES.md`. | Code + docs match (`RETENTION_DAYS = 7`). | No account-level retention/deletion policy exists because account deletion does not exist; `/privacy/` is marked draft pending legal review. |

---

## What is genuinely usable today (membership)

A Google account holder can sign in, stay signed in on a remembered device, pick
a unique `@handle`, publish a primary wallet address, find another user by exact
handle, exchange friend requests, build a contact list, block/unblock, and opt in
to exact-email discovery. Those paths have unit evidence and backend rules.

That is roughly **one fifth** of Module A. Password/email flows now have tested
code, but they have never completed a live round trip. Session administration,
privacy settings, roles and account lifecycle are still missing or blocked.

## Blockers, and exactly what would unblock each

| Blocker | Affected | What is needed |
|---|---|---|
| Firebase project console access + Email/Password provider + email templates | A1.1, A1.3, A1.5, A1.6, A3.1–A3.6, A9.1 | Code exists (Phase 0). Project owner must enable the provider, authorize the site domains, supply public Firebase config, and configure email templates/delivery before any of it can be called verified. |
| Firebase Admin SDK service account and a server to run it | A2.7, A2.8, A7.1, A7.3, A7.4, A8.1–A8.6, A9.3 | A deployed backend with credentials (never in client code) and an operator-approved deploy. |
| Transactional email service | A3.6, notifications | Provider account + API key stored server-side. |
| Realtime infrastructure (WebSocket or push) | A6.5, A6.6, B5 typing/presence | A server with persistent connections or a push service. |
| Object storage + scanning | A4.4, B4 | Bucket, upload service, malware scanning, signed URLs. |
| Formal privacy model + legal review | A6.1–A6.7, A9.5 | Product decision on defaults, then rules + relay policy; `/privacy/` review. |

## Recommended implementation order (dependency-first)

1. **Auth foundation**: registration/verification/reset/change-password code and
   unit tests are done (A1.1, A1.3, A3.1–A3.3). Remaining: enable the provider,
   configure email templates, then run the live/browser acceptance pass before
   raising any of them above PARTIAL. A9.1 (update email) now has code and tests
   but is likewise unverified live.
2. **Server session authority**: minimal backend with Admin SDK for logout-all,
   revocation, device list, suspension, deletion (A2.7, A2.8, A7.1–A7.4, A8.4,
   A9.3).
3. **Profile fields + privacy model**: display name/bio/status/visibility source
   exists but rules are undeployed (A4.3–A4.8); avatar needs storage (A4.4);
   friend-request, messaging, presence and last-seen policies remain (A6.1–A6.8).
4. **Roles + moderation**: custom claims, report store, admin audit (A8).
5. **Account lifecycle**: deactivation, deletion cascade, export (A9).
