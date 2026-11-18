// How long a remembered Google sign-in may sit unused on this browser.
//
// This is a browser-local convenience policy, not a security boundary. Firebase
// keeps a browser-local session until sign-out or site-data clearing, and a
// static site cannot revoke another device's session — that needs a privileged
// backend (see docs/GOOGLE-SIGN-IN.md). What this module adds is the part the
// site can honestly enforce: a remembered sign-in that has not been used for
// SESSION_IDLE_LIMIT_MS is ended on this browser and the visitor signs in again.
//
// It stores one timestamp and the account uid — never a token, wallet name,
// address, seed, password or keystore blob. Clearing it costs nothing: the next
// sign-in simply writes a fresh record. Losing the record must never force a
// sign-out, because a browser with blocked storage would otherwise be unable to
// stay signed in at all.
export const SESSION_RECORD_KEY = 'nsat-web-session-v1';
export const SESSION_EXPIRED_FLAG = 'nsat-session-expired-v1';
export const SESSION_IDLE_LIMIT_MS = 30 * 24 * 60 * 60 * 1000;

function storageOf(storage) {
  return storage === undefined ? globalThis.localStorage : storage;
}

/** `{ uid, lastSeenAt }` for the last successful sign-in, or null. */
export function readSessionRecord(storage = globalThis.localStorage) {
  const store = storageOf(storage);
  if (!store) return null;
  try {
    const parsed = JSON.parse(store.getItem(SESSION_RECORD_KEY) || 'null');
    if (!parsed || typeof parsed !== 'object') return null;
    const uid = typeof parsed.uid === 'string' ? parsed.uid.trim() : '';
    const lastSeenAt = Number(parsed.lastSeenAt);
    if (!uid || !Number.isFinite(lastSeenAt) || lastSeenAt <= 0) return null;
    return { uid, lastSeenAt };
  } catch {
    return null;
  }
}

export function writeSessionRecord({ uid, lastSeenAt }, storage = globalThis.localStorage) {
  const store = storageOf(storage);
  if (!store || typeof uid !== 'string' || !uid.trim()) return false;
  const at = Number(lastSeenAt);
  if (!Number.isFinite(at) || at <= 0) return false;
  try {
    store.setItem(SESSION_RECORD_KEY, JSON.stringify({ uid: uid.trim(), lastSeenAt: at }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Mark the account as used now. A stored record for another uid is replaced:
 * this browser remembers the account that is signed in, not a history of them.
 */
export function touchSessionRecord(uid, { now = Date.now(), storage = globalThis.localStorage } = {}) {
  if (!uid) return null;
  const record = { uid: String(uid), lastSeenAt: now };
  return writeSessionRecord(record, storage) ? record : null;
}

export function clearSessionRecord(storage = globalThis.localStorage) {
  const store = storageOf(storage);
  if (!store) return false;
  try {
    store.removeItem(SESSION_RECORD_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * True only for a valid record that has gone unused past the limit. A missing or
 * unreadable record is never stale: the caller has nothing to expire, and
 * treating unknown as expired would break sign-in wherever storage is blocked.
 * A timestamp in the future (clock moved backwards) is not stale either; the
 * caller re-touches it, which repairs the record.
 */
export function sessionIsStale(record, { now = Date.now(), maxAgeMs = SESSION_IDLE_LIMIT_MS } = {}) {
  if (!record || typeof record !== 'object') return false;
  const lastSeenAt = Number(record.lastSeenAt);
  if (!Number.isFinite(lastSeenAt) || lastSeenAt <= 0) return false;
  if (!Number.isFinite(now)) return false;
  const age = now - lastSeenAt;
  if (age <= 0) return false;
  return age > maxAgeMs;
}

/** Remember that the browser's saved sign-in was ended by this policy. */
export function markSessionExpired({ now = Date.now(), storage = globalThis.localStorage } = {}) {
  const store = storageOf(storage);
  if (!store) return false;
  try {
    store.setItem(SESSION_EXPIRED_FLAG, String(now));
    return true;
  } catch {
    return false;
  }
}

export const SESSION_EXPIRED_NOTICE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Timestamp of a recent forced sign-in, or 0.
 *
 * Reading does not clear it: React may mount the gate more than once (dev
 * StrictMode, a re-render, Fast Refresh), and a notice that disappears on the
 * second mount never reaches the visitor. The flag is cleared by a successful
 * sign-in instead, and an old one expires on its own.
 */
export function readSessionExpired({
  now = Date.now(), maxAgeMs = SESSION_EXPIRED_NOTICE_MS, storage = globalThis.localStorage,
} = {}) {
  const store = storageOf(storage);
  if (!store) return 0;
  try {
    const raw = store.getItem(SESSION_EXPIRED_FLAG);
    if (raw == null) return 0;
    const at = Number(raw);
    if (!Number.isFinite(at) || at <= 0) return 0;
    if (!Number.isFinite(now) || now - at > maxAgeMs) {
      store.removeItem(SESSION_EXPIRED_FLAG);
      return 0;
    }
    return at;
  } catch {
    return 0;
  }
}

/** A successful sign-in makes the explanation obsolete. */
export function clearSessionExpired(storage = globalThis.localStorage) {
  const store = storageOf(storage);
  if (!store) return false;
  try {
    store.removeItem(SESSION_EXPIRED_FLAG);
    return true;
  } catch {
    return false;
  }
}

/** One line for Settings: what this browser will do with the sign-in. */
export function describeSessionPolicy({ remembered }) {
  return remembered
    ? 'Remembered on this browser. It ends when you sign out, when you clear site data, or after 30 days without use.'
    : 'Session-only. Signing in ends when this browser session closes.';
}
