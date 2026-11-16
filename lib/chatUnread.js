// Last-known "new message" counts, per wallet, for the Chats list.
//
// Nothing here is message content: only public wallet addresses, how many
// unread messages each conversation had at the last check, and when that check
// happened. It is kept so the list can still show "2 new" while the wallet is
// locked — polling itself needs the key, so a locked screen shows the last
// snapshot and says how old it is.
'use client';

export const UNREAD_KEY = 'scw-chat-unread-v1';
const ADDRESS_RE = /^G[A-Z2-7]{55}$/;

function storageOf(storage) {
  if (storage) return storage;
  return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
}

function sanitizeCounts(value) {
  const counts = {};
  if (!value || typeof value !== 'object') return counts;
  for (const [peer, count] of Object.entries(value)) {
    const address = String(peer).toUpperCase();
    const number = Number(count);
    if (!ADDRESS_RE.test(address)) continue;
    if (!Number.isSafeInteger(number) || number <= 0) continue;
    counts[address] = number;
  }
  return counts;
}

function readAll(storage = undefined) {
  const store = storageOf(storage);
  if (!store) return {};
  try {
    const parsed = JSON.parse(store.getItem(UNREAD_KEY) || 'null');
    if (!parsed || typeof parsed !== 'object') return {};
    const out = {};
    for (const [owner, entry] of Object.entries(parsed)) {
      const address = String(owner).toUpperCase();
      if (!ADDRESS_RE.test(address) || !entry || typeof entry !== 'object') continue;
      const at = Number(entry.at);
      out[address] = {
        at: Number.isFinite(at) && at > 0 ? at : 0,
        counts: sanitizeCounts(entry.counts),
      };
    }
    return out;
  } catch {
    return {};
  }
}

function writeAll(snapshot, storage = undefined) {
  const store = storageOf(storage);
  if (!store) return;
  try { store.setItem(UNREAD_KEY, JSON.stringify(snapshot)); } catch { /* quota/private mode */ }
}

/** `{ at, counts }` for one wallet; empty when nothing was ever recorded. */
export function readUnreadSnapshot(address, storage = undefined) {
  const owner = String(address || '').toUpperCase();
  const entry = readAll(storage)[owner];
  return entry ? { at: entry.at, counts: entry.counts } : { at: 0, counts: {} };
}

/**
 * Replace one wallet's snapshot. Counts are sanitized on the way in as well as
 * on the way out: a caller cannot persist anything but addresses and integers.
 */
export function writeUnreadSnapshot(address, { counts, at = Date.now() } = {}, storage = undefined) {
  const owner = String(address || '').toUpperCase();
  if (!ADDRESS_RE.test(owner)) return { at: 0, counts: {} };
  const all = readAll(storage);
  const clean = sanitizeCounts(counts);
  const safeAt = Number.isFinite(Number(at)) ? Number(at) : 0;
  if (Object.keys(clean).length === 0) delete all[owner];
  else all[owner] = { at: safeAt, counts: clean };
  writeAll(all, storage);
  return { at: safeAt, counts: clean };
}

/** Drop one wallet's snapshot (e.g. every message was read). */
export function clearUnreadSnapshot(address, storage = undefined) {
  const owner = String(address || '').toUpperCase();
  const all = readAll(storage);
  if (!all[owner]) return;
  delete all[owner];
  writeAll(all, storage);
}

/**
 * Combine several wallets' snapshots for the locked list: counts add up per
 * conversation, and the timestamp is the most recent check.
 */
export function mergeUnreadSnapshots(addresses = [], storage = undefined) {
  const all = readAll(storage);
  const counts = {};
  let at = 0;
  for (const address of addresses) {
    const entry = all[String(address || '').toUpperCase()];
    if (!entry) continue;
    for (const [peer, count] of Object.entries(entry.counts)) {
      counts[peer] = (counts[peer] || 0) + count;
    }
    if (entry.at > at) at = entry.at;
  }
  return { at, counts };
}

