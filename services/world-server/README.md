# satoshicore-world-server

The Pixel World presence service: one Colyseus room per city, joined with a
single-use ticket minted after the player's existing Firebase session is verified.
It holds no keys, no wallet state, no message and no location history — a player
who disconnects is forgotten, and a restart starts every city empty.

Implemented slice: identity hand-off + city presence + movement validation +
server-side wallet-recipient re-check. No renderer yet.

## Run

```bash
cd services/world-server
npm ci
FIREBASE_PROJECT_ID=satoshicore \
WORLD_TICKET_SECRET="$(openssl rand -hex 32)" \
WORLD_ALLOWED_ORIGINS=https://wallet.satoshicore.org \
npm start
```

`npm test` runs the unit suite and an end-to-end test that starts a real server,
mints real tickets, connects two Colyseus clients, moves an avatar and checks the
rejections (spent ticket, wrong city, teleport, unverified wallet).

## Environment

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `FIREBASE_PROJECT_ID` | yes | — | Project whose ID tokens are accepted; also the Firestore project read with the caller's token |
| `WORLD_TICKET_SECRET` | yes | — | HMAC key for join tickets, at least 32 characters. Server-side only |
| `WORLD_PORT` / `PORT` | no | `8790` | Listen port |
| `WORLD_HOST` | no | `127.0.0.1` | Bind address. Loopback unless an operator deliberately exposes it |
| `WORLD_TICKET_TTL_MS` | no | `60000` | Ticket lifetime, 5 s – 10 min |
| `WORLD_ALLOWED_ORIGINS` | for a browser client | — | Comma-separated exact origins; a request from any other origin is refused |

A missing secret, a missing project id or an unusable port stops the process with a
readable reason. There is no "skip auth" switch.

## Endpoints

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| `GET` | `/api/world/health` | — | `{ ok, service, cities[] }` |
| `POST` | `/api/world/ticket` | `{ characterId, city }` + `Authorization: Bearer <Firebase ID token>` | `{ ticket, room, characterId, expiresInMs }` |
| `POST` | `/api/world/recipient` | `{ ownerUid, characterId }` + the same header | `{ address, characterId }` or a refusal code |

The ticket body is `{ uid, characterId, city, name, appearance }` — never an
address. `/recipient` re-runs `resolveRecipient` from `lib/characters.js`, so a
character with no verified binding, a tombstoned character, or a tampered
document is refused before any client shows a "send NSAT" action.

Join with the returned ticket and room name:

```js
const room = await client.joinOrCreate('city:bangkok', { ticket });
room.send('move', { x, y, facing: 'right' });
```

## Security properties

- The ID token is verified locally with `node:crypto` against Google's published
  certificates; `alg` must be `RS256`, and audience, issuer, `sub` and the time
  window are all checked. No service account or admin SDK is used.
- Character documents are read through the Firestore REST API with the caller's
  own ID token, so `firestore.rules` decides visibility. The service cannot read
  a document the rules would deny.
- Tickets are HMAC-signed, expire in a minute, are consumed atomically on first
  use, and are bound to one city.
- Presence is in memory and never persisted; logs carry events and counts, not
  coordinates or tokens.
- Positions are clamped to the city rectangle and speed-budgeted against the
  server's own clock. This is anti-cheat for a social room, not a simulation: if
  gameplay ever depends on standing somewhere, the server must own the movement.

## Not implemented yet

- No renderer, no map data, no collision beyond the rectangle.
- Character creation UI and the chat entry point ("visit world", "send NSAT")
  still belong to the next slice.
- Rooms live in one process; there is no multi-node room placement or persistence.
