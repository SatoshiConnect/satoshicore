// Basic website profile: a self-chosen public ID, a verified email, and one
// chosen primary wallet.
//
// What this is: `profiles/{uid}` holds exactly two fields — the profile ID the
// person chose and the public address they chose as primary. `profileIds/{id}`
// holds the claim that makes an ID unique.
//
// What this is NOT: an authentication factor for money. The profile proves
// nothing about a wallet and cannot sign; every send path still needs the local
// encrypted keystore and its password. A profile ID is a handle, not a key.
//
// Email: the address itself is never copied into Firestore. Verification is the
// identity provider's own claim (`request.auth.token.email_verified`), which
// firestore.rules requires before any profile write — so an unverified account
// cannot create a profile even by calling the API directly, and this module
// stores no email at all.
import { getFirebaseWebConfig, loadFirestore, loadGoogleAuth } from './firebaseAuth.js';
import { withTimeout } from './withTimeout.js';

export const PROFILES_COLLECTION = 'profiles';
export const PROFILE_IDS_COLLECTION = 'profileIds';

// `@` is part of the stored ID, followed by 3–20 lowercase letters, digits,
// `-` or `_`. Lowercase only so `@Alice` and `@alice` cannot be two people.
export const PROFILE_ID_RE = /^@[a-z0-9][a-z0-9_-]{2,19}$/;
export const PROFILE_ID_MIN = 3;
export const PROFILE_ID_MAX = 20;
// strkey account id, same shape every other link uses.
export const ACCOUNT_RE = /^G[A-Z2-7]{55}$/;

/** Trimmed, lowercased ID if it is usable, otherwise null. */
// `@` is required, not implied: the stored ID, its claim document and the
// displayed label are the same string, so nothing has to be migrated or
// re-interpreted between reading and writing.
export function normalizeProfileId(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text.startsWith('@')) return null;
  const normalized = `@${text.slice(1).toLowerCase()}`;
  return PROFILE_ID_RE.test(normalized) ? normalized : null;
}

/** Why an ID was rejected, in words a person can act on. */
export function describeProfileIdProblem(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return 'Choose a profile ID starting with @.';
  if (!text.startsWith('@')) return 'A profile ID must start with @.';
  const name = text.slice(1);
  if (/[A-Z]/.test(name)) return 'Use lowercase letters after @ — IDs are not case sensitive.';
  if (name.length < PROFILE_ID_MIN) return `Use at least ${PROFILE_ID_MIN} characters after @.`;
  if (name.length > PROFILE_ID_MAX) return `Use at most ${PROFILE_ID_MAX} characters after @.`;
  if (!PROFILE_ID_RE.test(`@${name.toLowerCase()}`)) {
    return 'Start with @, then use lowercase letters, digits, “-” and “_”.';
  }
  return '';
}

export function normalizeAddress(value) {
  const text = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return ACCOUNT_RE.test(text) ? text : null;
}

/**
 * The complete profile document. Two fields, always both present, so rules can
 * check the shape without looping and nothing else can be smuggled in.
 */
export function profileDocument({ profileId, primaryAddress = '' } = {}) {
  const id = normalizeProfileId(profileId);
  if (!id) throw new Error('profile id must start with @ and use 3–20 lowercase letters, digits, "-" or "_"');
  const address = primaryAddress ? normalizeAddress(primaryAddress) : '';
  if (primaryAddress && !address) {
    throw new Error('primary wallet must be a 56-character G… account id');
  }
  return { profileId: id, primaryAddress: address };
}

/** Whatever the database returned, only a well-formed profile survives. */
export function normalizeProfile(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = normalizeProfileId(raw.profileId);
  if (!id) return null;
  const address = raw.primaryAddress ? normalizeAddress(raw.primaryAddress) : '';
  return { profileId: id, primaryAddress: address || '' };
}

export function profileLabel(profileId) {
  return normalizeProfileId(profileId) || '';
}

// ---------------- why a write was refused ----------------
// A static site has no server that can ask on the user's behalf, so the only
// honest thing to do with a refusal is name the likely cause and the page that
// fixes it.
const firestoreConsole = (projectId, path) =>
  `https://console.firebase.google.com/project/${projectId || '_'}/${path}`;

export function describeProfileFailure(error, { action = 'save', projectId = '' } = {}) {
  const code = String(error?.code || '');
  const message = String(error?.message || '');
  if (code === 'ID_TAKEN') {
    return {
      title: 'That profile ID is taken',
      message: 'Someone claimed this ID first. IDs are unique across the site, so pick another.',
      tone: 'warn',
    };
  }
  if (code === 'permission-denied') {
    return {
      title: 'The database refused this change',
      message: `The security rules rejected the write, so the profile was not ${action === 'delete' ? 'deleted' : 'saved'}. Profile writes need a signed-in account whose email is verified, and an ID claimed by that same account.`,
      fix: { label: 'Check the rules', url: firestoreConsole(projectId, 'firestore/rules') },
      tone: 'err',
    };
  }
  if (code === 'unavailable' || code === 'deadline-exceeded') {
    return {
      title: 'The site database could not be reached',
      message: 'Nothing was written. Check the connection and try again.',
      tone: 'warn',
    };
  }
  // A deadline is not the same answer as a refusal: the write may have landed
  // after the client stopped waiting, so it must not be called failed.
  return {
    title: 'The change was not confirmed',
    message: 'The database did not answer in time. Reload to check before relying on it.',
    tone: 'warn',
  };
}

