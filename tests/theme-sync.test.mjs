// Theme sync is the only feature that writes user data to a database, so these
// tests pin the two things that keep it safe: the payload can only ever be
// { theme: 'light' | 'dark' }, and the deployed Firestore rules are what enforce
// ownership and field limits server-side.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PREFERENCES_COLLECTION,
  clearThemeFrom,
  normalizeTheme,
  preferenceDocument,
  readThemeFrom,
  syncEnabledFor,
  writeThemeTo,
} from '../lib/themeSync.js';

const RULES = readFileSync(join(process.cwd(), 'firestore.rules'), 'utf8');

function fakeStore(initial = null) {
  const state = { data: initial, writes: [], reads: 0, removes: 0 };
  return {
    state,
    read: async () => { state.reads += 1; return state.data; },
    write: async (data) => { state.writes.push(data); state.data = data; },
    remove: async () => { state.removes += 1; state.data = null; },
  };
}

test('only light and dark are valid themes', () => {
  assert.equal(normalizeTheme('light'), 'light');
  assert.equal(normalizeTheme('dark'), 'dark');
  for (const bad of ['', 'Light', 'blue', null, undefined, 0, {}, 'light ']) {
    assert.equal(normalizeTheme(bad), null, `${String(bad)} must not be accepted`);
  }
});

test('the synced payload is exactly one theme field', () => {
  const doc = preferenceDocument('dark');
  assert.deepEqual(doc, { theme: 'dark' });
  assert.deepEqual(Object.keys(doc), ['theme']);
  // A caller cannot smuggle wallet data into the document.
  assert.ok(!/seed|password|pubkey|address|balance|history|keystore/i.test(JSON.stringify(doc)));
  assert.throws(() => preferenceDocument('blue'), /theme must be light or dark/);
});

test('sync is off until an account opts in', () => {
  // No localStorage in the test runtime: sync must read as disabled, never as
  // "enabled by default".
  assert.equal(syncEnabledFor('uid-1'), false);
  assert.equal(syncEnabledFor(''), false);
});

test('writing and reading use only the theme document', async () => {
  const store = fakeStore(null);
  assert.equal(await readThemeFrom(store), null);

  assert.equal(await writeThemeTo(store, 'light'), 'light');
  assert.deepEqual(store.state.writes, [{ theme: 'light' }]);

  assert.equal(await readThemeFrom(store), 'light');
  await clearThemeFrom(store);
  assert.equal(store.state.removes, 1);
  assert.equal(await readThemeFrom(store), null);
});

test('a remote document with anything else is ignored', async () => {
  // Defense in depth: even if rules were misconfigured, a document carrying a
  // non-theme value is not applied to the page.
  const store = fakeStore({ theme: 'blue', seed: 'SXXX' });
  assert.equal(await readThemeFrom(store), null);
});

test('firestore rules keep theme sync owner-only and theme-only', () => {
  assert.match(RULES, /rules_version = '2'/);
  assert.ok(RULES.includes(PREFERENCES_COLLECTION), 'rules must cover the synced collection');
  assert.match(RULES, /match \/websitePreferences\/\{uid\}/);

  // Owner-only reads and deletes, owner-only writes.
  const ownerChecks = RULES.match(/request\.auth\.uid == uid/g) || [];
  assert.ok(ownerChecks.length >= 2, 'both read/delete and create/update must check the owner');

  // Field allowlist plus value restriction: this is what makes a wallet field
  // a database rejection rather than a client-side promise.
  assert.match(RULES, /request\.resource\.data\.keys\(\)\.hasOnly\(\['theme'\]\)/);
  assert.match(RULES, /data\.theme in \['light', 'dark'\]/);

  // Everything else is denied.
  assert.match(RULES, /match \/\{document=\*\*\}/);
  assert.match(RULES, /allow read, write: if false;/);
  assert.doesNotMatch(RULES, /allow (read|write)(, (read|write))?: if true/);
});

test('the wallet never writes to the preferences collection', () => {
  // The wallet engine has no database path at all: theme sync lives in its own
  // module and only that module may name the collection.
  const wallet = readFileSync(join(process.cwd(), 'lib', 'nsatWallet.js'), 'utf8');
  for (const needle of ['firestore', 'firebase', PREFERENCES_COLLECTION]) {
    assert.ok(!wallet.toLowerCase().includes(needle.toLowerCase()),
      `wallet engine must not reference ${needle}`);
  }
});
