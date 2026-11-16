// Encrypted chat relay.
//
// This module is deliberately dumb: it stores opaque envelopes and hands them to
// the wallet address they are addressed to. It never sees a message body, a
// wallet seed or a password, and it cannot decrypt anything — the ciphertext is
// produced on the sender's device with the recipient's published X25519 key and
// only that wallet's seed can open it (lib/e2eChat.js).
//
// Identity is a signature, not an account: every request carries the address,
// a timestamp, a nonce and an Ed25519 signature over the request line. The relay
// checks the signature against the address (a strkey decodes to its public key),
// rejects stale timestamps and replayed nonces, and then treats the address as
// the caller. No Google account, no session, no cookie.
//
// Metadata the relay does see, and does not hide: sender address, recipient
// address, message size, and arrival time. See docs/E2E-CHAT-DESIGN.md.
//
// Two recipient-side gates are enforced here rather than in the client, because
// a client check is not a control: a per-sender daily quota on stored mail, and
// a block list the recipient owns. Neither tells the sender anything it could
// act on — a blocked message is accepted and dropped, not refused.
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const B58_FREE = /^G[A-Z2-7]{55}$/;
const MAX_ENVELOPE_BYTES = 8 * 1024;
// Mail is addressed to a mailbox, not to one device, so a copy has to survive
// long enough for another device to fetch it. Seven days is the window: after
// that the relay forgets it, and a device that opted into saved chat history
// asks for it to be forgotten as soon as its own copy is stored.
const MAX_MESSAGES_PER_RECIPIENT = 2_000;
const RETENTION_DAYS = 7;
// Housekeeping runs on request at most this often, so a quiet relay still
// forgets expired mail instead of waiting for the next delivery.
const GC_INTERVAL_MS = 60_000;
const MAX_KEYS_PER_ADDRESS = 3;
const FRESHNESS_MS = 120_000;
// One wallet cannot fill somebody else's mailbox: this is the per-day ceiling
// for mail that is actually stored, counted per sender.
const MAX_MESSAGES_PER_SENDER_PER_DAY = 200;
const MAX_BLOCKS_PER_OWNER = 500;

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** strkey G… → 32-byte ed25519 public key (version byte + crc16 checked). */
export function decodeAddress(address) {
  const value = String(address || '');
  if (!B58_FREE.test(value)) return null;
  let bits = 0;
  let buffer = 0;
  const out = [];
  for (const char of value) {
    const index = B32.indexOf(char);
    if (index < 0) return null;
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  const bytes = Uint8Array.from(out);
  if (bytes.length !== 35) return null;
  if (bytes[0] !== 48) return null;                 // version byte for accounts
  // Stellar strkey: CRC16-XModem over version+payload, stored little-endian.
  const data = bytes.subarray(0, 33);
  const checksum = bytes[33] | (bytes[34] << 8);
  if ((crc16xmodem(data) & 0xffff) !== checksum) return null;
  return Buffer.from(bytes.subarray(1, 33));
}

export function crc16xmodem(bytes) {
  let crc = 0x0000;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

export function requestString({ method, path, address, ts, nonce }) {
  return `nsc-chat|1|${String(method).toUpperCase()}|${path}|${address}|${ts}|${nonce}`;
}

/** Verify a wallet-signed request. Returns the address or null. */
export function verifySignedRequest({ method, path, headers, now = Date.now() }) {
  const address = String(headers['x-nsat-address'] || '').toUpperCase();
  const ts = Number(headers['x-nsat-ts']);
  const nonce = String(headers['x-nsat-nonce'] || '');
  const sig = String(headers['x-nsat-signature'] || '');
  if (!B58_FREE.test(address) || !Number.isFinite(ts) || nonce.length < 8 || nonce.length > 64) return null;
  if (Math.abs(now - ts) > FRESHNESS_MS) return null;
  const publicKey = decodeAddress(address);
  if (!publicKey) return null;
  let signature;
  try {
    signature = Buffer.from(sig, 'base64');
  } catch {
    return null;
  }
  if (signature.length !== 64) return null;
  const key = crypto.createPublicKey({
    key: Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'), // ed25519 SPKI prefix
      publicKey,
    ]),
    format: 'der',
    type: 'spki',
  });
  const ok = crypto.verify(null, Buffer.from(requestString({ method, path, address, ts, nonce })), key, signature);
  return ok ? address : null;
}

