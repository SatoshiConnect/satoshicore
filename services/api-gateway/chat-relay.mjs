// Encrypted chat relay.
//
// This module is deliberately dumb: it stores opaque envelopes and hands them to
// every device registered for the wallet address they are addressed to. It never
// sees a message body, a wallet seed or a password, and it cannot decrypt
// anything — the ciphertext is produced on the sender's device with the
// recipient's published X25519 key. A v2 chat identity, delegated by the wallet
// once, holds the private half on the device and can open it while the wallet
// is locked (lib/e2eChat.js, lib/chatIdentity.js).
//
// Identity is a signature, not an account: every request carries the address,
// a timestamp, a nonce and an Ed25519 signature over the request line. v3 also
// carries the delegated chat public key, so the chat key signs after the wallet
// is locked; v1/v2 wallet-signed requests remain accepted. The relay rejects
// stale timestamps and replayed nonces. No Google account, no session, no cookie.
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

import {
  MAX_SUBSCRIPTIONS_PER_ADDRESS, PUSH_MAX_ATTEMPTS, pushRetryAt, validPushSubscription,
} from './push.mjs';

const B58_FREE = /^G[A-Z2-7]{55}$/;
const DEVICE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const LEGACY_DEVICE = 'legacy';
const MAX_ENVELOPE_BYTES = 8 * 1024;
const MAX_DEVICES_PER_ADDRESS = 10;
// Mail is addressed to a mailbox, not to one device, so a copy has to survive
// long enough for another device to fetch it. Seven days is the window: after
// that the relay forgets it, and a device that opted into saved chat history
// asks for it to be forgotten as soon as its own copy is stored.
//
// The ceiling is a safety valve, not the normal limit: at 8 KiB per envelope,
// 5,000 rows is a bounded ~40 MB per mailbox, and seven days of one sender at
// the full 200/day quota is at most 1,400. An unopened room therefore stops
// filling the shared mailbox long before this number, and a mailbox answers
// `429` only when several senders have maxed out at once. Housekeeping removes
// expired rows, so the ceiling comes back down on its own.
const MAX_MESSAGES_PER_RECIPIENT = 5_000;
const RETENTION_DAYS = 7;
// Housekeeping runs on request at most this often. The delete is indexed on
// `received_at`, so this is cheap; a short interval keeps a busy relay from
// counting expired mail toward the ceiling.
const GC_INTERVAL_MS = 15_000;
const MAX_KEYS_PER_ADDRESS = 3;
const FRESHNESS_MS = 120_000;
// One wallet cannot fill somebody else's mailbox: this is the per-day ceiling
// for mail that is actually stored, counted per sender.
const MAX_MESSAGES_PER_SENDER_PER_DAY = 200;
const MAX_BLOCKS_PER_OWNER = 500;
// A wallet can install the app on a handful of devices; each one registers its
// own push subscription. Older ones are evicted so a reinstall cannot fail.
const MAX_PUSH_SUBSCRIPTIONS = MAX_SUBSCRIPTIONS_PER_ADDRESS;
const PUSH_DRAIN_LIMIT = 25;

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

// v2 signs the device id too, so a request cannot be re-pointed at another
// device. Requests without one keep the v1 line for older clients.
export function requestString({ method, path, address, ts, nonce, device = '' }) {
  const id = DEVICE_RE.test(String(device)) ? String(device) : '';
  return id
    ? `nsc-chat|2|${String(method).toUpperCase()}|${path}|${address}|${id}|${ts}|${nonce}`
    : `nsc-chat|1|${String(method).toUpperCase()}|${path}|${address}|${ts}|${nonce}`;
}

// v3 uses a separate chat identity. The wallet signed one delegation when the
// identity was created; every later request is signed by the chat key, so chat
// keeps working while the wallet itself is locked.
export function chatIdentityRequestString({
  method, path, address, chatPub, ts, nonce, device = '',
}) {
  const id = DEVICE_RE.test(String(device)) ? String(device) : '';
  return id
    ? `nsc-chat|3|${String(method).toUpperCase()}|${path}|${address}|${chatPub}|${id}|${ts}|${nonce}`
    : `nsc-chat|3|${String(method).toUpperCase()}|${path}|${address}|${chatPub}|${ts}|${nonce}`;
}

export function chatDelegationString({ address, chatPub }) {
  return `nsc-chat-delegation|1|${address}|${chatPub}`;
}

function ed25519Key(raw) {
  try {
    return crypto.createPublicKey({
      key: Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'),
        Buffer.from(raw),
      ]),
      format: 'der',
      type: 'spki',
    });
  } catch {
    return null;
  }
}

