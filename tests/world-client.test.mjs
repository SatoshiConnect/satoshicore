import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_WORLD_URL, joinCity, requestTicket, websocketUrl, worldBaseUrl,
} from '../lib/worldClient.js';

const CHARACTER_ID = 'ch_0123456789abcdef0123456789abcdef';

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test('the world base url is trimmed and defaults to loopback', () => {
  assert.equal(worldBaseUrl('https://world.example/'), 'https://world.example');
  assert.equal(worldBaseUrl(''), process.env.NEXT_PUBLIC_WORLD_URL || DEFAULT_WORLD_URL);
});

test('the socket url keeps host and port, and upgrades the scheme', () => {
  assert.equal(websocketUrl('http://127.0.0.1:8790'), 'ws://127.0.0.1:8790');
  assert.equal(websocketUrl('https://world.example/'), 'wss://world.example');
  assert.equal(websocketUrl('http://localhost:8790/base/path'), 'ws://localhost:8790');
});

test('a ticket request carries the session and a character, never a wallet', async () => {
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return jsonResponse(200, { ticket: 'ticket-value', room: 'city:bangkok', characterId: CHARACTER_ID });
  };
  const pass = await requestTicket({
    idToken: 'id-token', characterId: CHARACTER_ID, city: 'bangkok',
    base: 'http://127.0.0.1:8790', fetchImpl,
  });
  assert.equal(pass.ticket, 'ticket-value');
  assert.equal(pass.room, 'city:bangkok');
  assert.equal(seen.url, 'http://127.0.0.1:8790/api/world/ticket');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers.authorization, 'Bearer id-token');
  assert.deepEqual(JSON.parse(seen.init.body), { characterId: CHARACTER_ID, city: 'bangkok' });
  assert.doesNotMatch(seen.init.body, /address|wallet/i);
});

test('a missing session is refused before any request', async () => {
  await assert.rejects(
    () => requestTicket({ idToken: '', characterId: CHARACTER_ID, city: 'bangkok' }),
    (error) => error.code === 'missing-token',
  );
});

test('an invalid character id is refused before any request', async () => {
  await assert.rejects(
    () => requestTicket({ idToken: 'token', characterId: 'Nok', city: 'bangkok' }),
    (error) => error.code === 'bad-character-id',
  );
});

test('a server refusal keeps its reason', async () => {
  await assert.rejects(
    () => requestTicket({
      idToken: 'token', characterId: CHARACTER_ID, city: 'bangkok',
      fetchImpl: async () => jsonResponse(403, { error: 'character-unavailable' }),
    }),
    (error) => error.code === 'character-unavailable' && /not available/.test(error.message),
  );
  await assert.rejects(
    () => requestTicket({
      idToken: 'token', characterId: CHARACTER_ID, city: 'bangkok',
      fetchImpl: async () => jsonResponse(429, { error: 'rate-limited' }),
    }),
    (error) => error.code === 'rate-limited' && /Slow down/.test(error.message),
  );
});

test('an unreachable server is reported as offline', async () => {
  await assert.rejects(
    () => requestTicket({
      idToken: 'token', characterId: CHARACTER_ID, city: 'bangkok',
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    }),
    (error) => error.code === 'world-offline',
  );
});

test('an unusable ticket body is refused', async () => {
  await assert.rejects(
    () => requestTicket({
      idToken: 'token', characterId: CHARACTER_ID, city: 'bangkok',
      fetchImpl: async () => jsonResponse(200, { room: 'city:bangkok' }),
    }),
    (error) => error.code === 'bad-ticket',
  );
});

test('joinCity joins the returned room with the ticket only', async () => {
  const calls = [];
  class FakeClient {
    constructor(url) {
      this.url = url;
      FakeClient.last = this;
    }

    async joinOrCreate(room, options) {
      calls.push({ room, options, url: this.url });
      return { sessionId: 'self-session', leave() {} };
    }

    close() { calls.push({ closed: true }); }
  }
  const { room, roomName } = await joinCity({
    idToken: 'token', characterId: CHARACTER_ID, city: 'bangkok',
    base: 'http://127.0.0.1:8790',
    fetchImpl: async () => jsonResponse(200, {
      ticket: 'ticket-value', room: 'city:bangkok', characterId: CHARACTER_ID,
    }),
    ClientClass: FakeClient,
  });
  assert.equal(room.sessionId, 'self-session');
  assert.equal(roomName, 'city:bangkok');
  assert.equal(calls[0].url, 'ws://127.0.0.1:8790');
  assert.equal(calls[0].room, 'city:bangkok');
  assert.deepEqual(calls[0].options, { ticket: 'ticket-value' });
});
