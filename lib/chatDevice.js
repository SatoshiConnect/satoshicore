// A stable, random name for this browser profile's chat device.
//
// It is not a key and it is not a fingerprint: the relay only uses it to keep
// one delivery per device, so acknowledging a message on the laptop does not
// erase the phone's copy. The wallet key still signs every request, and the
// device id is covered by that signature (nsc-chat|2|…).
export const DEVICE_KEY = 'scw-chat-device-v1';
export const DEVICE_RE = /^[A-Za-z0-9_-]{16,64}$/;

export function normalizeDeviceId(value) {
  const id = String(value || '').trim();
  return DEVICE_RE.test(id) ? id : '';
}

function randomId() {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === 'function') return webCrypto.randomUUID();
  if (typeof webCrypto?.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    webCrypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

/** Read or create this browser's device id; storage is optional for tests. */
export function getChatDeviceId(storage = undefined) {
  const store = storage
    || (typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage);
  try {
    const saved = normalizeDeviceId(store?.getItem(DEVICE_KEY));
    if (saved) return saved;
  } catch {
    // A blocked or private storage still gets an id for this session.
  }
  const id = randomId();
  try { store?.setItem(DEVICE_KEY, id); } catch { /* quota/private mode */ }
  return id;
}
