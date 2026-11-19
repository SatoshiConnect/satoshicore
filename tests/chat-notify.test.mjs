import assert from 'node:assert/strict';
import test from 'node:test';

import {
  notificationSupported, readNotifyPref, showEncryptedNotification, writeNotifyPref,
} from '../lib/chatNotify.js';

const A = `G${'A'.repeat(55)}`;

function memoryStorage() {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
  };
}

test('notification preference is off by default, per wallet, and fails closed', () => {
  const storage = memoryStorage();
  assert.equal(readNotifyPref(A, storage), false);
  writeNotifyPref(A, true, storage);
  assert.equal(readNotifyPref(A, storage), true);
  writeNotifyPref(A, false, storage);
  assert.equal(readNotifyPref(A, storage), false);
  storage.setItem('scw-chat-notify-v1', '{');
  assert.equal(readNotifyPref(A, storage), false);
});

test('without Notification support showing a notification is a no-op', () => {
  assert.equal(notificationSupported(), false);
  assert.equal(showEncryptedNotification(), false);
});