/** Verify a request signed by a delegated chat identity. */
export function verifyChatSignedRequest({ method, path, headers, now = Date.now() }) {
  const address = String(headers['x-nsat-address'] || '').toUpperCase();
  const chatPub = String(headers['x-nsat-chat-pub'] || '');
  const delegation = String(headers['x-nsat-chat-delegation'] || '');
  const ts = Number(headers['x-nsat-ts']);
  const nonce = String(headers['x-nsat-nonce'] || '');
  const sig = String(headers['x-nsat-signature'] || '');
  const device = deviceIdOf(headers);
  if (device === null) return null;
  if (!B58_FREE.test(address) || !Number.isFinite(ts) || nonce.length < 8 || nonce.length > 64) return null;
  if (Math.abs(now - ts) > FRESHNESS_MS) return null;
  const walletKey = decodeAddress(address);
  if (!walletKey) return null;
  let chatKeyBytes;
  let delegationBytes;
  let signatureBytes;
  try {
    chatKeyBytes = Buffer.from(chatPub, 'base64');
    delegationBytes = Buffer.from(delegation, 'base64');
    signatureBytes = Buffer.from(sig, 'base64');
  } catch {
    return null;
  }
  if (chatKeyBytes.length !== 32 || delegationBytes.length !== 64 || signatureBytes.length !== 64) return null;
  const walletPublicKey = ed25519Key(walletKey);
  const chatPublicKey = ed25519Key(chatKeyBytes);
  if (!walletPublicKey || !chatPublicKey) return null;
  const delegated = crypto.verify(
    null,
    Buffer.from(chatDelegationString({ address, chatPub })),
    walletPublicKey,
    delegationBytes,
  );
  if (!delegated) return null;
  const signed = crypto.verify(
    null,
    Buffer.from(chatIdentityRequestString({
      method, path, address, chatPub, ts, nonce, device,
    })),
    chatPublicKey,
    signatureBytes,
  );
  return signed ? { address, chatPub } : null;
}

/** A signed device id, '' when absent, or null when present but malformed. */
export function deviceIdOf(headers = {}) {
  const raw = String(headers['x-nsat-device'] || '').trim();
  if (!raw) return '';
  return DEVICE_RE.test(raw) ? raw : null;
}

