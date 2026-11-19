// Client side of the encrypted chat: signs with the delegated chat identity
// (or the wallet key for older v1/v2 requests), encrypts with the recipient's
// published key, and decrypts only what is addressed to this wallet. The relay
// sees addresses and ciphertext; it never sees a seed, a password or a message.
//
// The signature covers the request line. With a device id it is
// `nsc-chat|2|METHOD|path|address|device|ts|nonce`, so a captured request cannot
// be re-pointed at another path, device or time. Older clients use the v1 line
// without a device and are treated as one shared legacy device by the relay.
import nacl from 'tweetnacl';
import { normalizeDeviceId } from './chatDevice.js';
import { encodeG } from './nsatCodec.js';
import {
  openMessage, publicKeyBundle, chatPublicKeyBundle, sealMessage, verifyPublicKeyBundle,
} from './e2eChat.js';

const CHAT_BASE = '/api/v1/chat';
const REQUEST_TTL_MS = 120_000;

/** Kept byte-identical to the relay's verifier; tests assert both agree. */
export function chatRequestString({ method, path, address, ts, nonce, device = '' }) {
  const id = normalizeDeviceId(device);
  return id
    ? `nsc-chat|2|${String(method).toUpperCase()}|${path}|${address}|${id}|${ts}|${nonce}`
    : `nsc-chat|1|${String(method).toUpperCase()}|${path}|${address}|${ts}|${nonce}`;
}

/** v3 adds the separate chat public key to the signed line. */
export function chatIdentityRequestString({ method, path, address, chatPub, ts, nonce, device = '' }) {
  const id = normalizeDeviceId(device);
  return id
    ? `nsc-chat|3|${String(method).toUpperCase()}|${path}|${address}|${chatPub}|${id}|${ts}|${nonce}`
    : `nsc-chat|3|${String(method).toUpperCase()}|${path}|${address}|${chatPub}|${ts}|${nonce}`;
}

function base64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

