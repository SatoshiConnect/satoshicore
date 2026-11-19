import assert from 'node:assert/strict';
import test from 'node:test';

// A minimal localStorage so the stamp round trip can run outside a browser. It
// is installed before the module is imported because the module reads the
// global when it runs, not when it loads.
const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => { store.set(key, String(value)); },
  removeItem: (key) => { store.delete(key); },
};

const {
  REMINDER_DAYS, backupReminder, coveredWallets, lastDriveBackup, recordDriveBackup,
} = await import('../lib/backupReminder.js');

const DAY = 24 * 60 * 60 * 1000;
const now = Date.UTC(2026, 10, 15, 12, 0, 0);

test('a funded wallet that was never backed up is due', () => {
  assert.equal(REMINDER_DAYS, 7);
  assert.deepEqual(backupReminder({ balance: '5000000', lastBackupAt: '', now }), { due: true, ageDays: null, newWalletNames: [] });
});

test('nothing to lose never nags', () => {
  for (const balance of ['0', null, undefined, '', 'abc', '-5']) {
    assert.deepEqual(backupReminder({ balance, lastBackupAt: '', now }), { due: false, ageDays: null, newWalletNames: [] });
  }
});

test('the reminder waits out the full week and then fires', () => {
  const sixDaysAgo = new Date(now - 6 * DAY).toISOString();
  const eightDaysAgo = new Date(now - 8 * DAY).toISOString();
  assert.deepEqual(backupReminder({ balance: '1', lastBackupAt: sixDaysAgo, now }), { due: false, ageDays: 6, newWalletNames: [] });
  assert.deepEqual(backupReminder({ balance: '1', lastBackupAt: eightDaysAgo, now }), { due: true, ageDays: 8, newWalletNames: [] });
});

test('a stamp from the future is fresh, not negative', () => {
  const tomorrow = new Date(now + DAY).toISOString();
  assert.deepEqual(backupReminder({ balance: '1', lastBackupAt: tomorrow, now }), { due: false, ageDays: 0, newWalletNames: [] });
});

test('an unreadable stamp falls back to "never backed up"', () => {
  assert.deepEqual(backupReminder({ balance: '1', lastBackupAt: 'not-a-date', now }), { due: true, ageDays: null, newWalletNames: [] });
});

test('stamps are recorded per account and survive a reload', () => {
  const at = new Date(now);
  assert.equal(recordDriveBackup('  Appmigs@Gmail.com ', at), true);
  assert.equal(lastDriveBackup('appmigs@gmail.com'), at.toISOString());
  assert.equal(lastDriveBackup('someone-else@gmail.com'), '');
  // A blank account cannot be stamped, and a bad time is ignored rather than stored.
  assert.equal(recordDriveBackup('', at), false);
  assert.equal(recordDriveBackup('appmigs@gmail.com', 'not-a-date'), false);
  assert.equal(lastDriveBackup('appmigs@gmail.com'), at.toISOString());
});

test('a wallet added after the last upload is not covered, however new the copy', () => {
  const yesterday = new Date(now - DAY).toISOString();
  const fresh = backupReminder({ balance: '1', lastBackupAt: yesterday, now });
  assert.equal(fresh.due, false);
  // Same fresh copy, but one wallet on this device is not in it.
  const uncovered = backupReminder({
    balance: '1', lastBackupAt: yesterday, now, newWalletNames: ['Second'],
  });
  assert.equal(uncovered.due, true);
  assert.deepEqual(uncovered.newWalletNames, ['Second']);
  assert.equal(uncovered.ageDays, 1);
  // Nothing to lose means no nag, even with an uncovered wallet.
  assert.equal(backupReminder({
    balance: '0', lastBackupAt: yesterday, now, newWalletNames: ['Second'],
  }).due, false);
});

test('an upload records which wallets it carried', () => {
  const at = new Date(now);
  assert.equal(recordDriveBackup('appmigs@gmail.com', at, { wallets: ['GAAA', ' GAAA ', 'GBBB', '', null] }), true);
  assert.deepEqual(coveredWallets('appmigs@gmail.com'), ['GAAA', 'GBBB']);
  assert.deepEqual(coveredWallets('someone-else@gmail.com'), []);
  // The age is still readable from the same entry.
  assert.equal(lastDriveBackup('appmigs@gmail.com'), at.toISOString());
  // An older stamp written as a bare ISO string has an age but no wallet list,
  // so it cannot claim a new wallet is covered.
  store.set('scw-web-drive-backup-v1', JSON.stringify({ 'old@gmail.com': at.toISOString() }));
  assert.equal(lastDriveBackup('old@gmail.com'), at.toISOString());
  assert.deepEqual(coveredWallets('old@gmail.com'), []);
});
