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
