import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getFirebaseWebConfig,
  isFirebaseWebConfigured,
  setRememberGoogleSession,
  shouldRememberGoogleSession,
  signOutGoogleSession,
} from '../lib/firebaseAuth.js';

test('Google sign-in remains disabled when Firebase public config is absent', () => {
  const config = getFirebaseWebConfig({
    apiKey: '', authDomain: '', projectId: '', appId: '',
  });
  assert.deepEqual(config, {
    apiKey: '', authDomain: '', projectId: '', appId: '',
  });
  assert.equal(isFirebaseWebConfigured(config), false);
});

test('Google sign-in needs all four Firebase public web config values', () => {
  const config = {
    apiKey: 'public-web-key',
    authDomain: 'example.firebaseapp.com',
    projectId: 'example-project',
    appId: '1:123:web:abc',
  };
  assert.equal(isFirebaseWebConfigured(config), true);
  for (const key of Object.keys(config)) {
    assert.equal(isFirebaseWebConfigured({ ...config, [key]: '' }), false, `${key} is required`);
  }
  assert.equal(isFirebaseWebConfigured({ ...config, appId: '   ' }), false);
});

test('remember-device preference defaults off and stores only an explicit local flag', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  assert.equal(shouldRememberGoogleSession(storage), false);
  assert.equal(setRememberGoogleSession(true, storage), true);
  assert.equal(shouldRememberGoogleSession(storage), true);
  assert.deepEqual([...values], [['nsat-google-remember-device', '1']]);
  assert.equal(setRememberGoogleSession(false, storage), true);
  assert.equal(shouldRememberGoogleSession(storage), false);
  assert.equal(values.size, 0);
});

test('remember-device preference safely falls back to session-only if storage is blocked', () => {
  const blocked = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
    removeItem: () => { throw new Error('blocked'); },
  };
  assert.equal(shouldRememberGoogleSession(blocked), false);
  assert.equal(setRememberGoogleSession(true, blocked), false);
  assert.equal(setRememberGoogleSession(false, blocked), false);
});

// Signing out is the end of a wallet session, so the wallet must be told to
// lock BEFORE the network call: a slow or failing sign-out must never leave a
// signing key live on the strength of a request still on the wire.
test('signing out locks the wallet first, then clears the Google session', async () => {
  const order = [];
  const auth = { name: 'auth' };
  const authSdk = {
    browserSessionPersistence: 'session',
    setPersistence: async (instance, mode) => order.push(['persistence', instance, mode]),
    signOut: async (instance) => order.push(['signOut', instance]),
  };

  await signOutGoogleSession({
    load: async () => { order.push(['load']); return { auth, authSdk }; },
    announce: () => order.push(['announce']),
    remember: (value) => order.push(['remember', value]),
  });

  assert.deepEqual(order.map(([step]) => step),
    ['announce', 'load', 'persistence', 'signOut', 'remember', 'announce']);
  assert.deepEqual(order[2], ['persistence', auth, 'session'],
    'an explicit sign-out must leave no persistent Firebase record');
  assert.deepEqual(order[4], ['remember', false],
    'the remember-device flag is cleared by the sign-out');
  assert.deepEqual(order[5], ['announce'],
    'the settled sign-out announces again for a listener mounted late');
});

// A failing sign-out still ends the local session: the wallet is already locked
// and the flag is cleared, so the caller only has to show the error.
test('a failed sign-out still tears the local session down', async () => {
  const order = [];
  await assert.rejects(
    signOutGoogleSession({
      load: async () => ({
        auth: {},
        authSdk: {
          browserSessionPersistence: 'session',
          setPersistence: async () => {},
          signOut: async () => { throw new Error('offline'); },
        },
      }),
      announce: () => order.push('announce'),
      remember: (value) => order.push(['remember', value]),
    }),
    /offline/,
  );
  assert.deepEqual(order, ['announce', ['remember', false], 'announce']);
});

test('Firebase config exposes only the minimal auth web fields', () => {
  const config = getFirebaseWebConfig({
    apiKey: 'public-web-key',
    authDomain: 'example.firebaseapp.com',
    projectId: 'example-project',
    appId: '1:123:web:abc',
    clientSecret: 'must-not-be-copied',
  });
  assert.deepEqual(Object.keys(config).sort(), ['apiKey', 'appId', 'authDomain', 'projectId']);
  assert.ok(!JSON.stringify(config).includes('must-not-be-copied'));
});
