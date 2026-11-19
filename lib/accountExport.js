// Personal data export, scoped to what this browser can read without an Admin
// SDK: the owner's public profile, contact graph, friend requests and block
// list. Chat transcripts and sign-in/session records are deliberately not in
// this file — transcripts are encrypted locally and Auth data needs a server.
//
// The export contains uids and public wallet addresses because those are the
// contact graph; it must never contain an email, token, seed, password or key.
import { createFirestoreContactsStore } from './contacts.js';
import { loadFirestore, loadGoogleAuth } from './firebaseAuth.js';
import {
  createFirestoreProfileStore, normalizeProfile, readProfileFrom,
} from './profile.js';

export const ACCOUNT_EXPORT_FORMAT = 'nsat-account-export';
export const ACCOUNT_EXPORT_VERSION = 1;

const REQUEST_STATES = new Set(['pending', 'accepted', 'rejected']);

const sortedKeys = (value) => Object.keys(value || {}).sort();

const requestStates = (value) => Object.fromEntries(
  Object.entries(value || {})
    .filter(([, state]) => REQUEST_STATES.has(state))
    .sort(([left], [right]) => left.localeCompare(right)),
);

function exportStamp(value) {
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return new Date().toISOString();
}

/**
 * Pure shape of the download. Kept separate from Firestore so the redaction and
 * ordering can be tested without an account.
 */
export function buildAccountExport({
  profile = null,
  people = {},
  incoming = {},
  outgoing = {},
  blocked = {},
  exportedAt,
} = {}) {
  const own = normalizeProfile(profile);
  const stamp = exportStamp(exportedAt);
  return {
    format: ACCOUNT_EXPORT_FORMAT,
    version: ACCOUNT_EXPORT_VERSION,
    exportedAt: stamp,
    profile: own ? {
      profileId: own.profileId,
      primaryAddress: own.primaryAddress,
      displayName: own.displayName,
      bio: own.bio,
      status: own.status,
    } : null,
    contacts: sortedKeys(people),
    requests: {
      incoming: requestStates(incoming),
      outgoing: requestStates(outgoing),
    },
    blocked: sortedKeys(blocked),
  };
}

export function serializeAccountExport(data) {
  return JSON.stringify(buildAccountExport(data), null, 2);
}

export function accountExportFileName(exportedAt) {
  return `nsat-account-export-${exportStamp(exportedAt).slice(0, 10)}.json`;
}

/** Read what the signed-in account may read, then let the caller serialize it. */
export async function readAccountDataForExport() {
  const { auth } = await loadGoogleAuth();
  const user = auth.currentUser;
  if (!user?.uid) throw new Error('sign in to export account data');
  const { sdk, db } = await loadFirestore();
  const clientSdk = { ...sdk, db };
  const profileStore = createFirestoreProfileStore(user.uid, {
    emailVerified: user.emailVerified,
    sdk: clientSdk,
  });
  const contactsStore = createFirestoreContactsStore(user.uid, {
    emailVerified: user.emailVerified,
    sdk: clientSdk,
  });
  const [profile, graph] = await Promise.all([
    readProfileFrom(profileStore),
    contactsStore.snapshot(),
  ]);
  return { profile, ...graph };
}

/**
 * Build and hand a JSON file to the browser. Downloading is a user gesture; no
 * data leaves the device except as the file the person chose to save.
 */
export async function downloadAccountExport() {
  const data = await readAccountDataForExport();
  const json = serializeAccountExport(data);
  const exportedAt = JSON.parse(json).exportedAt;
  const filename = accountExportFileName(exportedAt);

  if (typeof document === 'undefined' || typeof URL === 'undefined'
    || typeof URL.createObjectURL !== 'function') {
    return { filename, json };
  }

  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return { filename, json };
}