// ---------------- store interface (testable without Firebase) ----------------
// A store is { read(), write(doc), remove(), claim(id), release(id), lookup(id) }.
export async function readProfileFrom(store) {
  return normalizeProfile(await withTimeout(store.read(), 'the site database did not answer'));
}

export async function writeProfileTo(store, profile) {
  const doc = profileDocument(profile);
  await withTimeout(store.write(doc), 'saving the profile did not complete');
  return doc;
}

export async function removeProfileFrom(store, profileId) {
  const id = normalizeProfileId(profileId);
  await withTimeout(store.remove(), 'deleting the profile did not complete');
  if (id) await withTimeout(store.release(id), 'releasing the profile id did not complete');
}

/**
 * Claim an ID and then write the profile that uses it.
 *
 * Order matters: the claim is what makes the ID unique, and the rules require a
 * profile's ID to be a claim held by the same account. If the profile write
 * fails after the claim, the claim is released again so a failed attempt does
 * not burn the ID.
 */
export async function claimProfileIdIn(store, profileId) {
  const id = normalizeProfileId(profileId);
  if (!id) throw new Error('profile id must start with @ and use 3–20 lowercase letters, digits, "-" or "_"');
  const holder = await withTimeout(store.lookup(id), 'checking the profile id did not complete');
  if (holder && holder !== store.uid) {
    throw Object.assign(new Error('that profile id is already claimed'), { code: 'ID_TAKEN' });
  }
  try {
    await withTimeout(store.claim(id), 'claiming the profile id did not complete');
  } catch (error) {
    // A concurrent claim loses here: the rules allow create only, so the second
    // writer is refused and the ID belongs to the first one.
    if (String(error?.code || '') === 'permission-denied') {
      throw Object.assign(new Error('that profile id is already claimed'), { code: 'ID_TAKEN' });
    }
    throw error;
  }
  return id;
}

export function createFirestoreProfileStore(uid, { emailVerified, sdk }) {
  if (!uid) throw new Error('a signed-in account is required for a profile');
  const profileRef = sdk.doc(sdk.db, PROFILES_COLLECTION, uid);
  const idRef = (id) => sdk.doc(sdk.db, PROFILE_IDS_COLLECTION, id);
  return {
    uid,
    // The verified-email requirement is enforced by firestore.rules; this flag
    // only lets the UI explain a refusal before the user hits it. It is never
    // sent to the database, so it cannot be spoofed into the document.
    emailVerified: Boolean(emailVerified),
    read: async () => {
      const snapshot = await sdk.getDoc(profileRef);
      return snapshot.exists() ? snapshot.data() : null;
    },
    write: async (doc) => {
      await sdk.setDoc(profileRef, doc);
    },
    remove: async () => {
      await sdk.deleteDoc(profileRef);
    },
    claim: async (id) => {
      await sdk.setDoc(idRef(id), { uid });
    },
    release: async (id) => {
      const snapshot = await sdk.getDoc(idRef(id));
      if (!snapshot.exists()) return;
      if (snapshot.data()?.uid !== uid) return;
      await sdk.deleteDoc(idRef(id));
    },
    lookup: async (id) => {
      const snapshot = await sdk.getDoc(idRef(id));
      return snapshot.exists() ? String(snapshot.data()?.uid || '') : '';
    },
  };
}

/**
 * Resolve a public `@id` to the wallet its profile points at.
 *
 * This is the one read that is not about the signed-in account: `profileIds/@id`
 * gives the owner's uid and `profiles/{uid}` gives the chosen primary address.
 * Both are documents a handle is meant to publish, and neither can move funds.
 * The rules allow a single-document get, never a list, so a handle is looked up
 * only by someone who already knows it.
 */
export async function resolveProfileHandle(value) {
  const id = normalizeProfileId(value);
  if (!id) throw new Error(describeProfileIdProblem(value) || 'invalid profile id');
  const { sdk, db } = await loadFirestore();
  const claim = await withTimeout(
    sdk.getDoc(sdk.doc(db, PROFILE_IDS_COLLECTION, id)),
    'looking up that profile did not complete',
  );
  if (!claim.exists()) {
    throw Object.assign(new Error(`there is no profile ${id}`), { code: 'PROFILE_NOT_FOUND' });
  }
  const uid = String(claim.data()?.uid || '');
  if (!uid) throw Object.assign(new Error(`there is no profile ${id}`), { code: 'PROFILE_NOT_FOUND' });
  const snapshot = await withTimeout(
    sdk.getDoc(sdk.doc(db, PROFILES_COLLECTION, uid)),
    'looking up that profile did not complete',
  );
  if (!snapshot.exists()) {
    throw Object.assign(new Error(`there is no profile ${id}`), { code: 'PROFILE_NOT_FOUND' });
  }
  const profile = normalizeProfile(snapshot.data());
  if (!profile) throw Object.assign(new Error(`there is no profile ${id}`), { code: 'PROFILE_NOT_FOUND' });
  // `uid` is what a contact request is keyed by; the handle and the address are
  // what the screen shows. Nothing here can sign or spend.
  return { uid, ...profile };
}

