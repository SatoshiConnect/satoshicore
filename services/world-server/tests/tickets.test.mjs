// A ticket is the only thing a socket presents, so its failures must be boring:
// expired, replayed, retargeted at another city, tampered with, or signed with a
// different key all return null.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTicketStore } from '../lib/tickets.mjs';

const SECRET = 'x'.repeat(48);
const at = 1_700_000_000_000;
const store = () => createTicketStore({ secret: SECRET, ttlMs: 60_000, now: () => at });

const mint = (over = {}) => store().mint({
  uid: 'uid-1', characterId: 'ch_' + 'ab'.repeat(16), city: 'bangkok',
  name: 'Mali', appearance: { v: 1, skin: 2, hair: 1, outfit: 4, accessory: 0 }, ...over,
});

test('a ticket carries identity, character and city, and no address', () => {
  const tickets = store();
  const token = tickets.mint({
    uid: 'uid-1', characterId: 'ch_' + 'ab'.repeat(16), city: 'bangkok',
    name: 'Mali', appearance: { v: 1, skin: 2, hair: 1, outfit: 4, accessory: 0 },
  });
  const claims = tickets.consume(token, { city: 'bangkok' });
  assert.equal(claims.uid, 'uid-1');
  assert.equal(claims.city, 'bangkok');
  assert.equal(claims.name, 'Mali');
  assert.equal(claims.appearance.skin, 2);
  assert.equal('address' in claims, false);
  assert.match(claims.jti, /^[0-9a-f]{32}$/);
});

test('a ticket is single-use', () => {
  const tickets = store();
  const token = mint();
  assert.ok(tickets.consume(token, { city: 'bangkok' }));
  assert.equal(tickets.consume(token, { city: 'bangkok' }), null);
  assert.equal(tickets.spentCount(), 1);
});

test('a ticket expires and does not work in another city', () => {
  const tickets = store();
  const token = mint();
  assert.equal(tickets.consume(token, { city: 'chiang-mai' }), null);
  const expired = store().mint({
    uid: 'u', characterId: 'c', city: 'bangkok', at: at - 120_000,
  });
  assert.equal(store().consume(expired, { city: 'bangkok' }), null);
});

test('editing the payload or the signature invalidates the ticket', () => {
  const tickets = store();
  const token = mint();
  const [body, signature] = token.split('.');
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  const edited = Buffer.from(JSON.stringify({ ...claims, uid: 'uid-2' })).toString('base64url');
  assert.equal(tickets.consume(`${edited}.${signature}`, { city: 'bangkok' }), null);
  assert.equal(tickets.consume(`${body}.${'A'.repeat(signature.length)}`, { city: 'bangkok' }), null);
  assert.equal(tickets.consume('not-a-ticket', { city: 'bangkok' }), null);
});

test('a ticket signed with another secret is refused', () => {
  const other = createTicketStore({ secret: 'y'.repeat(48), ttlMs: 60_000, now: () => at });
  const token = other.mint({ uid: 'uid-1', characterId: 'c', city: 'bangkok' });
  assert.equal(store().consume(token, { city: 'bangkok' }), null);
});

test('the secret is mandatory and a short one is rejected', () => {
  assert.throws(() => createTicketStore({ secret: 'short' }), /at least 32/);
  assert.throws(() => createTicketStore({}), /at least 32/);
});
