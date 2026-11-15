// Synthetic WebAuthn device-authenticator tests. No real face, fingerprint,
// passkey provider, wallet, or network is used here. They verify the crypto
// envelope and fail-closed properties of the local biometric unlock helper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  biometricWalletNames,
  enableBiometricUnlock,
  hasBiometricUnlock,
  removeBiometricUnlock,
  unlockWithBiometric,
} from '../lib/biometricUnlock.js';
import { encodeG, encodeSeed, ed25519Keypair } from '../lib/nsatCodec.js';

const STORE_KEY = 'scw-web-biometric-v1';
const records = new Map();
const localStorageStub = {
  getItem: (key) => records.has(key) ? records.get(key) : null,
  setItem: (key, value) => records.set(key, String(value)),
  removeItem: (key) => records.delete(key),
};
const CREDENTIAL_ID = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const PRF_OUTPUT = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);

function arrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function credential({ uv = true, prf = true } = {}) {
  const authData = new Uint8Array(37);
  authData[32] = uv ? 0x04 : 0;
  return {
    rawId: arrayBuffer(CREDENTIAL_ID),
    response: { authenticatorData: arrayBuffer(authData) },
    getClientExtensionResults: () => prf
      ? { prf: { results: { first: arrayBuffer(PRF_OUTPUT) } } }
      : { prf: {} },
  };
}

function installWebAuthn({ create = () => credential(), get = () => credential() } = {}) {
  const originals = new Map();
  for (const key of ['localStorage', 'navigator', 'PublicKeyCredential', 'location']) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  }
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorageStub });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { credentials: { create, get } },
  });
  Object.defineProperty(globalThis, 'PublicKeyCredential', { configurable: true, value: class {} });
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { hostname: 'satoshicore.org' },
  });
  return () => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  };
}

const SEED = new Uint8Array(32).fill(37);
const ADDRESS = encodeG(ed25519Keypair(SEED).pub32);
const SEED_STRKEY = encodeSeed(SEED);

test('enrollment stores only a local encrypted seed copy and unlock recovers the same key', async () => {
  records.clear();
  let createdOptions;
  let assertionOptions;
  const restore = installWebAuthn({
    create: async (options) => { createdOptions = options; return credential(); },
    get: async (options) => { assertionOptions = options; return credential(); },
  });
  try {
    assert.equal(await enableBiometricUnlock({ name: 'wallet-a', pubkey: ADDRESS, seed32: SEED }), true);
    assert.ok(createdOptions.publicKey.extensions.prf);
    assert.equal(createdOptions.publicKey.authenticatorSelection.userVerification, 'required');
    assert.equal(createdOptions.publicKey.authenticatorSelection.residentKey, 'discouraged');
    assert.equal(createdOptions.publicKey.authenticatorSelection.authenticatorAttachment, 'platform');
    assert.equal(createdOptions.publicKey.rp.id, 'satoshicore.org');
    assert.equal(assertionOptions.publicKey.userVerification, 'required');
    assert.equal(assertionOptions.publicKey.allowCredentials.length, 1);

    assert.equal(hasBiometricUnlock('wallet-a'), true);
    assert.deepEqual(biometricWalletNames(), ['wallet-a']);
    const stored = records.get(STORE_KEY);
    assert.ok(stored);
    assert.ok(!stored.includes(SEED_STRKEY), 'plaintext seed strkey must never be stored');
    assert.ok(!stored.includes(Buffer.from(PRF_OUTPUT).toString('base64url')),
      'PRF output must never be stored');
    assert.deepEqual(Object.keys(JSON.parse(stored).wallets['wallet-a']).sort(),
      ['box', 'id', 'iv', 'kdfSalt', 'salt', 'v']);

    const unlocked = await unlockWithBiometric('wallet-a', ADDRESS);
    assert.deepEqual(unlocked, SEED);
    unlocked.fill(0);
  } finally {
    restore();
    records.clear();
  }
});

test('missing PRF support fails closed and does not enable device unlock', async () => {
  records.clear();
  const restore = installWebAuthn({
    create: async () => credential(),
    get: async () => credential({ prf: false }),
  });
  try {
    await assert.rejects(
      () => enableBiometricUnlock({ name: 'wallet-a', pubkey: ADDRESS, seed32: SEED }),
      /does not support secure biometric unlock/,
    );
    assert.equal(hasBiometricUnlock('wallet-a'), false);
    assert.equal(records.has(STORE_KEY), false);
  } finally {
    restore();
    records.clear();
  }
});

test('a WebAuthn assertion without user verification cannot unlock', async () => {
  records.clear();
  const setupRestore = installWebAuthn();
  try {
    await enableBiometricUnlock({ name: 'wallet-a', pubkey: ADDRESS, seed32: SEED });
  } finally {
    setupRestore();
  }
  const restore = installWebAuthn({ get: async () => credential({ uv: false }) });
  try {
    await assert.rejects(() => unlockWithBiometric('wallet-a', ADDRESS), /verification was not completed/);
  } finally {
    restore();
    records.clear();
  }
});

test('tampering, wrong wallet address, absent setup and cancellation fail closed', async () => {
  records.clear();
  const setupRestore = installWebAuthn();
  try {
    await enableBiometricUnlock({ name: 'wallet-a', pubkey: ADDRESS, seed32: SEED });
  } finally {
    setupRestore();
  }

  const unlockRestore = installWebAuthn();
  try {
    await assert.rejects(() => unlockWithBiometric('missing', ADDRESS), /not set up/);
    const wrongAddress = encodeG(ed25519Keypair(new Uint8Array(32).fill(11)).pub32);
    await assert.rejects(() => unlockWithBiometric('wallet-a', wrongAddress), /does not match this wallet/);

    const state = JSON.parse(records.get(STORE_KEY));
    state.wallets['wallet-a'].box = state.wallets['wallet-a'].box.slice(0, -1) + 'A';
    records.set(STORE_KEY, JSON.stringify(state));
    await assert.rejects(() => unlockWithBiometric('wallet-a', ADDRESS), /Device unlock failed/);
  } finally {
    unlockRestore();
    records.clear();
  }

  const cancelRestore = installWebAuthn();
  try {
    await assert.rejects(
      () => enableBiometricUnlock({ name: 'wallet-a', pubkey: ADDRESS, seed32: SEED, shouldCancel: () => true }),
      /setup cancelled/,
    );
    assert.equal(hasBiometricUnlock('wallet-a'), false);
  } finally {
    cancelRestore();
    records.clear();
  }
});

test('device unlock can be removed without touching the wallet keystore', async () => {
  records.clear();
  const restore = installWebAuthn();
  try {
    await enableBiometricUnlock({ name: 'wallet-a', pubkey: ADDRESS, seed32: SEED });
    assert.equal(removeBiometricUnlock('wallet-a'), true);
    assert.equal(hasBiometricUnlock('wallet-a'), false);
    assert.equal(records.has(STORE_KEY), false);
    assert.equal(removeBiometricUnlock('wallet-a'), false);
  } finally {
    restore();
    records.clear();
  }
});
