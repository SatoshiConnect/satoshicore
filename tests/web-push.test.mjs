// Device-side Web Push helpers: the opt-in bookkeeping, the VAPID key, the
// browser capability checks and the app badge. No browser and no network: each
// helper takes the globals it needs, so the same code path the UI uses is what
// is asserted here.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  currentPushSubscription, decodePushKey, pushEnvironment, pushPermission,
  pushSubscriptionBody, readPushPref, subscribeWebPush, syncAppBadge,
  unsubscribeWebPush, vapidPublicKey, writePushPref,
} from '../lib/webPush.js';

const ADDRESS = `G${'A'.repeat(55)}`;

// 65-byte uncompressed P-256 point, base64url encoded like a real VAPID key.
const VAPID_BYTES = Uint8Array.from([0x04, ...Array.from({ length: 64 }, (_, i) => i % 251)]);
const VAPID = Buffer.from(VAPID_BYTES).toString('base64url');

function storage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
  };
}

function browser(overrides = {}) {
  return {
    navigator: { serviceWorker: {}, userAgent: 'Mozilla/5.0 Chrome/126' },
    PushManager: function PushManager() {},
    Notification: { permission: 'default' },
    isSecureContext: true,
    matchMedia: () => ({ matches: false }),
    atob: globalThis.atob,
    ...overrides,
  };
}

test('the VAPID key must be exactly one uncompressed P-256 point', () => {
  const bytes = decodePushKey(VAPID);
  assert.equal(bytes.length, 65);
  assert.equal(bytes[0], 0x04);
  assert.equal(decodePushKey('not base64!'), null);
  assert.equal(decodePushKey(''), null);

  const good = browser();
  assert.equal(vapidPublicKey(VAPID).length, 65);
  assert.equal(vapidPublicKey(''), null);
  // A 32-byte "key" (or the private half) must never be handed to the browser.
  assert.equal(vapidPublicKey(Buffer.from(VAPID_BYTES.slice(1, 33)).toString('base64url')), null);
  const wrongCurve = Uint8Array.from(VAPID_BYTES);
  wrongCurve[0] = 0x03;
  assert.equal(vapidPublicKey(Buffer.from(wrongCurve).toString('base64url')), null);
  assert.ok(good);
});

test('every reason a device cannot receive alerts is named, not hidden', () => {
  assert.equal(pushEnvironment({ global: browser(), configured: '' }).reason, 'not-configured');
  assert.equal(
    pushEnvironment({ global: browser({ PushManager: undefined }), configured: VAPID }).reason,
    'unsupported',
  );
  assert.equal(
    pushEnvironment({ global: browser({ isSecureContext: false }), configured: VAPID }).reason,
    'insecure',
  );
  // Safari tab on iOS: push only works after Add to Home Screen.
  const iosTab = browser({ navigator: { serviceWorker: {}, userAgent: 'iPhone Safari/605', standalone: false } });
  assert.equal(pushEnvironment({ global: iosTab, configured: VAPID }).reason, 'install-first');
  // The installed app reports standalone and is allowed through.
  const iosApp = browser({ navigator: { serviceWorker: {}, userAgent: 'iPhone Safari/605', standalone: true } });
  assert.equal(pushEnvironment({ global: iosApp, configured: VAPID }).supported, true);

  const supported = pushEnvironment({ global: browser(), configured: VAPID });
  assert.equal(supported.supported, true);
  assert.equal(supported.reason, '');
  assert.equal(supported.key.length, 65);
  assert.equal(pushPermission(browser()), 'default');
});

test('the subscription handed to the relay is only an endpoint and two keys', () => {
  const body = pushSubscriptionBody({
    endpoint: 'https://push.example/abc',
    keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) },
    expirationTime: null,
  });
  assert.deepEqual(body, {
    endpoint: 'https://push.example/abc',
    keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) },
  });
  assert.equal(pushSubscriptionBody({ endpoint: 'https://push.example/abc' }), null);
  assert.equal(pushSubscriptionBody(null), null);
});

test('subscribing reuses an existing subscription and asks for no payload-free trick', async () => {
  const existing = { endpoint: 'https://push.example/old' };
  const reused = await subscribeWebPush({
    registration: { pushManager: { getSubscription: async () => existing, subscribe: () => { throw new Error('must not subscribe'); } } },
    applicationServerKey: VAPID_BYTES,
  });
  assert.equal(reused, existing);

  let asked = null;
  const fresh = await subscribeWebPush({
    registration: {
      pushManager: {
        getSubscription: async () => null,
        subscribe: async (options) => { asked = options; return { endpoint: 'https://push.example/new' }; },
      },
    },
    applicationServerKey: VAPID_BYTES,
  });
  assert.equal(fresh.endpoint, 'https://push.example/new');
  assert.equal(asked.userVisibleOnly, true);
  assert.equal(asked.applicationServerKey, VAPID_BYTES);
});

test('unsubscribing returns the endpoint that must be removed relay-side', async () => {
  let unsubscribed = false;
  const endpoint = await unsubscribeWebPush({
    pushManager: {
      getSubscription: async () => ({ endpoint: 'https://push.example/x', unsubscribe: async () => { unsubscribed = true; } }),
    },
  });
  assert.equal(endpoint, 'https://push.example/x');
  assert.equal(unsubscribed, true);

  assert.equal(await unsubscribeWebPush({ pushManager: { getSubscription: async () => null } }), '');
  assert.equal(await currentPushSubscription({}), null);
});

test('the opt-in is per wallet and survives a reload', () => {
  const store = storage();
  assert.equal(readPushPref(ADDRESS, store), false);
  assert.equal(writePushPref(ADDRESS, true, store), true);
  assert.equal(readPushPref(ADDRESS, store), true);
  assert.equal(readPushPref(`G${'B'.repeat(55)}`, store), false, 'another wallet is not opted in');
  assert.equal(writePushPref(ADDRESS, false, store), false);
  assert.equal(readPushPref(ADDRESS, store), false);
});

test('the app badge follows the unread total and is cleared when it reaches zero', () => {
  const calls = [];
  const nav = {
    setAppBadge: (value) => calls.push(['set', value]),
    clearAppBadge: () => calls.push(['clear']),
  };
  assert.equal(syncAppBadge(3, { navigator: nav }), true);
  assert.equal(syncAppBadge(0, { navigator: nav }), true);
  assert.equal(syncAppBadge(-4, { navigator: nav }), true);
  assert.deepEqual(calls, [['set', 3], ['clear'], ['clear']]);

  // A browser without the Badging API must not throw.
  assert.equal(syncAppBadge(2, { navigator: {} }), true);
});