async function storeForSession() {
  const { auth } = await loadGoogleAuth();
  const user = auth.currentUser;
  if (!user?.uid) throw new Error('sign in to manage a profile');
  const { sdk, db } = await loadFirestore();
  return createFirestoreProfileStore(user.uid, {
    emailVerified: user.emailVerified, sdk: { ...sdk, db },
  });
}

// ---------------- user-facing operations ----------------
export async function readMyProfile() {
  return readProfileFrom(await storeForSession());
}

/**
 * Write a profile, claiming its ID first when the ID is new to this account.
 *
 * The old claim is released only after the new profile is saved, so a failure
 * in between never leaves the account holding a profile that points at an ID
 * somebody else could take, and never leaves two IDs claimed for one account.
 */
async function persistProfile(store, doc) {
  const existing = await readProfileFrom(store);
  const canonicalExistingId = existing?.profileId || '';
  const sameCanonicalId = canonicalExistingId === doc.profileId;
  if (sameCanonicalId) {
    // Same ID: there is nothing to claim or release, which is also what lets a
    // primary-wallet change work before the claim has ever been read.
    await writeProfileTo(store, doc);
    return doc;
  }
  await claimProfileIdIn(store, doc.profileId);
  try {
    await writeProfileTo(store, doc);
  } catch (error) {
    await withTimeout(store.release(doc.profileId), 'releasing the profile id did not complete').catch(() => {});
    throw error;
  }
  if (canonicalExistingId) {
    await withTimeout(store.release(canonicalExistingId), 'releasing the profile id did not complete').catch(() => {});
  }
  return doc;
}

/** Create (or replace) the profile: claims the ID first, then writes it. */
export async function createProfileForUser({ profileId, primaryAddress = '' }) {
  const store = await storeForSession();
  return persistProfile(store, profileDocument({ profileId, primaryAddress }));
}

/**
 * Change the ID of an existing profile, keeping its primary wallet.
 *
 * A typo is the usual reason, so this is a first-class action instead of
 * delete-and-recreate: the wallet choice survives, and the old ID is released
 * only once the new one is saved.
 */
export async function renameProfileIdIn(store, profileId) {
  const existing = await readProfileFrom(store);
  if (!existing) throw new Error('create a profile first');
  const id = normalizeProfileId(profileId);
  if (!id) throw new Error('profile id must start with @ and use 3–20 lowercase letters, digits, "-" or "_"');
  if (id === existing.profileId) return existing;
  return persistProfile(store, { profileId: id, primaryAddress: existing.primaryAddress });
}

export async function renameProfileIdForUser(profileId) {
  return renameProfileIdIn(await storeForSession(), profileId);
}

/**
 * Change the primary wallet. The address must already be linked to this account:
 * that is a rules check (`get()` on walletLinks), and the caller also passes the
 * linked list so the UI can refuse before writing.
 */
export async function saveProfileIn(store, { profileId, primaryAddress = '', linked = [] } = {}) {
  const doc = profileDocument({ profileId, primaryAddress });
  const value = doc.primaryAddress;
  if (value && !linked.includes(value)) {
    throw new Error('link that wallet to this account first');
  }
  return persistProfile(store, doc);
}

export async function saveMyProfile({ profileId, primaryAddress = '', linked = [] } = {}) {
  return saveProfileIn(await storeForSession(), { profileId, primaryAddress, linked });
}

export async function setPrimaryWalletForUser(address, { linked = [] } = {}) {
  const store = await storeForSession();
  const existing = await readProfileFrom(store);
  if (!existing) throw new Error('create a profile first');
  return saveProfileIn(store, {
    profileId: existing.profileId,
    primaryAddress: address,
    linked,
  });
}

export async function deleteProfileForUser() {
  const store = await storeForSession();
  const existing = await readProfileFrom(store);
  if (!existing) return null;
  await removeProfileFrom(store, existing.profileId);
  return existing;
}

/** Public lookup by ID: returns the claimed uid, or '' when free. */
export async function lookupProfileId(profileId) {
  const id = normalizeProfileId(profileId);
  if (!id) return '';
  const store = await storeForSession();
  return withTimeout(store.lookup(id), 'checking the profile id did not complete');
}

export function profileConsoleUrl(path = 'firestore/rules') {
  return firestoreConsole(getFirebaseWebConfig().projectId, path);
}
