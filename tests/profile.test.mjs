// The profile is the third thing the website writes to a database, so it is
// pinned the same way as the theme and the linked wallets: an exact document
// shape, a unique self-chosen ID, a primary address that must already be linked,
// and an email-verified requirement enforced by the rules rather than the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PROFILE_IDS_COLLECTION,
  PROFILE_ID_MAX,
  PROFILE_ID_MIN,
  PROFILES_COLLECTION,
  claimProfileIdIn,
  createFirestoreProfileStore,
  describeProfileFailure,
  describeProfileIdProblem,
  normalizeProfile,
  normalizeProfileId,
  profileDocument,
  profileLabel,
  readProfileFrom,
  removeProfileFrom,
  writeProfileTo,
} from '../lib/profile.js';

const RULES = readFileSync(join(process.cwd(), 'firestore.rules'), 'utf8');
const MODULE = readFileSync(join(process.cwd(), 'lib', 'profile.js'), 'utf8');

const ADDRESS = `G${'A'.repeat(55)}`;
const OTHER = `G${'B'.repeat(55)}`;
const UID = 'uid-1';

function fakeStore({ profile = null, claims = {}, uid = UID } = {}) {
  const state = { profile, claims: { ...claims }, reads: 0, writes: [], deletes: 0, releases: [] };
  return {
    state,
    uid,
    read: async () => { state.reads += 1; return state.profile; },
    write: async (doc) => { state.writes.push(doc); state.profile = doc; },
    remove: async () => { state.deletes += 1; state.profile = null; },
    claim: async (id) => {
      if (state.claims[id] && state.claims[id] !== uid) {
        throw Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });
      }
      state.claims[id] = uid;
    },
    release: async (id) => { state.releases.push(id); delete state.claims[id]; },
    lookup: async (id) => state.claims[id] || '',
  };
}

test('a profile ID is lowercase, 3–20 characters, and unambiguous', () => {
  assert.equal(normalizeProfileId('somchai'), 'somchai');
  assert.equal(normalizeProfileId('  Somchai  '), 'somchai', 'case is folded, not rejected');
  assert.equal(normalizeProfileId('a_b-9'), 'a_b-9');
  for (const bad of ['', 'ab', 'a'.repeat(PROFILE_ID_MAX + 1), 'has space', 'dot.name',
    '@handle', 'id!', '-lead', '_lead', 'กมล', null, undefined, 42, {}]) {
    assert.equal(normalizeProfileId(bad), null, `${String(bad)} must be rejected`);
  }
  // The bounds are the ones the rules use.
  assert.equal(normalizeProfileId('a'.repeat(PROFILE_ID_MIN)), 'a'.repeat(PROFILE_ID_MIN));
  assert.equal(normalizeProfileId('a'.repeat(PROFILE_ID_MAX)), 'a'.repeat(PROFILE_ID_MAX));
  assert.match(RULES, /\^\[a-z0-9\]\[a-z0-9_-\]\{2,19\}\$/);
});

test('a rejected ID says why, in words that can be acted on', () => {
  assert.match(describeProfileIdProblem(''), /Choose/);
  assert.match(describeProfileIdProblem('Somchai'), /lowercase/);
  assert.match(describeProfileIdProblem('ab'), /at least/);
  assert.match(describeProfileIdProblem('a'.repeat(PROFILE_ID_MAX + 1)), /at most/);
  assert.match(describeProfileIdProblem('has space'), /letters, digits/);
  assert.equal(describeProfileIdProblem('somchai'), '');
});

test('the profile document has exactly two fields and a canonical address', () => {
  assert.deepEqual(profileDocument({ profileId: 'Somchai' }), { profileId: 'somchai', primaryAddress: '' });
  assert.deepEqual(profileDocument({ profileId: 'alice', primaryAddress: ` ${ADDRESS} ` }),
    { profileId: 'alice', primaryAddress: ADDRESS });
  // A caller cannot widen the write into wallet data.
  const doc = profileDocument({ profileId: 'alice', primaryAddress: ADDRESS });
  assert.deepEqual(Object.keys(doc).sort(), ['primaryAddress', 'profileId']);
  assert.ok(!/seed|password|balance|history|keystore|email|name/i.test(JSON.stringify(doc)));
  assert.throws(() => profileDocument({ profileId: 'no' }), /profile id/);
  assert.throws(() => profileDocument({ profileId: 'alice', primaryAddress: 'G-short' }), /primary wallet/);
});

