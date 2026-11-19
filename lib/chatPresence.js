// Presence is opt-in per browser profile, not a server default. The stored
// value is a boolean preference only; the actual heartbeat is ephemeral on the
// relay and expires after 45 seconds.
export const PRESENCE_PREF_KEY = 'scw-chat-presence-v1';

function storeOf(storage) {
  if (storage) return storage;
  return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
}

export function readPresencePref(address, storage = undefined) {
  const owner = String(address || '').toUpperCase();
  if (!owner) return false;
  try {
    const parsed = JSON.parse(storeOf(storage)?.getItem(PRESENCE_PREF_KEY) || '{}');
    return parsed?.[owner] === true;
  } catch {
    return false;
  }
}

export function writePresencePref(address, enabled, storage = undefined) {
  const owner = String(address || '').toUpperCase();
  if (!owner) return false;
  const store = storeOf(storage);
  if (!store) return false;
  try {
    const parsed = JSON.parse(store.getItem(PRESENCE_PREF_KEY) || '{}');
    const next = parsed && typeof parsed === 'object' ? { ...parsed } : {};
    if (enabled) next[owner] = true;
    else delete next[owner];
    store.setItem(PRESENCE_PREF_KEY, JSON.stringify(next));
    return enabled === true;
  } catch {
    return false;
  }
}
