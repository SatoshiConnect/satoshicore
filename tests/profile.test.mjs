// The profile is the third thing the website writes to a database, so it is
// pinned the same way as the theme and the linked wallets: an exact document
// shape, a unique self-chosen ID, a primary address that must already be linked,
// and an email-verified requirement enforced by the rules rather than the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BIO_MAX,
  DEFAULT_PROFILE_VISIBILITY,
  DISPLAY_NAME_MAX,
  PROFILE_IDS_COLLECTION,
  PROFILE_ID_MAX,
  PROFILE_ID_MIN,
  PROFILES_COLLECTION,
  STATUS_MAX,
  claimProfileIdIn,
  createFirestoreProfileStore,
  renameProfileIdIn,
  saveProfileIn,
  describeProfileFailure,
  describeProfileIdProblem,
  normalizeProfile,
  normalizeProfileId,
  normalizeProfileText,
  normalizeProfileVisibility,
  profileDisplayLabel,
  profileDocument,
  profileLabel,
  readProfileFrom,
  removeProfileFrom,
  validateProfileText,
  writeProfileTo,
} from '../lib/profile.js';

const RULES = readFileSync(join(process.cwd(), 'firestore.rules'), 'utf8');
const MODULE = readFileSync(join(process.cwd(), 'lib', 'profile.js'), 'utf8');

const ADDRESS = `G${'A'.repeat(55)}`;
const OTHER = `G${'B'.repeat(55)}`;
const UID = 'uid-1';
const EMPTY_TEXT = {
  displayName: '', bio: '', status: '', visibility: DEFAULT_PROFILE_VISIBILITY,
};
const fullProfile = (over = {}) => ({
  profileId: '@alice', primaryAddress: '', ...EMPTY_TEXT, ...over,
});

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

test('a profile ID includes @, is lowercase, and has 3–20 name characters', () => {
  assert.equal(normalizeProfileId('@somchai'), '@somchai');
  assert.equal(normalizeProfileId('  @Somchai  '), '@somchai', 'case is folded, not rejected');
  assert.equal(normalizeProfileId('@a_b-9'), '@a_b-9');
  // @ is required, not implied — the stored ID and its claim are the same
  // string, so a bare name is not silently rewritten.
  assert.equal(normalizeProfileId('somchai'), null);
  for (const bad of ['', 'ab', '@ab', `@${'a'.repeat(PROFILE_ID_MAX + 1)}`, 'has space',
    '@dot.name', '@@handle', '@id!', '@-lead', '@_lead', '@กมล', null, undefined, 42, {}]) {
    assert.equal(normalizeProfileId(bad), null, `${String(bad)} must be rejected`);
  }
  // The bounds are the ones the rules use, excluding the required @ prefix.
  assert.equal(normalizeProfileId(`@${'a'.repeat(PROFILE_ID_MIN)}`), `@${'a'.repeat(PROFILE_ID_MIN)}`);
  assert.equal(normalizeProfileId(`@${'a'.repeat(PROFILE_ID_MAX)}`), `@${'a'.repeat(PROFILE_ID_MAX)}`);
  assert.match(RULES, /\^@\[a-z0-9\]\[a-z0-9_-\]\{2,19\}\$/);
});

test('a rejected ID says why, in words that can be acted on', () => {
  assert.match(describeProfileIdProblem(''), /Choose.*@/);
  assert.match(describeProfileIdProblem('@Somchai'), /lowercase/);
  assert.match(describeProfileIdProblem('@ab'), /at least/);
  assert.match(describeProfileIdProblem(`@${'a'.repeat(PROFILE_ID_MAX + 1)}`), /at most/);
  assert.match(describeProfileIdProblem('@has space'), /letters, digits/);
  assert.match(describeProfileIdProblem('somchai'), /must start with @/);
  assert.equal(describeProfileIdProblem('@somchai'), '');
});

test('the profile document has exactly six fields and a canonical address', () => {
  assert.deepEqual(profileDocument({ profileId: '@Somchai' }),
    fullProfile({ profileId: '@somchai' }));
  assert.deepEqual(profileDocument({ profileId: '@alice', primaryAddress: ` ${ADDRESS} ` }),
    fullProfile({ primaryAddress: ADDRESS }));
  // A caller cannot widen the write into wallet data.
  const doc = profileDocument({
    profileId: '@alice', primaryAddress: ADDRESS, displayName: ' Alice ', bio: ' hi ', status: ' ready ',
  });
  assert.deepEqual(Object.keys(doc).sort(),
    ['bio', 'displayName', 'primaryAddress', 'profileId', 'status', 'visibility']);
  assert.ok(!/seed|password|balance|history|keystore|email/i.test(JSON.stringify(doc)));
  assert.throws(() => profileDocument({ profileId: 'no' }), /profile id/);
  assert.throws(() => profileDocument({ profileId: '@alice', primaryAddress: 'G-short' }), /primary wallet/);
});

