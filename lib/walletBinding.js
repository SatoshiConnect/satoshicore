// Which website account a device's wallet was bound to.
//
// This is a label, not a key: it records the email that created/backed up the
// wallet so Settings can say "bound to …" and so a second account cannot
// silently adopt the same local wallet. It holds no seed, password, keystore
// blob or token, and deleting it costs nothing but the label.
const KEY = 'scw-web-wallet-owner-v1';

function read() {
  if (typeof localStorage === 'undefined') return {};
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function write(map) {
  if (typeof localStorage === 'undefined') return false;
  try {
    if (Object.keys(map).length) localStorage.setItem(KEY, JSON.stringify(map));
    else localStorage.removeItem(KEY);
    return true;
  } catch {
    return false;
  }
}

export function normalizeAccount(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** Email bound to this wallet name, or '' when unbound. */
export function ownerOf(name) {
  if (!name) return '';
  const map = read();
  return typeof map[name] === 'string' ? map[name] : '';
}

/** All bindings as { walletName: email }. */
export function allOwners() {
  return read();
}

export function bindOwner(name, email) {
  const account = normalizeAccount(email);
  if (!name || !account) return false;
  const map = read();
  map[name] = account;
  return write(map);
}

export function unbindOwner(name) {
  const map = read();
  if (!(name in map)) return true;
  delete map[name];
  return write(map);
}

/**
 * Wallets this browser may list for the session in progress.
 *
 * A signed-in account sees its own wallets plus unbound ones (created before
 * any account was used). With no account, a build that offers Google sign-in
 * lists only unbound wallets: a shared browser must not hand the next person
 * another account's wallet names just because they chose the standalone mode.
 * Builds without Google sign-in have no accounts to protect, so they list all.
 */
export function walletsForAccount(wallets, email, { signInRequired = false } = {}) {
  const list = Array.isArray(wallets) ? wallets : [];
  const account = normalizeAccount(email);
  if (!account) {
    return signInRequired ? list.filter((wallet) => !normalizeAccount(ownerOf(wallet.name))) : list;
  }
  return list.filter((wallet) => {
    const owner = normalizeAccount(ownerOf(wallet.name));
    return !owner || owner === account;
  });
}

/**
 * A readable wallet name derived from the signed-in email, so a new account is
 * one password away from a usable wallet instead of a form to fill in. Pure
 * and deterministic; the user can still edit the result.
 */
export function walletNameForAccount(email) {
  const account = normalizeAccount(email);
  const local = account.split('@')[0] || '';
  const words = local.split(/[._-]+/).filter(Boolean).map((part) => part.replace(/\d+$/u, ''));
  const cleaned = words.filter(Boolean).join(' ').replace(/[^\p{L}\p{N} ]/gu, '').trim();
  if (!cleaned) return 'Personal wallet';
  const titled = cleaned.replace(/\b\p{L}/gu, (ch) => ch.toUpperCase());
  return titled.slice(0, 32).trim() || 'Personal wallet';
}
