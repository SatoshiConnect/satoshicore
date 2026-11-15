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
  REMINDER_DAYS, backupReminder, lastDriveBackup, recordDriveBackup,
} = await import('../lib/backupReminder.js');

const DAY = 24 * 60 * 60 * 1000;
const now = Date.UTC(2026, 10, 15, 12, 0, 0);

test('a funded wallet that was never backed up is due', () => {
  assert.equal(REMINDER_DAYS, 7);
  assert.deepEqual(backupReminder({ balance: '5000000', lastBackupAt: '', now }), { due: true, ageDays: null });
});

test('nothing to lose never nags', () => {
  for (const balance of ['0', null, undefined, '', 'abc', '-5']) {
    assert.deepEqual(backupReminder({ balance, lastBackupAt: '', now }), { due: false, ageDays: null });
  }
});

test('the reminder waits out the full week and then fires', () => {
  const sixDaysAgo = new Date(now - 6 * DAY).toISOString();
  const eightDaysAgo = new Date(now - 8 * DAY).toISOString();
  assert.deepEqual(backupReminder({ balance: '1', lastBackupAt: sixDaysAgo, now }), { due: false, ageDays: 6 });
  assert.deepEqual(backupReminder({ balance: '1', lastBackupAt: eightDaysAgo, now }), { due: true, ageDays: 8 });
});

test('a stamp from the future is fresh, not negative', () => {
  const tomorrow = new Date(now + DAY).toISOString();
  assert.deepEqual(backupReminder({ balance: '1', lastBackupAt: tomorrow, now }), { due: false, ageDays: 0 });
});

test('an unreadable stamp falls back to "never backed up"', () => {
  assert.deepEqual(backupReminder({ balance: '1', lastBackupAt: 'not-a-date', now }), { due: true, ageDays: null });
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
