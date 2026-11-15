// The watch-only address link is the second (and only other) thing the website
// writes to a database, so these tests pin its limits the same way the theme
// tests do: one field, a canonical public address, owner-only, and no path from
// that document to signing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LINKS_COLLECTION,
  describeLinkFailure,
  diagnoseFirestoreProblem,
  linkDocument,
  linkEnabledFor,
  normalizeAddress,
  readLinkFrom,
  writeLinkTo,
  clearLinkFrom,
} from '../lib/walletLinks.js';
import { DB_TIMEOUT_MS, withTimeout } from '../lib/withTimeout.js';

const RULES = readFileSync(join(process.cwd(), 'firestore.rules'), 'utf8');
const MODULE = readFileSync(join(process.cwd(), 'lib', 'walletLinks.js'), 'utf8');

// A real-shaped account id: 'G' + 55 base32 characters.
const ADDRESS = `G${'A'.repeat(55)}`;

// A link that cannot be saved must name the reason and the page that fixes it,
// because a deadline alone reads as "frozen" rather than "not configured".
const reply = (status, message) => async () => ({
  status, ok: status >= 200 && status < 300,
  json: async () => ({ error: { message } }),
});

const CONFIG = { projectId: 'nsat-wallet-login', apiKey: 'key' };

test('a disabled database is named, not reported as a timeout', async () => {
  const { code } = await diagnoseFirestoreProblem({
    config: CONFIG,
    doFetch: reply(403, 'Cloud Firestore API has not been used in project nsat-wallet-login before or it is disabled.'),
  });
  assert.equal(code, 'FIRESTORE_API_DISABLED');
  const dialog = describeLinkFailure(code, { projectId: CONFIG.projectId });
  assert.match(dialog.title, /Firestore/i);
  assert.match(dialog.fix.url, /apis\/library\/firestore\.googleapis\.com\?project=nsat-wallet-login/);
});

test('a rules denial and a missing database get their own pages', async () => {
  const denied = await diagnoseFirestoreProblem({
    config: CONFIG, doFetch: reply(403, 'Missing or insufficient permissions.'),
  });
  assert.equal(denied.code, 'FIRESTORE_REFUSED');
  assert.match(describeLinkFailure(denied.code, { projectId: 'p' }).fix.url, /firestore\/rules/);

  const missing = await diagnoseFirestoreProblem({
    config: CONFIG, doFetch: reply(404, 'The database (default) does not exist for project p.'),
  });
  assert.equal(missing.code, 'FIRESTORE_NO_DATABASE');
  assert.match(describeLinkFailure(missing.code, { projectId: 'p' }).fix.label, /Create/i);
});

test('an answering database or an offline probe keeps the timeout wording', async () => {
  assert.equal((await diagnoseFirestoreProblem({ config: CONFIG, doFetch: reply(200, '') })).code, '');
  assert.equal((await diagnoseFirestoreProblem({
    config: CONFIG, doFetch: async () => { throw new Error('offline'); },
  })).code, '');
  const fallback = describeLinkFailure('', { projectId: 'p' });
  assert.match(fallback.message, /Reload to check/i);
  assert.equal(fallback.fix, undefined);
});

test('unlinking says unlinking, so the popup never misdescribes the action', () => {
  const unlink = describeLinkFailure('FIRESTORE_API_DISABLED', { action: 'unlink', projectId: 'p' });
  assert.match(unlink.message, /remove the linked address/i);
  const link = describeLinkFailure('FIRESTORE_API_DISABLED', { action: 'link', projectId: 'p' });
  assert.match(link.message, /save this address/i);
});

function fakeStore(initial = null) {
  const state = { data: initial, writes: [], removes: 0 };
  return {
    state,
    read: async () => state.data,
    write: async (data) => { state.writes.push(data); state.data = data; },
    remove: async () => { state.removes += 1; state.data = null; },
  };
}

test('only a canonical 56-character G… address is accepted', () => {
  assert.equal(normalizeAddress(ADDRESS), ADDRESS);
  assert.equal(normalizeAddress(`  ${ADDRESS}  `), ADDRESS);
  for (const bad of [
    '', 'G', ADDRESS.slice(0, 55), `${ADDRESS}A`,       // wrong length
    `S${'A'.repeat(55)}`,                               // seed strkey, not an account
    `g${'a'.repeat(55)}`,                               // lowercase base32
    `G${'0'.repeat(55)}`, `G${'1'.repeat(55)}`,         // base32 has no 0 or 1
    ADDRESS.replace('G', 'X'),                          // not an account id
    null, undefined, 0, {}, [],                         // not a string
  ]) {
    assert.equal(normalizeAddress(bad), null, `${String(bad)} must not be accepted`);
  }
});

