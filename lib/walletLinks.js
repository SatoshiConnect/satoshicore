// Optional link between a website account and ONE public wallet address.
//
// What this buys: after signing in with Google on a new device, the wallet can
// show that address's balance and receive address without a key on the device.
// What it deliberately does NOT do: it cannot sign, cannot spend, and is not a
// backup. A public address proves nothing about ownership — anyone who knows it
// can watch it — so this document is a convenience pointer, never an
// authentication factor for money. Sending still requires the encrypted
// keystore + password on the device doing the signing.
//
// One person usually holds several wallets, so each linked wallet is its own
// document at walletLinks/{uid}/addresses/{address}, holding exactly
// { address: "G…" }. No document ever contains a wallet name, balance, history,
// seed, password, keystore blob or signature; firestore.rules rejects any other
// field and any value that is not a 56-character G… account id, and requires the
// document id to match the address it holds.
import { getFirebaseWebConfig, loadFirestore, loadGoogleAuth } from './firebaseAuth.js';
import { withTimeout } from './withTimeout.js';

export const LINK_FLAG = 'nsat-address-link';
export const LINKS_COLLECTION = 'walletLinks';
export const ADDRESSES_SUBCOLLECTION = 'addresses';
// A bound, not a rule: the database cannot count a collection, so the client
// refuses a eleventh wallet and says why instead of growing without limit.
export const MAX_LINKED_ADDRESSES = 10;
// strkey account id: version byte 6<<3 = 48 ('G') + 32 bytes base32.
export const ACCOUNT_RE = /^G[A-Z2-7]{55}$/;

export function normalizeAddress(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return ACCOUNT_RE.test(text) ? text : null;
}

// The document write is built in one place so a caller cannot widen it: this
// object is the complete payload that leaves the device.
export function addressDocument(address) {
  const value = normalizeAddress(address);
  if (!value) throw new Error('wallet address must be a 56-character G… account id');
  return { address: value };
}

/** Canonical, de-duplicated addresses; anything unreadable is dropped. */
export function normalizeAddresses(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const value = normalizeAddress(item);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= MAX_LINKED_ADDRESSES) break;
  }
  return out;
}

// Which account on this browser asked for the link. A different signed-in
// account must not inherit the local choice.
export function linkEnabledFor(uid) {
  if (!uid || typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(LINK_FLAG) === uid;
  } catch {
    return false;
  }
}

export function setLinkFlag(uid, enabled) {
  if (typeof localStorage === 'undefined') return;
  try {
    if (enabled && uid) localStorage.setItem(LINK_FLAG, uid);
    else localStorage.removeItem(LINK_FLAG);
  } catch {
    // Storage blocked: the link simply stays device-only.
  }
}

// ---------------- why a link could not be saved --------------
// A Firestore write that never settles has one usual cause: the Cloud Firestore
// API is off for the project, so Google refuses every request and the SDK keeps
// retrying instead of failing. The UI then only sees a deadline, which says
// nothing the user can act on. This probe asks the same API a question that
// fails fast and turns the answer into an explanation.
const API_BASE = 'https://firestore.googleapis.com/v1/projects';
const apiEnabledUrl = (projectId) => `https://console.cloud.google.com/apis/library/firestore.googleapis.com${projectId ? `?project=${projectId}` : ''}`;
const consoleUrl = (projectId, path) => `https://console.firebase.google.com/project/${projectId || '_'}/${path}`;

/** Ask the Firestore API directly why it refused, without needing the SDK. */
export async function diagnoseFirestoreProblem({ doFetch = globalThis.fetch, config = getFirebaseWebConfig() } = {}) {
  const { projectId, apiKey } = config || {};
  if (!projectId || !apiKey) return { code: '' };
  try {
    const response = await doFetch(
      `${API_BASE}/${projectId}/databases/(default)/documents/walletLinks?key=${encodeURIComponent(apiKey)}`,
      { method: 'GET' },
    );
    const body = await response.json().catch(() => ({}));
    const message = String(body?.error?.message || '');
    if (response.status === 403) {
      if (/has not been used|is disabled/i.test(message)) return { code: 'FIRESTORE_API_DISABLED' };
      if (/permission|insufficient/i.test(message)) return { code: 'FIRESTORE_REFUSED' };
    }
    if (response.status === 404 && /database/i.test(message)) return { code: 'FIRESTORE_NO_DATABASE' };
    // A 200 (or a plain rules denial) means the API answers, so the failure was
    // something else and the caller keeps its own message.
    return { code: '', status: response.status };
  } catch {
    return { code: '' };
  }
}

