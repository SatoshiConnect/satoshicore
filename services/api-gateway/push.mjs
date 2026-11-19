// Web Push transport for the chat relay.
//
// Privacy shape (deliberate, and documented in docs/messenger/WEB-PUSH.md):
//   - the payload carries ONE routing hint: the peer wallet address, so a tap
//     can open the right conversation. No message text, no sender name, no
//     unread count, no envelope, no ciphertext.
//   - the payload is encrypted to the browser's subscription (RFC 8291), so the
//     push service (Google / Mozilla / Apple) cannot read even that hint. What
//     it does see is that this device received a push, and when — which is why
//     the UI makes this an explicit opt-in instead of a default.
//   - a push is only a wake-up. The recipient still fetches and decrypts the
//     message through the signed relay API on the device.
import * as webpush from 'web-push';

export const MAX_SUBSCRIPTIONS_PER_ADDRESS = 5;
export const PUSH_MAX_ATTEMPTS = 5;
export const PUSH_BACKOFF_MS = 30_000;
export const PUSH_MAX_BACKOFF_MS = 10 * 60_000;
export const DEFAULT_PUSH_SUBJECT = 'mailto:noreply@satoshicore.org';

const BASE64URL = /^[A-Za-z0-9_-]{16,160}$/;

/** The only thing that crosses the push service: which room to open. */
export function pushPayload(peer) {
  return JSON.stringify({ v: 1, peer: String(peer || '').toUpperCase() });
}

/**
 * A browser subscription must look like one before it reaches the table: an
 * https endpoint and the two base64url keys the push service will encrypt to.
 */
export function validPushSubscription(subscription) {
  const endpoint = String(subscription?.endpoint || '');
  const p256dh = String(subscription?.keys?.p256dh || '');
  const auth = String(subscription?.keys?.auth || '');
  if (!/^https:\/\/[^\s]{8,400}$/.test(endpoint)) return false;
  if (!BASE64URL.test(p256dh) || !BASE64URL.test(auth)) return false;
  return true;
}

/** Exponential backoff for a push service that answered 429/5xx. */
export function pushRetryAt(at, attempts) {
  const step = PUSH_BACKOFF_MS * 2 ** Math.max(0, attempts - 1);
  return at + Math.min(step, PUSH_MAX_BACKOFF_MS);
}

/**
 * Build the transport. `send` exists so tests (and an operator debugging a
 * push service) can replace the network call without touching the queue.
 */
export function createPushTransport({
  publicKey = '',
  privateKey = '',
  subject = DEFAULT_PUSH_SUBJECT,
  send,
} = {}) {
  const configured = Boolean(publicKey && privateKey);
  let deliver = typeof send === 'function' ? send : null;

  if (configured && !deliver) {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    deliver = (subscription, payload) => webpush.sendNotification(subscription, payload, {
      // A queued alert that is an hour old is noise; the message is still on
      // the relay and the app shows it on the next open.
      TTL: 600,
      urgency: 'normal',
    });
  }

  return {
    configured,
    publicKey: configured ? publicKey : '',
    /**
     * Send one wake-up. Never throws: the caller keeps a durable queue and
     * decides between retry and permanent removal from the status code.
     */
    async send(subscription, peer) {
      if (!configured || !deliver) return { ok: false, status: 0, reason: 'not-configured' };
      try {
        const result = await deliver(subscription, pushPayload(peer));
        return { ok: true, status: Number(result?.statusCode) || 201 };
      } catch (error) {
        return { ok: false, status: Number(error?.statusCode) || 0, reason: error?.message || 'push failed' };
      }
    },
  };
}
