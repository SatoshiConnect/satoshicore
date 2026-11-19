// Message requests: a wallet can be written to by any address, so the first
// message from somebody this device does not already know is held back instead
// of arriving as a normal conversation. Nothing here is message content — the
// store holds public addresses only, next to the friend list and pins.
//
// Exempt: the wallet's own Saved Messages room, anybody in the transfer-derived
// contact list, anybody the person added as a friend, anybody already accepted,
// and any peer this device already has history with (an archived row). That last
// one is what keeps a long conversation from being re-gated while the transfer
// history is still loading.
const ADDRESS_RE = /^G[A-Z2-7]{55}$/;
export const REQUESTS_PREFIX = 'scw-chat-requests-v1:';
export const REQUEST_LIMIT = 200;

const normalize = (value) => String(value || '').trim().toUpperCase();

function storageOf(storage) {
  if (storage) return storage;
  return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
}

const keyOf = (owner) => `${REQUESTS_PREFIX}${normalize(owner)}`;

function sanitizeList(value) {
  const out = [];
  for (const item of Array.isArray(value) ? value : []) {
    const address = normalize(item);
    if (!ADDRESS_RE.test(address) || out.includes(address)) continue;
    out.push(address);
    if (out.length >= REQUEST_LIMIT) break;
  }
  return out;
}

/** `{ accepted, pending }` for one wallet; junk and a corrupt file read as empty. */
export function readRequests(storage = undefined, owner) {
  const store = storageOf(storage);
  const empty = { accepted: [], pending: [] };
  if (!store || !ADDRESS_RE.test(normalize(owner))) return empty;
  try {
    const parsed = JSON.parse(store.getItem(keyOf(owner)) || 'null');
    if (!parsed || typeof parsed !== 'object') return empty;
    return {
      accepted: sanitizeList(parsed.accepted),
      pending: sanitizeList(parsed.pending),
    };
  } catch {
    return empty;
  }
}

function write(store, owner, state) {
  try {
    store.setItem(keyOf(owner), JSON.stringify({
      accepted: sanitizeList(state.accepted),
      pending: sanitizeList(state.pending),
    }));
    return true;
  } catch {
    return false; // quota/private mode: the gate still works for this session
  }
}

/** Remember senders that are waiting for a decision (addresses only). */
export function notePending(storage = undefined, owner, peers = []) {
  const state = readRequests(storage, owner);
  const next = [...state.pending];
  let changed = false;
  for (const peer of Array.isArray(peers) ? peers : [peers]) {
    const address = normalize(peer);
    if (!ADDRESS_RE.test(address) || next.includes(address)) continue;
    if (next.length >= REQUEST_LIMIT) break;
    next.push(address);
    changed = true;
  }
  if (!changed) return { ...state, changed: false };
  const store = storageOf(storage);
  if (store) write(store, owner, { ...state, pending: next });
  return { accepted: state.accepted, pending: next, changed: true };
}

/** Accept one sender: their room joins the normal list from now on. */
export function acceptSender(storage = undefined, owner, peer) {
  const state = readRequests(storage, owner);
  const address = normalize(peer);
  if (!ADDRESS_RE.test(address)) return { ...state, changed: false };
  const accepted = state.accepted.includes(address)
    ? state.accepted
    : sanitizeList([...state.accepted, address]);
  const pending = state.pending.filter((item) => item !== address);
  const changed = pending.length !== state.pending.length
    || accepted.length !== state.accepted.length;
  if (changed) {
    const store = storageOf(storage);
    if (store) write(store, owner, { accepted, pending });
  }
  return { accepted, pending, changed };
}

/** Forget a pending request without accepting it (Delete / Block). */
export function dropPending(storage = undefined, owner, peer) {
  const state = readRequests(storage, owner);
  const address = normalize(peer);
  const pending = state.pending.filter((item) => item !== address);
  if (pending.length === state.pending.length) return { ...state, changed: false };
  const store = storageOf(storage);
  if (store) write(store, owner, { ...state, pending });
  return { accepted: state.accepted, pending, changed: true };
}

const contains = (list, address) => {
  if (list instanceof Set) return list.has(address);
  if (!Array.isArray(list)) return false;
  return list.some((item) => normalize(item) === address);
};

/**
 * Is mail from this address a request? True only for a sender this device does
 * not already know; the wallet itself is never a request (Saved Messages).
 */
export function isRequestSender(peer, {
  owner = '', contacts = [], friends = [], accepted = [], archived = [],
} = {}) {
  const address = normalize(peer);
  if (!ADDRESS_RE.test(address)) return false;
  if (address === normalize(owner)) return false;
  return !(
    contains(contacts, address)
    || contains(friends, address)
    || contains(accepted, address)
    || contains(archived, address)
  );
}

/** Drop badges that belonged to a request sender; keeps every other room. */
export function withoutRequestCounts(counts, isRequest) {
  const next = {};
  for (const [peer, count] of Object.entries(counts && typeof counts === 'object' ? counts : {})) {
    if (typeof isRequest === 'function' && isRequest(peer)) continue;
    next[peer] = count;
  }
  return next;
}
