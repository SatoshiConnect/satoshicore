// Per-wallet muted conversations. Local-only: muting hides badges and browser
// notifications on this device, but does not tell the relay or the peer.
export const MUTE_KEY = 'scw-chat-mute-v1';
const MAX_MUTED = 100;

function storeOf(storage) {
  if (storage) return storage;
  return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
}

function load(address, storage) {
  const owner = String(address || '').toUpperCase();
  if (!owner) return [];
  try {
    const parsed = JSON.parse(storeOf(storage)?.getItem(MUTE_KEY) || '{}');
    const list = parsed?.[owner];
    return Array.isArray(list) ? list.filter((peer) => /^G[A-Z2-7]{55}$/.test(peer)) : [];
  } catch {
    return [];
  }
}

export function readMuted(address, storage = undefined) {
  return load(address, storage);
}

export function isMuted(address, peer, storage = undefined) {
  return load(address, storage).includes(String(peer || '').toUpperCase());
}

export function writeMuted(address, peers, storage = undefined) {
  const owner = String(address || '').toUpperCase();
  const store = storeOf(storage);
  if (!owner || !store) return [];
  const next = [...new Set((peers || []).map((peer) => String(peer).toUpperCase()))]
    .filter((peer) => /^G[A-Z2-7]{55}$/.test(peer)).slice(0, MAX_MUTED);
  try {
    const parsed = JSON.parse(store.getItem(MUTE_KEY) || '{}');
    const all = parsed && typeof parsed === 'object' ? { ...parsed } : {};
    if (next.length) all[owner] = next;
    else delete all[owner];
    store.setItem(MUTE_KEY, JSON.stringify(all));
    return next;
  } catch {
    return load(owner, storage);
  }
}

export function toggleMuted(address, peer, storage = undefined) {
  const target = String(peer || '').toUpperCase();
  const current = load(address, storage);
  return writeMuted(
    address,
    current.includes(target) ? current.filter((item) => item !== target) : [...current, target],
    storage,
  );
}
