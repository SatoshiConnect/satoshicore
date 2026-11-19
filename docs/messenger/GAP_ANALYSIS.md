# GAP_ANALYSIS

Gap analysis for the requested **Membership & Authentication** and
**Real-Time Chat** scope, produced before any further implementation. Date:
2026-11-16. Source state: `feat/chat-first-wallet-ux` @ `d63d6ff` + uncommitted
worktree changes.

This file is the index for the eight required reports:

| Report | Purpose |
|---|---|
| `SYSTEM_ARCHITECTURE.md` | What exists, trust boundaries, what does not exist |
| `DATABASE_SCHEMA.md` | Firestore, SQLite, browser storage, migrations |
| `API_DOCUMENTATION.md` | Every endpoint/SDK call actually implemented |
| `MEMBERSHIP_FEATURE_CHECKLIST.md` | Module A: 66 requirements, per-item status |
| `CHAT_FEATURE_CHECKLIST.md` | Module B: 89 requirements + Module C |
| `SECURITY_REVIEW.md` | Threat model, controls, findings F1–F15 |
| `TEST_RESULTS.md` | Exact commands, counts, acceptance matrix, failures |
| `DEPLOYMENT_GUIDE.md` | Deploy/rollback/migration/operations procedure |

---

## 1. Method and limits

- Inspected the repository, build config, Firestore rules, gateway, client
  libraries, tests, and existing operational docs.
- Treated a requirement as COMPLETE only when code **and** a passing, relevant
  test (or a production record) existed.
- Did not accept UI presence, a database table, or an API stub as evidence.
- Re-ran every focused suite and the production build in this environment.
- Did not have Firebase credentials, email delivery, Admin SDK access, object
  storage, WebSocket infrastructure, or production deploy authorization, so
  anything depending on those is BLOCKED rather than guessed at.

Full evidence: `TEST_RESULTS.md`.

---

## 2. Scorecard

| Scope | Requirements | COMPLETE | PARTIAL | BLOCKED | NOT STARTED |
|---|---:|---:|---:|---:|---:|
| Module A — Membership | 66 | 15 (23%) | 26 (39%) | 9 (14%) | 16 (24%) |
| Module B — Chat | 89 | 34 (38%) | 29 (33%) | 11 (12%) | 15 (17%) |
| Module C — Federation | 10 | 0 implemented (4 negative constraints honoured) | 0 | 0 | 6 |
| **Mandatory total (A+B)** | **155** | **49 (32%)** | **55 (35%)** | **20 (13%)** | **31 (20%)** |

**The mandatory scope is approximately one fifth complete. It is not done, and
must not be reported as done.**

What “COMPLETE” consists of is narrow and real: Google sign-in/session basics,
handle/profile claim, contact/friend/block graph, 1:1 encrypted messaging,
per-device delivery, quotas, retention, encrypted archive, and key backup.

---

## 3. The ten largest gaps

Ordered by dependency impact, not by effort.

### G1. Email/password code exists, but no verified live auth backend
Phase 0 added registration, verification request/resend, sign-in, forgot/reset,
change-password and email change behind a provider interface (`lib/emailAuth.js`)
with 25 unit tests. What is still missing is a **configured provider and a
delivered email**: no real account has been created, no verification/reset/link
has been consumed, and MFA and account linking remain untouched.
**Blocks:** A1.1/A1.3/A1.5/A1.6 and A3.1–A3.3 stay PARTIAL; A2.7–A2.9, A3.4–A3.6,
A9.1 and notifications remain blocked/unstarted.
**Needs:** enable Firebase Email/Password, authorize domains, configure email
templates/delivery, then run the live acceptance pass. Argon2id specifically
still requires a controlled server.

### G2. No server-side session authority
No “log out all devices”, no session list, no revocation after sensitive
changes, no suspicious-login detection, no suspension. Firebase client SDK cannot
do these alone.
**Blocks:** A2.7–A2.9, A7, A8.4, A9.3.
**Needs:** Admin SDK (`revokeRefreshTokens`, `disabled`) on a server.

### G3. No privacy model
Who can find/request/message/view/see-online/see-last-seen is not configurable,
and there is no backend policy for it. Blocks are the only control.
**Blocks:** A6 (7 of 8 items), B3.4's read-receipt opt-out, and B5.1
(presence privacy).
**Needs:** profile privacy document, rules branches, relay message policy.

### G4. No account lifecycle
Email change and a **scoped** export exist (`lib/accountExport.js`: profile,
contacts, requests, blocks). There is still no deactivation, deletion or
retention control, and the export omits chat transcripts and Auth/session data.
Deleting an account today would orphan the handle claim, both sides of the
contact graph, blocks, the discovery hash, and Drive files.
**Blocks:** A9, compliance/retention claims.
**Needs:** Admin SDK + a documented cascade; extend the export with transcripts
and Auth data once a server can authorize it.

