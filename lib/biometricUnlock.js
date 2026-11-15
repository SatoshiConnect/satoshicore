// Optional device-authenticator unlock for an existing local web keystore.
//
// This does NOT scan, read, or store a face or fingerprint. WebAuthn asks the
// platform authenticator to verify the user; depending on the device that may
// be Face ID, fingerprint, Windows Hello, a security key, or the device PIN.
// The wallet site receives only an assertion and a PRF output. It stores the
// assertion credential id plus an AES-GCM ciphertext in this browser's
// localStorage. The PRF output is never stored or sent to a server.
//
// This is a SECOND, optional local unlock path. The original password-encrypted
// keystore remains unchanged and the wallet password remains the recovery path
// if the authenticator is removed, unavailable, or unsupported. A copied
// keystore backup does not include this device-local biometric configuration.
//
// PRF outputs are supported by some but not all authenticators. We require a
// real 32-byte PRF result and a user-verified WebAuthn assertion; absent support
// fails closed without storing an unlock record.
import { decodeSeed, ed25519Keypair, encodeG, encodeSeed } from './nsatCodec.js';

const STORAGE_KEY = 'scw-web-biometric-v1';
const VERSION = 1;
const INFO = new TextEncoder().encode('SatoshiCore web wallet biometric unlock v1');
const CHALLENGE_BYTES = 32;
const SALT_BYTES = 32;
const KDF_SALT_BYTES = 16;
const IV_BYTES = 12;

const toBase64Url = (bytes) => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

const fromBase64Url = (value) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('malformed device unlock data');
  }
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

function loadRecords() {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (!value) return {};
    const parsed = JSON.parse(value);
    if (!parsed || parsed.v !== VERSION || !parsed.wallets
      || typeof parsed.wallets !== 'object' || Array.isArray(parsed.wallets)) return {};
    return parsed.wallets;
  } catch {
    return {};
  }
}

function saveRecords(wallets) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: VERSION, wallets }));
}

export function hasBiometricUnlock(name) {
  return typeof name === 'string' && Object.hasOwn(loadRecords(), name);
}

export function biometricWalletNames() {
  return Object.keys(loadRecords());
}

export function removeBiometricUnlock(name) {
  const wallets = loadRecords();
  if (!Object.hasOwn(wallets, name)) return false;
  delete wallets[name];
  if (Object.keys(wallets).length) saveRecords(wallets);
  else localStorage.removeItem(STORAGE_KEY);
  return true;
}

function assertBrowserSupport() {
  // Node's secure test runtime is allowed; in a real browser, WebAuthn is only
  // available in secure contexts (HTTPS, or localhost).
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    throw new Error('Device unlock requires a secure connection (HTTPS).');
  }
  if (!globalThis.navigator?.credentials?.create || !globalThis.navigator?.credentials?.get) {
    throw new Error('This browser does not provide device authentication. Use the wallet password.');
  }
  if (typeof globalThis.PublicKeyCredential === 'undefined') {
    throw new Error('This browser does not provide WebAuthn device authentication. Use the wallet password.');
  }
}

function relyingPartyId() {
  const host = globalThis.location?.hostname;
  if (!host || host.includes(':') || host.includes('/')) {
    throw new Error('Could not determine this site for device authentication.');
  }
  return host;
}

function credentialId(credential) {
  return toBase64Url(new Uint8Array(credential.rawId));
}

function validatedPrfOutput(credential) {
  const output = credential?.getClientExtensionResults?.()?.prf?.results?.first;
  if (!(output instanceof ArrayBuffer) && !ArrayBuffer.isView(output)) {
    throw new Error('This device does not support secure biometric unlock (passkey PRF). Use the wallet password.');
  }
  const bytes = output instanceof ArrayBuffer
    ? new Uint8Array(output)
    : new Uint8Array(output.buffer, output.byteOffset, output.byteLength);
  if (bytes.length !== 32) {
    throw new Error('The device returned an invalid unlock result. Use the wallet password.');
  }
  const copy = bytes.slice();
  bytes.fill(0);
  return copy;
}

function assertUserVerified(credential) {
  const data = credential?.response?.authenticatorData;
  if (!(data instanceof ArrayBuffer) || data.byteLength < 33) {
    throw new Error('The device did not verify you. Use the wallet password.');
  }
  const flags = new Uint8Array(data)[32];
  // WebAuthn authenticator data flag 0x04 is UV (user verification).
  if ((flags & 0x04) === 0) {
    throw new Error('Device verification was not completed. Use the wallet password.');
  }
}

