// Optional cross-device sync of the SITE THEME only.
//
// Scope is deliberately one value: light or dark. The synced document lives at
// websitePreferences/{uid} in Cloud Firestore and contains exactly { theme }.
// It never receives a wallet name, public address, balance, history, seed,
// password, keystore blob, key or signature — see firestore.rules, which
// rejects any document with another field or a value outside those two words.
//
// Sync is opt-in and off by default: signing in with Google alone uploads
// nothing. The user turns it on in Wallet → Settings → Website account, and
// the local flag records which account opted in so another account signed in
// on the same browser never inherits the setting.
import { loadFirestore, loadGoogleAuth } from './firebaseAuth.js';

export const THEME_KEY = 'nsat-theme';
export const THEME_SYNC_FLAG = 'nsat-theme-sync';
export const PREFERENCES_COLLECTION = 'websitePreferences';

const THEMES = ['light', 'dark'];

export function normalizeTheme(value) {
  return THEMES.includes(value) ? value : null;
}

// The document write is built in one place so a caller cannot widen it: this
// object is the complete payload that leaves the device.
export function preferenceDocument(theme) {
  const value = normalizeTheme(theme);
  if (!value) throw new Error('theme must be light or dark');
  return { theme: value };
}

export function currentTheme() {
  if (typeof document === 'undefined') return null;
  return normalizeTheme(document.documentElement?.dataset?.theme);
}

// Applying a remote choice is the same operation the toggle performs, so a
// synced theme survives a reload through the existing localStorage key.
export function applyThemeLocally(theme) {
  const value = normalizeTheme(theme);
  if (!value || typeof document === 'undefined') return null;
  document.documentElement.dataset.theme = value;
  try {
    localStorage.setItem(THEME_KEY, value);
  } catch {
    // Private mode / storage blocked: the theme still applies to this page.
  }
  return value;
}

export function syncEnabledFor(uid) {
  if (!uid || typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(THEME_SYNC_FLAG) === uid;
  } catch {
    return false;
  }
}

export function setSyncFlag(uid, enabled) {
  if (typeof localStorage === 'undefined') return;
  try {
    if (enabled && uid) localStorage.setItem(THEME_SYNC_FLAG, uid);
    else localStorage.removeItem(THEME_SYNC_FLAG);
  } catch {
    // Storage blocked: sync simply stays off for this session.
  }
}

// ---------------- store interface (testable without Firebase) ----------------
// A store is { read(), write(data), remove() }. Firestore supplies the real
// one below; tests supply a stub.
export async function readThemeFrom(store) {
  const data = await store.read();
  return data ? normalizeTheme(data.theme) : null;
}

export async function writeThemeTo(store, theme) {
  const doc = preferenceDocument(theme);
  await store.write(doc);
  return doc.theme;
}

export async function clearThemeFrom(store) {
  await store.remove();
}

export function createFirestoreThemeStore(uid, sdk) {
  if (!uid) throw new Error('a signed-in account is required for theme sync');
  const ref = sdk.doc(sdk.db, PREFERENCES_COLLECTION, uid);
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
  if (!uid) throw new Error('a signed-in account is required for theme sync');
  const { sdk, db } = await loadFirestore();
  return createFirestoreThemeStore(uid, { ...sdk, db });
}

async function signedInUid() {
  const { auth } = await loadGoogleAuth();
  return auth.currentUser?.uid || '';
}

// ---------------- user-facing operations ----------------
// Used after the theme toggle flips: only a browser whose opted-in account is
// signed in writes anything.
export async function pushThemeForCurrentUser(theme) {
  const value = normalizeTheme(theme);
  if (!value) return false;
  const uid = await signedInUid();
  if (!syncEnabledFor(uid)) return false;
  await writeThemeTo(await storeForUid(uid), value);
  return true;
}

// On sign-in / page load, an opted-in account's stored choice wins: the theme
// is applied to this device so every device opens the same way.
export async function pullThemeForUser(uid) {
  if (!syncEnabledFor(uid)) return null;
  const remote = await readThemeFrom(await storeForUid(uid));
  if (!remote) return null;
  applyThemeLocally(remote);
  return remote;
}

// Turning sync on adopts an existing choice instead of overwriting it; with no
// stored choice yet, this device's current theme is the first write.
export async function enableThemeSync(uid, localTheme) {
  const store = await storeForUid(uid);
  const remote = await readThemeFrom(store);
  if (remote) {
    applyThemeLocally(remote);
    setSyncFlag(uid, true);
    return { theme: remote, source: 'account' };
  }
  const saved = await writeThemeTo(store, localTheme || currentTheme());
  setSyncFlag(uid, true);
  return { theme: saved, source: 'device' };
}

// Turning sync off deletes the stored entry rather than leaving a stale theme
// behind. The flag is cleared first, so a failed delete cannot resurrect
// uploads on the next toggle.
export async function disableThemeSync(uid) {
  setSyncFlag(uid, false);
  await clearThemeFrom(await storeForUid(uid));
}