/**
 * Which explanation fits a failed link or unlink.
 *
 * The SDK's own error is the authority: `permission-denied` means the database
 * answered and the rules refused, which is a different situation from a request
 * that never reached it. The anonymous probe below only ever sees "permission
 * denied" once the rules are owner-only, so trusting it first would report a
 * rules denial for an unrelated timeout — the exact misdiagnosis this replaces.
 * The probe still decides the two cases the SDK cannot name: a disabled API and
 * a database that was never created.
 */
export function classifyLinkFailure(error, probeCode = '') {
  const code = String(error?.code || '');
  const message = String(error?.message || '');
  if (code === 'permission-denied') return 'FIRESTORE_REFUSED';
  if (code === 'not-found') return 'FIRESTORE_NO_DATABASE';
  if (code === 'unavailable' || code === 'deadline-exceeded') return 'NETWORK';
  const timedOut = /did not complete|did not answer/.test(message);
  if (!timedOut) {
    // An unclassified SDK error still benefits from a definite API answer, so a
    // disabled API or a missing database wins over "something went wrong".
    return probeCode === 'FIRESTORE_API_DISABLED' || probeCode === 'FIRESTORE_NO_DATABASE'
      ? probeCode
      : '';
  }
  // A deadline says nothing about why: the write may even land later. Only a
  // definite API answer upgrades it, and a bare "permission denied" from the
  // probe never does.
  return probeCode === 'FIRESTORE_API_DISABLED' || probeCode === 'FIRESTORE_NO_DATABASE'
    ? probeCode
    : '';
}

/** The popup text for a failed link or unlink, including the page that fixes it. */
export function describeLinkFailure(code, { action = 'link', projectId = '' } = {}) {
  const verb = action === 'unlink' ? 'remove that link' : 'save this address';
  switch (code) {
    case 'FIRESTORE_API_DISABLED':
      return {
        title: 'Cloud Firestore is turned off',
        message: `Google refused the write, so the site could not ${verb}. The database is not enabled for this project yet, and the change never left the browser.`,
        fix: { label: 'Enable Cloud Firestore', url: apiEnabledUrl(projectId) },
        tone: 'err',
      };
    case 'FIRESTORE_NO_DATABASE':
      return {
        title: 'The site database does not exist yet',
        message: `The project has no Firestore database, so the site could not ${verb}. Create it once and the same button works.`,
        fix: { label: 'Create the database', url: consoleUrl(projectId, 'firestore') },
        tone: 'err',
      };
    case 'FIRESTORE_REFUSED':
      return {
        title: 'The database refused this write',
        message: `The security rules rejected the request, so the site could not ${verb}. The rules must allow this signed-in account to write its own walletLinks documents and nothing more.`,
        fix: { label: 'Check the rules', url: consoleUrl(projectId, 'firestore/rules') },
        tone: 'err',
      };
    case 'NETWORK':
      return {
        title: 'The site database could not be reached',
        message: `The browser could not reach the database, so the site could not ${verb}. Nothing was written. Check the connection and try again.`,
        tone: 'warn',
      };
    default:
      return {
        title: 'The address was not confirmed as saved',
        message: 'The database did not answer in time. Reload to check before relying on it; if the address appears, it is linked.',
        tone: 'warn',
      };
  }
}

// ---------------- store interface (testable without Firebase) ----------------
// A store is {
//   list(), add(address), remove(address), removeAll()
// }. Tests supply a stub; Firestore supplies the real one below.
export async function readLinksFrom(store) {
  return normalizeAddresses(await withTimeout(store.list(), 'the site database did not answer'));
}

export async function addLinkTo(store, address) {
  const saved = addressDocument(address);
  await withTimeout(store.add(saved.address), 'saving the address did not complete');
  return saved.address;
}

export async function removeLinkFrom(store, address) {
  const value = normalizeAddress(address);
  if (!value) throw new Error('wallet address must be a 56-character G… account id');
  await withTimeout(store.remove(value), 'removing the address did not complete');
}

export async function clearLinksFrom(store) {
  await withTimeout(store.removeAll(), 'removing the addresses did not complete');
}

