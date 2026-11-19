// Forwarding reuses the normal encrypted send path: the selected text becomes a
// new message in the target conversation. The relay sees the same envelope it
// already accepts; there is no new operation and no server-side copy.
export const FORWARD_TARGET_LIMIT = 50;

const ADDRESS_RE = /^G[A-Z2-7]{55}$/;

const normalizeAddress = (value) => {
  const text = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return ADDRESS_RE.test(text) ? text : '';
};

/**
 * Existing chats that may receive a forward: valid addresses, current room
 * excluded, de-duplicated and capped. `known` is the same merged list the chat
 * screen renders, so only people already in the list can be chosen.
 */
export function forwardTargets(known, current, { limit = FORWARD_TARGET_LIMIT } = {}) {
  const blocked = normalizeAddress(current);
  const out = [];
  for (const entry of Array.isArray(known) ? known : []) {
    const address = normalizeAddress(entry);
    if (!address || address === blocked || out.includes(address)) continue;
    out.push(address);
    if (out.length >= limit) break;
  }
  return out;
}