function randomNonce() {
  const bytes = nacl.randomBytes(16);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * An idempotency key for one outgoing message. A retry reuses it, so the relay
 * can return the original row instead of storing a second copy. The value is
 * opaque and contains no address or plaintext.
 */
export function createClientId() {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid.replace(/-/g, '');
  return Array.from(nacl.randomBytes(16), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function createChatClient({
  origin = '', fetchImpl, now = () => Date.now(), deviceId = '',
} = {}) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) throw new Error('A fetch implementation is required for chat.');
  const base = String(origin || '').replace(/\/$/, '');
  const device = normalizeDeviceId(deviceId);

  function signedHeaders({ seed32, chatIdentity, address, method, path }) {
    if (chatIdentity) {
      if (!chatIdentity.seed32 || !chatIdentity.chatPub || !chatIdentity.delegation) {
        throw new Error('The chat identity is not available on this device.');
      }
      const ts = now();
      const nonce = randomNonce();
      const signature = nacl.sign.detached(
        Buffer.from(chatIdentityRequestString({
          method, path, address: String(address).toUpperCase(), chatPub: chatIdentity.chatPub,
          ts, nonce, device,
        })),
        nacl.sign.keyPair.fromSeed(chatIdentity.seed32).secretKey,
      );
      return {
        'x-nsat-address': String(address).toUpperCase(),
        'x-nsat-chat-pub': chatIdentity.chatPub,
        'x-nsat-chat-delegation': chatIdentity.delegation,
        ...(device ? { 'x-nsat-device': device } : {}),
        'x-nsat-ts': String(ts),
        'x-nsat-nonce': nonce,
        'x-nsat-signature': base64(signature),
        'content-type': 'application/json',
      };
    }
    const signer = nacl.sign.keyPair.fromSeed(seed32);
    const own = encodeG(signer.publicKey);
    if (own !== String(address || '').toUpperCase()) {
      signer.secretKey.fill(0);
      throw new Error('This wallet does not match the address.');
    }
    const ts = now();
    const nonce = randomNonce();
    const signature = nacl.sign.detached(
      Buffer.from(chatRequestString({ method, path, address: own, ts, nonce, device })),
      signer.secretKey,
    );
    signer.secretKey.fill(0);
    // Keep the nonce inside the relay's accepted range (8..64 chars).
    return {
      'x-nsat-address': own,
      ...(device ? { 'x-nsat-device': device } : {}),
      'x-nsat-ts': String(ts),
      'x-nsat-nonce': nonce,
      'x-nsat-signature': base64(signature),
      'content-type': 'application/json',
    };
  }

  // The signature covers the pathname only; the query string is not signed, so
  // `?since=` can move without invalidating a request. The relay verifies on
  // `url.pathname`, which is exactly what is signed here.
  async function call({ seed32, chatIdentity, address, method, path, query = '', body, auth = true }) {
    const headers = auth
      ? signedHeaders({ seed32, chatIdentity, address, method, path })
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
      const error = new Error(`Chat relay refused the request: ${reason}`);
      error.status = res.status;
      // A 429 carries both a body field and the standard header. Keeping them
      // on the error lets the UI wait exactly as long as the server asked
      // instead of reconnecting on its own schedule.
      const retryAfter = Number(res.headers?.get?.('retry-after'))
        || Number(payload?.retryAfter);
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        error.retryAfterMs = retryAfter * 1000;
      }
      throw error;
    }
    return payload;
  }

  // One page walk over the mailbox: decrypt locally, never delete. The relay
  // returns at most `limit` rows per call, so a backlog is read in order. `peer`
  // narrows the walk to one conversation, which is what opening a room needs.
  async function readMessages({
    seed32, chatIdentity, legacySeed32, address, since = 0, limit = 200, maxPages = 10, peer = '',
  }) {
    const opened = [];
    const undecryptable = [];
    const conversation = String(peer || '').toUpperCase();
    let cursor = since;
    for (let page = 0; page < maxPages; page += 1) {
      const res = await call({
        seed32, chatIdentity,
        address,
        method: 'GET',
        path: `${CHAT_BASE}/messages`,
        query: `since=${encodeURIComponent(cursor)}&limit=${encodeURIComponent(limit)}`
          + (conversation ? `&peer=${encodeURIComponent(conversation)}` : ''),
      });
      const rows = Array.isArray(res?.messages) ? res.messages : [];
      for (const row of rows) {
        try {
          const message = openMessage({
            seed32: legacySeed32 || seed32, chatIdentity, address, envelope: row.envelope,
          });
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
    async publishKey({ seed32, chatIdentity, address }) {
      const bundle = chatIdentity
        ? chatPublicKeyBundle({
          seed32: chatIdentity.seed32,
          address,
          delegation: chatIdentity.delegation,
          legacyX25519Pub: chatIdentity.legacyX25519Pub,
        })
        : publicKeyBundle(seed32, address);
      await call({
        seed32, chatIdentity, address, method: 'POST', path: `${CHAT_BASE}/keys`, body: { bundle },
      });
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

    /** Encrypt one message without sending it, so a retry can reuse the bytes. */
    async prepare({ seed32, chatIdentity, from, to, text }) {
      const recipient = String(to || '').toUpperCase();
      const bundle = await this.fetchKey(recipient);
      const publishedKey = chatIdentity
        ? (bundle.x25519ChatPub || bundle.x25519Pub)
        : bundle.x25519Pub;
      const x25519Pub = Uint8Array.from(Buffer.from(publishedKey, 'base64'));
      const envelope = sealMessage({
        seed32, chatIdentity, from, to: recipient, recipientX25519Pub: x25519Pub, text,
      });
      return { envelope, to: recipient };
    },

    /** Hand a prepared envelope to the relay; safe to repeat with the same id. */
    async sendPrepared({ seed32, chatIdentity, address, envelope, clientId }) {
      if (!envelope || typeof envelope !== 'object') throw new Error('A prepared message is required.');
      return call({
        seed32, chatIdentity, address, method: 'POST', path: `${CHAT_BASE}/messages`,
        body: { envelope, clientId: String(clientId || '') },
      });
    },

    /**
     * Wake on new mail for this wallet. The event is only a signal; the
     * authenticated `peek()` still fetches and decrypts the actual rows. The
     * stream carries no ciphertext, address or message text.
     */
    async subscribe({ seed32, chatIdentity, address, signal, onEvent }) {
      const path = `${CHAT_BASE}/events`;
      const res = await doFetch(`${base}${path}`, {
        method: 'GET',
        headers: {
          ...signedHeaders({ seed32, chatIdentity, address, method: 'GET', path }),
          accept: 'text/event-stream',
        },
        cache: 'no-store',
        signal,
      });
      if (!res.ok) {
        const error = new Error(`Chat event stream refused: HTTP ${res.status}`);
        error.status = res.status;
        throw error;
      }
      if (!res.body?.getReader) throw new Error('Streaming is not available in this browser.');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let split;
        while ((split = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const data = block.split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .join('\n');
          if (!data) continue;
          try { onEvent?.(JSON.parse(data)); } catch { /* ignore malformed event */ }
        }
      }
    },

    /** Delete the sender's own message for every participant. */
    async deleteMessage({ seed32, chatIdentity, address, id }) {
      return call({
        seed32, chatIdentity, address, method: 'POST', path: `${CHAT_BASE}/messages/delete`,
        body: { id: Number(id) },
      });
    },

    /** Id-only delete tombstones for the current wallet. */
    async tombstones({ seed32, chatIdentity, address, since = 0, peer = '' }) {
      const query = new URLSearchParams({ since: String(since) });
      if (peer) query.set('peer', String(peer).toUpperCase());
      return call({
        seed32, chatIdentity, address, method: 'GET', path: `${CHAT_BASE}/tombstones`,
        query: query.toString(),
      });
    },

    /** Opt-in heartbeat; the relay expires it after 45 s. */
    async presence({ seed32, chatIdentity, address, online }) {
      return call({
        seed32, chatIdentity, address, method: 'POST', path: `${CHAT_BASE}/presence`,
        body: { online: online === true },
      });
    },

    /** Online state for a peer with whom this wallet has shared messages. */
    async peerPresence({ seed32, chatIdentity, address, peer }) {
      return call({
        seed32, chatIdentity, address, method: 'GET', path: `${CHAT_BASE}/presence`,
        query: `peer=${encodeURIComponent(String(peer).toUpperCase())}`,
      });
    },

    /** Ephemeral typing state; the relay never stores it. */
    async typing({ seed32, chatIdentity, address, peer, active }) {
      return call({
        seed32, chatIdentity, address, method: 'POST', path: `${CHAT_BASE}/typing`,
        body: { peer: String(peer).toUpperCase(), typing: !!active },
      });
    },

    /** Mark the highest displayed message from this peer as read. */
    async markRead({ seed32, chatIdentity, address, peer, id }) {
      return call({
        seed32, chatIdentity, address, method: 'POST', path: `${CHAT_BASE}/read`,
        body: { peer: String(peer).toUpperCase(), id: Number(id) },
      });
    },

    /** How far the peer has read messages this wallet sent to them. */
    async readReceipt({ seed32, chatIdentity, address, peer }) {
      return call({
        seed32, chatIdentity, address, method: 'GET', path: `${CHAT_BASE}/read`,
        query: `peer=${encodeURIComponent(String(peer).toUpperCase())}`,
      });
    },

    /** Encrypt and hand one message to the relay. */
    async send({ seed32, chatIdentity, from, to, text, clientId = createClientId() }) {
      const prepared = await this.prepare({ seed32, chatIdentity, from, to, text });
      await this.sendPrepared({
        seed32, chatIdentity, address: from, envelope: prepared.envelope, clientId,
      });
      return prepared.envelope;
    },

    /**
     * Read what is waiting for this wallet **without deleting it**. Messages
     * that cannot be opened (a key from another wallet, a tampered envelope)
     * are reported, not dropped. Deleting is the separate, explicit `ack()`.
     */
    async peek({
      seed32, chatIdentity, legacySeed32, address, since = 0, limit = 200, maxPages = 10, peer = '',
    }) {
      return readMessages({
        seed32, chatIdentity, legacySeed32, address, since, limit, maxPages, peer,
      });
    },

    /** Delete this device's copies of specific messages (max 200 per call). */
    async ack({ seed32, chatIdentity, address, ids }) {
      // One id, one delete: a duplicated id must not double-count `deleted`.
      const list = [...new Set((Array.isArray(ids) ? ids : [])
        .filter((id) => Number.isSafeInteger(id) && id > 0))];
      let deleted = 0;
      for (let i = 0; i < list.length; i += 200) {
        const res = await call({
          seed32, chatIdentity, address, method: 'POST', path: `${CHAT_BASE}/ack`,
          body: { ids: list.slice(i, i + 200) },
        });
                deleted += Number(res?.deleted) || 0;
      }
      return deleted;
    },

    /**
     * Tell the relay this device can be woken while the app is closed. The
     * payload is the browser's own subscription: an endpoint and two keys. The
     * relay answers 503 when the operator has no VAPID keypair, which the UI
     * shows as "not available" instead of a silent failure.
     */
    async registerPush({ seed32, chatIdentity, address, subscription }) {
      return call({
        seed32, chatIdentity, address, method: 'POST', path: `${CHAT_BASE}/push`,
        body: { subscription },
      });
    },

    /** Drop one device's subscription (the one that was just unsubscribed). */
    async removePush({ seed32, chatIdentity, address, endpoint }) {
      return call({
        seed32, chatIdentity, address, method: 'POST', path: `${CHAT_BASE}/push/remove`,
        body: { endpoint: String(endpoint || '') },
      });
    },

    /** My own block list, as the relay holds it. */
    async blocks({ seed32, chatIdentity, address }) {
      const res = await call({
        seed32, chatIdentity, address, method: 'GET', path: `${CHAT_BASE}/blocks`,
      });
      return Array.isArray(res?.blocked) ? res.blocked.map((item) => String(item).toUpperCase()) : [];
    },

    /**
     * Stop mail between this wallet and one address, in both directions.
     *
     * The relay answers as if the message were stored either way, so a sender
     * cannot learn that they were blocked; the block also clears mail that is
     * already queued. Reversible with `unblock`.
     */
    async block({ seed32, chatIdentity, address, peer }) {
      const target = String(peer || '').toUpperCase();
      if (!/^G[A-Z2-7]{55}$/.test(target)) throw new Error('That is not a wallet address.');
      return call({
        seed32, chatIdentity, address, method: 'POST', path: `${CHAT_BASE}/blocks`,
        body: { blocked: target, action: 'add' },
      });
    },

    async unblock({ seed32, chatIdentity, address, peer }) {
      const target = String(peer || '').toUpperCase();
      if (!/^G[A-Z2-7]{55}$/.test(target)) throw new Error('That is not a wallet address.');
      return call({
        seed32, chatIdentity, address, method: 'POST', path: `${CHAT_BASE}/blocks`,
        body: { blocked: target, action: 'remove' },
      });
    },
  };
}

export { REQUEST_TTL_MS };