async function keyFromPrf(prfOutput, kdfSalt) {
  const material = await crypto.subtle.importKey('raw', prfOutput, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: kdfSalt, info: INFO },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function getPrfAssertion({ id, salt, rpId }) {
  let credential;
  try {
    credential = await navigator.credentials.get({
      publicKey: {
        challenge: randomBytes(CHALLENGE_BYTES),
        rpId,
        allowCredentials: [{ id: fromBase64Url(id), type: 'public-key' }],
        userVerification: 'required',
        timeout: 60_000,
        extensions: { prf: { eval: { first: fromBase64Url(salt) } } },
      },
    });
  } catch (error) {
    if (error?.name === 'NotAllowedError') {
      throw new Error('Device check was cancelled or not completed. Use the wallet password.');
    }
    if (error?.name === 'NotSupportedError') {
      throw new Error('This device does not support secure device unlock. Use the wallet password.');
    }
    throw new Error('Device check failed. Use the wallet password.');
  }
  if (!credential) throw new Error('Device authentication was cancelled. Use the wallet password.');
  if (credentialId(credential) !== id) {
    throw new Error('The authenticator returned a different credential. Use the wallet password.');
  }
  assertUserVerified(credential);
  const result = validatedPrfOutput(credential);
  return result;
}

function safeCredentialName(address) {
  // Avoid displaying or putting a user-defined wallet label into the OS passkey
  // chooser. The final six public-key characters distinguish local accounts.
  return `wallet-${address.slice(-6).toLowerCase()}`;
}

/**
 * Add a biometric/device-unlock route without changing the password keystore.
 * Must be called from a direct user gesture while this wallet is unlocked.
 */
export async function enableBiometricUnlock({ name, pubkey, seed32, shouldCancel = () => false }) {
  const checkCancelled = () => {
    if (shouldCancel()) throw new Error('Wallet locked — device unlock setup cancelled.');
  };
  assertBrowserSupport();
  if (typeof name !== 'string' || !name || !/^G[A-Z2-7]{55}$/.test(pubkey || '')
    || !(seed32 instanceof Uint8Array) || seed32.length !== 32) {
    throw new Error('Unlock an existing wallet first, then enable device unlock.');
  }
  const rpId = relyingPartyId();
  const challenge = randomBytes(CHALLENGE_BYTES);
  const userId = randomBytes(32);
  const created = await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { id: rpId, name: 'SatoshiCore Wallet' },
      user: {
        id: userId,
        name: safeCredentialName(pubkey),
        displayName: 'SatoshiCore wallet',
      },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        // The credential id is stored only with this browser's local unlock
        // record; do not create a discoverable/synced sign-in passkey.
        residentKey: 'discouraged',
        requireResidentKey: false,
        userVerification: 'required',
      },
      timeout: 60_000,
      attestation: 'none',
      extensions: { prf: {} },
    },
  });
  if (!created) throw new Error('Device authentication was cancelled. The wallet password still works.');
  checkCancelled();

  const id = credentialId(created);
  const prfSalt = randomBytes(SALT_BYTES);
  // Even if create-time PRF reporting is absent on this authenticator, only
  // the actual assertion result decides whether this feature may be enabled.
  let prfOutput;
  try {
    prfOutput = await getPrfAssertion({ id, salt: toBase64Url(prfSalt), rpId });
    checkCancelled();
    const kdfSalt = randomBytes(KDF_SALT_BYTES);
    const iv = randomBytes(IV_BYTES);
    const key = await keyFromPrf(prfOutput, kdfSalt);
    checkCancelled();
    const plaintext = new TextEncoder().encode(encodeSeed(seed32));
    let box;
    try {
      box = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext));
    } finally {
      plaintext.fill(0);
    }

    checkCancelled();
    const records = loadRecords();
    records[name] = {
      v: VERSION,
      id,
      salt: toBase64Url(prfSalt),
      kdfSalt: toBase64Url(kdfSalt),
      iv: toBase64Url(iv),
      box: toBase64Url(box),
    };
    saveRecords(records);
    return true;
  } finally {
    prfOutput?.fill(0);
    userId.fill(0);
    challenge.fill(0);
    prfSalt.fill(0);
  }
}

/** Unlock an existing wallet with an enrolled device authenticator. */
export async function unlockWithBiometric(name, expectedPubkey) {
  assertBrowserSupport();
  if (typeof name !== 'string' || !name || !/^G[A-Z2-7]{55}$/.test(expectedPubkey || '')) {
    throw new Error('Select a wallet with device unlock enabled.');
  }
  const record = loadRecords()[name];
  if (!record || record.v !== VERSION) {
    throw new Error('Device unlock is not set up for this wallet. Use the wallet password.');
  }
  const { id, salt, kdfSalt, iv, box } = record;
  // Decode/length-check before opening a platform prompt. A damaged local
  // record fails closed; the original password-encrypted keystore is untouched.
  const prfSalt = fromBase64Url(salt);
  const kdfSaltBytes = fromBase64Url(kdfSalt);
  const ivBytes = fromBase64Url(iv);
  const ciphertext = fromBase64Url(box);
  const idBytes = fromBase64Url(id);
  if (prfSalt.length !== SALT_BYTES || kdfSaltBytes.length !== KDF_SALT_BYTES
    || ivBytes.length !== IV_BYTES || ciphertext.length < 17
    || idBytes.length < 16 || idBytes.length > 1024) {
    throw new Error('Device unlock data is damaged. Use the wallet password.');
  }

  let prfOutput;
  let plainBytes;
  let seed32;
  let returned = false;
  try {
    prfOutput = await getPrfAssertion({ id, salt, rpId: relyingPartyId() });
    const key = await keyFromPrf(prfOutput, kdfSaltBytes);
    let plain;
    try {
      plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBytes }, key, ciphertext);
    } catch {
      throw new Error('Device unlock failed. Use the wallet password.');
    }
    plainBytes = new Uint8Array(plain);
    seed32 = decodeSeed(new TextDecoder().decode(plainBytes));
    const derivedAddress = encodeG(ed25519Keypair(seed32).pub32);
    if (derivedAddress !== expectedPubkey) {
      throw new Error('Device unlock data does not match this wallet. Use the wallet password.');
    }
    returned = true;
    return seed32;
  } finally {
    if (seed32 && !returned) seed32.fill(0);
    prfOutput?.fill(0);
    plainBytes?.fill(0);
    prfSalt.fill(0);
    kdfSaltBytes.fill(0);
    ivBytes.fill(0);
    ciphertext.fill(0);
    idBytes.fill(0);
  }
}
