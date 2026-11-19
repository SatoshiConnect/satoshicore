# DEPLOYMENT_GUIDE

Operational guide for the current architecture.

**Deployed 2026-11-16 22:40; hotfix deployed 2026-11-17 07:28–07:34
(owner-approved):** gateway files and a new static webroot were activated on this
host. See §12 for the release, backup and exact rollback commands.

The previous recorded production deployment (2026-11-16, owner-approved) is in
`docs/messenger/RELEASE-READINESS.md`; this guide describes the procedure and
the state it must preserve.

---

## 1. What is being deployed

| Layer | Artifact | Host |
|---|---|---|
| Static site | `out/` from `next build` | Caddy webroot (versioned dir + symlink) |
| Firestore rules | `firestore.rules` | Firebase project `nsat-wallet-login` |
| API gateway | `services/api-gateway/server.js`, `chat-relay.mjs` | Node process under launchd `org.satoshicore.gateway` |
| Chat database | SQLite at `NSAT_CHAT_DB` | Gateway host (persistent disk) |
| Chain core | `nsat-core` | Separate service (not covered here) |

There is no application server, container, or database migration service.

---

## 2. Environments

| Environment | Web | Gateway | Firebase |
|---|---|---|---|
| Local | `next dev` (3000) | `node services/api-gateway/server.js` (8787) | Not configured on this machine |
| Shadow/release check | built `out/` served locally | `127.0.0.1:8798` shadow instance | rules not deployed |
| Production | `https://satoshicore.org` | `https://gateway.satoshicore.org`, launchd | `nsat-wallet-login` |

`CNAME` in the repo points at `wallet.satoshicore.org` for the GitHub Pages
build path. The operated production site is the Caddy webroot on
`satoshicore.org`; do not assume the two are interchangeable.

---

## 3. Prerequisites

- Node matching the project (this audit used Node 26.8.2, npm 11.19.1). The
  repo ships `package-lock.json`; use `npm ci` for a reproducible install.
- A build-time environment with the public Firebase config (names in §4).
- Firebase CLI authenticated to `nsat-wallet-login` for rules.
- For the Phase 0 email flows: the **Email/Password** provider enabled in
  Firebase Authentication, the production domains (and `localhost` for dev) in
  Authorized domains, and working email templates/delivery. None of these is
  configured in this environment.
- Access to the gateway host, its launchd job, and the chat SQLite file.
- A rollback target: previous webroot directory, previous gateway files, and the
  previous ruleset id.
- Operator approval. **Do not deploy rules or gateway changes without it.**

---

## 4. Configuration (names only — never commit values)

