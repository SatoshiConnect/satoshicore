import test from 'node:test';
import assert from 'node:assert/strict';

import { WALLET_STATUS, walletStatus } from '../lib/walletStatus.js';
import { readWalletNote, setBackupVerified, setRegistrationState } from '../lib/walletNotes.js';

test('the ledger answer decides the on-chain label', () => {
  assert.equal(walletStatus({ chain: { kind: 'exact' } }).id, WALLET_STATUS.ACTIVE);
  assert.equal(walletStatus({ chain: { kind: 'unavailable' }, backup: { verified: true } }).id,
    WALLET_STATUS.OFFLINE);
});

// A silent network must not hide the one warning the user can act on offline.
test('an unverified backup is still reported when the network is unreachable', () => {
  assert.equal(walletStatus({ chain: { kind: 'unavailable' } }).id,
    WALLET_STATUS.BACKUP_REQUIRED);
  assert.equal(walletStatus({}).id, WALLET_STATUS.BACKUP_REQUIRED);
});

test('local records never claim an on-chain account', () => {
  for (const backup of [{ verified: true }, { verified: false }, undefined]) {
    for (const registration of [{ state: 'done' }, { state: 'pending' }, { state: 'failed' }]) {
      const status = walletStatus({ chain: { kind: 'missing' }, backup, registration });
      assert.notEqual(status.id, WALLET_STATUS.ACTIVE, JSON.stringify({ backup, registration }));
    }
  }
});

test('missing accounts read as pending, failed, backup required, or created locally', () => {
  assert.equal(walletStatus({ chain: { kind: 'missing' }, registration: { state: 'pending' } }).id,
    WALLET_STATUS.PENDING);
  assert.equal(walletStatus({ chain: { kind: 'missing' }, registration: { state: 'failed' } }).id,
    WALLET_STATUS.FAILED);
  assert.equal(walletStatus({ chain: { kind: 'missing' }, backup: { verified: false } }).id,
    WALLET_STATUS.BACKUP_REQUIRED);
  assert.equal(walletStatus({ chain: { kind: 'missing' }, backup: { verified: true } }).id,
    WALLET_STATUS.CREATED);
  // Labels are the wording the UI shows.
  assert.equal(walletStatus({ chain: { kind: 'exact' } }).label, 'Active On-chain');
  assert.equal(walletStatus({ chain: { kind: 'missing' } }).label, 'Backup Required');
});

test('notes are per address, secret-free, and ignore unknown states', () => {
  const store = new Map();
  const storage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
  };
  const a = 'GAAA';
  setBackupVerified(a, true, storage);
  assert.equal(readWalletNote(a, storage).backup.verified, true);
  assert.equal(readWalletNote('GBBB', storage).backup, undefined);

  setRegistrationState(a, 'pending', storage);
  assert.equal(readWalletNote(a, storage).registration.state, 'pending');
  setRegistrationState(a, 'whatever', storage);
  assert.equal(readWalletNote(a, storage).registration.state, '');

  const raw = [...store.values()].join(' ');
  assert.equal(/S[A-Z2-7]{55}/.test(raw), false);
});
