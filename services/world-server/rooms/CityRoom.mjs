// One room per city: who is standing where, in memory only.
//
// The room holds nothing that outlives it: no position history, no address, no
// key, no message. A player who disconnects is forgotten, and a restart starts
// every city empty. That is deliberate — the world is a place to meet, while the
// account, the chat and the chain stay in their own systems.
//
// Joining requires a ticket minted by the HTTP endpoint after it verified the
// Firebase ID token and read the character document with that account's own
// credential. The socket never sees the ID token, and the name and appearance it
// shows are the ones the ticket carries from the verified document.
import { Room } from 'colyseus';
import { schema, t } from '@colyseus/schema';
import { applyMove } from '../lib/movement.mjs';
import { isWalkablePixel, mapForCity, spawnForCharacter } from '../../../lib/worldMap.js';

// `schema()` rather than decorators: this service is plain JavaScript, and the
// decorator form needs a compiler configuration that does not exist here.
export const Player = schema({
  characterId: t.string(),
  name: t.string(),
  x: t.number(),
  y: t.number(),
  facing: t.string(),
  // Appearance indexes from the verified character document, so every client
  // draws the same sprite the owner chose. Bounded by the character module and
  // the Firestore rules; the room copies, it does not invent.
  skin: t.uint8(),
  hair: t.uint8(),
  outfit: t.uint8(),
  accessory: t.uint8(),
}, 'Player');

export const CityState = schema({
  players: t.map(Player),
}, 'CityState');

const MAX_MESSAGE_KEYS = 4;

function readMove(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  if (Object.keys(message).length > MAX_MESSAGE_KEYS) return null;
  const { x, y, facing } = message;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (facing !== undefined && typeof facing !== 'string') return null;
  return { x, y, facing };
}

/**
 * Build the room class for a city.
 *
 * A factory rather than a subclass per file keeps the city's bounds and its
 * ticket verifier in the closure, so nothing global can be pointed at the wrong
 * city by mistake.
 */
export function createCityRoom({ city, tickets, presence = null, now = Date.now }) {
  return class CityRoom extends Room {
    onCreate() {
      this.maxClients = city.maxPlayers;
      this.setState(new CityState());
      // The development spectator reads this room's live state; nothing is copied.
      if (presence) presence.attach(city.id, this);
      // Last accepted position per session; the reference the speed budget uses.
      this.references = new Map();
      // The same tile grid the browser draws. The server keeps it so a reported
      // position can be checked against the city, not only against its bounds.
      this.map = mapForCity(city);

      this.onMessage('move', (client, message) => this.handleMove(client, message));
      // Unknown message types are ignored rather than echoed or logged: a probe
      // learns nothing about the server from silence.
      this.onMessage('*', () => {});
    }

    /** Called before the seat is reserved. A bad ticket is a rejected join. */
    onAuth(_client, options) {
      const claims = tickets.consume(options?.ticket, { city: city.id });
      if (!claims) throw new Error('world-join-rejected');
      return claims;
    }

    onJoin(client, _options, auth) {
      const claims = auth || client.auth;
      if (!claims || claims.city !== city.id) {
        // Defence in depth: onAuth already checked, but a future code path that
        // skips it must not produce a player without verified claims.
        throw new Error('world-join-rejected');
      }

      // One character, one seat. A second device takes over the character and the
      // older session is disconnected, so two avatars never share a name.
      const taken = [];
      this.state.players.forEach((player, sessionId) => {
        if (player.characterId === claims.characterId) taken.push(sessionId);
      });
      for (const sessionId of taken) {
        this.state.players.delete(sessionId);
        this.references.delete(sessionId);
        const stale = this.clients.find((c) => c.sessionId === sessionId);
        if (stale) stale.leave(4001);
      }

      const spawn = spawnForCharacter(this.map, claims.characterId);
      const player = new Player();
      player.characterId = claims.characterId;
      player.name = typeof claims.name === 'string' ? claims.name : '';
      const look = claims.appearance && typeof claims.appearance === 'object' ? claims.appearance : {};
      player.skin = Number.isInteger(look.skin) ? look.skin : 0;
      player.hair = Number.isInteger(look.hair) ? look.hair : 0;
      player.outfit = Number.isInteger(look.outfit) ? look.outfit : 0;
      player.accessory = Number.isInteger(look.accessory) ? look.accessory : 0;
      player.x = spawn.x;
      player.y = spawn.y;
      player.facing = 'down';
      this.state.players.set(client.sessionId, player);
      this.references.set(client.sessionId, { at: now(), x: spawn.x, y: spawn.y });
    }

    handleMove(client, message) {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      const move = readMove(message);
      if (!move) return;
      const reference = this.references.get(client.sessionId) || null;
      const result = applyMove({
        x: move.x, y: move.y, facing: move.facing, now: now(), reference, city,
      });
      if (!result.ok) return;
      // The rectangle is not the whole rule: a building or the river is not a
      // legal standing place, and only the server's copy of the map decides.
      if (!isWalkablePixel(this.map, result.x, result.y)) return;
      player.x = result.x;
      player.y = result.y;
      player.facing = result.facing;
      this.references.set(client.sessionId, { at: now(), x: result.x, y: result.y });
    }

    onLeave(client) {
      if (this.state?.players) this.state.players.delete(client.sessionId);
      if (this.references) this.references.delete(client.sessionId);
    }

    onDispose() {
      if (presence) presence.detach(city.id, this);
      if (this.state?.players) this.state.players.clear();
      if (this.references) this.references.clear();
    }
  };
}