test('a resolved peer uses the display name, then the handle, then the caller fallback', () => {
  assert.equal(profileDisplayLabel({ displayName: 'Alice', profileId: '@alice' }), 'Alice');
  assert.equal(profileDisplayLabel({ displayName: '   ', profileId: '@alice' }), '@alice');
  assert.equal(profileDisplayLabel({ profileId: '@alice' }), '@alice');
  assert.equal(profileDisplayLabel({ displayName: 'Alice', profileId: 'not-a-handle' }), 'Alice');
  assert.equal(profileDisplayLabel({ displayName: '', profileId: 'not-a-handle' }, 'G…fallback'),
    'G…fallback');
  assert.equal(profileDisplayLabel(null, '@fallback'), '@fallback');
  assert.equal(profileDisplayLabel({}, ''), '');
  // An over-long display name is not shown; the handle is the safe label.
  assert.equal(profileDisplayLabel({
    displayName: 'x'.repeat(DISPLAY_NAME_MAX + 1), profileId: '@alice',
  }), '@alice');
});

test('profile visibility is a closed set and defaults for old documents', () => {
  assert.equal(DEFAULT_PROFILE_VISIBILITY, 'signed-in');
  assert.equal(normalizeProfileVisibility('signed-in'), 'signed-in');
  assert.equal(normalizeProfileVisibility('contacts'), 'contacts');
  assert.equal(normalizeProfileVisibility('private'), 'private');
  assert.equal(normalizeProfileVisibility('public'), null);
  assert.equal(normalizeProfile({ profileId: '@alice' }).visibility, DEFAULT_PROFILE_VISIBILITY);
  assert.equal(normalizeProfile({ profileId: '@alice', visibility: 'private' }).visibility, 'private');
  assert.deepEqual(profileDocument({ profileId: '@alice', visibility: 'contacts' }),
    fullProfile({ visibility: 'contacts' }));
  assert.throws(() => profileDocument({ profileId: '@alice', visibility: 'public' }), /visibility/);
});

test('display name, bio and status are optional, whitespace-normalized and bounded', () => {
  assert.equal(normalizeProfileText('  Alice\n\nSmith  '), 'Alice Smith');
  assert.equal(normalizeProfileText('\u0000Alice\u0007'), 'Alice');
  assert.equal(normalizeProfileText(null), '');
  assert.deepEqual(validateProfileText('  hi  ', { max: 5 }), { ok: true, text: 'hi' });
  assert.deepEqual(validateProfileText(undefined, { max: 5 }), { ok: true, text: '' });
  assert.equal(validateProfileText('123456', { max: 5 }).ok, false);
  assert.match(validateProfileText('123456', { max: 5, label: 'bio' }).message, /bio.*5/);
  assert.equal(validateProfileText(42, { max: 5 }).ok, false);
  // Counted as characters, not UTF-16 units: 50 emoji fit a 50-character field.
  assert.equal(validateProfileText('😀'.repeat(DISPLAY_NAME_MAX), { max: DISPLAY_NAME_MAX }).ok, true);

  const doc = profileDocument({
    profileId: '@alice', displayName: '  Alice  ', bio: '  builds things ', status: ' ready ',
  });
  assert.deepEqual(doc, fullProfile({
    displayName: 'Alice', bio: 'builds things', status: 'ready',
  }));
  assert.throws(
    () => profileDocument({ profileId: '@alice', displayName: 'x'.repeat(DISPLAY_NAME_MAX + 1) }),
    /display name/,
  );
  assert.throws(() => profileDocument({ profileId: '@alice', bio: 'x'.repeat(BIO_MAX + 1) }), /bio/);
  assert.throws(() => profileDocument({ profileId: '@alice', status: 'x'.repeat(STATUS_MAX + 1) }), /status/);
  assert.throws(() => profileDocument({ profileId: '@alice', displayName: 42 }), /display name/);
});

