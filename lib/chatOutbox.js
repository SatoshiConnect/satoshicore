// Encrypted outbox for messages that could not be handed to the relay.
//
// Only the ciphertext envelope is stored. The plaintext and the wallet seed are
// never written here: after a reload the device can retry the same bytes, but it
// cannot display the message body from the outbox alone. Entries are scoped to
// the sending wallet so one browser profile can hold several wallets safely.
//
// A retry reuses `clientId`; the relay's unique (sender, client_id) index makes
// a repeated POST the same message instead of a duplicate.
'use client';

export const OUTBOX_PREFIX = 'scw-chat-outbox-v1:';
export const MAX_OUTBOX = 50;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,80}$/;
const ADDRESS_RE = /^G[A-Z2-7]{55}$/;

function storageOf(storage) {
  if (storage) return storage;
  return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
}

export function outboxKey(owner) {
  const address = String(owner || '').toUpperCase();
  if (!ADDRESS_RE.test(address)) return '';
  return `${OUTBOX_PREFIX}${address}`;
}

function validItem(item) {
  return Boolean(
    item
    && CLIENT_ID_RE.test(String(item.clientId || ''))
    && ADDRESS_RE.test(String(item.to || '').toUpperCase())
    && item.envelope && typeof item.envelope === 'object'
    && Number.isSafeInteger(item.createdAt) && item.createdAt > 0,
  );
}

/** Read queued envelopes for one wallet. Corrupt or foreign rows are dropped. */
export function readOutbox(owner, storage = undefined) {
  const key = outboxKey(owner);
  const store = storageOf(storage);
  if (!key || !store) return [];
  try {
    const parsed = JSON.parse(store.getItem(key) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(validItem).slice(-MAX_OUTBOX).map((item) => ({
      clientId: String(item.clientId),
      to: String(item.to).toUpperCase(),
      envelope: item.envelope,
      createdAt: item.createdAt,
      attempts: Number.isSafeInteger(item.attempts) && item.attempts >= 0 ? item.attempts : 0,
      lastError: typeof item.lastError === 'string' ? item.lastError : '',
    }));
  } catch {
    return [];
  }
}

function writeOutbox(owner, items, storage = undefined) {
  const key = outboxKey(owner);
  const store = storageOf(storage);
  if (!key || !store) return [];
  const clean = items.filter(validItem).slice(-MAX_OUTBOX);
  try {
    store.setItem(key, JSON.stringify(clean));
  } catch {
    // Quota or private mode: report the queue as it is, never pretend it saved.
  }
  return clean;
}

/** Add one prepared envelope. Re-adding the same clientId is a no-op. */
export function enqueueOutbox(owner, item, storage = undefined) {
  const current = readOutbox(owner, storage);
  if (!validItem(item)) return current;
  if (current.some((entry) => entry.clientId === item.clientId)) return current;
  return writeOutbox(owner, [...current, {
    clientId: String(item.clientId),
    to: String(item.to).toUpperCase(),
    envelope: item.envelope,
    createdAt: item.createdAt,
    attempts: 0,
    lastError: '',
  }], storage);
}

export function removeOutbox(owner, clientId, storage = undefined) {
  const current = readOutbox(owner, storage);
  return writeOutbox(owner, current.filter((item) => item.clientId !== clientId), storage);
}

/** Record a failed retry without changing the ciphertext or the client id. */
export function markOutboxFailure(owner, clientId, error, storage = undefined) {
  const current = readOutbox(owner, storage);
  return writeOutbox(owner, current.map((item) => (item.clientId === clientId
    ? {
      ...item,
      attempts: item.attempts + 1,
      lastError: String(error?.message || error || '').slice(0, 240),
    }
    : item)), storage);
}
