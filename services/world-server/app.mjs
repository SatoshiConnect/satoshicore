// The world service: three HTTP endpoints and a Colyseus room per city.
//
//   GET  /api/world/health      liveness plus the public city list
//   POST /api/world/ticket      Firebase ID token → single-use join ticket
//   POST /api/world/recipient   verified character → wallet address, checked here
//
// Identity is the account system's, not ours: the browser sends the Firebase ID
// token it already holds, this service verifies it against Google's certificates,
// then reads the character document with that same token so firestore.rules
// decides what the caller may see. No service account, no admin credential, no
// second login.
//
// The recipient endpoint exists because a client is not allowed to be the only
// thing that checks a wallet binding. It re-runs the same signature verification
// the page runs (`resolveRecipient`) before an address is ever shown next to a
// "send NSAT" action, and refuses a name, a tombstone or a tampered document.
import express from 'express';
import { Server } from 'colyseus';
import { CHARACTER_ID_RE, resolveRecipient } from '../../lib/characters.js';
import { CITIES, cityCatalog, cityRoomName, findCity } from './lib/cities.mjs';
import { createFirebaseVerifier } from './lib/firebaseToken.mjs';
import { createFirestoreReader } from './lib/firestore.mjs';
import { createTicketStore } from './lib/tickets.mjs';
import { createCityRoom } from './rooms/CityRoom.mjs';

export const TICKET_LIMIT = 12;
export const TICKET_WINDOW_MS = 60_000;

const badRequest = (res, code) => res.status(400).json({ error: code });
const forbidden = (res, code) => res.status(403).json({ error: code });

function bearerOf(req) {
  const header = req.get('authorization') || '';
  const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(header);
  return match ? match[1] : '';
}

/** Per-account ticket rate limit. Deliberately in memory and per process. */
function createTicketLimiter({ limit = TICKET_LIMIT, windowMs = TICKET_WINDOW_MS, now = Date.now } = {}) {
  const hits = new Map();
  return function allow(uid) {
    const at = now();
    const recent = (hits.get(uid) || []).filter((time) => at - time < windowMs);
    if (recent.length >= limit) {
      hits.set(uid, recent);
      return false;
    }
    recent.push(at);
    hits.set(uid, recent);
    if (hits.size > 5000) {
      for (const [key, times] of hits) {
        if (!times.length || at - times[times.length - 1] > windowMs) hits.delete(key);
      }
    }
    return true;
  };
}

function applyCors(app, allowedOrigins) {
  app.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin) {
      if (!allowedOrigins.includes(origin)) return forbidden(res, 'origin-not-allowed');
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    return next();
  });
}

/**
 * Mount the world routes onto the transport's Express app.
 *
 * Exported separately so a test can drive the HTTP surface without a socket.
 */
export function mountWorldRoutes(app, {
  tickets, verifyIdToken, readCharacter, allowedOrigins = [],
  now = Date.now, limiter = createTicketLimiter({ now }),
}) {
  if (allowedOrigins.length) applyCors(app, allowedOrigins);
  app.use(express.json({ limit: '8kb' }));

  const authenticate = async (req, res) => {
    const token = bearerOf(req);
    if (!token) {
      res.status(401).json({ error: 'missing-token' });
      return null;
    }
    let claims = null;
    try {
      claims = await verifyIdToken(token);
    } catch {
      res.status(503).json({ error: 'identity-unavailable' });
      return null;
    }
    if (!claims || !claims.uid) {
      res.status(401).json({ error: 'invalid-token' });
      return null;
    }
    return claims;
  };

  app.get('/api/world/health', (_req, res) => {
    res.json({ ok: true, service: 'satoshicore-world', cities: cityCatalog() });
  });

  app.post('/api/world/ticket', async (req, res) => {
    const claims = await authenticate(req, res);
    if (!claims) return undefined;
    const body = req.body || {};
    const city = findCity(body.city);
    if (!city) return badRequest(res, 'unknown-city');
    const characterId = typeof body.characterId === 'string' ? body.characterId.trim() : '';
    if (!CHARACTER_ID_RE.test(characterId)) return badRequest(res, 'bad-character-id');
    if (!limiter(claims.uid)) return res.status(429).json({ error: 'rate-limited' });

    let character;
    try {
      character = await readCharacter({
        idToken: bearerOf(req), uid: claims.uid, characterId,
      });
    } catch (error) {
      const status = error && error.status === 401 ? 401 : 502;
      return res.status(status).json({ error: 'character-unavailable' });
    }
    if (!character || character.owner !== claims.uid || character.deletedAt) {
      return forbidden(res, 'character-unavailable');
    }

    const ticket = tickets.mint({
      uid: claims.uid,
      characterId,
      city: city.id,
      name: character.name,
      appearance: character.appearance,
    });
    return res.json({
      ticket,
      room: cityRoomName(city.id),
      characterId,
      expiresInMs: tickets.ttlMs,
    });
  });

  app.post('/api/world/recipient', async (req, res) => {
    const claims = await authenticate(req, res);
    if (!claims) return undefined;
    const body = req.body || {};
    const ownerUid = typeof body.ownerUid === 'string' ? body.ownerUid.trim() : '';
    const characterId = typeof body.characterId === 'string' ? body.characterId.trim() : '';
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(ownerUid)) return badRequest(res, 'bad-owner');
    if (!CHARACTER_ID_RE.test(characterId)) return badRequest(res, 'bad-character-id');

    let character;
    try {
      character = await readCharacter({
        idToken: bearerOf(req), uid: ownerUid, characterId,
      });
    } catch {
      return res.status(502).json({ error: 'character-unavailable' });
    }
    if (!character) return res.status(404).json({ error: 'character-unavailable' });

    try {
      const recipient = resolveRecipient({ character });
      return res.json({ address: recipient.address, characterId: recipient.characterId });
    } catch (error) {
      return forbidden(res, error && error.code ? error.code : 'unverified-wallet');
    }
  });

  return app;
}

/**
 * Start the world service.
 *
 * All the dependencies that touch the network are injectable so the tests can
 * exercise the real routes and the real room without Google or Firestore.
 */
export async function startWorldServer({
  config, verifyIdToken, readCharacter, now = Date.now,
  cities = CITIES, log = () => {},
} = {}) {
  const verify = verifyIdToken
    || createFirebaseVerifier({ projectId: config.projectId, now });
  const read = readCharacter || createFirestoreReader({ projectId: config.projectId });
  const tickets = createTicketStore({ secret: config.ticketSecret, ttlMs: config.ticketTtlMs, now });

  const gameServer = new Server({
    greet: false,
    express: (app) => mountWorldRoutes(app, {
      tickets, verifyIdToken: verify, readCharacter: read,
      allowedOrigins: config.allowedOrigins, now,
    }),
  });

  for (const city of cities) {
    gameServer.define(cityRoomName(city.id), createCityRoom({ city, tickets, now }), city);
  }

  await gameServer.listen(config.port, config.host);
  log('world_listening', { port: config.port, host: config.host, cities: cities.length });

  return {
    gameServer,
    tickets,
    async close() {
      await gameServer.gracefullyShutdown(false);
    },
  };
}
