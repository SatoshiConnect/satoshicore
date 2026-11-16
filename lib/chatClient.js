// Client side of the encrypted chat: signs each request with the wallet key,
// encrypts with the recipient's published key, and decrypts only what is
// addressed to this wallet. The relay sees addresses and ciphertext; it never
// sees a seed, a password or a message.
//
// The signature covers the request line (`nsc-chat|1|METHOD|path|address|ts|nonce`),
// so a captured request cannot be re-pointed at another path or replayed later —
// the relay refuses stale timestamps and repeated nonces.
import nacl from 'tweetnacl';
import { encodeG } from './nsatCodec.js';
import {
  openMessage, publicKeyBundle, sealMessage, verifyPublicKeyBundle,
} from './e2eChat.js';

const CHAT_BASE = '/api/v1/chat';
const REQUEST_TTL_MS = 120_000;

/** Kept byte-identical to the relay's verifier; tests assert both agree. */
export function chatRequestString({ method, path, address, ts, nonce }) {
  return `nsc-chat|1|${String(method).toUpperCase()}|${path}|${address}|${ts}|${nonce}`;
}

function base64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

function randomNonce() {
  const bytes = nacl.randomBytes(16);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function createChatClient({ origin = '', fetchImpl, now = () => Date.now() } = {}) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) throw new Error('A fetch implementation is required for chat.');
  const base = String(origin || '').replace(/\/$/, '');

  function signedHeaders({ seed32, address, method, path }) {
    const signer = nacl.sign.keyPair.fromSeed(seed32);
    const own = encodeG(signer.publicKey);
    if (own !== String(address || '').toUpperCase()) {
      signer.secretKey.fill(0);
      throw new Error('This wallet does not match the address.');
    }
    const ts = now();
    const nonce = randomNonce();
    const signature = nacl.sign.detached(
      Buffer.from(chatRequestString({ method, path, address: own, ts, nonce })),
      signer.secretKey,
    );
    signer.secretKey.fill(0);
    // Keep the nonce inside the relay's accepted range (8..64 chars).
    return {
      'x-nsat-address': own,
      'x-nsat-ts': String(ts),
      'x-nsat-nonce': nonce,
      'x-nsat-signature': base64(signature),
      'content-type': 'application/json',
    };
  }

  // The signature covers the pathname only; the query string is not signed, so
  // `?since=` can move without invalidating a request. The relay verifies on
  // `url.pathname`, which is exactly what is signed here.
  async function call({ seed32, address, method, path, query = '', body, auth = true }) {
    const headers = auth
      ? signedHeaders({ seed32, address, method, path })
      : { 'content-type': 'application/json' };
    const url = `${base}${path}${query ? `?${query}` : ''}`;
    const res = await doFetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = payload?.error || `HTTP ${res.status}`;
      throw new Error(`Chat relay refused the request: ${reason}`);
    }
    return payload;
  }

  // One page walk over the mailbox: decrypt locally, never delete. The relay
  // returns at most `limit` rows per call, so a backlog is read in order.
  async function readMessages({ seed32, address, since = 0, limit = 200, maxPages = 10 }) {
    const opened = [];
    const undecryptable = [];
    let cursor = since;
    for (let page = 0; page < maxPages; page += 1) {
      const res = await call({
        seed32, address, method: 'GET', path: `${CHAT_BASE}/messages`,
        query: `since=${encodeURIComponent(cursor)}&limit=${encodeURIComponent(limit)}`,
      });
      const rows = Array.isArray(res?.messages) ? res.messages : [];
      for (const row of rows) {
        try {
          const message = openMessage({ seed32, address, envelope: row.envelope });
          opened.push({ id: row.id, receivedAt: row.receivedAt, ...message });
        } catch (error) {
          undecryptable.push({ id: row.id, reason: String(error?.message || error) });
        }
      }
      if (rows.length < limit) break;
      cursor = rows[rows.length - 1].id;
    }
    return { messages: opened, undecryptable };
  }

  return {
    /** Publish this wallet's X25519 key, signed by the wallet key itself. */
    async publishKey({ seed32, address }) {
      const bundle = publicKeyBundle(seed32, address);
      await call({ seed32, address, method: 'POST', path: `${CHAT_BASE}/keys`, body: { bundle } });
      return bundle;
    },

    /** The recipient's published key, verified against their address. */
    async fetchKey(address) {
      const target = String(address || '').toUpperCase();
      let res;
      try {
        res = await call({
          method: 'GET',
          path: `${CHAT_BASE}/keys`,
          query: `address=${encodeURIComponent(target)}`,
          auth: false,
        });
      } catch (error) {
        if (/no key published/i.test(String(error?.message || ''))) {
          throw new Error('That address has published no usable messaging key.');
        }
        throw error;
      }
      const bundle = res?.bundle;
      if (!verifyPublicKeyBundle(bundle) || bundle.address !== target) {
        throw new Error('That address has published no usable messaging key.');
      }
      return bundle;
    },

    /** Encrypt and hand one message to the relay. */
    async send({ seed32, from, to, text }) {
      const recipient = String(to || '').toUpperCase();
      const bundle = await this.fetchKey(recipient);
      const x25519Pub = Uint8Array.from(Buffer.from(bundle.x25519Pub, 'base64'));
      const envelope = sealMessage({ seed32, from, to: recipient, recipientX25519Pub: x25519Pub, text });
      await call({ seed32, address: from, method: 'POST', path: `${CHAT_BASE}/messages`, body: { envelope } });
      return envelope;
    },

    /**
     * Read what is waiting for this wallet **without deleting it**. Messages
     * that cannot be opened (a key from another wallet, a tampered envelope)
     * are reported, not dropped. Deleting is the separate, explicit `ack()`.
     */
    async peek({ seed32, address, since = 0, limit = 200, maxPages = 10 }) {
      return readMessages({ seed32, address, since, limit, maxPages });
    },

    /** Delete specific messages from this wallet's mailbox (max 200 per call). */
    async ack({ seed32, address, ids }) {
      const list = (Array.isArray(ids) ? ids : []).filter((id) => Number.isInteger(id));
      let deleted = 0;
      for (let i = 0; i < list.length; i += 200) {
        const res = await call({
          seed32, address, method: 'POST', path: `${CHAT_BASE}/ack`,
          body: { ids: list.slice(i, i + 200) },
        });
                deleted += Number(res?.deleted) || 0;
      }
      return deleted;
    },

    /** My own block list, as the relay holds it. */
    async blocks({ seed32, address }) {
      const res = await call({ seed32, address, method: 'GET', path: `${CHAT_BASE}/blocks` });
      return Array.isArray(res?.blocked) ? res.blocked.map((item) => String(item).toUpperCase()) : [];
    },

    /**
     * Stop mail between this wallet and one address, in both directions.
     *
     * The relay answers as if the message were stored either way, so a sender
     * cannot learn that they were blocked; the block also clears mail that is
     * already queued. Reversible with `unblock`.
     */
    async block({ seed32, address, peer }) {
      const target = String(peer || '').toUpperCase();
      if (!/^G[A-Z2-7]{55}$/.test(target)) throw new Error('That is not a wallet address.');
      return call({
        seed32, address, method: 'POST', path: `${CHAT_BASE}/blocks`,
        body: { blocked: target, action: 'add' },
      });
    },

    async unblock({ seed32, address, peer }) {
      const target = String(peer || '').toUpperCase();
      if (!/^G[A-Z2-7]{55}$/.test(target)) throw new Error('That is not a wallet address.');
      return call({
        seed32, address, method: 'POST', path: `${CHAT_BASE}/blocks`,
        body: { blocked: target, action: 'remove' },
      });
    },
  };
}

export { REQUEST_TTL_MS };