### 4.1 Build-time, public (safe to embed)

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_FIREBASE_API_KEY` | Firebase web config |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | Firebase auth domain; also widens CSP frame-src |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | Firebase project |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | Firebase app id |
| `NEXT_PUBLIC_API_GATEWAY_URL` | Gateway origin when not same-origin |
| `NEXT_PUBLIC_INDEXER_URL` | Indexer origin (CSP connect-src) |
| `NEXT_PUBLIC_API_SAME_ORIGIN` | `1` = call `/api` on the page origin |
| `NEXT_PUBLIC_CHAT_RELAY` | `1` = enable the chat surface |
| `NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY` | VAPID public key; enables the "Background alerts" opt-in |
| `NEXT_PUBLIC_BASE_PATH` | Subpath deployments only |
| `NEXT_PUBLIC_NSAT_NETWORK_ID` / `_NAME` | Network identity shown/verified |
| `NEXT_PUBLIC_IDLE_LOCK_MS` | Wallet idle lock (1–60 min, clamped) |

Missing Firebase values do **not** fail the build; they produce a site with no
account gate and “Google sign-in is not configured in this build.” That artifact
must not be published as production.

Email/password introduces **no new variables**: it uses the same Firebase web
config. Enabling the provider, templates and authorized domains is a Firebase
console action, separate from deploying this code.

### 4.2 Gateway runtime (server-side only)

| Variable | Default | Purpose |
|---|---|---|
| `NSAT_CHAT_RELAY` | off | `1` mounts `/api/v1/chat/*`; without it the routes are 404 |
| `NSAT_CHAT_DB` | `./data/chat.sqlite` | SQLite path; must be on persistent, backed-up disk |
| `NSAT_CHAT_MAX_PENDING` | 5000 | Mailbox ceiling |
| `NSAT_CHAT_GC_MS` | 15000 | Minimum interval between GC passes |
| `ALLOWED_ORIGINS` | empty | Comma-separated CORS origins for direct gateway use |
| `RATE_WINDOW_MS` / `RATE_MAX_REQUESTS` | 60000 / 120 | Per-IP fixed-window limit for wallet/API routes; chat has its own classes |
| `RATE_CHAT_READ_MAX` | 300 | Per-IP chat reads per 60 s (`RATE_CHAT_READ_WINDOW_MS`); reading history never shares the API bucket |
| `RATE_CHAT_WRITE_MAX` | 120 | Per-IP sends/acks/typing per 60 s (`RATE_CHAT_WRITE_WINDOW_MS`); must stay ≤ `RATE_MAX_REQUESTS` |
| `RATE_CHAT_CONNECT_MAX` | 30 | Per-IP `/chat/events` handshakes per 60 s (`RATE_CHAT_CONNECT_WINDOW_MS`) |
| `NSAT_VAPID_PUBLIC_KEY` / `NSAT_VAPID_PRIVATE_KEY` | off | Web Push (background chat alerts). Without a pair the relay answers `503` on `/chat/push` and the UI hides the control. Generate with `node scripts/generate-vapid-keys.mjs`; the private key stays on this host |
| `NSAT_VAPID_SUBJECT` | `mailto:noreply@satoshicore.org` | VAPID contact; a real mailbox is better for a push service that wants to reach the operator |
| `NSAT_PUSH_INTERVAL_MS` | 2500 | How often the durable alert queue is drained; `0` disables the timer (tests) |
| `MAX_BODY_BYTES` | 65536 | Envelope/body cap (chat body caps at 16 KiB) |
| `NSAT_CORE_HTTP_URL`, `NSAT_INDEXER_URL`, `NSAT_EXPECTED_NETWORK` | — | Chain/indexer wiring |
| `GATEWAY_VERSION` | `24.0.0` | Reported by `/health` |

Sponsorship secrets (`NSAT_SPONSOR_SEED_FILE`, budget variables) belong to the
separate sponsor service and must remain server-side.

### 4.3 Never in the client bundle

Service-account JSON, sponsor seed, Firebase Admin credentials, SMTP/API keys,
wallet seeds, chat seeds, or session tokens. `tests/security-scan.mjs` scans the
static output for token/private-key patterns.

---

## 5. Pre-deploy gate

```bash
cd .messenger-audit

# 1. Install exactly what the lockfile says
npm ci

# 2. Focused suites (all must pass)
node --test tests/firebase-auth.test.mjs tests/profile.test.mjs tests/contacts.test.mjs
npm run test:email-auth
npm run test:chat-payments
node --test tests/chat-relay.test.mjs tests/chat-relay-gates.test.mjs \
  tests/chat-relay-archive.test.mjs tests/e2e-chat.test.mjs
npm run test:gateway
npm run test:clipboard
npm run test:pins
npm run test:forward
npm run test:search
npm run test:relay-status
npm run test:reply
npm run test:share
npm run test:outbox
npm run test:events
npm run test:export
node --test tests/session-policy.test.mjs
npm run test:chat-tabs
npm run test:acceptance:locked
npm run test:chat-archive
npm run test:chat-archive-ack
npm run test:chat-unread
npm run test:chat-races

# 3. Build with the production public config present
npm run build

# 4. Static-export gate — requires the Firebase public config.
#    Without it this fails at "signed-out homepage does not offer the wallet gate".
node tests/static-export.test.mjs

# 5. Artifact secret scan
node tests/security-scan.mjs out
```

Do not proceed if step 4 fails for any reason other than a deliberately
different gate design. In this audit it failed only because the environment had
no Firebase config (see `TEST_RESULTS.md` §4).

---

## 6. Deploy order

**Rules → gateway → web.** The site must never ship ahead of the backend it
calls, and the relay must never receive traffic while its database path is
unprepared.

### Step 0 — Back up everything you will touch

```bash
# Gateway files + SQLite (adjust to the real paths on the host)
mkdir -p ~/nsat-ops/backups/gateway-v2-$(date +%Y%m%d-%H%M%S)
cp ~/nsat-ops/gateway/server.js ~/nsat-ops/gateway/chat-relay.mjs \
   ~/nsat-ops/backups/gateway-v2-<timestamp>/
cp ~/nsat-ops/gateway/data/chat.sqlite ~/nsat-ops/backups/gateway-v2-<timestamp>/
node -e "const {DatabaseSync}=require('node:sqlite');\
const db=new DatabaseSync(process.argv[1]);\
console.log(db.prepare('PRAGMA integrity_check').get());" \
  ~/nsat-ops/backups/gateway-v2-<timestamp>/chat.sqlite
```

Record the current webroot symlink target and the current Firestore ruleset id
(Firebase Console → Firestore → Rules → version history) **before** changing
either.

### Step 1 — Firestore rules

```bash
npx firebase deploy --only firestore:rules --project nsat-wallet-login
```

Then verify from a signed-in browser that the contact screen still reads/writes,
and that an unauthenticated read is denied.

**Ordering for the batched-accept change:** this release's rules use
`existsAfter()`/`getAfter()` so one batched write can accept a request and
create the contact. Deploy these rules **before** the web client that batches;
the old rules would deny the batch. Run the rules against the Firestore emulator
first (not done in this audit: no emulator config here).

**Profile fields and visibility:** the rules accept documents with or without
`displayName`/`bio`/`status`/`visibility`, so existing profiles stay valid. Deploy
the rules and the new web client together. After the rules are live, an **old**
client that saves a profile omits those fields and would clear text and reset
`visibility` to the public `signed-in` default — a privacy regression. Do not
leave old clients running against the new rules.

### Step 2 — Gateway

1. Copy the reviewed `chat-relay.mjs`/`server.js` into `~/nsat-ops/gateway/`.
   Never edit the live file in place.
2. Ensure `NSAT_CHAT_RELAY=1` and `NSAT_CHAT_DB` point at the prepared path.
3. Restart the launchd job `org.satoshicore.gateway` (the way the live service
   has been restarted by the operator). Do not start a second copy on the same
   port or database.
4. Check `GET /health` and the process log.

### Step 3 — Static site

1. Copy `out/` into a **new versioned webroot directory**.
2. Swap the symlink to it.
3. Reload Caddy.
4. Keep the previous directory for rollback.

Never overwrite the live webroot in place; the symlink swap is the rollback
unit.

---

## 7. Post-deploy verification

| Check | Command / action | Expected |
|---|---|---|
| Gateway liveness | `curl -sS https://gateway.satoshicore.org/health` | `{"status":"ok", ...}` |
| Chat route mounted | signed `GET /api/v1/chat/blocks` with a throwaway key | `200 {"blocked":[…]}` (not 404) |
| Site served | `curl -I https://satoshicore.org/` | 200, HTML, security headers/CSP |
| Account gate | open in a clean profile | Google **and** email sign-in offered, or an explicit “not configured” message (never a broken button) |
| Email sign-up | create an account with a test inbox | verification email arrives; link sets `emailVerified`; resend works |
| Password reset | request a reset for the test account | email arrives; provider-hosted page completes; old password fails, new one signs in |
| Email change | settings → Change email, with a second test inbox | wrong password is refused; link arrives at the **new** address; old address still signs in until the link is opened; after opening, the new one signs in |
| Profile text | create/edit a profile with a display name, status and bio | values survive save, rename and primary-wallet change; over-limit text is refused with a message; a second signed-in account can read the profile |
| Profile visibility | set visibility to Contacts only, then open the handle from a second account | the second account sees a “not public” message; the owner still reads it; making it public restores the read |
| Account export | signed-in profile → Download my data | JSON downloads with profile/contacts/requests/blocks, no email or key material; the note states transcripts and sign-in data are excluded |
| Change password | reauthenticate → change | current password required; new password signs in after sign-out |
| Chat smoke | two wallets, one message | send 200, receive on the other device, ack clears |
| Read-only release check | `npm run verify:messenger-p3` | no writes, no transaction |
| Deployed-site check | `npm run verify:deployed` | 8 passed / 0 failed (advisory allowed) |

No transaction and no funds should be involved in a deployment check. If a
check requires moving funds, it is not a deployment check.

---

## 8. Rollback

| Layer | Rollback | Verification |
|---|---|---|
| Static site | re-point symlink to previous webroot; reload Caddy | `curl -I`, homepage marker |
| Gateway | restore previous `server.js`/`chat-relay.mjs` from the backup; restart launchd job | `/health`, signed chat read |
| Chat DB | stop gateway, restore the prior SQLite file, start gateway | `PRAGMA integrity_check`, signed read |
| Firestore rules | re-publish the previous ruleset id from console history | contact screen read/write; unauthenticated deny |

Rollback order is the reverse of deploy: site → gateway → rules. Rolling rules
back while a newer client expects new fields can break that client; roll the
site back first.

**Data downgrade is not automatic.** The relay schema is additive only; an older
binary can read a newer database only if no destructive change was made. There is
no schema-version table.

---

## 9. Migrations

- **Relay schema**: `CREATE TABLE IF NOT EXISTS` only. Additive changes are
  idempotent. A destructive change requires a written migration + backup +
  rollback plan, and should add a schema-version table first.
- **Client chat data**: `lib/chatMigration.js` re-encrypts archive and payment
  inbox rows from the wallet seed to the chat identity. It is copy-first and
  guarded by `scw-chat-identity-migrated-v1:<ADDRESS>`; the marker is written
  only after both migrations succeed. Tests:
  `tests/chat-archive-migration.test.mjs`.
- **Firestore**: no runner. Field additions are safe (rules allowlist must be
  updated in the same release); renames need a backfill script and a
  compatibility window.

---

## 10. Backup and restore

**Backup (operational today):** copy the SQLite file and run `integrity_check`
before every gateway deploy; keep the webroot and ruleset ids in the release
record. Retention of these backups is operator-defined.

**Restore drill (documented, not yet executed):**

1. Stop the gateway launchd job.
2. Move the current database aside (do not delete).
3. Copy the backup into `NSAT_CHAT_DB`.
4. Run `PRAGMA integrity_check`.
5. Start the gateway; verify `/health`.
6. Sign a `GET /api/v1/chat/messages?limit=1` with a test wallet and confirm a
   well-formed response.
7. Send a test message between two disposable wallets and ack it.

A restore is not proven until this drill has been run and recorded. It has not
been run in this audit.

---

## 11. Operations

| Concern | Action |
|---|---|
| Retention | Automatic: 7 days, plus deletion when every device acks. No manual purge needed. |
| Disk growth | Bounded by per-mailbox 5,000 × 8 KiB and 10 devices; monitor the SQLite file and `data/` directory. |
| Quotas | `NSAT_CHAT_MAX_PENDING` and `NSAT_CHAT_GC_MS` are the only operator knobs; changing `MAX_MESSAGES_PER_SENDER_PER_DAY` requires a code change. |
| Logs | JSON lines on stdout: `chat_relay_failed`, `rate_limited`, `core_info_failed`. No message bodies are logged. Ship to the operator's log store. |
| Health | `/health` (gateway), `/api/v1/network/status` (chain identity). There is **no** relay-specific health or delivery-failure metric. |
| Key rotation | No relay signing key exists (requests are signed by users). Wallet/chat identity rotation is not implemented. |
| Multi-instance | **Not supported.** One gateway process per SQLite file; a second writer on a shared filesystem is unsafe. |

---

## 12. Deployment record — web 2026-11-17 07:34; gateway hotfix 2026-11-17 07:28

| Item | Value |
|---|---|
| Web release | `~/nsat-ops/satoshicore-webroot-chat-fix-20261117-073403` |
| Live symlink | `~/nsat-ops/satoshicore-webroot` → the release above |
| Previous web release | `~/nsat-ops/satoshicore-webroot-chat-m1-20261116-224031` |
| Gateway backup | `~/nsat-ops/backups/chat-rate-ip-20261117-072836/` (pre-rate-fix server.js; chat-relay.mjs with SSE-v3 fix) |
| Earlier gateway backup | `~/nsat-ops/backups/chat-sse-v3-20261117-072632/` (pre-SSE-v3 chat-relay.mjs) |
| Original gateway backup | `~/nsat-ops/backups/chat-m1-20261116-223314/` (server.js, chat-relay.mjs, SQLite) |
| Web backup | `~/nsat-ops/backups/web-chat-m1-20261116-223409/out` |
| Build | `.messenger-audit/out` built with the production Firebase public config, `NEXT_PUBLIC_CHAT_RELAY=1`, `NEXT_PUBLIC_API_SAME_ORIGIN=1` |
| Gate | `node tests/static-export.test.mjs` 12/12; `node tests/security-scan.mjs out` passed |
| Gateway check | `http://127.0.0.1:8787/health` 200; `/api/v1/chat/presence` and `/events` 401 (routes present) |
| Public check | `https://satoshicore.org/wallet/` 200, `page-b4b1976b1ff51d29.js` + new chat chunk `282-9615f16a185c0555.js`; browser console empty; `/api/v1/chain/info` 200 |
| Hotfix checks | SSE v3 `/chat/events` 200 (unsigned still 401); UI send **Sent**, recipient decrypt + reply, sender bubble **Read**; no 429 |
| Production smoke (2026-11-17) | Two throwaway runs over `https://gateway.satoshicore.org` (wallet-signed and delegated v3): publish → send → decrypt → read receipt → ack, **13/13 checks**; keys/messages/devices/quota rows removed; DB `integrity_check` `ok` |

**Rollback web:**

```bash
ln -sfn ~/nsat-ops/satoshicore-webroot-chat-m1-20261116-224031 \
  ~/nsat-ops/satoshicore-webroot
```

**Rollback gateway:** copy `server.js` and `chat-relay.mjs` from
`~/nsat-ops/backups/chat-m1-20261116-223314/` back to `~/nsat-ops/gateway/`
(and `data/chat.sqlite` if restoring data), then restart
`org.satoshicore.gateway`. The 2026-11-17 hotfix is reverted by this too.

Production chat login was **not** exercised with an operator wallet seed. The
signed-out gate, same-origin API calls, unsigned chat 401s and the new asset were
verified in a browser. On 2026-11-17 the browser UI sent and received a message
with two disposable wallets, the recipient decrypted it and replied, and the
sender showed **Read**; the deployed relay was also exercised in wallet-signed
and delegated-v3 runs (13/13 checks). Google sign-in and an operator wallet seed
remain untested.

## 13. What cannot be deployed yet

| Requested capability | Why it cannot be deployed |
|---|---|
| Email/password registration, verification, reset, change | Email/Password was enabled on 2026-11-17 and two live accounts were created/signed in. The full acceptance still needs delivery/click of verification, reset and email-change links; do not call those verified until §7 passes with a live inbox. |
| Logout-all, session/device admin | No Admin SDK backend |
| Privacy settings (A6) | No schema or enforcement |
| Roles, suspension, reports, admin audit | Not implemented |
| Groups, invitations, group roles | Not implemented |
| Attachments, voice, previews, scanning | No storage/scanning infrastructure |
| Realtime push, typing, presence | No WebSocket/push service |
| Account deletion/export | No server-side account authority |
| Federation | Not implemented; would require a Matrix homeserver, not this relay |

Deploying a UI for any of these would violate the project rule against
non-functional surfaces. They stay out of the build until backed by real
services.

---

## 13. Production record to preserve

From the last approved deployment (details and evidence in
`docs/messenger/RELEASE-READINESS.md`):

| Item | Value |
|---|---|
| Firestore ruleset | `e4bac944-e3f3-4765-83fd-a4583dccb127` |
| Previous ruleset | `1f1bbce6-cf44-49f2-b2da-59b46b55a2e9` |
| Gateway service | launchd `org.satoshicore.gateway` |
| Gateway backup | `~/nsat-ops/backups/gateway-v2-20261116-173125` |
| Live webroot symlink | `satoshicore-webroot-chat-inbox-20261116-164328` |
| `/health` expectation | `{"status":"ok","service":"satoshicore-api-gateway",...}` |

Verify these against the host before the next deploy; do not assume they are
still current.