test('a document that is not a profile never reaches the app', () => {
  assert.deepEqual(normalizeProfile({ profileId: 'alice', primaryAddress: ADDRESS }),
    { profileId: 'alice', primaryAddress: ADDRESS });
  assert.deepEqual(normalizeProfile({ profileId: 'alice' }), { profileId: 'alice', primaryAddress: '' });
  assert.deepEqual(normalizeProfile({ profileId: 'ALICE', primaryAddress: 'junk' }),
    { profileId: 'alice', primaryAddress: '' }, 'bad address is dropped, not stored back');
  for (const bad of [null, 'alice', [], { profileId: 'x' }, { primaryAddress: ADDRESS }]) {
    assert.equal(normalizeProfile(bad), null);
  }
  assert.equal(profileLabel('somchai'), '@somchai');
  assert.equal(profileLabel(''), '');
});

test('claiming an ID is one-time, and a taken ID is reported as taken', async () => {
  const store = fakeStore();
  assert.equal(await claimProfileIdIn(store, 'somchai'), 'somchai');
  assert.equal(store.state.claims.somchai, UID);

  const other = { ...fakeStore(), uid: 'uid-2' };
  other.state.claims = { somchai: UID };
  await assert.rejects(() => claimProfileIdIn(other, 'somchai'),
    (error) => error.code === 'ID_TAKEN');
  assert.equal(other.state.claims.somchai, UID, 'the first claim is untouched');

  // A lost race comes back from the rules as permission-denied, and must read
  // as "taken" rather than as a generic failure.
  const raced = fakeStore();
  raced.claim = async () => {
    throw Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });
  };
  await assert.rejects(() => claimProfileIdIn(raced, 'fresh'), (error) => error.code === 'ID_TAKEN');
});

test('profile round trip: create, change primary wallet, delete and release', async () => {
  const store = fakeStore();
  assert.equal(await readProfileFrom(store), null);

  await writeProfileTo(store, { profileId: 'alice', primaryAddress: '' });
  assert.deepEqual(await readProfileFrom(store), { profileId: 'alice', primaryAddress: '' });

  await writeProfileTo(store, { profileId: 'alice', primaryAddress: ADDRESS });
  assert.deepEqual(await readProfileFrom(store), { profileId: 'alice', primaryAddress: ADDRESS });

  await removeProfileFrom(store, 'alice');
  assert.equal(store.state.deletes, 1);
  assert.deepEqual(store.state.releases, ['alice']);
  assert.deepEqual(store.state.claims, {});
  assert.equal(await readProfileFrom(store), null);
});

test('the Firestore store keeps the claim and the profile in separate documents', async () => {
  const written = [];
  const deleted = [];
  let profileSnap = { exists: () => false, data: () => null };
  const claims = {};
  const sdk = {
    doc: (_db, collection, key) => `ref:${collection}:${key}`,
    getDoc: async (ref) => {
      if (ref.startsWith(`ref:${PROFILES_COLLECTION}`)) return profileSnap;
      const id = ref.split(':')[2];
      return claims[id] ? { exists: () => true, data: () => ({ uid: claims[id] }) }
        : { exists: () => false, data: () => null };
    },
    setDoc: async (ref, data) => {
      written.push({ ref, data });
      if (ref.startsWith(`ref:${PROFILES_COLLECTION}`)) {
        profileSnap = { exists: () => true, data: () => data };
      } else {
        const id = ref.split(':')[2];
        if (claims[id] && claims[id] !== data.uid) {
          throw Object.assign(new Error('denied'), { code: 'permission-denied' });
        }
        claims[id] = data.uid;
      }
    },
    deleteDoc: async (ref) => {
      deleted.push(ref);
      if (ref.startsWith(`ref:${PROFILES_COLLECTION}`)) {
        profileSnap = { exists: () => false, data: () => null };
      } else {
        delete claims[ref.split(':')[2]];
      }
    },
  };
  const store = createFirestoreProfileStore(UID, { emailVerified: true, sdk: { ...sdk, db: {} } });

  assert.equal(store.emailVerified, true);
  assert.equal(await store.lookup('alice'), '');
  await store.claim('alice');
  assert.deepEqual(written[0], { ref: `ref:${PROFILE_IDS_COLLECTION}:alice`, data: { uid: UID } });
  await store.write({ profileId: 'alice', primaryAddress: ADDRESS });
  assert.deepEqual(await store.read(), { profileId: 'alice', primaryAddress: ADDRESS });
  assert.deepEqual(written[1],
    { ref: `ref:${PROFILES_COLLECTION}:${UID}`, data: { profileId: 'alice', primaryAddress: ADDRESS } });

  // Releasing someone else's claim must do nothing at all.
  const foreign = createFirestoreProfileStore('uid-2', { emailVerified: true, sdk: { ...sdk, db: {} } });
  await foreign.release('alice');
  assert.equal(claims.alice, UID, 'a foreign release leaves the claim alone');

  await store.release('alice');
  assert.equal(claims.alice, undefined);
  assert.ok(deleted.includes(`ref:${PROFILE_IDS_COLLECTION}:alice`));
});

