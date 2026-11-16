// The relay copy of a fetched message is dropped only after this device has
// stored it in the opt-in archive. Kept out of ChatPanel so the ordering and
// failure rules are covered by tests: an archive error must never be the reason
// a message is lost.
import { archiveMessages, readArchivePrefs } from './chatArchive.js';

export const relayIdOf = (message) => Number(
  typeof message?.id === 'string' ? message.id.replace(/^m/, '') : message?.id,
);

// Relay messages carry `ts`; saved ones carry `at`. The archive keeps the
// original timestamp either way.
export const atOf = (message) => {
  const at = Number(message?.at ?? message?.ts);
  return Number.isFinite(at) && at > 0 ? at : Date.now();
};

// Ask the relay to drop messages this device no longer needs. Returns how many
// it says it removed; a failure leaves the copies for retention.
export async function ackIds({ seed32, address, ids, ack }) {
  const list = (Array.isArray(ids) ? ids : [])
    .filter((id) => Number.isSafeInteger(id) && id > 0);
  if (list.length === 0 || typeof ack !== 'function') return 0;
  try {
    return await ack({ seed32, address, ids: list });
  } catch {
    return 0;
  }
}

// Saved history is what lets the relay forget early: store the message
// encrypted-at-rest first, then acknowledge exactly the ids this device really
// stored. If saving fails the copy stays on the relay until its 7-day
// retention. Without saved history this is a no-op and the relay keeps the
// message.
//
// `prefs` and `store` are injectable so tests can hold the write open or make
// it fail; production callers get the real archive without passing anything.
export async function archiveAndClearRelay({
  seed32, address, messages, ack,
  prefs = readArchivePrefs(), store = archiveMessages,
}) {
  if (!seed32 || !address || !prefs?.enabled || !messages?.length) return 0;
  if (typeof ack !== 'function' || typeof store !== 'function') return 0;
  const byPeer = new Map();
  for (const message of messages) {
    const peer = String(message?.peer || message?.from || '').toUpperCase();
    if (!peer || typeof message.text !== 'string' || !message.text) continue;
    const relayId = relayIdOf(message);
    if (!Number.isSafeInteger(relayId)) continue;
    const group = byPeer.get(peer) || [];
    // One id shape for the archive whichever screen saved the line first.
    group.push({ ...message, id: `m${relayId}`, at: atOf(message) });
    byPeer.set(peer, group);
  }
  const storedIds = [];
  for (const [peer, group] of byPeer) {
    try {
      const stored = await store({ seed32, address, peer, messages: group });
      if (stored > 0) storedIds.push(...group.map(relayIdOf));
    } catch {
      // Keep the relay copy.
    }
  }
  return ackIds({ seed32, address, ids: storedIds, ack });
}
