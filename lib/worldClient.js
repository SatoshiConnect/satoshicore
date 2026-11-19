// The browser side of the world service: ask for a single-use join ticket with
// the Firebase session the account already has, then open the Colyseus room.
//
// The socket carries the ticket, never the ID token, and the ticket is bound to
// one character and one city. Nothing here knows a wallet or a key.
import { CHARACTER_ID_RE } from './characters.js';

export const DEFAULT_WORLD_URL = 'http://127.0.0.1:8790';

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

export function worldBaseUrl(value) {
  const raw = value || process.env.NEXT_PUBLIC_WORLD_URL || DEFAULT_WORLD_URL;
  return String(raw).replace(/\/+$/, '');
}

/** http(s)://host:port → ws(s)://host:port for the Colyseus client. */
export function websocketUrl(base) {
  const url = new URL(base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.origin;
}

const TICKET_MESSAGES = {
  'missing-token': 'Your session ended. Sign in again.',
  'invalid-token': 'Your session ended. Sign in again.',
  'identity-unavailable': 'The world could not verify your session right now.',
  'unknown-city': 'That city is not open yet.',
  'bad-character-id': 'Pick a character first.',
  'character-unavailable': 'That character is not available in the world.',
  'rate-limited': 'Slow down a moment, then try again.',
};

/** Exchange the account's ID token for one ticket. */
export async function requestTicket({
  idToken, characterId, city, base = worldBaseUrl(), fetchImpl = fetch,
}) {
  if (!idToken) throw fail('missing-token', TICKET_MESSAGES['missing-token']);
  if (!CHARACTER_ID_RE.test(String(characterId || ''))) {
    throw fail('bad-character-id', TICKET_MESSAGES['bad-character-id']);
  }
  if (!city) throw fail('unknown-city', TICKET_MESSAGES['unknown-city']);

  let response;
  try {
    response = await fetchImpl(`${base}/api/world/ticket`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ characterId, city }),
    });
  } catch {
    throw fail('world-offline', 'The world server is not reachable.');
  }

  if (!response.ok) {
    let code = '';
    try {
      const body = await response.json();
      code = typeof body?.error === 'string' ? body.error : '';
    } catch {
      code = '';
    }
    throw fail(code || `http-${response.status}`,
      TICKET_MESSAGES[code] || 'The world refused that join.');
  }

  const body = await response.json();
  if (!body || typeof body.ticket !== 'string' || !body.ticket) {
    throw fail('bad-ticket', 'The world returned an unusable ticket.');
  }
  if (typeof body.room !== 'string' || !body.room) {
    throw fail('bad-ticket', 'The world returned no room.');
  }
  return { ticket: body.ticket, room: body.room, characterId };
}

/**
 * Join a city room.
 *
 * The Colyseus SDK is imported lazily so the static export does not pull the
 * socket client into the server render, and so a person who never opens the
 * world never downloads it.
 */
export async function joinCity({
  idToken, characterId, city, base = worldBaseUrl(), fetchImpl = fetch, ClientClass = null,
}) {
  const pass = await requestTicket({ idToken, characterId, city, base, fetchImpl });
  const sdk = ClientClass ? { Client: ClientClass } : await import('@colyseus/sdk');
  const client = new sdk.Client(websocketUrl(base));
  let room;
  try {
    room = await client.joinOrCreate(pass.room, { ticket: pass.ticket });
  } catch (error) {
    client.close?.();
    throw fail('join-rejected', 'The city room rejected that join.');
  }
  return { client, room, roomName: pass.room };
}
