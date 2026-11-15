import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getFirebaseWebConfig,
  isFirebaseWebConfigured,
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