/** Verify a wallet-signed request. Returns the address or null. */
export function verifySignedRequest({ method, path, headers, now = Date.now() }) {
  const address = String(headers['x-nsat-address'] || '').toUpperCase();
  const ts = Number(headers['x-nsat-ts']);
  const nonce = String(headers['x-nsat-nonce'] || '');
  const sig = String(headers['x-nsat-signature'] || '');
  const device = deviceIdOf(headers);
  if (device === null) return null;
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
  const ok = crypto.verify(
    null,
    Buffer.from(requestString({ method, path, address, ts, nonce, device })),
    key,
    signature,
  );
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
      received_at INTEGER NOT NULL,
      client_id TEXT
    );
    CREATE INDEX IF NOT EXISTS chat_messages_inbox ON chat_messages (recipient, id);
    CREATE INDEX IF NOT EXISTS chat_messages_peer ON chat_messages (recipient, sender, id);
    CREATE INDEX IF NOT EXISTS chat_messages_gc ON chat_messages (received_at);
    -- One row per device that has identified itself for this wallet. A message
    -- is copied to every registered device, so reading on one does not erase
    -- the copy another device still needs. 'legacy' is the device id used by
    -- clients that predate the device header.
    CREATE TABLE IF NOT EXISTS chat_devices (
      address TEXT NOT NULL,
      device_id TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      PRIMARY KEY (address, device_id)
    );
    CREATE INDEX IF NOT EXISTS chat_devices_seen ON chat_devices (address, last_seen_at);
    CREATE INDEX IF NOT EXISTS chat_devices_gc ON chat_devices (last_seen_at);
    -- A message survives until every device it was delivered to has acked it,
    -- or until retention expires. Rows are deleted with their message.
    CREATE TABLE IF NOT EXISTS chat_deliveries (
      message_id INTEGER NOT NULL,
      device_id TEXT NOT NULL,
      PRIMARY KEY (message_id, device_id)
    );
    CREATE INDEX IF NOT EXISTS chat_deliveries_device ON chat_deliveries (device_id, message_id);
    -- Mail that predates this schema has no device rows: make it visible to the
    -- legacy device until a real device registers and backfills itself.
    INSERT OR IGNORE INTO chat_deliveries (message_id, device_id)
      SELECT m.id, 'legacy' FROM chat_messages m
      WHERE NOT EXISTS (SELECT 1 FROM chat_deliveries d WHERE d.message_id = m.id);
    -- A recipient's block list. The relay never publishes it and never tells a
    -- sender that a block exists; it only stops storing their mail.
    CREATE TABLE IF NOT EXISTS chat_blocks (
      owner TEXT NOT NULL,
      blocked TEXT NOT NULL,
      at INTEGER NOT NULL,
      PRIMARY KEY (owner, blocked)
    );
    -- The highest message id each reader has displayed for a sender. This is a
    -- read receipt, not a delivery receipt: it is written only after the room
    -- has rendered the message, and it never contains message text.
    CREATE TABLE IF NOT EXISTS chat_reads (
      reader TEXT NOT NULL,
      sender TEXT NOT NULL,
      last_id INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (reader, sender)
    );
    -- A deleted message leaves an id-only tombstone so offline recipients and
    -- the sender's other devices can remove their local/archived copy. It does
    -- not retain the deleted ciphertext.
    CREATE TABLE IF NOT EXISTS chat_tombstones (
      id INTEGER PRIMARY KEY,
      sender TEXT NOT NULL,
      recipient TEXT NOT NULL,
      deleted_at INTEGER NOT NULL
    );
    -- Durable pair marker used only to decide whether presence may be
    -- disclosed. It stores no profile or message content.
    CREATE TABLE IF NOT EXISTS chat_contacts (
      owner TEXT NOT NULL,
      peer TEXT NOT NULL,
      last_at INTEGER NOT NULL,
      PRIMARY KEY (owner, peer)
    );
    CREATE TABLE IF NOT EXISTS chat_quota (
      address TEXT NOT NULL,
      day INTEGER NOT NULL,
      count INTEGER NOT NULL,
      PRIMARY KEY (address, day)
    );
    CREATE INDEX IF NOT EXISTS chat_quota_gc ON chat_quota (day);
    -- Replay guard that survives a gateway restart. A nonce is accepted once
    -- and kept for twice the freshness window; the row is the authority, not an
    -- in-memory set. Expired rows are removed by the same GC pass as mail.
    CREATE TABLE IF NOT EXISTS chat_nonces (
      nonce TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chat_nonces_expiry ON chat_nonces (expires_at);
    -- Push subscriptions are per device, never per message: an endpoint plus the
    -- two keys the push service encrypts to. Nothing here identifies a message.
    CREATE TABLE IF NOT EXISTS chat_push_subs (
      address TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (address, endpoint)
    );
    -- A durable "wake this wallet" queue: one pending row per wallet, so a burst
    -- of messages becomes one notification, and a gateway restart does not drop
    -- an alert. It holds an address pair and nothing that can be read as text.
    CREATE TABLE IF NOT EXISTS chat_push_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      address TEXT NOT NULL,
      peer TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_at INTEGER NOT NULL,
      claimed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS chat_push_queue_due ON chat_push_queue (next_at);
    CREATE INDEX IF NOT EXISTS chat_push_queue_address ON chat_push_queue (address);
  `);
  // Older database files predate client_id. Adding the column is a safe
  // migration; the partial unique index makes a retried POST one message, not
  // two, while leaving historical rows (NULL) untouched.
  const columns = db.prepare('PRAGMA table_info(chat_messages)').all();
  if (!columns.some((column) => column.name === 'client_id')) {
    db.exec('ALTER TABLE chat_messages ADD COLUMN client_id TEXT');
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_client
      ON chat_messages (sender, client_id) WHERE client_id IS NOT NULL;
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
  maxDevicesPerAddress = MAX_DEVICES_PER_ADDRESS,
  push = null,
} = {}) {
  if (!dbPath) throw new Error('A chat relay needs a database path.');
  const db = openDatabase(dbPath);
  // Web Push is optional: without VAPID keys the routes answer 503 and no
  // queued work exists, so an operator can run the relay without it.
  const pushEnabled = Boolean(push?.configured);
  let lastGcAt = 0;
  const listeners = new Set();
  // Ephemeral typing cooldown; this never enters SQLite and expires with the
  // process. A sender can wake the peer at most once every 2 s per direction.
  const typingAt = new Map();
  // Ephemeral, opt-in presence. A heartbeat is not persisted; it expires in
  // 45 s and is only disclosed to a wallet that already shares message history.
  const presenceAt = new Map();

  /** Drop mail past retention and stale quota rows. Safe to call any time. */
  function runGc(at) {
    const cutoff = at - retentionDays * 86_400_000;
    db.prepare(
      'DELETE FROM chat_deliveries WHERE message_id IN (SELECT id FROM chat_messages WHERE received_at < ?)',
    ).run(cutoff);
    const expired = db.prepare('DELETE FROM chat_messages WHERE received_at < ?').run(cutoff);
    // A device that has not been seen for the whole retention window cannot
    // still need any message that is left; drop it so a stale legacy client
    // does not keep every future envelope alive. A returning device registers
    // again and is backfilled with what is still pending.
    const staleDevices = db.prepare(
      'SELECT address, device_id FROM chat_devices WHERE last_seen_at < ?',
    ).all(cutoff);
    const dropDeviceMail = db.prepare(
      `DELETE FROM chat_deliveries WHERE device_id = ?
       AND message_id IN (SELECT id FROM chat_messages WHERE recipient = ?)`,
    );
    const dropDevice = db.prepare('DELETE FROM chat_devices WHERE address = ? AND device_id = ?');
    for (const row of staleDevices) {
      dropDeviceMail.run(row.device_id, row.address);
      dropDevice.run(row.address, row.device_id);
    }
    db.prepare('DELETE FROM chat_tombstones WHERE deleted_at < ?').run(cutoff);
    db.prepare('DELETE FROM chat_quota WHERE day < ?').run(Math.floor(at / 86_400_000) - 1);
    db.prepare('DELETE FROM chat_nonces WHERE expires_at <= ?').run(at);
    lastGcAt = at;
    return Number(expired?.changes || 0);
  }

  /** Keep the per-wallet device list bounded; the oldest device loses its mail. */
  function trimDevices(address) {
    const held = db.prepare('SELECT COUNT(*) c FROM chat_devices WHERE address = ?').get(address).c;
    const extra = held - maxDevicesPerAddress;
    if (extra <= 0) return;
    const stale = db.prepare(
      'SELECT device_id FROM chat_devices WHERE address = ? ORDER BY last_seen_at ASC LIMIT ?',
    ).all(address, extra);
    const dropMail = db.prepare(
      `DELETE FROM chat_deliveries WHERE device_id = ?
       AND message_id IN (SELECT id FROM chat_messages WHERE recipient = ?)`,
    );
    const dropDevice = db.prepare('DELETE FROM chat_devices WHERE address = ? AND device_id = ?');
    for (const row of stale) {
      dropMail.run(row.device_id, address);
      dropDevice.run(address, row.device_id);
    }
  }

  /** Register or refresh one device and give it the pending mail it has not seen. */
  function touchDevice(address, device, at) {
    if (!device) return;
    const known = db.prepare(
      'SELECT first_seen_at FROM chat_devices WHERE address = ? AND device_id = ?',
    ).get(address, device);
    if (known) {
      db.prepare('UPDATE chat_devices SET last_seen_at = ? WHERE address = ? AND device_id = ?')
        .run(at, address, device);
      return;
    }
    db.prepare(
      'INSERT INTO chat_devices (address, device_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)',
    ).run(address, device, at, at);
    // A device that registers late still gets the mail still waiting here.
    db.prepare(
      `INSERT OR IGNORE INTO chat_deliveries (message_id, device_id)
       SELECT id, ? FROM chat_messages WHERE recipient = ?`,
    ).run(device, address);
    trimDevices(address);
  }

  /** Copy a new message to every device that currently reads this mailbox. */
  function deliverToDevices(messageId, recipient) {
    const devices = db.prepare('SELECT device_id FROM chat_devices WHERE address = ?').all(recipient);
    const insert = db.prepare(
      'INSERT OR IGNORE INTO chat_deliveries (message_id, device_id) VALUES (?, ?)',
    );
    for (const row of devices) insert.run(messageId, row.device_id);
  }

  /** A wallet with at least one registered device subscription. */
  function pushable(address) {
    return db.prepare('SELECT COUNT(*) c FROM chat_push_subs WHERE address = ?').get(address).c > 0;
  }

  /**
   * Queue one wake-up for a recipient. A burst collapses into the row that is
   * already pending, and that row's peer moves to the newest sender so the
   * notification opens the conversation the person actually just heard from.
   * Nothing about the message is stored here — not the id, not the size.
   */
  function enqueuePush(recipient, sender, at) {
    if (!pushEnabled || !recipient || recipient === sender) return false;
    if (!pushable(recipient)) return false;
    const pending = db.prepare(
      'SELECT id FROM chat_push_queue WHERE address = ? AND claimed_at IS NULL ORDER BY id ASC LIMIT 1',
    ).get(recipient);
    if (pending) {
      db.prepare('UPDATE chat_push_queue SET peer = ? WHERE id = ?').run(sender, pending.id);
      return true;
    }
    db.prepare(
      `INSERT INTO chat_push_queue (address, peer, created_at, attempts, next_at)
       VALUES (?, ?, ?, 0, ?)`,
    ).run(recipient, sender, at, at);
    return true;
  }

  // Durable replay guard. The nonce row is inserted before the request is
  // acted on, so a captured request cannot be replayed after a restart, and a
  // nonce used by a failed request is still spent (the client retries with a
  // fresh one). One process per SQLite file is assumed; see the deployment
  // guide.
  function freshNonce(nonce, at) {
    const seen = db.prepare('SELECT 1 AS hit FROM chat_nonces WHERE nonce = ?').get(nonce);
    if (seen) return false;
    db.prepare('INSERT INTO chat_nonces (nonce, expires_at) VALUES (?, ?)')
      .run(nonce, at + FRESHNESS_MS * 2);
    return true;
  }

  const json = (status, body) => ({ status, body });

  return {
    close() {
      listeners.clear();
      try { db.close(); } catch { /* already closed */ }
    },

    /** Authenticate an SSE handshake once; it consumes the nonce like a request. */
    authenticate({ method, path, headers }) {
      // A browser with a delegated chat identity signs v3, even while the
      // wallet is locked. The SSE route must accept the same identity as the
      // signed HTTP routes; otherwise the UI reconnects forever with 401 and
      // its polling/fetch path looks broken. Wallet-signed v1/v2 clients are
      // still accepted for compatibility.
      const chatAuth = verifyChatSignedRequest({ method, path, headers, now: now() });
      const address = chatAuth?.address || verifySignedRequest({ method, path, headers });
      if (!address) return null;
      const nonce = String(headers?.['x-nsat-nonce'] || '');
      const at = now();
      if (!nonce || !freshNonce(nonce, at)) return null;
      const device = deviceIdOf(headers) || '';
      if (device) touchDevice(address, device, at);
      return { address, device };
    },

    /** Wake an SSE connection when this recipient gets a new message. */
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** Exposed so a test (or an operator) can collect without waiting a minute. */
    gc(at = now()) {
      return runGc(at);
    },

    /** What push looks like from the outside: configured, or not at all. */
    pushInfo() {
      return { configured: pushEnabled, publicKey: push?.publicKey || '' };
    },

    /**
     * Deliver due wake-ups. The queue is the source of truth; this pass is
     * idempotent and safe to run again after a crash (claimed rows are only
     * removed once a push service accepted them). Never throws: a failing push
     * service must not take the relay down.
     */
    async pushTick(at = now(), { limit = PUSH_DRAIN_LIMIT } = {}) {
      const stats = { due: 0, delivered: 0, dropped: 0, retried: 0, gone: 0 };
      if (!pushEnabled) return stats;
      db.prepare(
        'UPDATE chat_push_queue SET claimed_at = NULL WHERE claimed_at IS NOT NULL AND claimed_at < ?',
      ).run(at - 5 * 60_000);
      const due = db.prepare(
        `SELECT id, address, peer, attempts FROM chat_push_queue
         WHERE next_at <= ? AND claimed_at IS NULL ORDER BY id ASC LIMIT ?`,
      ).all(at, limit);
      stats.due = due.length;
      if (!due.length) return stats;
      // A crash between claim and answer must not strand an alert forever: a
      // claim older than five minutes is returned to the queue on the next pass.
      const claim = db.prepare('UPDATE chat_push_queue SET claimed_at = ? WHERE id = ?');
      const drop = db.prepare('DELETE FROM chat_push_queue WHERE id = ?');
      const reschedule = db.prepare(
        'UPDATE chat_push_queue SET attempts = ?, next_at = ?, claimed_at = NULL WHERE id = ?',
      );
      const subsOf = db.prepare('SELECT endpoint, p256dh, auth FROM chat_push_subs WHERE address = ?');
      const unsubscribe = db.prepare('DELETE FROM chat_push_subs WHERE address = ? AND endpoint = ?');

      for (const job of due) {
        claim.run(at, job.id);
        const subs = subsOf.all(job.address);
        if (!subs.length) {
          drop.run(job.id);
          stats.dropped += 1;
          continue;
        }
        let accepted = 0;
        let failed = 0;
        for (const sub of subs) {
          let result;
          try {
            result = await push.send({
              endpoint: sub.endpoint,
              keys: { p256dh: sub.p256dh, auth: sub.auth },
            }, job.peer);
          } catch {
            result = { ok: false, status: 0 };
          }
          if (result?.ok) {
            accepted += 1;
            continue;
          }
          if (result?.status === 404 || result?.status === 410) {
            // The browser dropped the subscription (uninstalled, cleared data).
            unsubscribe.run(job.address, sub.endpoint);
            stats.gone += 1;
            continue;
          }
          failed += 1;
        }
        if (accepted > 0) {
          drop.run(job.id);
          stats.delivered += 1;
          continue;
        }
        if (failed === 0) {
          // Every device was gone; nothing left to wake.
          drop.run(job.id);
          stats.dropped += 1;
          continue;
        }
        const attempts = Number(job.attempts || 0) + 1;
        if (attempts >= PUSH_MAX_ATTEMPTS) {
          drop.run(job.id);
          stats.dropped += 1;
          continue;
        }
        reschedule.run(attempts, pushRetryAt(at, attempts), job.id);
        stats.retried += 1;
      }
      return stats;
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

      const chatAuth = verifyChatSignedRequest({ method, path, headers, now: at });
      const address = chatAuth?.address || verifySignedRequest({ method, path, headers, now: at });
      if (!address) return json(401, { error: 'signature required' });
      const nonce = String(headers['x-nsat-nonce'] || '');
      if (!freshNonce(nonce, at)) return json(409, { error: 'replayed request' });
      // Every signed request identifies the device making it. Older clients omit
      // the header and are treated as one shared `legacy` device.
      const device = deviceIdOf(headers) || LEGACY_DEVICE;
      touchDevice(address, device, at);

      if (method === 'POST' && path === '/api/v1/chat/keys') {
        const bundle = body?.bundle;
        if (!bundle || String(bundle.address || '').toUpperCase() !== address) {
          return json(400, { error: 'bundle address mismatch' });
        }
        if (bundle.v === 2) {
          if (!chatAuth
              || String(bundle.chatPub || '') !== chatAuth.chatPub
              || String(bundle.delegation || '') !== String(headers['x-nsat-chat-delegation'] || '')) {
            return json(400, { error: 'chat identity mismatch' });
          }
          if (!/^[A-Za-z0-9+/=]{40,60}$/.test(String(bundle.x25519Pub || ''))) {
            return json(400, { error: 'x25519Pub invalid' });
          }
        } else
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
        const clientId = body?.clientId === undefined ? '' : String(body.clientId);
        if (clientId && !/^[A-Za-z0-9_-]{8,80}$/.test(clientId)) {
          return json(400, { error: 'clientId invalid' });
        }
        const serialized = JSON.stringify(envelope);
        const bytes = Buffer.byteLength(serialized);
        if (bytes > MAX_ENVELOPE_BYTES) return json(413, { error: 'envelope too large' });

        // A retry must be the same message. If this sender already stored this
        // client id, return the original id and do not deliver or charge quota
        // again. This check is before the block/quota gates on purpose: a
        // message that was already accepted remains accepted on a retry.
        if (clientId) {
          const existing = db.prepare(
            'SELECT id FROM chat_messages WHERE sender = ? AND client_id = ?',
          ).get(address, clientId);
          if (existing) return json(200, { ok: true, id: existing.id, duplicate: true });
        }

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
        // the send path itself, not only on the periodic housekeeping pass.
        runGc(at);
        const pending = db.prepare(
          'SELECT COUNT(*) c FROM chat_messages WHERE recipient = ?',
        ).get(recipient).c;
        if (pending >= maxPerRecipient) {
          return json(429, { error: 'recipient mailbox is full' });
        }
        const inserted = db.prepare(
          `INSERT INTO chat_messages
             (sender, recipient, envelope, bytes, received_at, client_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(address, recipient, serialized, bytes, at, clientId || null);
        deliverToDevices(Number(inserted.lastInsertRowid), recipient);
        // Cheap, best-effort wake-up: the durable row is what matters, and an
        // alert is never allowed to turn a stored message into a failed send.
        try {
          enqueuePush(recipient, address, at);
        } catch { /* the message is stored; a push is a convenience */ }
        const contact = db.prepare(
          `INSERT INTO chat_contacts (owner, peer, last_at) VALUES (?, ?, ?)
           ON CONFLICT (owner, peer) DO UPDATE SET last_at = excluded.last_at`,
        );
        contact.run(address, recipient, at);
        contact.run(recipient, address, at);
        db.prepare(
          `INSERT INTO chat_quota (address, day, count) VALUES (?, ?, 1)
           ON CONFLICT (address, day) DO UPDATE SET count = count + 1`,
        ).run(address, day);
        for (const listener of listeners) {
          try {
            listener({ type: 'message', recipient, id: Number(inserted.lastInsertRowid) });
          } catch { /* one dead SSE client */ }
        }
        return json(200, { ok: true, id: Number(inserted.lastInsertRowid) });
      }

      if (method === 'GET' && path === '/api/v1/chat/messages') {
        const since = Number(query.since);
        const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 200);
        // `peer` narrows a read to one conversation. Opening a room asks for
        // that sender's pending mail instead of paging the whole mailbox, while
        // the list poll stays on `since` (its own cursor).
        const peer = typeof query.peer === 'string' ? query.peer.toUpperCase() : '';
        if (peer && !B58_FREE.test(peer)) return json(400, { error: 'invalid peer' });
        // Only this device's delivery is returned: another device reading the
        // same mailbox must not hide a message this one has not fetched yet.
        const rows = peer
          ? db.prepare(
            `SELECT m.id, m.envelope, m.received_at FROM chat_messages m
             JOIN chat_deliveries d ON d.message_id = m.id
             WHERE m.recipient = ? AND d.device_id = ? AND m.sender = ? AND m.id > ?
             ORDER BY m.id ASC LIMIT ?`,
          ).all(address, device, peer, Number.isFinite(since) ? since : 0, limit)
          : db.prepare(
            `SELECT m.id, m.envelope, m.received_at FROM chat_messages m
             JOIN chat_deliveries d ON d.message_id = m.id
             WHERE m.recipient = ? AND d.device_id = ? AND m.id > ?
             ORDER BY m.id ASC LIMIT ?`,
          ).all(address, device, Number.isFinite(since) ? since : 0, limit);
        return json(200, {
          messages: rows.map((row) => ({ id: row.id, receivedAt: row.received_at, envelope: JSON.parse(row.envelope) })),
        });
      }

      // Acknowledge only this device's copies. The message itself is removed
      // once no device still needs it, or at retention, whichever comes first.
      if (method === 'POST' && path === '/api/v1/chat/ack') {
        const ids = Array.isArray(body?.ids)
          ? [...new Set(body.ids.filter((id) => Number.isSafeInteger(id) && id > 0))].slice(0, 200)
          : [];
        if (ids.length === 0) return json(400, { error: 'ids required' });
        const placeholders = ids.map(() => '?').join(',');
        // Scope by recipient as well as device: one browser can hold several
        // wallets, and an ack signed by one must not touch another's delivery.
        const owned = db.prepare(
          `SELECT d.message_id FROM chat_deliveries d
           JOIN chat_messages m ON m.id = d.message_id
           WHERE d.device_id = ? AND m.recipient = ? AND d.message_id IN (${placeholders})`,
        ).all(device, address, ...ids).map((row) => row.message_id);
        if (owned.length === 0) return json(200, { ok: true, acked: 0, deleted: 0 });
        const ownedPlaceholders = owned.map(() => '?').join(',');
        const acked = db.prepare(
          `DELETE FROM chat_deliveries WHERE device_id = ? AND message_id IN (${ownedPlaceholders})`,
        ).run(device, ...owned);
        // Only messages this device actually held may disappear, and only when
        // no other device still has a delivery for them.
        const cleared = db.prepare(
          `DELETE FROM chat_messages WHERE recipient = ? AND id IN (${ownedPlaceholders})
           AND NOT EXISTS (SELECT 1 FROM chat_deliveries WHERE message_id = chat_messages.id)`,
        ).run(address, ...owned);
        return json(200, {
          ok: true,
          acked: Number(acked?.changes || 0),
          deleted: Number(cleared?.changes || 0),
        });
      }

      // Presence is opt-in: the client sends a heartbeat only after the user
      // enables it. It is in-memory and expires, never a message or profile row.
      if (method === 'POST' && path === '/api/v1/chat/presence') {
        if (body?.online === false) presenceAt.delete(address);
        else presenceAt.set(address, now());
        if (presenceAt.size > 5000) presenceAt.delete(presenceAt.keys().next().value);
        return json(200, { ok: true });
      }

      if (method === 'GET' && path === '/api/v1/chat/presence') {
        const peer = String(query.peer || '').toUpperCase();
        if (!B58_FREE.test(peer)) return json(400, { error: 'invalid peer' });
        const shared = db.prepare(
          'SELECT 1 AS hit FROM chat_contacts WHERE owner = ? AND peer = ?',
        ).get(address, peer);
        if (!shared) return json(200, { peer, online: false, lastSeen: 0, known: false });
        const seen = presenceAt.get(peer) || 0;
        return json(200, {
          peer,
          online: seen > 0 && now() - seen < 45_000,
          lastSeen: seen,
          known: true,
        });
      }

      // Typing is deliberately ephemeral: no message row, no read receipt and
      // no plaintext. `until` lets a receiver expire it even if the stop frame
      // is lost.
      if (method === 'POST' && path === '/api/v1/chat/typing') {
        const peer = String(body?.peer || '').toUpperCase();
        if (!B58_FREE.test(peer) || peer === address) return json(400, { error: 'invalid peer' });
        const active = body?.typing === true;
        const at = now();
        const key = `${address}:${peer}`;
        if (active && at - (typingAt.get(key) || 0) < 2000) {
          return json(200, { ok: true, suppressed: true });
        }
        typingAt.set(key, at);
        if (typingAt.size > 5000) typingAt.delete(typingAt.keys().next().value);
        for (const listener of listeners) {
          try {
            listener({
              type: 'typing', recipient: peer, from: address,
              until: active ? at + 5000 : 0,
            });
          } catch { /* one dead SSE client */ }
        }
        return json(200, { ok: true });
      }

      // Delete-for-everyone: only the original sender may remove the ciphertext.
      // The recipient and the sender's other devices learn the id from the
      // tombstone list or SSE, never from a new plaintext message.
      if (method === 'POST' && path === '/api/v1/chat/messages/delete') {
        const id = Number(body?.id);
        if (!Number.isSafeInteger(id) || id <= 0) return json(400, { error: 'id required' });
        const row = db.prepare(
          'SELECT sender, recipient FROM chat_messages WHERE id = ?',
        ).get(id);
        if (!row) {
          const tomb = db.prepare('SELECT sender FROM chat_tombstones WHERE id = ?').get(id);
          return tomb?.sender === address ? json(200, { ok: true, deleted: true }) : json(404, { error: 'message not found' });
        }
        if (row.sender !== address) return json(403, { error: 'not the sender' });
        const at = now();
        db.prepare('DELETE FROM chat_deliveries WHERE message_id = ?').run(id);
        db.prepare('DELETE FROM chat_messages WHERE id = ?').run(id);
        db.prepare(
          'INSERT OR REPLACE INTO chat_tombstones (id, sender, recipient, deleted_at) VALUES (?, ?, ?, ?)',
        ).run(id, row.sender, row.recipient, at);
        for (const listener of listeners) {
          try { listener({ type: 'deleted', recipient: row.recipient, peer: row.sender, id }); } catch { /* closed */ }
          try { listener({ type: 'deleted', recipient: row.sender, peer: row.recipient, id }); } catch { /* closed */ }
        }
        return json(200, { ok: true, deleted: true });
      }

      // Tombstones are id-only and visible to both participants. `since` is a
      // millisecond cursor; `peer` narrows a room fetch.
      if (method === 'GET' && path === '/api/v1/chat/tombstones') {
        const since = Number(query.since);
        const peer = String(query.peer || '').toUpperCase();
        if (peer && !B58_FREE.test(peer)) return json(400, { error: 'invalid peer' });
        const floor = Number.isFinite(since) && since > 0 ? since : 0;
        const rows = peer
          ? db.prepare(
            `SELECT id, deleted_at, sender, recipient FROM chat_tombstones
             WHERE deleted_at > ? AND ((sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?))
             ORDER BY deleted_at ASC LIMIT 500`,
          ).all(floor, address, peer, peer, address)
          : db.prepare(
            `SELECT id, deleted_at, sender, recipient FROM chat_tombstones
             WHERE deleted_at > ? AND (recipient = ? OR sender = ?)
             ORDER BY deleted_at ASC LIMIT 500`,
          ).all(floor, address, address);
        return json(200, {
          deletions: rows.map((row) => ({
            id: row.id, at: row.deleted_at,
            peer: row.sender === address ? row.recipient : row.sender,
          })),
        });
      }

      // A reader marks what they have displayed. `peer` is the sender whose
      // messages were read; the caller is the reader. Upsert keeps the maximum
      // id, so out-of-order marks cannot move a receipt backwards.
      if (method === 'POST' && path === '/api/v1/chat/read') {
        const peer = String(body?.peer || '').toUpperCase();
        const id = Number(body?.id);
        if (!B58_FREE.test(peer) || !Number.isSafeInteger(id) || id <= 0) {
          return json(400, { error: 'peer and id required' });
        }
        // Do not let a reader inflate a sender's status with an id that was not
        // actually sent to them. The client marks read before acking its copy.
        const owned = db.prepare(
          'SELECT 1 AS hit FROM chat_messages WHERE id = ? AND sender = ? AND recipient = ?',
        ).get(id, peer, address);
        if (!owned) return json(404, { error: 'message not found' });
        const at = now();
        db.prepare(
          `INSERT INTO chat_reads (reader, sender, last_id, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (reader, sender) DO UPDATE SET
             last_id = MAX(chat_reads.last_id, excluded.last_id), updated_at = excluded.updated_at`,
        ).run(address, peer, id, at);
        // The sender may be looking at the room; a read frame updates
        // Sent → Read without waiting for the next room open. It contains no
        // message text, only the reader and the highest id.
        for (const listener of listeners) {
          try {
            listener({ type: 'read', recipient: peer, from: address, lastId: id });
          } catch { /* one dead SSE client */ }
        }
        return json(200, { ok: true });
      }

      // A sender asks how far the peer has read messages this sender wrote.
      if (method === 'GET' && path === '/api/v1/chat/read') {
        const peer = String(query.peer || '').toUpperCase();
        if (!B58_FREE.test(peer)) return json(400, { error: 'invalid peer' });
        const row = db.prepare(
          'SELECT last_id, updated_at FROM chat_reads WHERE reader = ? AND sender = ?',
        ).get(peer, address);
        return json(200, { peer, lastId: row?.last_id || 0, at: row?.updated_at || 0 });
      }

      // ---------------- block list ----------------
      // Only the owner can read or change their own list, and the entries are
      // plain wallet addresses: no reason, no name, no message. A block also
      // clears what that sender already queued for this wallet, so a block takes
      // effect on mail that is already sitting on the relay.
      // Register this device's push subscription. The relay stores an endpoint
      // and two keys; it never learns a message from it. `503` when the operator
      // did not configure VAPID is honest, and the client hides the control.
      if (method === 'POST' && path === '/api/v1/chat/push') {
        if (!pushEnabled) return json(503, { error: 'push is not configured' });
        const subscription = body?.subscription;
        if (!validPushSubscription(subscription)) return json(400, { error: 'subscription invalid' });
        const endpoint = String(subscription.endpoint);
        const p256dh = String(subscription.keys.p256dh);
        const auth = String(subscription.keys.auth);
        db.prepare(
          `INSERT INTO chat_push_subs (address, endpoint, p256dh, auth, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (address, endpoint) DO UPDATE SET
             p256dh = excluded.p256dh, auth = excluded.auth, updated_at = excluded.updated_at`,
        ).run(address, endpoint, p256dh, auth, at, at);
        const held = db.prepare('SELECT COUNT(*) c FROM chat_push_subs WHERE address = ?').get(address).c;
        if (held > MAX_PUSH_SUBSCRIPTIONS) {
          // A reinstalled browser must not be refused because the old endpoint
          // is still on file: the oldest device loses its subscription instead.
          db.prepare(
            `DELETE FROM chat_push_subs WHERE address = ? AND endpoint NOT IN (
               SELECT endpoint FROM chat_push_subs WHERE address = ?
               ORDER BY updated_at DESC LIMIT ?
             )`,
          ).run(address, address, MAX_PUSH_SUBSCRIPTIONS);
        }
        return json(200, { ok: true, subscriptions: Math.min(held, MAX_PUSH_SUBSCRIPTIONS) });
      }

      if (method === 'POST' && path === '/api/v1/chat/push/remove') {
        const endpoint = String(body?.endpoint || '');
        if (!endpoint) return json(400, { error: 'endpoint required' });
        const removed = db.prepare(
          'DELETE FROM chat_push_subs WHERE address = ? AND endpoint = ?',
        ).run(address, endpoint);
        return json(200, { ok: true, removed: Number(removed?.changes || 0) });
      }

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
        db.prepare(
          `DELETE FROM chat_deliveries WHERE message_id IN (
             SELECT id FROM chat_messages WHERE recipient = ? AND sender = ?
           )`,
        ).run(address, blocked);
        // A block must also silence an alert that is already queued, in both
        // directions: pushing for a conversation that is now blocked is worse
        // than a missed notification.
        db.prepare(
          'DELETE FROM chat_push_queue WHERE (address = ? AND peer = ?) OR (address = ? AND peer = ?)',
        ).run(address, blocked, blocked, address);
        const cleared = db.prepare(
          'DELETE FROM chat_messages WHERE recipient = ? AND sender = ?',
        ).run(address, blocked);
        return json(200, { ok: true, blocked: true, cleared: Number(cleared?.changes || 0) });
      }

      return json(404, { error: 'not found' });
    },
  };
}