test('the linked document is exactly one public address', () => {
  const doc = linkDocument(ADDRESS);
  assert.deepEqual(doc, { address: ADDRESS });
  assert.deepEqual(Object.keys(doc), ['address']);
  // A caller cannot widen the write into wallet data.
  assert.ok(!/seed|password|balance|history|keystore|pubkey|name/i.test(JSON.stringify(doc)));
  assert.throws(() => linkDocument('G-wrong'), /wallet address must be a 56-character/);
});

test('nothing is stored for an account until it links explicitly', () => {
  assert.equal(linkEnabledFor('uid-1'), false);
  assert.equal(linkEnabledFor(''), false);
});

test('reading and writing use only the address document', async () => {
  const store = fakeStore(null);
  assert.equal(await readLinkFrom(store), null);

  assert.equal(await writeLinkTo(store, ADDRESS), ADDRESS);
  assert.deepEqual(store.state.writes, [{ address: ADDRESS }]);
  assert.equal(await readLinkFrom(store), ADDRESS);

  await clearLinkFrom(store);
  assert.equal(store.state.removes, 1);
  assert.equal(await readLinkFrom(store), null);
});

test('a document wider than one field is refused', async () => {
  // Defense in depth: if the database ever held extra wallet data, the UI must
  // not read it back into the app at all.
  for (const doc of [
    { address: ADDRESS, balance: '21000000' },
    { address: ADDRESS, seed: 'SXXX' },
    { address: ADDRESS, history: [] },
    { theme: 'dark' },
    {},
  ]) {
    assert.equal(await readLinkFrom(fakeStore(doc)), null, JSON.stringify(doc));
  }
});

test('firestore rules keep the link owner-only, single-field and address-shaped', () => {
  assert.match(RULES, /rules_version = '2'/);
  assert.ok(RULES.includes(LINKS_COLLECTION), 'rules must cover the linked collection');
  assert.match(RULES, /match \/walletLinks\/\{uid\}/);
  assert.match(RULES, /request\.auth\.uid == uid/);
  assert.match(RULES, /request\.resource\.data\.keys\(\)\.hasOnly\(\['address'\]\)/);
  // The shape check is what stops this document holding anything else.
  assert.match(RULES, /address\.matches\('\^G\[A-Z2-7\]\{55\}\$'\)/);
  // Still no writable path anywhere else.
  assert.match(RULES, /match \/\{document=\*\*\}/);
  assert.match(RULES, /allow read, write: if false;/);
  assert.doesNotMatch(RULES, /allow (read|write)(, (read|write))?: if true/);
});

test('a database that never answers fails instead of hanging the button', async () => {
  // Found on the deployed site: with the Cloud Firestore API disabled, the SDK
  // queues and retries forever, the promise never settles, and the control
  // stayed disabled with no message at all.
  const never = new Promise(() => {});
  const started = Date.now();
  await assert.rejects(() => withTimeout(never, 'gave up', 30), /gave up/);
  assert.ok(Date.now() - started < 2000, 'the deadline must fire well before a person gives up');

  // The deadline is a bound, not a delay: a normal answer passes straight through.
  assert.equal(await withTimeout(Promise.resolve('ok'), 'nope', 1000), 'ok');
  assert.equal(DB_TIMEOUT_MS, 12_000);

  // And the storage helpers actually route the three database calls through it,
  // so no browser control can wait on an unanswered write forever.
  for (const call of ['store.read()', 'store.write(doc)', 'store.remove()']) {
    assert.ok(MODULE.includes(`withTimeout(${call}`), `${call} must be bounded by the deadline`);
  }
  const theme = readFileSync(join(process.cwd(), 'lib', 'themeSync.js'), 'utf8');
  for (const call of ['store.read()', 'store.write(doc)', 'store.remove()']) {
    assert.ok(theme.includes(`withTimeout(${call}`), `theme sync ${call} must be bounded too`);
  }
});

test('watching an address grants no signing path', () => {
  // The module handles a public pointer only: no key material is imported and
  // no signing/tx code is reachable from it.
  for (const needle of ['nsatWallet', 'nsatCodec', 'buildSignedTx', 'keystoreUnlock',
    'ed25519Sign', 'submitSignedTransaction', 'seed32']) {
    assert.ok(!MODULE.includes(needle), `address linking must not reference ${needle}`);
  }
  // And the wallet engine still has no database path of its own.
  const wallet = readFileSync(join(process.cwd(), 'lib', 'nsatWallet.js'), 'utf8');
  assert.ok(!wallet.toLowerCase().includes('firestore'));
  assert.ok(!wallet.includes(LINKS_COLLECTION));
});
