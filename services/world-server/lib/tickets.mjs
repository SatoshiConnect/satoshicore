// Short-lived, single-use join tickets.
//
// The proof of identity is the Firebase ID token, but that token must not be
// handed to the game socket: it is long-lived, it is the account's credential,
// and a game connection has no business holding it. The HTTP endpoint verifies
// the ID token once and mints a ticket that says exactly three things:
//
//   who (uid) · which character · which city, until when
//
// The ticket is signed with a server-only HMAC key, expires in a minute, and is
// consumed on first use. A ticket is not a login: it cannot be refreshed, cannot
// join a second city, and cannot be replayed by a client that captured it.
//
// The spent-ticket ledger is in memory. A restart forgets it, which is fine —
// tickets live for a minute and carry their own expiry — and no ticket is ever
// written to disk or to a database.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const TICKET_VERSION = 1;
export const DEFAULT_TTL_MS = 60_000;
// Enough headroom for a busy city without letting the ledger grow without bound.
export const MAX_SPENT_TICKETS = 20_000;

const b64url = (buffer) => Buffer.from(buffer).toString('base64url');

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function createTicketStore({
  secret, ttlMs = DEFAULT_TTL_MS, now = Date.now, maxSpent = MAX_SPENT_TICKETS,
} = {}) {
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new Error('A world ticket secret of at least 32 characters is required.');
  }
  if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > 10 * 60_000) {
    throw new Error('Ticket lifetime must be between 1 ms and 10 minutes.');
  }
  const spent = new Map();

  const sign = (body) => createHmac('sha256', secret).update(body).digest();

  function sweep(at) {
    for (const [jti, exp] of spent) {
      if (exp <= at) spent.delete(jti);
    }
    // A burst of invalid-but-well-signed tickets must not unbound the ledger.
    if (spent.size > maxSpent) {
      const excess = spent.size - maxSpent;
      let removed = 0;
      for (const jti of spent.keys()) {
        spent.delete(jti);
        removed += 1;
        if (removed >= excess) break;
      }
    }
  }

  return {
    ttlMs,

    /**
     * Mint a ticket for one character in one city.
     *
     * The name and appearance are copied into the ticket because they are what
     * other players see in the room; the wallet address is deliberately absent,
     * so presence never becomes an address directory.
     */
    mint({ uid, characterId, city, name = '', appearance = null, at = now() }) {
      if (typeof uid !== 'string' || !uid) throw new Error('A ticket needs a uid.');
      if (typeof characterId !== 'string' || !characterId) throw new Error('A ticket needs a character id.');
      if (typeof city !== 'string' || !city) throw new Error('A ticket needs a city.');
      sweep(at);
      const payload = {
        v: TICKET_VERSION,
        jti: randomBytes(16).toString('hex'),
        uid,
        characterId,
        city,
        name: String(name).slice(0, 24),
        appearance,
        iat: at,
        exp: at + ttlMs,
      };
      const body = b64url(JSON.stringify(payload));
      return `${body}.${b64url(sign(body))}`;
    },

    /**
     * Verify and spend a ticket. Returns the claims, or null for every failure.
     *
     * Consuming is atomic within this process: verification and the spent-ledger
     * write happen in the same synchronous step, so two sockets cannot both win
     * with the same ticket.
     */
    consume(token, { city } = {}, at = now()) {
      if (typeof token !== 'string' || token.length > 2048) return null;
      const parts = token.split('.');
      if (parts.length !== 2) return null;
      const [body, signature] = parts;
      const expected = sign(body);
      let given;
      try {
        given = Buffer.from(signature, 'base64url');
      } catch {
        return null;
      }
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
      const claims = parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (!claims || claims.v !== TICKET_VERSION) return null;
      if (typeof claims.jti !== 'string' || claims.jti.length < 16) return null;
      if (!Number.isFinite(claims.exp) || claims.exp <= at) return null;
      if (!Number.isFinite(claims.iat) || claims.iat > at + 5_000) return null;
      if (city && claims.city !== city) return null;
      sweep(at);
      if (spent.has(claims.jti)) return null;
      spent.set(claims.jti, claims.exp);
      return claims;
    },

    /** For tests and health output: how many unexpired spent tickets are held. */
    spentCount(at = now()) {
      sweep(at);
      return spent.size;
    },
  };
}