// One document per wallet, not one per account: a person can hold several
// wallets, and each document is a single public address whose id and field must
// agree. That is what lets the rules prove the shape without looping over a
// list, and it keeps every document identical in what it can contain.
export function createFirestoreLinkStore(uid, sdk) {
  if (!uid) throw new Error('a signed-in account is required to link an address');
  const links = sdk.collection(sdk.db, LINKS_COLLECTION, uid, ADDRESSES_SUBCOLLECTION);
  // The single-address document written before this supported more than one
  // wallet. It is read as one more entry and deleted the first time its address
  // is unlinked, so an older account keeps working without a migration step.
  const legacyRef = sdk.doc(sdk.db, LINKS_COLLECTION, uid);
  const addressRef = (address) => sdk.doc(sdk.db, LINKS_COLLECTION, uid, ADDRESSES_SUBCOLLECTION, address);
  return {
    list: async () => {
      const [snapshot, legacy] = await Promise.all([sdk.getDocs(links), sdk.getDoc(legacyRef)]);
      const saved = snapshot.docs.map((entry) => entry.data()?.address).filter(Boolean);
      const old = legacy.exists() ? legacy.data()?.address : '';
      return normalizeAddresses([...saved, ...(old ? [old] : [])]);
    },
    add: async (address) => {
      await sdk.setDoc(addressRef(address), addressDocument(address));
    },
    remove: async (address) => {
      await sdk.deleteDoc(addressRef(address));
      const legacy = await sdk.getDoc(legacyRef);
      if (legacy.exists() && normalizeAddress(legacy.data()?.address) === address) {
        await sdk.deleteDoc(legacyRef);
      }
    },
    removeAll: async () => {
      const snapshot = await sdk.getDocs(links);
      await Promise.all(snapshot.docs.map((entry) => sdk.deleteDoc(entry.ref)));
      await sdk.deleteDoc(legacyRef);
    },
  };
}

async function storeForUid(uid) {
  if (!uid) throw new Error('a signed-in account is required to link an address');
  const { sdk, db } = await loadFirestore();
  return createFirestoreLinkStore(uid, { ...sdk, db });
}

async function signedInUid() {
  const { auth } = await loadGoogleAuth();
  return auth.currentUser?.uid || '';
}

// ---------------- user-facing operations ----------------
// Linking is an explicit, per-account action in Settings. It records which
// account chose to link on this browser.
export async function addLinkedAddressForUser(uid, address) {
  const value = normalizeAddress(address);
  if (!value) throw new Error('wallet address must be a 56-character G… account id');
  const store = await storeForUid(uid);
  const existing = await readLinksFrom(store);
  // Linking the same wallet twice is a no-op, not a second document.
  if (existing.includes(value)) {
    setLinkFlag(uid, true);
    return existing;
  }
  if (existing.length >= MAX_LINKED_ADDRESSES) {
    throw Object.assign(
      new Error(`this account already links ${MAX_LINKED_ADDRESSES} wallets`),
      { code: 'LINK_LIMIT' },
    );
  }
  await addLinkTo(store, value);
  setLinkFlag(uid, true);
  return [...existing, value];
}

/** Remove one wallet; the others stay linked. Returns what is left. */
export async function removeLinkedAddressForUser(uid, address, { store: injected = null } = {}) {
  const value = normalizeAddress(address);
  if (!value) throw new Error('wallet address must be a 56-character G… account id');
  const store = injected || await storeForUid(uid);
  // The list is read once, before the delete, and the result is computed from
  // it. Reading again afterwards would report a failure for a removal that had
  // already happened, and would cost a second round trip for nothing.
  const existing = await readLinksFrom(store);
  await removeLinkFrom(store, value);
  const remaining = existing.filter((item) => item !== value);
  if (!remaining.length) setLinkFlag(uid, false);
  return remaining;
}

// Removing every link deletes the stored entries instead of leaving stale
// addresses on the account; the local flag is cleared first so a failed delete
// cannot resurrect uploads.
export async function unlinkAddressForUser(uid) {
  setLinkFlag(uid, false);
  await clearLinksFrom(await storeForUid(uid));
}

// Read path for a device that has no key: an account's linked wallets are shown
// after sign-in so balance and receive work. Reading is not gated on this
// browser's link flag — the flag only governs what this device uploads.
export async function pullLinkedAddressesForUser(uid) {
  if (!uid) return [];
  try {
    return await readLinksFrom(await storeForUid(uid));
  } catch {
    // No database configured yet, or offline: the wallet stays as it was.
    return [];
  }
}

// Convenience for callers that only have the event: returns every address of
// the currently signed-in account, or an empty list.
export async function linkedAddressesForCurrentUser() {
  const uid = await signedInUid();
  return uid ? pullLinkedAddressesForUser(uid) : [];
}
