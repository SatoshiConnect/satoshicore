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
import { loadFirestore, loadGoogleAuth } from './firebaseAuth.js';
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