### G5. No roles, moderation, or audit
No User/Moderator/Admin roles, no RBAC, no report queue, no suspension, no audit
trail. Report-user is also missing from chat.
**Blocks:** A8 (all), B8.6 (report), and safe operation at any scale.
**Needs:** custom claims or a server role store, append-only audit, admin API/UI.

### G6. No group model
No conversations as entities, no membership records, no owner/admin/moderator/
member roles, no invitations, no group details.
**Blocks:** B1.2, B1.5–B1.7, B6 (all), pinning permissions, group notifications.
**Needs:** new schema (conversation + membership), new relay routes, new UI,
authorization per operation.

### G7. No attachments
No object storage, upload, progress, previews, voice notes, size/type limits,
scanning, or signed access.
**Blocks:** B4 (all 11).
**Needs:** bucket, upload service, scanner, per-conversation authorization, and
an explicit decision about E2EE for files.

### G8. No push transport beyond SSE
Chat has an authenticated SSE wake-up stream plus a 15 s polling fallback, and
text read receipts, ephemeral typing and opt-in presence. There is no WebSocket
or OS/web push; browser notifications work only while the tab is open.
**Blocks:** B5.10 (push when closed), A6.5-A6.6 privacy controls.
**Needs:** a persistent-connection service or a push provider; a static export
cannot host it.

### G9. Incomplete delivery semantics
No local pending/failed/retry outbox, no idempotency key, no delivered/read
receipt, no offline queue.
**Blocks:** B3.1, B3.3–B3.7, B7.3/B7.4/B7.6, D14/D15.
**Needs:** client outbox (encrypted), server idempotency, receipt protocol with
privacy controls.

### G10. Control messages are best-effort, not durable server objects
Edit and reaction controls travel as encrypted envelopes and are acknowledged
after use. They have no server-side edit/reaction history or per-reactor slot.
**Blocks:** durable cross-device edit history, multi-reactor reactions.
**Needs:** a signed control-row retention model if edit/reaction history must
survive devices that were offline beyond retention.

---

## 4. What is already trustworthy

Do not rewrite these; extend them.

| Capability | Why it is trustworthy |
|---|---|
| Google sign-in + remember-device + sign-out ordering | 42/42 focused tests; documented production use |
| Handle claim/uniqueness/rename rollback | Transactional claim, create-only rules, 42/42 tests |
| Contact graph (request/accept/reject/cancel/remove/block) | Planners + rules state machine + 42/42 tests |
| Email discovery opt-in | Verified email + hash + no list + 1.2 s throttle + tests |
| 1:1 E2EE (X25519 + XSalsa20-Poly1305) | Vetted library; relay cannot decrypt; E2E test |
| Signed relay requests (v1/v2/v3) | Freshness, nonce, device binding, sender match; 41/41 |
| Per-device delivery and ack isolation | Schema + device headers + tests |
| Quotas, blocks, retention, GC | Constants enforced server-side; 41/41 |
| Chat while wallet locked | Separate chat identity + delegation; 3/3 acceptance |
| Encrypted archive + identity backup | AES-GCM, wrong-key/tamper rejection; 51/51 group |

Known weaknesses are in `SECURITY_REVIEW.md`. F5 (non-atomic contact writes) is
fixed in client and rules source with a failure-injection test, but the
`getAfter()` rules change is **not deployed or emulator-tested**; F8 (in-memory
replay guard) is fixed with a restart test. F1 (chat seed at rest), F3
(discovery oracle) and F6 (CSP `unsafe-inline`) remain.

---

## 5. Dependency-ordered plan

Each phase ends with a gate. Do not start a phase whose gate is blocked.

### Phase 0 — Enable verifiable auth (unblocks the most)
1. ~~Add registration, verification, login, forgot/reset, change-password UI +
   validation + tests~~ — **done in code** (`lib/emailAuth.js`,
   `components/EmailAccount.js`, 25/25 tests). Still PARTIAL.
2. Configure Email/Password provider, email templates, authorized domains and a
   delivery path. **This is the remaining work.**
3. Decide the hashing story: provider-managed (document the algorithm) or a
   server with Argon2id (A1.5). Currently provider-managed, algorithm unverified.
4. **Gate (not yet met):** live account creation, delivered verification email,
   clicked link, provider-hosted reset, change-password round trip, plus the
   unit cases already covered (duplicate, weak, bad/expired token, network).

