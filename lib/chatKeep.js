// "Keep" turns one message into something this device holds: it is written into
// the encrypted archive, copied into Saved Messages, and only then may this
// device's relay copy be acknowledged. The order is the whole point — a message
// that was not stored must stay on the relay, and the relay's 7-day retention is
// the only other thing that removes it.
import { relayIdOf } from './chatRelayArchive.js';
import { archiveMessages } from './chatArchive.js';

// The relay deletes undelivered mail 7 days after arrival (`RETENTION_DAYS` in
// chat-relay.mjs). Kept out of the UI so the countdown and the relay agree.
export const RELAY_RETENTION_MS = 7 * 86_400_000;

/** The archive key id for one thread line: `m<relay id>` when it has one. */
export function archiveIdOf(message) {
  const relay = relayIdOf(message);
  if (Number.isSafeInteger(relay) && relay > 0) return `m${relay}`;
  return String(message?.id || '');
}

/**
 * When the relay will drop this message, or 0 when it was never on the relay
 * (a local line, a queued one). The relay's clock starts at arrival, so
 * `receivedAt` wins over the sender's `ts`.
 */
export function relayExpiresAt(message) {
  const relay = relayIdOf(message);
  if (!Number.isSafeInteger(relay) || relay <= 0) return 0;
  const started = Number(message?.receivedAt) || Number(message?.at) || 0;
  return started > 0 ? started + RELAY_RETENTION_MS : 0;
}

/** "expires in 3d" — or '' when there is no relay copy to expire. */
export function expiryLabel(message, now = Date.now()) {
  const expiresAt = relayExpiresAt(message);
  if (!expiresAt) return '';
  const left = expiresAt - now;
  if (left <= 0) return 'relay copy expired';
  if (left < 3_600_000) return `expires in ${Math.max(1, Math.ceil(left / 60_000))}m`;
  if (left < 86_400_000) return `expires in ${Math.ceil(left / 3_600_000)}h`;
  return `expires in ${Math.ceil(left / 86_400_000)}d`;
}

/**
 * Which thread ids this device already holds, split by what they mean:
 * `inSaved` is the Saved Messages copy, `anywhere` is "the relay may forget it".
 * Both are sets of archive ids (`m<relay id>`), so they compare with
 * `archiveIdOf(message)`.
 */
export function keptIds(rows, owner) {
  const self = String(owner || '').toUpperCase();
  const inSaved = new Set();
  const anywhere = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = String(row?.id || '');
    if (!id) continue;
    anywhere.add(id);
    if (String(row?.peer || '').toUpperCase() === self) inSaved.add(id);
  }
  return { inSaved, anywhere };
}

/**
 * Keep one line, in order: the source conversation, then Saved Messages, then
 * the ack. `archive` and `ack` are injectable so the ordering rules are covered
 * by tests; production callers get the real archive and the client's `ack`.
 *
 * Throwing on a failed store is deliberate: the caller must not acknowledge a
 * message this device could not keep.
 */
export async function keepMessage({
  message, address, seed32, scope = 'chat',
  archive = archiveMessages, ack = null, relayId = 0,
}) {
  const owner = String(address || '').toUpperCase();
  const peer = String(message?.peer || message?.from || '').toUpperCase();
  // One id shape for the archive, whichever screen saved the line first.
  const relay = Number(relayId) || relayIdOf(message);
  const id = Number.isSafeInteger(relay) && relay > 0 ? `m${relay}` : String(message?.id || '');
  if (!owner || !peer) throw new Error('This message has no conversation to keep.');
  if (!id) throw new Error('This message cannot be kept before it has an id.');

  const row = {
    id,
    at: Number(message?.at) || Number(message?.receivedAt) || Date.now(),
    text: message?.text,
    own: Boolean(message?.own),
    ...(message?.reaction ? { reaction: message.reaction } : {}),
  };

  // 1. The conversation it came from.
  const stored = Number(await archive({
    seed32, address: owner, peer, messages: [row], scope,
  })) || 0;
  if (stored <= 0) throw new Error('This device could not store the message, so nothing was acknowledged.');

  // 2. A copy in Saved Messages. Inside Saved Messages there is nobody to copy
  //    to, so the same row is the copy.
  let saved = 0;
  if (peer !== owner) {
    saved = Number(await archive({
      seed32, address: owner, peer: owner, messages: [{ ...row, own: true }], scope,
    })) || 0;
    if (saved <= 0) throw new Error('The Saved Messages copy could not be written, so nothing was acknowledged.');
  }

  // 3. Only a message this device holds may leave the relay.
  let acked = 0;
  if (typeof ack === 'function' && Number(relayId) > 0) {
    acked = Number(await ack(Number(relayId))) || 0;
  }
  return { stored, saved, acked, id };
}
