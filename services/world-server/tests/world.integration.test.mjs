// The whole slice in one test: real HTTP, real tickets, real Colyseus rooms, two
// clients. Identity verification and Firestore are injected because the point is
// this service's behaviour, not Google's uptime.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import nacl from 'tweetnacl';
import { Client } from '@colyseus/sdk';
import { createWalletBinding } from '../../../lib/characters.js';
import { encodeG } from '../../../lib/nsatCodec.js';
import { isWalkablePixel, mapForCity } from '../../../lib/worldMap.js';
import { startWorldServer } from '../app.mjs';
import { CITIES } from '../lib/cities.mjs';

const SECRET = 'integration-secret-'.padEnd(48, 'x');
const OWNER = 'uid-1';
const OTHER = 'uid-2';
const ID_A = 'ch_' + 'a1'.repeat(16);
const ID_B = 'ch_' + 'b2'.repeat(16);
const SEED = new Uint8Array(32).fill(11);
const ADDRESS = encodeG(nacl.sign.keyPair.fromSeed(SEED).publicKey);

const appearance = { v: 1, skin: 1, hair: 2, outfit: 3, accessory: 0 };
const binding = createWalletBinding({
  walletSeed32: SEED, characterId: ID_A, owner: OWNER, address: ADDRESS, issuedAt: 1_700_000_000_000,
});
const characters = {
  [`${OWNER}/${ID_A}`]: {
    characterId: ID_A, owner: OWNER, name: 'Mali', appearance, walletBinding: binding,
    lastWallet: null, createdAt: 1, updatedAt: 1, deletedAt: null,
  },
  [`${OTHER}/${ID_B}`]: {
    characterId: ID_B, owner: OTHER, name: 'Somsak', appearance, walletBinding: null,
    lastWallet: null, createdAt: 1, updatedAt: 1, deletedAt: null,
  },
};

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitFor(check, { timeoutMs = 6000, stepMs = 40 } = {}) {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for world state');
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

const playersOf = (room) => {
  const seen = {};
  room.state.players.forEach((player, sessionId) => { seen[sessionId] = { ...player }; });
  return seen;
};

test('world service: tickets, presence, movement and recipient checks', async (t) => {
  const port = await freePort();
  const config = {
    port, host: '127.0.0.1', projectId: 'satoshicore-test',
    ticketSecret: SECRET, allowedOrigins: [], ticketTtlMs: 60_000, exposed: false,
  };
  const verifyIdToken = async (token) => {
    if (token === 'token-owner') return { uid: OWNER, emailVerified: true };
    if (token === 'token-other') return { uid: OTHER, emailVerified: true };
    return null;
  };
  const readCharacter = async ({ uid, characterId }) => characters[`${uid}/${characterId}`] || null;

  const running = await startWorldServer({ config, verifyIdToken, readCharacter });
  const base = `http://127.0.0.1:${port}`;
  const rooms = [];
  t.after(async () => {
    await Promise.all(rooms.map((room) => room.leave().catch(() => {})));
    await running.close();
  });

  const call = (path, { token, body, method = 'POST' } = {}) => fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  // ---- HTTP surface -------------------------------------------------------
  const health = await call('/api/world/health', { method: 'GET' });
  assert.equal(health.status, 200);
  const healthBody = await health.json();
  assert.equal(healthBody.ok, true);
  assert.equal(healthBody.cities.length, CITIES.length);

  assert.equal((await call('/api/world/ticket', { body: { city: 'bangkok', characterId: ID_A } })).status, 401);
  assert.equal((await call('/api/world/ticket', { token: 'nope', body: { city: 'bangkok', characterId: ID_A } })).status, 401);
  assert.equal((await call('/api/world/ticket', { token: 'token-owner', body: { city: 'atlantis', characterId: ID_A } })).status, 400);
  assert.equal((await call('/api/world/ticket', { token: 'token-owner', body: { city: 'bangkok', characterId: 'name-only' } })).status, 400);

  const issued = await call('/api/world/ticket', { token: 'token-owner', body: { city: 'bangkok', characterId: ID_A } });
  assert.equal(issued.status, 200);
  const first = await issued.json();
  assert.equal(first.room, 'city:bangkok');
  assert.ok(first.ticket);
  // The wallet address is never part of what a client receives for presence.
  assert.equal(JSON.stringify(first).includes(ADDRESS), false);

  const second = await (await call('/api/world/ticket', { token: 'token-other', body: { city: 'bangkok', characterId: ID_B } })).json();
  const bangkokOnly = await (await call('/api/world/ticket', { token: 'token-other', body: { city: 'bangkok', characterId: ID_B } })).json();

  const recipient = await call('/api/world/recipient', { token: 'token-other', body: { ownerUid: OWNER, characterId: ID_A } });
  assert.equal(recipient.status, 200);
  assert.equal((await recipient.json()).address, ADDRESS);

  // A character with no binding cannot be paid, and a name is never an address.
  const unbound = await call('/api/world/recipient', { token: 'token-owner', body: { ownerUid: OTHER, characterId: ID_B } });
  assert.equal(unbound.status, 403);
  assert.equal((await unbound.json()).error, 'unverified-wallet');

  // ---- sockets ------------------------------------------------------------
  const clientA = new Client(`ws://127.0.0.1:${port}`);
  const clientB = new Client(`ws://127.0.0.1:${port}`);
  const roomA = await clientA.joinOrCreate('city:bangkok', { ticket: first.ticket });
  const roomB = await clientB.joinOrCreate('city:bangkok', { ticket: second.ticket });
  rooms.push(roomA, roomB);

  const both = await waitFor(() => {
    const players = playersOf(roomA);
    return Object.keys(players).length === 2 && players;
  });
  assert.equal(both[roomA.sessionId].characterId, ID_A);
  assert.equal(both[roomA.sessionId].name, 'Mali');
  const seenByB = await waitFor(() => {
    const players = playersOf(roomB);
    return Object.keys(players).length === 2 && players;
  });
  assert.equal(seenByB[roomA.sessionId].characterId, ID_A);
  assert.equal(seenByB[roomB.sessionId].name, 'Somsak');

  // A move is accepted within the walking budget and reaches the other client.
  // The server now checks the shared tile map, so the step is chosen from the
  // directions the map says are open instead of assuming the spawn is clear.
  const cityMap = mapForCity({ id: 'bangkok', width: 1280, height: 960 });
  const start = { x: both[roomA.sessionId].x, y: both[roomA.sessionId].y };
  const candidates = [[20, 0, 'right'], [-20, 0, 'left'], [0, 20, 'down'], [0, -20, 'up']];
  const step = candidates.find(([dx, dy]) => isWalkablePixel(cityMap, start.x + dx, start.y + dy));
  assert.ok(step, 'a legal step exists at the spawn');
  const [dx, dy, facing] = step;
  roomA.send('move', { x: start.x + dx, y: start.y + dy, facing });
  await waitFor(() => {
    const seen = playersOf(roomB)[roomA.sessionId];
    return seen && seen.x === start.x + dx && seen.y === start.y + dy;
  });
  assert.equal(playersOf(roomB)[roomA.sessionId].facing, facing);

  // The collision check is the server's, not the page's: a point inside a
  // blocked tile is dropped even when it is close enough for the walking budget.
  const blockedNearby = [];
  for (let oy = -12; oy <= 12; oy += 4) {
    for (let ox = -12; ox <= 12; ox += 4) {
      const target = { x: start.x + dx + ox, y: start.y + dy + oy };
      if (!isWalkablePixel(cityMap, target.x, target.y)) blockedNearby.push(target);
    }
  }
  if (blockedNearby.length) {
    roomA.send('move', { ...blockedNearby[0], facing });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const after = playersOf(roomB)[roomA.sessionId];
    assert.deepEqual({ x: after.x, y: after.y }, { x: start.x + dx, y: start.y + dy });
  }

  // A teleport is dropped by the server, so the other client never sees it.
  roomA.send('move', { x: start.x + 900, y: start.y, facing: 'right' });
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(playersOf(roomB)[roomA.sessionId].x, start.x + dx);

  // A spent ticket cannot open a second connection.
  const replayClient = new Client(`ws://127.0.0.1:${port}`);
  await assert.rejects(replayClient.joinOrCreate('city:bangkok', { ticket: first.ticket }));

  // A ticket minted for Bangkok cannot enter Chiang Mai.
  const crossClient = new Client(`ws://127.0.0.1:${port}`);
  await assert.rejects(crossClient.joinOrCreate('city:chiang-mai', { ticket: bangkokOnly.ticket }));

  // Leaving removes presence for the other side.
  await roomB.leave();
  await waitFor(() => Object.keys(playersOf(roomA)).length === 1);
});