### Phase 1 — Session authority
1. Deploy a minimal backend with Admin SDK (never in client).
2. Add logout-all, session list/revoke, forced reauth, suspension, and an audit
   event on each (A2.7, A2.8, A7.1–A7.4, A8.4).
3. **Gate:** revoke a session from device B and prove device A is denied on the
   next request; unauthenticated calls get 401.

### Phase 2 — Profile + privacy
1. `displayName`, `bio`, `status` and `visibility` are added with client
   validation, UI and rules source (PARTIAL: rules not deployed/emulator-tested).
   `visibility` currently governs profile-document reads only. `avatarUrl` still
   needs storage; friend-request/message/presence policies remain (A6).
2. Enforce each privacy rule in rules and in the relay message policy.
3. **Gate:** tests for each visibility value, including a denied path from a
   second account.

### Phase 3 — Message protocol v2
1. Add message types: reply, edit, delete, reaction, forward.
2. Add client idempotency key + encrypted outbox + retry/backoff.
3. Add a per-contact read-receipt opt-out (the receipt itself now exists).
4. **Gate:** duplicate-send test, edit/delete authorization tests, offline queue
   replay test, receipt privacy test.

### Phase 4 — Groups
1. `conversations` + `conversation_members` (roles), invitations, removal.
2. Relay routes for group envelopes keyed per member device.
3. **Gate:** non-member cannot read/post; moderator removal takes effect;
   invitation permission enforced server-side.

### Phase 5 — Attachments
1. Object storage + upload service + scanner + signed URLs.
2. Size/type limits, progress, cancel/retry, previews, voice.
3. **Gate:** unauthorized fetch denied; infected file quarantined; oversized
   upload rejected server-side.

### Phase 6 — Realtime and notifications
1. OS/web push provider; complete presence privacy controls.
2. **Gate:** two clients see a message in <1 s; reconnect recovers; no duplicate
   rendering.

### Phase 7 — Moderation and lifecycle
1. Roles, reports, admin audit, suspension, deletion cascade, export.
2. **Gate:** deleted account leaves no orphan handle/contact/block/discovery
   documents; audit is append-only; ordinary admins cannot read ciphertext.

---

## 6. Blocker matrix

| External dependency | Needed for | Status |
|---|---|---|
| Firebase Email/Password provider + email templates | A1, A3, A9.1 | Not configured; no console access in this environment |
| Transactional email provider/API key | verification, reset, change notifications | Not available |
| Firebase Admin service account + deployable backend | A2.7/A2.8, A7, A8, A9.3 | Not available |
| Object storage + malware scanner | A4.4, B4 | Not available |
| WebSocket/push infrastructure | A6.5/A6.6, B5.1/B5.10, realtime | Not available |
| Legal review of privacy/retention text | A9.5, A6 defaults | `/privacy/` still marked draft |
| Production deploy authorization | anything touching live rules/gateway/web | Not granted for this audit |

These are honest blockers: a client-only workaround would create a feature that
cannot be enforced or verified.

---

## 7. Risks of claiming completion now

| Claim | Why it would be false |
|---|---|
| “Membership system complete” | 25 requirements not started, 14 blocked, no password/email/reset/session admin/privacy/roles |
| “Real-time chat” | SSE wake-ups plus polling; typing and opt-in presence exist; no OS/web push |
| “LINE-like” | No groups, media/voice, OS/web push, moderation |
| “Secure account system” | No MFA, no session revocation, no deletion, extractable chat seed |
| “Production ready” | Full suite is not green here (static-export gate), no Firestore E2E, no restore drill |

## 8. Immediate next action

Phase 0 code is written and unit-tested. The remaining gate is configuration
and live verification, which this environment cannot provide. Phase 1 removed
the two security findings that needed no infrastructure:

1. ~~F5 atomic contact writes~~ — **fixed in client and rules source** (one
   Firestore `writeBatch`, `getAfter()`/`existsAfter()` in the rules, and a
   failed-commit test); the rules still need emulator/live verification before
   deployment. ~~F8 persisted replay guard~~ — **fixed** (SQLite `chat_nonces`,
   with a restart-replay test).
2. ~~F10 bounded rate map~~ and ~~F11 log scrubbing~~ — **fixed** with
   `tests/gateway-hardening.test.mjs`; ~~B2.7 message copy~~ — **fixed** with
   `tests/clipboard.test.mjs`. Still open without new infrastructure: F6
   header/CSP hardening (needs the web-server config).
3. Wiring the reset action page to the provider-hosted handler (already used)
   or a custom `confirmPasswordReset` page once the redirect domain is known.

Do not raise any Phase 0 row above PARTIAL until a live account, a delivered
verification email and a completed reset have been observed.