function openDatabase(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS chat_keys (
      address TEXT NOT NULL,
      x25519_pub TEXT NOT NULL,
      bundle TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (address, x25519_pub)
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender TEXT NOT NULL,
      recipient TEXT NOT NULL,
      envelope TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      received_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chat_messages_inbox ON chat_messages (recipient, id);
    CREATE INDEX IF NOT EXISTS chat_messages_gc ON chat_messages (received_at);
    -- A recipient's block list. The relay never publishes it and never tells a
    -- sender that a block exists; it only stops storing their mail.
    CREATE TABLE IF NOT EXISTS chat_blocks (
      owner TEXT NOT NULL,
      blocked TEXT NOT NULL,
      at INTEGER NOT NULL,
      PRIMARY KEY (owner, blocked)
    );
    CREATE TABLE IF NOT EXISTS chat_quota (
      address TEXT NOT NULL,
      day INTEGER NOT NULL,
      count INTEGER NOT NULL,
      PRIMARY KEY (address, day)
    );
    CREATE INDEX IF NOT EXISTS chat_quota_gc ON chat_quota (day);
  `);
  return db;
}

/**
 * Build the relay. `handle()` takes a parsed request and returns a parsed
 * response, so it can be tested without a socket and mounted by server.js.
 */
export function createChatRelay({
  dbPath,
  now = () => Date.now(),
  maxPerSenderPerDay = MAX_MESSAGES_PER_SENDER_PER_DAY,
  maxBlocksPerOwner = MAX_BLOCKS_PER_OWNER,
  maxPerRecipient = MAX_MESSAGES_PER_RECIPIENT,
  retentionDays = RETENTION_DAYS,
  gcIntervalMs = GC_INTERVAL_MS,
} = {}) {
  if (!dbPath) throw new Error('A chat relay needs a database path.');
  const db = openDatabase(dbPath);
  const seenNonces = new Map(); // nonce → expiry, replay guard
  let lastGcAt = 0;

  /** Drop mail past retention and stale quota rows. Safe to call any time. */
  function runGc(at) {
    const expired = db.prepare('DELETE FROM chat_messages WHERE received_at < ?')
      .run(at - retentionDays * 86_400_000);
    db.prepare('DELETE FROM chat_quota WHERE day < ?').run(Math.floor(at / 86_400_000) - 1);
    lastGcAt = at;
    return Number(expired?.changes || 0);
  }

  function freshNonce(nonce) {
    const at = now();
    for (const [key, expiry] of seenNonces) {
      if (expiry <= at) seenNonces.delete(key);
    }
    if (seenNonces.has(nonce)) return false;
    seenNonces.set(nonce, at + FRESHNESS_MS * 2);
    return seenNonces.size <= 20000 ? true : false;
  }

  const json = (status, body) => ({ status, body });

  return {
    close() {
      try { db.close(); } catch { /* already closed */ }
    },

    /** Exposed so a test (or an operator) can collect without waiting a minute. */
    gc(at = now()) {
      return runGc(at);
    },

    handle({ method, path, query = {}, headers = {}, body = null }) {
      const at = now();
      if (at - lastGcAt >= gcIntervalMs) runGc(at);

      // A published messaging key is public information: anyone may read one.
      if (method === 'GET' && path === '/api/v1/chat/keys') {
        const address = String(query.address || '').toUpperCase();
        if (!B58_FREE.test(address)) return json(400, { error: 'address required' });
        const row = db.prepare(
          'SELECT bundle FROM chat_keys WHERE address = ? ORDER BY updated_at DESC LIMIT 1',
        ).get(address);
        if (!row) return json(404, { error: 'no key published' });
        return json(200, { bundle: JSON.parse(row.bundle) });
      }

      const address = verifySignedRequest({ method, path, headers, now: at });
      if (!address) return json(401, { error: 'signature required' });
      const nonce = String(headers['x-nsat-nonce'] || '');
      if (!freshNonce(nonce)) return json(409, { error: 'replayed request' });

      if (method === 'POST' && path === '/api/v1/chat/keys') {
        const bundle = body?.bundle;
        if (!bundle || String(bundle.address || '').toUpperCase() !== address) {
          return json(400, { error: 'bundle address mismatch' });
        }
        // The signature on the bundle is checked in the client SDK once; here a
        // cheap shape check keeps the table free of nonsense.
        if (!/^[A-Za-z0-9+/=]{40,60}$/.test(String(bundle.x25519Pub || ''))) {
          return json(400, { error: 'x25519Pub invalid' });
        }
        const serialized = JSON.stringify(bundle);
        db.prepare(
          `INSERT INTO chat_keys (address, x25519_pub, bundle, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (address, x25519_pub) DO UPDATE SET bundle = excluded.bundle, updated_at = excluded.updated_at`,
        ).run(address, String(bundle.x25519Pub), serialized, at);
        const count = db.prepare('SELECT COUNT(*) c FROM chat_keys WHERE address = ?').get(address).c;
        if (count > MAX_KEYS_PER_ADDRESS) {
          db.prepare(
            `DELETE FROM chat_keys WHERE address = ? AND x25519_pub NOT IN (
               SELECT x25519_pub FROM chat_keys WHERE address = ? ORDER BY updated_at DESC LIMIT ?
             )`,
          ).run(address, address, MAX_KEYS_PER_ADDRESS);
        }
        return json(200, { ok: true });
      }

      if (method === 'POST' && path === '/api/v1/chat/messages') {
        const envelope = body?.envelope;
        if (!envelope || typeof envelope !== 'object') return json(400, { error: 'envelope required' });
        if (String(envelope.from || '').toUpperCase() !== address) {
          return json(403, { error: 'envelope sender does not match the signer' });
        }
        if (!B58_FREE.test(String(envelope.to || '').toUpperCase())) {
          return json(400, { error: 'envelope recipient invalid' });
        }
        const recipient = String(envelope.to).toUpperCase();
        const serialized = JSON.stringify(envelope);
        const bytes = Buffer.byteLength(serialized);
        if (bytes > MAX_ENVELOPE_BYTES) return json(413, { error: 'envelope too large' });

        // A block is held by the side that set it, in either direction: if either
        // address blocked the other, the message is not stored. The answer is the
        // same as a delivered one on purpose — the relay must not become the
        // place where a person learns that they were blocked — and a dropped
        // message costs the sender no quota, because nothing was delivered.
        const blocked = db.prepare(
          `SELECT 1 AS hit FROM chat_blocks
           WHERE (owner = ? AND blocked = ?) OR (owner = ? AND blocked = ?)`,
        ).get(recipient, address, address, recipient);
        if (blocked) return json(200, { ok: true, stored: false });

        const day = Math.floor(at / 86_400_000);
        const usedToday = db.prepare(
          'SELECT count FROM chat_quota WHERE address = ? AND day = ?',
        ).get(address, day)?.count || 0;
        if (usedToday >= maxPerSenderPerDay) {
          return json(429, { error: 'daily message limit reached' });
        }

        // Expired mail must not make a mailbox look full: enforce retention on
        // the send path itself, not only on the once-a-minute housekeeping pass.
        runGc(at);
        const pending = db.prepare(
          'SELECT COUNT(*) c FROM chat_messages WHERE recipient = ?',
        ).get(recipient).c;
        if (pending >= maxPerRecipient) {
          return json(429, { error: 'recipient mailbox is full' });
        }
        db.prepare(
          'INSERT INTO chat_messages (sender, recipient, envelope, bytes, received_at) VALUES (?, ?, ?, ?, ?)',
        ).run(address, recipient, serialized, bytes, at);
        db.prepare(
          `INSERT INTO chat_quota (address, day, count) VALUES (?, ?, 1)
           ON CONFLICT (address, day) DO UPDATE SET count = count + 1`,
        ).run(address, day);
        return json(200, { ok: true });
      }

      if (method === 'GET' && path === '/api/v1/chat/messages') {
        const since = Number(query.since);
        const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 200);
        const rows = db.prepare(
          `SELECT id, envelope, received_at FROM chat_messages
           WHERE recipient = ? AND id > ? ORDER BY id ASC LIMIT ?`,
        ).all(address, Number.isFinite(since) ? since : 0, limit);
        return json(200, {
          messages: rows.map((row) => ({ id: row.id, receivedAt: row.received_at, envelope: JSON.parse(row.envelope) })),
        });
      }

      // Explicit clear only: the client no longer acknowledges on read, so this
      // runs when a person asks for their mailbox to be emptied. It removes the
      // copies of every device on purpose; the UI warns before calling it.
      if (method === 'POST' && path === '/api/v1/chat/ack') {
        const ids = Array.isArray(body?.ids) ? body.ids.filter((id) => Number.isInteger(id)).slice(0, 200) : [];
        if (ids.length === 0) return json(400, { error: 'ids required' });
        const placeholders = ids.map(() => '?').join(',');
        const cleared = db.prepare(`DELETE FROM chat_messages WHERE recipient = ? AND id IN (${placeholders})`)
          .run(address, ...ids);
        return json(200, { ok: true, deleted: Number(cleared?.changes || 0) });
      }

      // ---------------- block list ----------------
      // Only the owner can read or change their own list, and the entries are
      // plain wallet addresses: no reason, no name, no message. A block also
      // clears what that sender already queued for this wallet, so a block takes
      // effect on mail that is already sitting on the relay.
      if (method === 'GET' && path === '/api/v1/chat/blocks') {
        const rows = db.prepare(
          'SELECT blocked FROM chat_blocks WHERE owner = ? ORDER BY blocked LIMIT ?',
        ).all(address, maxBlocksPerOwner);
        return json(200, { blocked: rows.map((row) => row.blocked) });
      }

      if (method === 'POST' && path === '/api/v1/chat/blocks') {
        const blocked = String(body?.blocked || '').toUpperCase();
        const action = String(body?.action || 'add');
        if (!B58_FREE.test(blocked)) return json(400, { error: 'blocked address invalid' });
        if (blocked === address) return json(400, { error: 'cannot block your own address' });
        if (action === 'remove') {
          db.prepare('DELETE FROM chat_blocks WHERE owner = ? AND blocked = ?').run(address, blocked);
          return json(200, { ok: true, blocked: false });
        }
        if (action !== 'add') return json(400, { error: 'action must be add or remove' });
        // Blocking somebody who is already blocked is a no-op, not a new entry:
        // it must not fail because the list happens to be at its ceiling.
        const alreadyBlocked = db.prepare(
          'SELECT 1 AS hit FROM chat_blocks WHERE owner = ? AND blocked = ?',
        ).get(address, blocked);
        if (!alreadyBlocked) {
          const held = db.prepare('SELECT COUNT(*) c FROM chat_blocks WHERE owner = ?').get(address).c;
          if (held >= maxBlocksPerOwner) return json(429, { error: 'block list is full' });
        }
        db.prepare(
          `INSERT INTO chat_blocks (owner, blocked, at) VALUES (?, ?, ?)
           ON CONFLICT (owner, blocked) DO UPDATE SET at = excluded.at`,
        ).run(address, blocked, at);
        const cleared = db.prepare(
          'DELETE FROM chat_messages WHERE recipient = ? AND sender = ?',
        ).run(address, blocked);
        return json(200, { ok: true, blocked: true, cleared: Number(cleared?.changes || 0) });
      }

      return json(404, { error: 'not found' });
    },
  };
}
