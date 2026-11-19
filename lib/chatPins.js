// Pinned conversations are a local preference, not account data: they live in
// this browser, per wallet address, and never reach the relay or Firestore.
// The list stores only public wallet addresses; losing it costs nothing.
export const CHAT_PINS_PREFIX = 'scw-chat-pins-v1:';
export const CHAT_PIN_LIMIT = 100;

const ADDRESS_RE = /^G[A-Z2-7]{55}$/;

function normalizeAddress(value) {
  const text = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return ADDRESS_RE.test(text) ? text : '';
}

function storageOf(storage) {
  return storage === undefined ? globalThis.localStorage : storage;
}

function keyFor(owner) {
  const address = normalizeAddress(owner);
  return address ? `${CHAT_PINS_PREFIX}${address}` : '';
}

function uniqueValid(value) {
  const out = [];
  for (const entry of Array.isArray(value) ? value : []) {
    const address = normalizeAddress(entry);
    if (address && !out.includes(address)) out.push(address);
    if (out.length >= CHAT_PIN_LIMIT) break;
  }
  return out;
}

/** Pinned addresses for one wallet, newest last, capped and deduplicated. */
export function readPinned(storage, owner) {
  const store = storageOf(storage);
  const key = keyFor(owner);
  if (!store || !key) return [];
  try {
    const parsed = JSON.parse(store.getItem(key) || '[]');
    return uniqueValid(parsed);
  } catch {
    return [];
  }
}

export function isPinned(storage, owner, peer) {
  const address = normalizeAddress(peer);
  return Boolean(address) && readPinned(storage, owner).includes(address);
}

/**
 * Add or remove one conversation. Returns the resulting list and whether the
 * peer is now pinned. A full list or blocked storage leaves the list unchanged.
 */
export function togglePin(storage, owner, peer) {
  const store = storageOf(storage);
  const key = keyFor(owner);
  const address = normalizeAddress(peer);
  const current = readPinned(store, owner);
  if (!store || !key || !address) return { pinned: false, pins: current };

  const already = current.includes(address);
  if (!already && current.length >= CHAT_PIN_LIMIT) {
    return { pinned: false, pins: current, error: 'LIMIT' };
  }
  const pins = already ? current.filter((value) => value !== address) : [...current, address];
  try {
    store.setItem(key, JSON.stringify(pins));
    return { pinned: !already, pins };
  } catch {
    return { pinned: already, pins: current, error: 'STORAGE' };
  }
}
