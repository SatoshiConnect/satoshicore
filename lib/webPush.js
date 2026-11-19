// Background alerts for the encrypted chat (Web Push).
//
// What this module is responsible for, and what it deliberately is not:
//   - it registers the device with the browser's push service and hands the
//     subscription to the relay through the signed chat API;
//   - it never puts a message, a name or a count into that registration, and it
//     never subscribes on its own: the caller must have shown the disclosure
//     first and the person must have said yes;
//   - the notification itself is composed on this device by the service worker
//     (public/sw.js), not by the relay's payload.
//
// The honest limits are surfaced as a reason string instead of a broken toggle:
// a browser without PushManager, a plain-HTTP origin, an iOS browser tab that
// has not been added to the Home Screen, or a build without a VAPID public key
// all say why they cannot do this.
const PUSH_PREF_KEY = 'scw-chat-push-v1';
const VAPID_ENV = 'NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY';
// Read as a static member expression on purpose: Next replaces exactly this
// form at build time. A computed `process.env[name]` is not inlined and would
// reach the browser as a ReferenceError.
const BUILD_VAPID_KEY = process.env.NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function storeOf(storage) {
  if (storage) return storage;
  return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
}

/** base64url (unpadded) → bytes. Returns null for anything that is not a key. */
export function decodePushKey(value) {
  const text = String(value || '').trim();
  if (!text || !BASE64URL.test(text)) return null;
  const pad = text.length % 4 === 0 ? '' : '='.repeat(4 - (text.length % 4));
  try {
    const raw = globalThis.atob(text.replace(/-/g, '+').replace(/_/g, '/') + pad);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * The VAPID key baked in at build time. Uncompressed P-256 point: 65 bytes
 * starting with 0x04. A build without it simply has no push support.
 */
export function vapidPublicKey(configured = BUILD_VAPID_KEY) {
  const bytes = decodePushKey(configured);
  if (!bytes || bytes.length !== 65 || bytes[0] !== 0x04) return null;
  return bytes;
}

function isIosBrowserTab(global) {
  const nav = global?.navigator || {};
  const ua = String(nav.userAgent || '');
  if (!/iPhone|iPad|iPod/i.test(ua)) return false;
  // Installed PWAs report standalone; a Safari tab cannot receive web push.
  if (nav.standalone === true) return false;
  try {
    return !global.matchMedia?.('(display-mode: standalone)')?.matches;
  } catch {
    return true;
  }
}

/**
 * Can this browser receive a background alert, and if not, why?
 * `reason` is a stable token so the UI can word it in one place.
 */
export function pushEnvironment({
  global = globalThis,
  configured = BUILD_VAPID_KEY,
} = {}) {
  const nav = global?.navigator || {};
  const key = vapidPublicKey(configured);
  if (!key) return { supported: false, reason: 'not-configured', key: null };
  if (!nav.serviceWorker || !global.PushManager || !global.Notification) {
    return { supported: false, reason: 'unsupported', key: null };
  }
  if (global.isSecureContext === false) return { supported: false, reason: 'insecure', key: null };
  if (isIosBrowserTab(global)) return { supported: false, reason: 'install-first', key: null };
  return { supported: true, reason: '', key };
}

export function pushPermission(global = globalThis) {
  return String(global?.Notification?.permission || 'default');
}

/** True once this browser holds a live subscription for the current worker. */
export async function currentPushSubscription(registration) {
  if (!registration?.pushManager?.getSubscription) return null;
  try {
    return await registration.pushManager.getSubscription();
  } catch {
    return null;
  }
}

export async function subscribeWebPush({ registration, applicationServerKey }) {
  if (!registration?.pushManager?.subscribe) throw new Error('Push is not available in this browser.');
  const existing = await currentPushSubscription(registration);
  if (existing) return existing;
  return registration.pushManager.subscribe({
    // Every push must produce something the person can see; browsers require it.
    userVisibleOnly: true,
    applicationServerKey,
  });
}

export async function unsubscribeWebPush(registration) {
  const subscription = await currentPushSubscription(registration);
  if (!subscription) return '';
  try {
    await subscription.unsubscribe();
  } catch {
    /* the browser may already have dropped it */
  }
  return String(subscription.endpoint || '');
}

/** The subscription shape the relay accepts, and the only data it receives. */
export function pushSubscriptionBody(subscription) {
  const json = typeof subscription?.toJSON === 'function' ? subscription.toJSON() : subscription;
  const endpoint = String(json?.endpoint || '');
  const p256dh = String(json?.keys?.p256dh || '');
  const auth = String(json?.keys?.auth || '');
  if (!endpoint || !p256dh || !auth) return null;
  return { endpoint, keys: { p256dh, auth } };
}

/** Remember the opt-in locally so the toggle survives a reload. */
export function readPushPref(address, storage = undefined) {
  const owner = String(address || '').toUpperCase();
  if (!owner) return false;
  try {
    const parsed = JSON.parse(storeOf(storage)?.getItem(PUSH_PREF_KEY) || '{}');
    return parsed?.[owner] === true;
  } catch {
    return false;
  }
}

export function writePushPref(address, enabled, storage = undefined) {
  const owner = String(address || '').toUpperCase();
  const store = storeOf(storage);
  if (!owner || !store) return false;
  try {
    const parsed = JSON.parse(store.getItem(PUSH_PREF_KEY) || '{}');
    const next = parsed && typeof parsed === 'object' ? { ...parsed } : {};
    if (enabled) next[owner] = true;
    else delete next[owner];
    store.setItem(PUSH_PREF_KEY, JSON.stringify(next));
    return enabled === true;
  } catch {
    return false;
  }
}

/**
 * App icon badge. Counts only what this device already knows — no request is
 * made, and a browser without the Badging API is simply skipped.
 */
export function syncAppBadge(count, global = globalThis) {
  const value = Math.max(0, Math.trunc(Number(count) || 0));
  try {
    if (value > 0) global?.navigator?.setAppBadge?.(value);
    else global?.navigator?.clearAppBadge?.();
    return true;
  } catch {
    return false;
  }
}

export { PUSH_PREF_KEY, VAPID_ENV };
