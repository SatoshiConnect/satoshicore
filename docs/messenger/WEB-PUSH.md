# Web Push — background alerts for the encrypted chat

Status: **IMPLEMENTED → VERIFIED in tests (not deployed)**.

The wallet can now tell a person that an encrypted message arrived while the app
is closed. It is opt-in, per device, and it carries no conversation.

## 1. What crosses the wire

| Hop | What it sees |
|---|---|
| Gateway relay | The pair of wallet addresses (it already stores envelopes for them), the message size and time — unchanged by this feature |
| Push service (FCM / Mozilla autopush / Apple) | An endpoint, an encrypted payload of ~30 bytes, and the timing of the push |
| Browser / service worker | Decrypts the payload; it contains `{"v":1,"peer":"G…"}` only |
| Notification shown to the person | A fixed sentence written on the device: "New encrypted message. Open it to decrypt on this device." |

Deliberately **not** in the payload: message text, sender name, ciphertext,
unread count, message id. The alert is a wake-up; the message itself is still
fetched and decrypted by the signed relay API on the device.

The honest trade-off: even though the payload is encrypted end-to-end to the
browser subscription (RFC 8291), the push service learns that *this device*
received *an* alert and when. That is why the UI shows the disclosure below
before it subscribes anything, and why the control is per device.

## 2. Opt-in UX

- Location: chat → details (ⓘ) → **Background alerts**.
- First tap opens a disclosure panel; nothing is requested until
  **Turn on alerts** is pressed inside it.
- Turning it on: `Notification.requestPermission()` → `pushManager.subscribe({
  userVisibleOnly: true, applicationServerKey })` → signed
  `POST /api/v1/chat/push` with `{ endpoint, keys }`.
- Turning it off: `subscription.unsubscribe()` → signed
  `POST /api/v1/chat/push/remove` → the local opt-in flag is cleared.
- The preference is stored per wallet address in `scw-chat-push-v1`
  (localStorage). It contains no endpoint and no key.
- When the browser cannot do it, the button is disabled with the reason:
  `not-configured` (build has no VAPID key), `unsupported` (no PushManager),
  `insecure` (plain HTTP origin), `install-first` (iOS Safari tab — Add to Home
  Screen is required for web push).

The app icon badge is separate and not opt-in: it shows the total unread the
list already displays (`navigator.setAppBadge`), computed locally, no request.

## 3. Relay behaviour

New tables in the chat SQLite file:

- `chat_push_subs(address, endpoint, p256dh, auth, created_at, updated_at)` —
  max 5 per wallet, oldest evicted on the sixth.
- `chat_push_queue(id, address, peer, created_at, attempts, next_at, claimed_at)`
  — a durable "wake this wallet" row.

Queue rules:

- Enqueued only when the recipient has at least one subscription and the
  recipient is not the sender.
- One pending row per wallet: a burst of messages becomes one notification, and
  that row's `peer` moves to the newest sender, so the tap opens the
  conversation the person just heard from.
- A drain pass (`relay.pushTick()`, timer in `server.js` every
  `NSAT_PUSH_INTERVAL_MS`, default 2.5 s) claims rows, sends, and:
  - deletes the row when at least one device accepted it;
  - deletes the subscription on `404`/`410` (browser uninstalled or cleared);
  - reschedules with exponential backoff on other failures (30 s → 10 min,
    max 5 attempts), then drops the row;
  - returns a claim older than 5 minutes to the queue, so a crash cannot strand
    an alert.
- Blocking a peer deletes queued alerts in both directions.
- Without VAPID keys nothing is enqueued, `POST /chat/push` answers `503`, and
  messages keep working.

## 4. Service worker

`public/sw.js` gained two handlers:

- `push` — parses the routing hint, validates it against `^G[A-Z2-7]{55}$`, and
  shows one notification (`tag: 'nsat-chat'`, icon from the shell). A missing or
  malformed payload still alerts, and opens the chat screen.
- `notificationclick` — closes the notification, focuses an existing window of
  this scope and navigates it to `/wallet/?peer=G…`, or opens a new window when
  none exists.

`ChatPanel` consumes `?peer=` once (via `history.replaceState`), then reuses the
existing `pendingPeer` path — so an alert that arrives while the wallet is
locked opens the room right after unlock.

## 5. Configuration

```sh
node scripts/generate-vapid-keys.mjs
```

Gateway (server-side, never in the repo):

```sh
NSAT_VAPID_PUBLIC_KEY=<public>
NSAT_VAPID_PRIVATE_KEY=<private>
NSAT_VAPID_SUBJECT=mailto:ops@satoshicore.org
```

Web build (public, safe to publish):

```sh
NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY=<public>
```

Rotating the pair invalidates every existing subscription; each device
re-subscribes the next time somebody turns alerts on.

## 6. Verification

```sh
node --test tests/chat-push.test.mjs      # queue, payload privacy, routes, eviction, retry, 410, block
node --test tests/web-push.test.mjs       # key validation, capability reasons, opt-in, badge
node --test tests/service-worker.test.mjs # push/notificationclick behaviour in a fake SW global
```

Manual acceptance on a real device (not yet performed):

1. Build with the public key, serve over HTTPS, install/open the app.
2. Chat → ⓘ → Background alerts → read the disclosure → Turn on alerts.
3. Close the tab (or the app), send a message from another wallet.
4. Expect one OS notification with no text; tapping it opens that conversation.
5. Turn alerts off, send again: no notification, and the message still arrives
   in the list when the app is opened.

## 7. Limitations

- iOS requires the site to be added to the Home Screen (16.4+); a Safari tab
  cannot subscribe — the UI says so instead of failing silently.
- The alert has no per-chat granularity beyond the room it opens, and no
  notification actions (reply from the notification is not implemented).
- A muted chat still pushes: mute is a local UI preference the relay does not
  know. Suppressing it would need a relay-side per-peer flag, which is a
  metadata change worth designing separately.
- Notification permission is per origin, not per wallet: a second wallet on the
  same device shares the browser permission but registers its own subscription.
- Tapping an alert when the app is open somewhere else in the same window
  navigates that window to `/wallet/?peer=G…`. Because the wallet keeps its seed
  in memory only, that reload ends the unlocked session and asks for the
  password again. A window already on the target room is only focused, never
  reloaded. Follow-up worth doing: a `postMessage` handshake so an unlocked tab
  switches rooms without navigating.
