// The watch-only address link is the second (and only other) thing the website
// writes to a database, so these tests pin its limits the same way the theme
// tests do: one public address per document, owner-only, and no path from that
// document to signing. One account may hold several wallets, so the store is a
// list of those documents rather than a single address.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ADDRESSES_SUBCOLLECTION,
  LINKS_COLLECTION,
  MAX_LINKED_ADDRESSES,
  addLinkTo,
  addressDocument,
  clearLinksFrom,
  createFirestoreLinkStore,
  describeLinkFailure,
  diagnoseFirestoreProblem,
  linkEnabledFor,
  normalizeAddress,
  normalizeAddresses,
  readLinksFrom,
  removeLinkFrom,
} from '../lib/walletLinks.js';
import { DB_TIMEOUT_MS, withTimeout } from '../lib/withTimeout.js';

const RULES = readFileSync(join(process.cwd(), 'firestore.rules'), 'utf8');
const MODULE = readFileSync(join(process.cwd(), 'lib', 'walletLinks.js'), 'utf8');

// Real-shaped account ids: 'G' + 55 base32 characters.
const ADDRESS = `G${'A'.repeat(55)}`;
const OTHER = `G${'B'.repeat(55)}`;

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

// Two addresses, two documents: the store is a collection of wallets, not one
// account-level pointer.
function fakeStore(initial = []) {
  const state = { addresses: [...initial], adds: [], removes: [], cleared: 0 };
  return {
    state,
    list: async () => [...state.addresses],
    add: async (address) => {
      state.adds.push(address);
      if (!state.addresses.includes(address)) state.addresses.push(address);
    },
    remove: async (address) => {
      state.removes.push(address);
      state.addresses = state.addresses.filter((item) => item !== address);
    },
    removeAll: async () => { state.cleared += 1; state.addresses = []; },
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

test('several wallets are kept, de-duplicated, and capped', () => {
  assert.deepEqual(normalizeAddresses([ADDRESS, OTHER]), [ADDRESS, OTHER]);
  // The same wallet twice is one wallet.
  assert.deepEqual(normalizeAddresses([ADDRESS, ADDRESS, OTHER]), [ADDRESS, OTHER]);
  // Anything unreadable is dropped rather than stored.
  assert.deepEqual(normalizeAddresses([ADDRESS, 'nope', null, OTHER]), [ADDRESS, OTHER]);
  assert.deepEqual(normalizeAddresses('not a list'), []);

  // Distinct, canonical ids built from the base32 alphabet (no 0, 1, 8 or 9).
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const many = Array.from({ length: MAX_LINKED_ADDRESSES + 5 }, (_, index) =>
    `G${ALPHABET[index].repeat(55)}`);
  assert.equal(new Set(many).size, many.length, 'the generated ids must be distinct');
  assert.equal(normalizeAddresses(many).length, MAX_LINKED_ADDRESSES);
});

test('each linked wallet is one document holding one public address', () => {
  const doc = addressDocument(ADDRESS);
  assert.deepEqual(doc, { address: ADDRESS });
  assert.deepEqual(Object.keys(doc), ['address']);
  // A caller cannot widen the write into wallet data.
  assert.ok(!/seed|password|balance|history|keystore|pubkey|name/i.test(JSON.stringify(doc)));
  assert.throws(() => addressDocument('G-wrong'), /wallet address must be a 56-character/);
});

test('nothing is stored for an account until it links explicitly', () => {
  assert.equal(linkEnabledFor('uid-1'), false);
  assert.equal(linkEnabledFor(''), false);
});

test('reading and writing keep every linked wallet, one removal at a time', async () => {
  const store = fakeStore();
  assert.deepEqual(await readLinksFrom(store), []);

  assert.equal(await addLinkTo(store, ADDRESS), ADDRESS);
  assert.equal(await addLinkTo(store, OTHER), OTHER);
  assert.deepEqual(store.state.adds, [ADDRESS, OTHER]);
  assert.deepEqual(await readLinksFrom(store), [ADDRESS, OTHER]);

  // Removing one wallet must leave the other linked.
  await removeLinkFrom(store, ADDRESS);
  assert.deepEqual(store.state.removes, [ADDRESS]);
  assert.deepEqual(await readLinksFrom(store), [OTHER]);

  await clearLinksFrom(store);
  assert.equal(store.state.cleared, 1);
  assert.deepEqual(await readLinksFrom(store), []);
  await assert.rejects(() => removeLinkFrom(store, 'nope'), /wallet address must be a 56-character/);
});

test('a document that is not a public address never reaches the app', async () => {
  // Defense in depth: whatever the database holds, only canonical addresses are
  // read back, so extra wallet data cannot be surfaced by a misconfigured store.
  const store = {
    list: async () => [ADDRESS, 'GXXX', null, { address: OTHER }, OTHER, `${ADDRESS.slice(0, 55)}A`],
    add: async () => {},
    remove: async () => {},
    removeAll: async () => {},
  };
  assert.deepEqual(await readLinksFrom(store), [ADDRESS, OTHER]);
});

test('firestore rules keep each link owner-only, single-field and address-shaped', () => {
  assert.match(RULES, /rules_version = '2'/);
  assert.ok(RULES.includes(LINKS_COLLECTION), 'rules must cover the linked collection');
  assert.ok(RULES.includes(ADDRESSES_SUBCOLLECTION), 'rules must cover the per-wallet subcollection');
  assert.match(RULES, /match \/walletLinks\/\{uid\}/);
  assert.match(RULES, /match \/addresses\/\{address\}/);
  assert.match(RULES, /request\.auth\.uid == uid/);
  assert.match(RULES, /request\.resource\.data\.keys\(\)\.hasOnly\(\['address'\]\)/);
  // The shape check is what stops these documents holding anything else, and the
  // document id must be the address, so a write cannot file A under B.
  assert.match(RULES, /address\.matches\('\^G\[A-Z2-7\]\{55\}\$'\)/);
  assert.match(RULES, /request\.resource\.data\.address == address/);
  // Still no writable path anywhere else.
  assert.match(RULES, /match \/\{document=\*\*\}/);
  assert.match(RULES, /allow read, write: if false;/);
  assert.doesNotMatch(RULES, /allow (read|write)(, (read|write))?: if true/);
});

test('the Firestore store is a collection of wallets, not one pointer', () => {
  const deleted = [];
  const written = [];
  const snapshot = { docs: [{ data: () => ({ address: ADDRESS }), ref: 'ref-a' }] };
  const legacySnap = { exists: () => true, data: () => ({ address: OTHER }) };
  const sdk = {
    collection: () => 'links-collection',
    doc: (_db, _collection, _uid, sub, address) => `ref:${sub || ''}:${address || ''}`,
    getDocs: async () => snapshot,
    getDoc: async () => legacySnap,
    setDoc: async (ref, data) => { written.push({ ref, data }); },
    deleteDoc: async (ref) => { deleted.push(ref); },
  };
  const store = createFirestoreLinkStore('uid-1', { ...sdk, db: {} });
  assert.equal(typeof store.list, 'function');
  assert.equal(typeof store.add, 'function');
  // A store built for the subcollection writes one address per document and
  // keeps the address id and field together.
  return store.add(ADDRESS).then(() => {
    assert.deepEqual(written, [{ ref: `ref:${ADDRESSES_SUBCOLLECTION}:${ADDRESS}`, data: { address: ADDRESS } }]);
  }).then(() => store.list()).then((list) => {
    // The single-address document from before is read as one more wallet.
    assert.deepEqual(list, [ADDRESS, OTHER]);
    return store.remove(OTHER);
  }).then(() => {
    assert.ok(deleted.includes(`ref:${ADDRESSES_SUBCOLLECTION}:${OTHER}`));
    assert.ok(deleted.includes('ref::'), 'the legacy document is removed with its address');
  });
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

  // And the storage helpers actually route every database call through it, so no
  // browser control can wait on an unanswered read or write forever.
  for (const call of ['store.list()', 'store.add(saved.address)', 'store.remove(value)', 'store.removeAll()']) {
    assert.ok(MODULE.includes(`withTimeout(${call}`), `${call} must be bounded by the deadline`);
  }
  const theme = readFileSync(join(process.cwd(), 'lib', 'themeSync.js'), 'utf8');
  for (const call of ['store.read()', 'store.write(doc)', 'store.remove()']) {
    assert.ok(theme.includes(`withTimeout(${call}`), `theme sync ${call} must be bounded too`);
  }
});

test('watching an address grants no signing path', () => {
  // The module handles public pointers only: no key material is imported and no
  // signing/tx code is reachable from it.
  for (const needle of ['nsatWallet', 'nsatCodec', 'buildSignedTx', 'keystoreUnlock',
    'ed25519Sign', 'submitSignedTransaction', 'seed32']) {
    assert.ok(!MODULE.includes(needle), `address linking must not reference ${needle}`);
  }
  // And the wallet engine still has no database path of its own.
  const wallet = readFileSync(join(process.cwd(), 'lib', 'nsatWallet.js'), 'utf8');
  assert.ok(!wallet.toLowerCase().includes('firestore'));
  assert.ok(!wallet.includes(LINKS_COLLECTION));
});
