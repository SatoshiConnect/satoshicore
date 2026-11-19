// Wallet ↔ website-account binding: the name suggested from a signed-in email,
// and the local label that keeps another account from adopting the wallet.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bindOwner, normalizeAccount, ownerOf, unbindOwner, visibleWalletNamed, walletNameForAccount,
  walletsForAccount,
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

test('an accountless session never lists a wallet that belongs to another account', () => {
  globalThis.localStorage = memoryStorage();
  bindOwner('Mine', 'me@example.com');
  bindOwner('Theirs', 'other@example.com');
  const wallets = [{ name: 'Mine' }, { name: 'Theirs' }, { name: 'Loose' }];

  // No account identity during auth initialization: only unbound wallets are visible as defense in depth.
  assert.deepEqual(walletsForAccount(wallets, '', { signInRequired: true }).map((w) => w.name), ['Loose']);
  // Signed in: own wallet plus unbound, never the other account's.
  assert.deepEqual(walletsForAccount(wallets, 'ME@example.com', { signInRequired: true }).map((w) => w.name), ['Mine', 'Loose']);
  // The extension build has no website-account identity to scope wallets against.
  assert.deepEqual(walletsForAccount(wallets, '', { signInRequired: false }).map((w) => w.name), ['Mine', 'Theirs', 'Loose']);
  assert.deepEqual(walletsForAccount(null, '', { signInRequired: true }), []);
});

// The unlock path resolves the wallet it is about to decrypt through this
// helper, so a hidden wallet must resolve to nothing even with the exact name.
test('an unlock request resolves only wallets this session may see', () => {
  globalThis.localStorage = memoryStorage();
  bindOwner('Mine', 'me@example.com');
  bindOwner('Theirs', 'other@example.com');
  const wallets = [{ name: 'Mine', pubkey: 'G-MINE' }, { name: 'Theirs', pubkey: 'G-THEIRS' }, { name: 'Loose', pubkey: 'G-LOOSE' }];

  // Unauthenticated web state during auth initialization: account-bound wallets stay invisible.
  assert.equal(visibleWalletNamed(wallets, '', 'Theirs', { signInRequired: true }), null);
  assert.equal(visibleWalletNamed(wallets, '', 'Mine', { signInRequired: true }), null);
  assert.deepEqual(visibleWalletNamed(wallets, '', 'Loose', { signInRequired: true }), { name: 'Loose', pubkey: 'G-LOOSE' });

  // Signed in as the owner: its own wallet resolves, the other account's does not.
  assert.deepEqual(visibleWalletNamed(wallets, 'me@example.com', 'Mine', { signInRequired: true }), { name: 'Mine', pubkey: 'G-MINE' });
  assert.equal(visibleWalletNamed(wallets, 'me@example.com', 'Theirs', { signInRequired: true }), null);
  assert.equal(visibleWalletNamed(wallets, '', 'Nope', { signInRequired: true }), null);
  assert.equal(visibleWalletNamed(wallets, '', '', { signInRequired: true }), null);
});

test('an empty account or name is never bound', () => {
  globalThis.localStorage = memoryStorage();
  assert.equal(bindOwner('', 'a@b.c'), false);
  assert.equal(bindOwner('Primary', '   '), false);
  assert.equal(ownerOf('Primary'), '');
  assert.equal(normalizeAccount('  A@B.C '), 'a@b.c');
});
