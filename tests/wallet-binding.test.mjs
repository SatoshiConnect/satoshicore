// Wallet ↔ website-account binding: the name suggested from a signed-in email,
// and the local label that keeps another account from adopting the wallet.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bindOwner, normalizeAccount, ownerOf, unbindOwner, walletNameForAccount,
} from '../lib/walletBinding.js';

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

test('the wallet name comes from the account, without the domain or digits', () => {
  assert.equal(walletNameForAccount('appmigs@gmail.com'), 'Appmigs');
  assert.equal(walletNameForAccount('ada.lovelace@example.com'), 'Ada Lovelace');
  assert.equal(walletNameForAccount('john_doe_2@example.com'), 'John Doe');
  assert.equal(walletNameForAccount('my-wallet@example.com'), 'My Wallet');
});

test('an unusable account still yields a usable name', () => {
  assert.equal(walletNameForAccount(''), 'Personal wallet');
  assert.equal(walletNameForAccount('@@@'), 'Personal wallet');
  assert.equal(walletNameForAccount('12345@example.com'), 'Personal wallet');
  assert.ok(walletNameForAccount('verylongaccountnamethatgoesonandonandon@example.com').length <= 32);
});

test('binding records the account for one wallet and can be removed', () => {
  globalThis.localStorage = memoryStorage();
  assert.equal(ownerOf('Primary'), '');
  assert.equal(bindOwner('Primary', '  User@Example.com '), true);
  assert.equal(ownerOf('Primary'), 'user@example.com');
  assert.equal(ownerOf('Other'), '');
  unbindOwner('Primary');
  assert.equal(ownerOf('Primary'), '');
});

test('an empty account or name is never bound', () => {
  globalThis.localStorage = memoryStorage();
  assert.equal(bindOwner('', 'a@b.c'), false);
  assert.equal(bindOwner('Primary', '   '), false);
  assert.equal(ownerOf('Primary'), '');
  assert.equal(normalizeAccount('  A@B.C '), 'a@b.c');
});
