// Friends for the encrypted chat: someone you name yourself, so you do not have
// to make a transfer first to say hello.
//
// A friend is stored as a public wallet address and nothing else — no name, no
// email, no message. The chat transcript still lives in the session only. That
// is the whole reason this list is kept apart from the chat module: the one
// thing that reaches storage is data the chain already publishes.
import { describeProfileIdProblem, normalizeAddress, normalizeProfileId } from './profile.js';

// Enough for a personal list, small enough that a mistyped loop cannot fill a
// device's storage.
export const FRIEND_LIMIT = 50;

export function friendStorageKey(walletAddress) {
  return `scw-chat-friends-${String(walletAddress || '').trim().toUpperCase()}`;
}

/**
 * What the "Add friend" field holds: an `@profile` ID to look up, or a `G…`
 * wallet address. Anything else is refused before a request is made, with the
 * wording the form shows.
 */
export function parseFriendTarget(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return { error: 'Enter a @profile ID or a wallet address (G…).' };
  if (text.startsWith('@')) {
    const id = normalizeProfileId(text);
    return id ? { kind: 'id', value: id } : { error: describeProfileIdProblem(text) };
  }
  const address = normalizeAddress(text);
  if (address) return { kind: 'address', value: address };
  if (/^g/i.test(text) || text.length > 20) {
    return { error: 'That does not look like a wallet address — a G… account ID has 56 characters.' };
  }
  return { error: 'Start with @ for a profile ID, or paste a G… wallet address.' };
}

/** Only well-formed addresses survive, in order, without duplicates. */
export function normalizeFriends(list) {
  const seen = new Set();
  const out = [];
  for (const entry of Array.isArray(list) ? list : []) {
    const address = normalizeAddress(entry);
    if (!address || seen.has(address)) continue;
    seen.add(address);
    out.push(address);
    if (out.length >= FRIEND_LIMIT) break;
  }
  return out;
}

/**
 * Contacts from the transfer index, then the friends added by hand. A friend who
 * is also a counterparty appears once — the transfer came first, so it keeps its
 * place and only the "friend" badge is added by the caller.
 */
export function mergeContacts(contacts, friends) {
  return normalizeFriends([...(Array.isArray(contacts) ? contacts : []), ...normalizeFriends(friends)]);
}

/** Friends stored for this wallet, or an empty list when storage is absent. */
export function readFriends(storage, walletAddress) {
  if (!storage || !walletAddress) return [];
  try {
    const raw = storage.getItem(friendStorageKey(walletAddress));
    if (!raw) return [];
    return normalizeFriends(JSON.parse(raw));
  } catch {
    return [];
  }
}

/**
 * Add one friend. Returns the stored list and whether it changed, so the caller
 * can say "already added" instead of pretending a write happened.
 */
export function addFriend(storage, walletAddress, entry) {
  const address = normalizeAddress(entry);
  if (!address) throw new Error('not a wallet address');
  const current = readFriends(storage, walletAddress);
  if (current.includes(address)) return { friends: current, added: false };
  if (current.length >= FRIEND_LIMIT) {
    throw Object.assign(new Error(`this list already holds ${FRIEND_LIMIT} friends`), { code: 'FRIEND_LIMIT' });
  }
  const friends = [...current, address];
  if (storage) {
    try {
      storage.setItem(friendStorageKey(walletAddress), JSON.stringify(friends));
    } catch {
      // Storage full or blocked: keep the entry for this session rather than
      // failing the add after the address was already resolved.
    }
  }
  return { friends, added: true };
}

export function removeFriend(storage, walletAddress, entry) {
  const address = normalizeAddress(entry);
  const friends = readFriends(storage, walletAddress).filter((item) => item !== address);
  if (storage) {
    try {
      storage.setItem(friendStorageKey(walletAddress), JSON.stringify(friends));
    } catch { /* nothing else to do; the UI has the new list */ }
  }
  return friends;
}
