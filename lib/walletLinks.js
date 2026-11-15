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
// The stored document is exactly { address: "G…" } at walletLinks/{uid}.
// It never contains a wallet name, balance, history, seed, password, keystore
// blob or signature; firestore.rules rejects any other field and any value that
// is not a 56-character G… account id.
import { getFirebaseWebConfig, loadFirestore, loadGoogleAuth } from './firebaseAuth.js';
import { withTimeout } from './withTimeout.js';

export const LINK_FLAG = 'nsat-address-link';
export const LINKS_COLLECTION = 'walletLinks';
// strkey account id: version byte 6<<3 = 48 ('G') + 32 bytes base32.
export const ACCOUNT_RE = /^G[A-Z2-7]{55}$/;

export function normalizeAddress(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return ACCOUNT_RE.test(text) ? text : null;
}

// The document write is built in one place so a caller cannot widen it: this
// object is the complete payload that leaves the device.
export function linkDocument(address) {
  const value = normalizeAddress(address);
  if (!value) throw new Error('wallet address must be a 56-character G… account id');
  return { address: value };
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

// ---------------- store interface (testable without Firebase) ----------------
// A store is { read(), write(data), remove() }. Firestore supplies the real one
// below; tests supply a stub.
export async function readLinkFrom(store) {
  const data = await withTimeout(store.read(), 'the site database did not answer');
  if (!data || typeof data !== 'object') return null;
  // Fail closed on anything wider than the one documented field, so a
  // misconfigured database can never feed extra wallet data into the UI.
  if (Object.keys(data).length !== 1) return null;
  return normalizeAddress(data.address);
}

export async function writeLinkTo(store, address) {
  const doc = linkDocument(address);
  await withTimeout(store.write(doc), 'saving the address did not complete');
  return doc.address;
}

export async function clearLinkFrom(store) {
  await withTimeout(store.remove(), 'removing the address did not complete');
}

export function createFirestoreLinkStore(uid, sdk) {
  if (!uid) throw new Error('a signed-in account is required to link an address');
  const ref = sdk.doc(sdk.db, LINKS_COLLECTION, uid);
  return {
    read: async () => {
      const snapshot = await sdk.getDoc(ref);
      return snapshot.exists() ? snapshot.data() : null;
    },
    write: async (data) => {
      await sdk.setDoc(ref, data);
    },
    remove: async () => {
      await sdk.deleteDoc(ref);
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

/** The popup text for a failed link or unlink, including the page that fixes it. */
export function describeLinkFailure(code, { action = 'link', projectId = '' } = {}) {
  const verb = action === 'unlink' ? 'remove the linked address' : 'save this address';
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
        message: `The security rules rejected the request, so the site could not ${verb}. The rules must allow this signed-in account to write its own walletLinks document and nothing more.`,
        fix: { label: 'Check the rules', url: consoleUrl(projectId, 'firestore/rules') },
        tone: 'err',
      };
    default:
      return {
        title: 'The address was not confirmed as saved',
        message: 'The database did not answer in time. Reload to check before relying on it; if the address appears, it is linked.',
        tone: 'warn',
      };
  }
}

// ---------------- user-facing operations ----------------
// Linking is an explicit, per-account action in Settings. It records which
// account chose to link on this browser.
export async function linkAddressForUser(uid, address) {
  const store = await storeForUid(uid);
  const saved = await writeLinkTo(store, address);
  setLinkFlag(uid, true);
  return saved;
}

// Removing the link deletes the stored entry instead of leaving a stale address
// on the account; the local flag is cleared first so a failed delete cannot
// resurrect uploads.
export async function unlinkAddressForUser(uid) {
  setLinkFlag(uid, false);
  await clearLinkFrom(await storeForUid(uid));
}

// Read path for a device that has no key: an account's linked address is shown
// after sign-in so balance and receive work. Reading is not gated on this
// browser's link flag — the flag only governs what this device uploads.
export async function pullLinkedAddressForUser(uid) {
  if (!uid) return null;
  try {
    return await readLinkFrom(await storeForUid(uid));
  } catch {
    // No database configured yet, or offline: the wallet stays as it was.
    return null;
  }
}

// Convenience for callers that only have the event: returns the address of the
// currently signed-in account, or null.
export async function linkedAddressForCurrentUser() {
  const uid = await signedInUid();
  return uid ? pullLinkedAddressForUser(uid) : null;
}
