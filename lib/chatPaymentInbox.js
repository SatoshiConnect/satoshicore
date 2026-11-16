// Encrypted payment-request inbox.
//
// A payment request is ordinary signed chat text, but it is also an obligation:
// reading the room must not make it disappear. This module keeps one encrypted
// record per request in the same local archive database as saved chat, with the
// lifecycle pending → paid / declined / expired. The record is local to this
// device; the relay only ever sees the encrypted chat envelope.
//
// The inbox never signs or submits a payment. "Review payment" uses the same
// Send page and local approval path as before; status changes here are bookkeeping.
import { normalizeAddress } from './profile.js';
import {
  REQUESTS_STORE, deriveArchiveKey, openArchiveDb, openArchiveText, sealArchiveText,
} from './chatArchive.js';
import { parsePaymentRequestText } from './chatPaymentRequest.js';

export const REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const REQUEST_WARNING_MS = 48 * 60 * 60 * 1000;
export const REQUEST_STATUSES = Object.freeze(['pending', 'paid', 'declined', 'expired']);

const DIRECTIONS = ['incoming', 'outgoing'];
const available = () => typeof indexedDB !== 'undefined';
const rowKey = (owner, requestKey) => `${owner}|${requestKey}`;
// AAD is bound to the request row, not to the chat message row, so moving a
// payment record to another wallet/peer/timestamp makes it unreadable.
const aadId = (requestKey) => `pay:${requestKey}`;

export function canonicalRequestMessageId(messageId) {
  // Relay inbox rows use numeric ids, while the thread prefixes them with `m`.
  // Both shapes must name the same request.
  return String(messageId || '').trim().replace(/^m(?=\d)/, '');
}

export function requestKeyFor(direction, messageId) {
  const id = canonicalRequestMessageId(messageId);
  if (!DIRECTIONS.includes(direction) || !id) return '';
  return `${direction}:${id}`;
}

function normalizeStatus(status) {
  return REQUEST_STATUSES.includes(status) ? status : 'pending';
}

function normalizeRequest(request) {
  if (!request || typeof request !== 'object') return null;
  const direction = DIRECTIONS.includes(request.direction) ? request.direction : '';
  const requestKey = String(request.requestKey || '').trim();
  const peer = normalizeAddress(request.peer);
  const to = normalizeAddress(request.to);
  const amount = typeof request.amount === 'string' && /^[1-9]\d*$/.test(request.amount)
    ? request.amount : '';
  const createdAt = Number(request.createdAt);
  if (!direction || !requestKey || !peer || !to || !amount || !Number.isFinite(createdAt)) return null;
  return {
    requestKey,
    direction,
    peer,
    to,
    amount,
    status: normalizeStatus(request.status),
    createdAt,
    updatedAt: Number.isFinite(Number(request.updatedAt)) ? Number(request.updatedAt) : createdAt,
    messageId: String(request.messageId || ''),
  };
}

/**
 * Turn one decrypted chat line into a request record, or null for normal text.
 * Incoming expiry starts at the relay receive time when available, so a skewed
 * sender clock cannot extend the relay's own 7-day retention window.
 */
export function paymentRequestFromMessage({ message, owner } = {}) {
  if (!message || !message.id || typeof message.text !== 'string') return null;
  const parsed = parsePaymentRequestText(message.text, message.from);
  if (parsed?.kind !== 'payment-request') return null;
  const direction = message.own === true ? 'outgoing' : 'incoming';
  const peer = normalizeAddress(direction === 'outgoing' ? message.peer : message.from);
  const self = normalizeAddress(owner || message.from);
  if (!peer || !self) return null;
  const at = Number.isFinite(Number(message.at)) ? Number(message.at) : Date.now();
  const receivedAt = Number.isFinite(Number(message.receivedAt)) ? Number(message.receivedAt) : 0;
  const createdAt = direction === 'incoming' && receivedAt > 0 ? receivedAt : at;
  return normalizeRequest({
    requestKey: requestKeyFor(direction, message.id),
    direction,
    peer,
    to: parsed.address,
    amount: parsed.amount,
    status: 'pending',
    createdAt,
    updatedAt: createdAt,
    messageId: canonicalRequestMessageId(message.id),
  });
}

/** Expiry is derived from the request's creation time, never from local reads. */
export function paymentRequestTiming(request, now = Date.now()) {
  const createdAt = Number(request?.createdAt) || 0;
  const expiresAt = createdAt + REQUEST_TTL_MS;
  const msLeft = expiresAt - now;
  return {
    expiresAt,
    msLeft,
    expired: msLeft <= 0,
    warning: msLeft > 0 && msLeft <= REQUEST_WARNING_MS,
  };
}

/** Pending requests become expired when their seven-day window ends. */
export function paymentRequestStatusAt(request, now = Date.now()) {
  const status = normalizeStatus(request?.status);
  if (status === 'pending' && paymentRequestTiming(request, now).expired) return 'expired';
  return status;
}

/**
 * A transaction card can settle a request only when it names the right payer,
 * payee and exact integer amount. The card is still a chat claim; the ledger is
 * the final authority, just as it is for every transaction bubble.
 */