test('a document that is not a profile never reaches the app', () => {
  assert.deepEqual(normalizeProfile({
    profileId: '@alice', primaryAddress: ADDRESS, displayName: ' Alice ', bio: ' hi ',
    status: ' ready ', visibility: 'contacts',
  }), fullProfile({
    primaryAddress: ADDRESS, displayName: 'Alice', bio: 'hi', status: 'ready', visibility: 'contacts',
  }));
  // Missing text fields are the old two-field shape and read as empty.
  assert.deepEqual(normalizeProfile({ profileId: '@alice', primaryAddress: ADDRESS }),
    fullProfile({ primaryAddress: ADDRESS }));
  // A document without @ is not a profile this build understands.
  assert.equal(normalizeProfile({ profileId: 'alice' }), null);
  assert.deepEqual(normalizeProfile({ profileId: '@ALICE', primaryAddress: 'junk' }),
    fullProfile({ profileId: '@alice' }), 'bad address is dropped, not stored back');
  // Over-long or non-string text is dropped rather than trusted.
  assert.deepEqual(normalizeProfile({
    profileId: '@alice', displayName: 'x'.repeat(DISPLAY_NAME_MAX + 1), bio: 42, status: 'ok',
    visibility: 'unknown',
  }), fullProfile({ status: 'ok', visibility: 'private' }), 'unknown visibility fails closed');
  for (const bad of [null, 'alice', [], { profileId: 'x' }, { primaryAddress: ADDRESS }]) {
    assert.equal(normalizeProfile(bad), null);
  }
  assert.equal(profileLabel('@somchai'), '@somchai');
  assert.equal(profileLabel('somchai'), '', 'an ID without @ is not a label either');
  assert.equal(profileLabel(''), '');
});

test('claiming an ID is one-time, and a taken ID is reported as taken', async () => {
  const store = fakeStore();
  assert.equal(await claimProfileIdIn(store, '@somchai'), '@somchai');
  assert.equal(store.state.claims['@somchai'], UID);

  const other = { ...fakeStore(), uid: 'uid-2' };
  other.state.claims = { '@somchai': UID };
  await assert.rejects(() => claimProfileIdIn(other, '@somchai'),
    (error) => error.code === 'ID_TAKEN');
  assert.equal(other.state.claims['@somchai'], UID, 'the first claim is untouched');

  // A lost race comes back from the rules as permission-denied, and must read
  // as "taken" rather than as a generic failure.
  const raced = fakeStore();
  raced.claim = async () => {
    throw Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });
  };
  await assert.rejects(() => claimProfileIdIn(raced, '@fresh'), (error) => error.code === 'ID_TAKEN');
});

test('profile round trip: create, change primary wallet, delete and release', async () => {
  const store = fakeStore();
  assert.equal(await readProfileFrom(store), null);

  await writeProfileTo(store, { profileId: '@alice', primaryAddress: '' });
  assert.deepEqual(await readProfileFrom(store), fullProfile());

  await writeProfileTo(store, {
    profileId: '@alice', primaryAddress: ADDRESS, displayName: 'Alice', bio: 'hi', status: 'ready',
  });
  assert.deepEqual(await readProfileFrom(store), fullProfile({
    primaryAddress: ADDRESS, displayName: 'Alice', bio: 'hi', status: 'ready',
  }));

  await removeProfileFrom(store, '@alice');
  assert.equal(store.state.deletes, 1);
  assert.deepEqual(store.state.releases, ['@alice']);
  assert.deepEqual(store.state.claims, {});
  assert.equal(await readProfileFrom(store), null);
});

test('changing an ID claims the new one first and releases the old one after', async () => {
  const store = fakeStore({
    profile: {
      profileId: '@alice', primaryAddress: ADDRESS, displayName: 'Alice', bio: 'hi', status: 'ready',
    },
    claims: { '@alice': UID },
  });
  const renamed = await renameProfileIdIn(store, '@Alice-2');
  assert.deepEqual(renamed, fullProfile({
    profileId: '@alice-2', primaryAddress: ADDRESS, displayName: 'Alice', bio: 'hi', status: 'ready',
  }), 'the primary wallet and display text survive the rename');
  assert.deepEqual(store.state.claims, { '@alice-2': UID }, 'old claim released, new one held');
  assert.deepEqual(store.state.releases, ['@alice']);

  // Same ID is a no-op, not claim and write churn.
  const writes = store.state.writes.length;
  const again = await renameProfileIdIn(store, '@alice-2');
  assert.equal(again.profileId, '@alice-2');
  assert.equal(store.state.writes.length, writes);

  await assert.rejects(() => renameProfileIdIn(store, '@no'), /profile id/);
  const empty = fakeStore();
  await assert.rejects(() => renameProfileIdIn(empty, '@bob'), /create a profile first/);
});

