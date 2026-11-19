// Saved Messages is the current wallet talking to itself. It is a dedicated
// system conversation, not a friend/contact and not a peer that can read-receipt
// its own messages.
const ADDRESS_RE = /^G[A-Z2-7]{55}$/;

export const SAVED_MESSAGES_LABEL = 'Saved Messages';

export function savedMessagesAddress(owner) {
  const address = String(owner || '').trim().toUpperCase();
  return ADDRESS_RE.test(address) ? address : '';
}

export function isSavedMessagesPeer(owner, peer) {
  const address = savedMessagesAddress(owner);
  return Boolean(address && address === savedMessagesAddress(peer));
}

/** A normal peer has Sent/Read status; a self-room intentionally has none. */
export function readReceiptLabel({ owner, peer, messageId, lastId } = {}) {
  if (!peer || isSavedMessagesPeer(owner, peer)) return '';
  const id = Number(messageId);
  if (!Number.isSafeInteger(id) || id <= 0) return '';
  return Number(lastId) >= id ? 'Read' : 'Sent';
}