export function paymentRequestForCard({ card, requests, owner, now = Date.now() } = {}) {
  if (!card || card.kind !== 'transaction-card' || !Array.isArray(requests)) return null;
  const self = normalizeAddress(owner);
  if (!self || !card.from || !card.to || card.from === card.to) return null;
  const candidates = requests
    .filter((request) => request && paymentRequestStatusAt(request, now) === 'pending')
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  for (const request of candidates) {
    if (request.amount !== card.amount) continue;
    if (request.direction === 'incoming'
        && card.from === self && card.to === request.peer) return request;
    if (request.direction === 'outgoing'
        && card.from === request.peer && card.to === self) return request;
  }
  return null;
}

async function sealRequest(key, owner, request) {
  const sealed = await sealArchiveText(key, {
    address: owner,
    peer: request.peer,
    id: aadId(request.requestKey),
    at: request.createdAt,
    own: request.direction === 'outgoing',
    text: JSON.stringify({
      amount: request.amount,
      to: request.to,
      direction: request.direction,
      status: request.status,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
    }),
  });
  return {
    key: rowKey(owner, request.requestKey),
    owner,
    peer: request.peer,
    requestKey: request.requestKey,
    createdAt: request.createdAt,
    ...sealed,
  };
}

async function openRequest(key, owner, row) {
  const body = await openArchiveText(key, {
    ...row, address: owner, id: aadId(row.requestKey), at: row.createdAt,
  });
  if (!body) return null;
  let data;
  try { data = JSON.parse(body.text); } catch { return null; }
  return normalizeRequest({
    ...data,
    requestKey: row.requestKey,
    peer: row.peer,
    createdAt: row.createdAt,
  });
}

async function putRows(rows) {
  if (!rows.length) return 0;
  const db = await openArchiveDb();
  try {
    const tx = db.transaction(REQUESTS_STORE, 'readwrite');
    const store = tx.objectStore(REQUESTS_STORE);
    for (const row of rows) store.put(row);
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('The payment inbox write failed.'));
      tx.onabort = () => reject(tx.error || new Error('The payment inbox write was aborted.'));
    });
    return rows.length;
  } finally {
    db.close();
  }
}

/**
 * Read this wallet's requests, materializing pending → expired as it goes.
 * Reading is the only trigger needed: there is no background job, and a request
 * cannot stay pending past its seven-day relay window by accident.
 */
export async function readPaymentRequests({ seed32, address, now = Date.now() } = {}) {
  if (!available() || !seed32 || !address) return [];
  const owner = String(address).toUpperCase();
  const key = await deriveArchiveKey(seed32, owner);
  const db = await openArchiveDb();
  let rows = [];
  try {
    rows = await new Promise((resolve, reject) => {
      const tx = db.transaction(REQUESTS_STORE, 'readonly');
      const request = tx.objectStore(REQUESTS_STORE).index('owner').getAll(owner);
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
  const requests = [];
  const expiredRows = [];
  for (const row of rows) {
    const request = await openRequest(key, owner, row);
    if (!request) continue;
    if (request.status === 'pending' && paymentRequestTiming(request, now).expired) {
      request.status = 'expired';
      request.updatedAt = now;
      expiredRows.push(await sealRequest(key, owner, request));
    }
    requests.push(request);
  }
  if (expiredRows.length) await putRows(expiredRows);
  return requests.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

/** Add requests that are not in the inbox yet; existing statuses are never reset. */
export async function upsertPaymentRequests({ seed32, address, requests, now = Date.now() } = {}) {
  if (!available() || !seed32 || !address || !Array.isArray(requests) || !requests.length) return 0;
  const owner = String(address).toUpperCase();
  const existing = await readPaymentRequests({ seed32, address: owner, now });
  const seen = new Set(existing.map((request) => request.requestKey));
  const key = await deriveArchiveKey(seed32, owner);
  const rows = [];
  for (const candidate of requests) {
    const request = normalizeRequest(candidate);
    if (!request || seen.has(request.requestKey)) continue;
    seen.add(request.requestKey);
    rows.push(await sealRequest(key, owner, request));
  }
  return putRows(rows);
}

/** Change the local bookkeeping status; this never touches the ledger. */
export async function setPaymentRequestStatus({
  seed32, address, requestKey, status, now = Date.now(),
} = {}) {
  if (!available() || !seed32 || !address || !requestKey) return null;
  if (!['paid', 'declined', 'expired'].includes(status)) throw new Error('Unknown payment request status.');
  const owner = String(address).toUpperCase();
  const key = await deriveArchiveKey(seed32, owner);
  const db = await openArchiveDb();
  let row;
  try {
    row = await new Promise((resolve, reject) => {
      const tx = db.transaction(REQUESTS_STORE, 'readonly');
      const request = tx.objectStore(REQUESTS_STORE).get(rowKey(owner, requestKey));
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
  if (!row) return null;
  const request = await openRequest(key, owner, row);
  if (!request) return null;
  request.status = status;
  request.updatedAt = now;
  await putRows([await sealRequest(key, owner, request)]);
  return request;
}

/** Mark at most one matching pending request paid after a transaction card. */
export async function settlePaymentRequestForCard({
  seed32, address, card, now = Date.now(),
} = {}) {
  if (!available() || !seed32 || !address || !card) return null;
  const requests = await readPaymentRequests({ seed32, address, now });
  const match = paymentRequestForCard({ card, requests, owner: address, now });
  if (!match) return null;
  return setPaymentRequestStatus({ seed32, address, requestKey: match.requestKey, status: 'paid', now });
}