/** "just now", "4m ago", "2h ago", "3d ago" — or '' when there is no check. */
export function formatUnreadAge(at, now = Date.now()) {
  if (!Number.isFinite(at) || at <= 0) return '';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// ---------------- per-device read marks and fetch cursor ----------------
//
// The relay no longer deletes on read, so "new" is a local judgement: a message
// is unread on this device until this device has opened the conversation since
// it arrived. The marks below store, per peer, the newest relay arrival time
// this device has seen. The cursor stores the highest relay id this device has
// already fetched, so a poll asks only for what came after it.

export const READ_KEY = 'scw-chat-read-v1';
export const CURSOR_KEY = 'scw-chat-cursor-v1';

function readOwnerMap(key, storage) {
  const store = storageOf(storage);
  if (!store) return {};
  try {
    const parsed = JSON.parse(store.getItem(key) || 'null');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeOwnerMap(key, map, storage) {
  const store = storageOf(storage);
  if (!store) return;
  try { store.setItem(key, JSON.stringify(map)); } catch { /* quota/private mode */ }
}

/** `{ [peer]: newestSeenArrivalAt }` for one wallet. */
export function readReadMarks(address, storage = undefined) {
  const owner = String(address || '').toUpperCase();
  const raw = readOwnerMap(READ_KEY, storage)[owner];
  const marks = {};
  if (!raw || typeof raw !== 'object') return marks;
  for (const [peer, at] of Object.entries(raw)) {
    const peerAddress = String(peer).toUpperCase();
    const stamp = Number(at);
    if (!ADDRESS_RE.test(peerAddress)) continue;
    if (!Number.isFinite(stamp) || stamp <= 0) continue;
    marks[peerAddress] = stamp;
  }
  return marks;
}

/** Record that this device has seen this conversation up to `receivedAt`. */
export function markPeerSeen(address, peer, receivedAt, storage = undefined) {
  const owner = String(address || '').toUpperCase();
  const peerAddress = String(peer || '').toUpperCase();
  const stamp = Number(receivedAt);
  if (!ADDRESS_RE.test(owner) || !ADDRESS_RE.test(peerAddress)) return readReadMarks(owner, storage);
  if (!Number.isFinite(stamp) || stamp <= 0) return readReadMarks(owner, storage);
  const marks = readReadMarks(owner, storage);
  if (stamp > (marks[peerAddress] || 0)) marks[peerAddress] = stamp;
  const all = readOwnerMap(READ_KEY, storage);
  all[owner] = marks;
  writeOwnerMap(READ_KEY, all, storage);
  return marks;
}

/** Forget the read marks (after the relay copy was cleared). */
export function clearReadMarks(address, storage = undefined) {
  const owner = String(address || '').toUpperCase();
  const all = readOwnerMap(READ_KEY, storage);
  if (!all[owner]) return;
  delete all[owner];
  writeOwnerMap(READ_KEY, all, storage);
}

/** Highest relay id this device has fetched for this wallet (0 = never). */
export function readCursor(address, storage = undefined) {
  const owner = String(address || '').toUpperCase();
  const value = readOwnerMap(CURSOR_KEY, storage)[owner];
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

export function writeCursor(address, lastId, storage = undefined) {
  const owner = String(address || '').toUpperCase();
  const id = Number(lastId);
  if (!ADDRESS_RE.test(owner) || !Number.isSafeInteger(id) || id <= 0) return readCursor(owner, storage);
  const all = readOwnerMap(CURSOR_KEY, storage);
  all[owner] = Math.max(id, Number(all[owner]) || 0);
  writeOwnerMap(CURSOR_KEY, all, storage);
  return all[owner];
}

/**
 * Count messages that arrived after this device last read each conversation.
 * `messages` is what the relay returned: `{ from, receivedAt }`.
 */
export function countUnread(messages, marks) {
  const counts = {};
  for (const message of messages || []) {
    const peer = String(message?.from || '').toUpperCase();
    if (!ADDRESS_RE.test(peer)) continue;
    if (Number(message?.receivedAt || 0) <= (marks?.[peer] || 0)) continue;
    counts[peer] = (counts[peer] || 0) + 1;
  }
  return counts;
}

/** Newest arrival time per peer in a relay batch, for marking a room seen. */
export function newestArrivalByPeer(messages) {
  const newest = {};
  for (const message of messages || []) {
    const peer = String(message?.from || '').toUpperCase();
    if (!ADDRESS_RE.test(peer)) continue;
    const stamp = Number(message?.receivedAt || 0);
    if (stamp > (newest[peer] || 0)) newest[peer] = stamp;
  }
  return newest;
}