// A failed rename must leave the account exactly as it was: still holding the
// old ID and its profile, with the unclaimed new ID free for anyone.
test('a failed rename gives the new ID back and keeps the old profile', async () => {
  const store = fakeStore({ profile: { profileId: '@alice', primaryAddress: ADDRESS }, claims: { '@alice': UID } });
  store.write = async () => { throw Object.assign(new Error('denied'), { code: 'permission-denied' }); };
  await assert.rejects(() => renameProfileIdIn(store, '@bob'), /denied/);
  assert.deepEqual(store.state.claims, { '@alice': UID }, 'the new claim is released again');
  assert.deepEqual(store.state.profile, { profileId: '@alice', primaryAddress: ADDRESS });

  // And a rename onto an ID somebody else holds is refused before any write.
  const taken = fakeStore({ profile: { profileId: '@alice', primaryAddress: '' }, claims: { '@alice': UID, '@bob': 'uid-2' } });
  await assert.rejects(() => renameProfileIdIn(taken, '@bob'), (error) => error.code === 'ID_TAKEN');
  assert.equal(taken.state.writes.length, 0);
  assert.deepEqual(taken.state.claims, { '@alice': UID, '@bob': 'uid-2' });
});

// One save path for the Edit form: ID and primary wallet are written together,
// and a primary wallet that is not linked is refused before anything is sent.
test('saving writes the ID and primary wallet together, and refuses a stray wallet', async () => {
  const store = fakeStore({ profile: { profileId: '@alice', primaryAddress: '' }, claims: { '@alice': UID } });
  await assert.rejects(
    () => saveProfileIn(store, { profileId: '@alice', primaryAddress: ADDRESS, linked: [OTHER] }),
    /link that wallet/,
  );
  assert.equal(store.state.writes.length, 0, 'a refused save writes nothing');

  const saved = await saveProfileIn(store, {
    profileId: '@alice', primaryAddress: ADDRESS, displayName: ' Alice ', bio: ' hi ', status: ' ready ',
    linked: [ADDRESS],
  });
  assert.deepEqual(saved, fullProfile({
    primaryAddress: ADDRESS, displayName: 'Alice', bio: 'hi', status: 'ready',
  }));
  assert.deepEqual(store.state.writes, [fullProfile({
    primaryAddress: ADDRESS, displayName: 'Alice', bio: 'hi', status: 'ready',
  })]);

  // A save that also changes the ID claims the new one and releases the old one.
  const renamed = await saveProfileIn(store,
    { profileId: '@alice-b', primaryAddress: '', linked: [ADDRESS] });
  assert.deepEqual(renamed, fullProfile({ profileId: '@alice-b' }));
  assert.deepEqual(store.state.claims, { '@alice-b': UID });
  assert.deepEqual(store.state.releases, ['@alice']);
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
  // Shape: five optional-fields-on-profile, one on the claim.
  assert.match(RULES,
    /hasOnly\(\[\s*'profileId', 'primaryAddress', 'displayName', 'bio', 'status', 'visibility'\s*\]\)/);
  assert.match(RULES, /hasOnly\(\['uid'\]\)/);
  // Text is checked only when present, and the maxima match lib/profile.js.
  assert.match(RULES, /isProfileText\(request\.resource\.data\.displayName, 50\)/);
  assert.match(RULES, /isProfileText\(request\.resource\.data\.bio, 160\)/);
  assert.match(RULES, /isProfileText\(request\.resource\.data\.status, 80\)/);
  assert.match(RULES, /resource\.data\.get\('visibility', 'signed-in'\)/);
  assert.match(RULES, /request\.resource\.data\.visibility in \['signed-in', 'contacts', 'private'\]/);
  // A profile's ID must be a claim held by this same account, and the primary
  // address must be a wallet this account already linked.
  assert.match(RULES, /documents\/profileIds\/\$\(request\.resource\.data\.profileId\)/);
  assert.match(RULES, /documents\/walletLinks\/\$\(owner\)\/addresses\/\$\(address\)/);
  assert.match(RULES, /isLinkedAddress\(uid, request\.resource\.data\.primaryAddress\)/);
  // A handle is meant to be shared: one profile document may be read by any
  // signed-in account (that is what turns @id → wallet address), while the
  // collection itself still cannot be listed.
  assert.match(RULES, /match \/profiles\/\{uid\}[\s\S]*?allow get: if request\.auth != null;/);
  assert.match(RULES, /match \/profiles\/\{uid\}[\s\S]*?allow list: if false/);
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
