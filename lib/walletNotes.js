// This device's own notes about a wallet: whether its key was backed up
// (verified by re-reading what the user saved) and where a registration
// attempt stands. Addresses and short state words only — never key material,
// never a claim that the ledger confirmed anything (that comes from the chain
// query, see lib/walletStatus.js).
const KEY = 'scw-wallet-notes-v1';

function readAll(storage) {
  if (!storage) return {};
  try {
    const parsed = JSON.parse(storage.getItem(KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeAll(storage, map) {
  if (!storage) return false;
  try {
    if (Object.keys(map).length) storage.setItem(KEY, JSON.stringify(map));
    else storage.removeItem(KEY);
    return true;
  } catch {
    return false;
  }
}

const ownerOf = (address) => String(address || '').toUpperCase();

export function readWalletNote(address, storage = undefined) {
  const store = storage
    || (typeof localStorage === 'undefined' ? null : localStorage);
  return readAll(store)[ownerOf(address)] || {};
}

export function setBackupVerified(address, verified, storage = undefined) {
  const store = storage
    || (typeof localStorage === 'undefined' ? null : localStorage);
  const all = readAll(store);
  const owner = ownerOf(address);
  if (!owner) return false;
  all[owner] = { ...all[owner], backup: { verified: Boolean(verified), at: Date.now() } };
  return writeAll(store, all);
}

export function setRegistrationState(address, state, storage = undefined) {
  const store = storage
    || (typeof localStorage === 'undefined' ? null : localStorage);
  const all = readAll(store);
  const owner = ownerOf(address);
  if (!owner) return false;
  const allowed = state === 'pending' || state === 'failed' || state === 'done';
  all[owner] = {
    ...all[owner],
    registration: { state: allowed ? state : '', at: Date.now() },
  };
  return writeAll(store, all);
}