test('a refusal names the cause instead of looking frozen', () => {
  const taken = describeProfileFailure({ code: 'ID_TAKEN' });
  assert.match(taken.title, /taken/i);
  assert.equal(taken.fix, undefined);

  const denied = describeProfileFailure({ code: 'permission-denied' },
    { action: 'save', projectId: 'nsat-wallet-login' });
  assert.match(denied.message, /verified/);
  assert.match(denied.fix.url, /firestore\/rules/);
  assert.match(describeProfileFailure({ code: 'permission-denied' }, { action: 'delete' }).message,
    /not deleted/);

  const offline = describeProfileFailure({ code: 'unavailable' });
  assert.match(offline.title, /could not be reached/i);
  assert.match(offline.message, /Nothing was written/i);

  const stuck = describeProfileFailure(new Error('saving the profile did not complete'));
  assert.match(stuck.message, /Reload/i);
});

test('the rules require a verified email, a claim of your own and a linked wallet', () => {
  assert.ok(RULES.includes(`profiles/`), 'rules must cover the profile document');
  assert.ok(RULES.includes(PROFILE_IDS_COLLECTION), 'rules must cover the ID claims');
  assert.match(RULES, /request\.auth\.token\.email_verified == true/);
  assert.match(RULES, /match \/profiles\/\{uid\}/);
  assert.match(RULES, /match \/profileIds\/\{profileId\}/);
  // Shape: two fields on the profile, one on the claim.
  assert.match(RULES, /hasOnly\(\['profileId', 'primaryAddress'\]\)/);
  assert.match(RULES, /hasOnly\(\['uid'\]\)/);
  // A profile's ID must be a claim held by this same account, and the primary
  // address must be a wallet this account already linked.
  assert.match(RULES, /documents\/profileIds\/\$\(request\.resource\.data\.profileId\)/);
  assert.match(RULES, /documents\/walletLinks\/\$\(owner\)\/addresses\/\$\(address\)/);
  assert.match(RULES, /isLinkedAddress\(uid, request\.resource\.data\.primaryAddress\)/);
  // Claims are create-only, exact-get only, and deletable only by the holder.
  assert.match(RULES, /allow list: if false/);
  assert.match(RULES, /allow update: if false/);
  assert.match(RULES, /resource\.data\.uid == request\.auth\.uid/);
  // Still nothing writable anywhere else.
  assert.match(RULES, /match \/\{document=\*\*\}/);
  assert.match(RULES, /allow read, write: if false;/);
  assert.doesNotMatch(RULES, /allow (read|write)(, (read|write))?: if true/);
});

test('the profile holds no key material and cannot reach a signing path', () => {
  for (const needle of ['nsatWallet', 'nsatCodec', 'buildSignedTx', 'ed25519Sign',
    'keystoreUnlock', 'submitSignedTransaction', 'seed32', 'adminAuth']) {
    assert.ok(!MODULE.includes(needle), `the profile module must not reference ${needle}`);
  }
  // The email is checked through the auth claim, never stored.
  assert.ok(!/setDoc\([^)]*email:/.test(MODULE));
  assert.ok(!/profileDocument\([^)]*email/.test(MODULE));
  assert.match(MODULE, /request\.auth\.token\.email_verified|emailVerified/);
  // Every database call is bounded, like the other two client-writable stores.
  for (const call of ['store.read()', 'store.write(doc)', 'store.remove()',
    'store.release(id)', 'store.lookup(id)']) {
    assert.ok(MODULE.includes(`withTimeout(${call}`), `${call} must be bounded by the deadline`);
  }
});
