// Web Wallet transaction builder + encrypted keystore.
//
// SECURITY MODEL:
//  - Seeds are generated/imported in the browser and stored ONLY as an
//    AES-GCM-256 ciphertext (PBKDF2-SHA256, 600k iterations) in
//    localStorage under "scw-web-keystore-v1". Plaintext seeds live in
//    memory only while the wallet is unlocked.
//  - Transaction construction + Ed25519 signing happen client-side via
//    WebCrypto. The gateway only ever relays already-signed envelopes.
//  - Wire format is the byte-exact port of scripts/nsat-txcli.py (proven
//    on every live-verified NSAT transaction).
//
// Amounts use BigInt only — never floats.

import {
  concat, u32Bytes, i64BytesArr, u64BytesArr,
  buildTxV0, buildEnvelopeV0, opCreateAccount, opPayment,
  ed25519Keypair, ed25519Sign, ed25519Pub, sha256,
  encodeG, decodeSeed, decodeG, encodeSeed,
} from './nsatCodec.js';

const ENVELOPE_TYPE_TX = 2;
const ENVELOPE_TYPE_TX_V0 = 0;
const KS_KEY = 'scw-web-keystore-v1';
const PBKDF2_ITER = 600000;
// The password is the only thing between a stolen keystore blob and the seed,
// so new wallets get a length floor instead of composition rules a password
// manager cannot satisfy. Existing keystores keep unlocking with their old
// password — only creation and import are gated.
export const MIN_PASSWORD_LENGTH = 12;

export function checkNewPassword(password) {
  const value = String(password ?? '');
  if (value.trim().length === 0) return { ok: false, reason: 'Enter a password.' };
  if ([...value].length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      reason: `Use at least ${MIN_PASSWORD_LENGTH} characters — this password is the only protection on the encrypted keystore.`,
    };
  }
  return { ok: true };
}

// Overwrite a seed buffer in place. The UI holds the buffer in React state, so
// dropping the reference alone leaves the bytes readable until GC runs; zeroing
// makes the lock mean what it says.
export function zeroSeed(seed32) {
  try {
    if (seed32 && typeof seed32.fill === 'function') seed32.fill(0);
  } catch {
    // A frozen/wrapped buffer cannot be wiped; nothing else is safe to do here.
  }
}

// ---------------- storage indirection ----------------
// The keystore/history persistence backend is injectable so alternative
// distribution shells (e.g. the browser extension popup, which persists to
// the extension's isolated chrome.storage.local) can reuse this exact
// audited code path. The default is a lazy passthrough to page localStorage
// — the web wallet's behavior is unchanged. Adapters only ever see
// ciphertext (the AES-GCM keystore blob) and public history entries.
let WALLET_STORAGE = {
  getItem: (k) => localStorage.getItem(k),
  setItem: (k, v) => localStorage.setItem(k, v),
};
export function setWalletStorage(adapter) {
  WALLET_STORAGE = adapter;
}

// ---------------- helpers ----------------
const hexOf = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const b64Of = b => { let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s); };
const unb64 = s => { const bin = atob(s); const o = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i); return o; };

// ---------------- keystore ----------------
function ksLoad() {
  try { return JSON.parse(WALLET_STORAGE.getItem(KS_KEY) || '{"v":1,"wallets":[]}'); }
  catch { return { v: 1, wallets: [] }; }
}
function ksSave(store) {
  WALLET_STORAGE.setItem(KS_KEY, JSON.stringify(store));
}

export function keystoreList() {
  return ksLoad().wallets.map(w => ({ name: w.name, pubkey: w.pubkey }));
}
export function keystoreHas(name) {
  return ksLoad().wallets.some(w => w.name === name);
}

async function deriveKey(password, salt) {
  const passwordBytes = new TextEncoder().encode(password);
  password = '';
  try {
    const base = await crypto.subtle.importKey(
      'raw', passwordBytes, 'PBKDF2', false, ['deriveKey']);
    return await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: PBKDF2_ITER, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  } finally {
    passwordBytes.fill(0);
  }
}

function walletEntry(name, seed32, password) {
  return (async () => {
    // pubkey is DERIVED from the seed — never passed in separately,
    // code-impossible for stored key and displayed address to diverge.
    const pubkeyG = encodeG(ed25519Keypair(seed32).pub32);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const keyPromise = deriveKey(password, salt);
    password = '';
    const key = await keyPromise;
    const plaintext = new TextEncoder().encode(JSON.stringify({ seedS: encodeSeed(seed32) }));
    let box;
    try {
      box = new Uint8Array(await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv }, key, plaintext));
    } finally {
      plaintext.fill(0);
    }
    return {
      name, pubkey: pubkeyG,
      kdf: { algo: 'PBKDF2-HMAC-SHA256', salt: b64Of(salt), iterations: PBKDF2_ITER },
      aead: 'AES-GCM-256',
      nonce: b64Of(iv),
      box: b64Of(box),
    };
  })();
}

// Create a new random wallet; returns { name, pubkeyG, seedS } — seed shown
// ONCE for backup, only the ciphertext is stored.
function scrub(seed32) { seed32.fill(0); }
export async function keystoreCreate(name, password) {
  const strength = checkNewPassword(password);
  if (!strength.ok) throw new Error(strength.reason);
  const store = ksLoad();
  if (store.wallets.some(w => w.name === name)) {
    throw new Error(`wallet '${name}' already exists`);
  }
  const seed32 = crypto.getRandomValues(new Uint8Array(32));
  try {
    const entryPromise = walletEntry(name, seed32, password);
    password = '';
    const entry = await entryPromise;
    store.wallets.push(entry);
    ksSave(store);
    return { name, pubkeyG: entry.pubkey, seedS: encodeSeed(seed32) };
  } finally {
    // Also wipe on encryption or storage failure, not only on success.
    scrub(seed32);
  }
}

// Import an existing S… seed; same encrypted storage.
export async function keystoreImport(name, seedS, password) {
  const strength = checkNewPassword(password);
  if (!strength.ok) throw new Error(strength.reason);
  const store = ksLoad();
  if (store.wallets.some(w => w.name === name)) {
    throw new Error(`wallet '${name}' already exists`);
  }
  const seed32 = decodeSeed(seedS.trim());
  seedS = '';
  try {
    const entryPromise = walletEntry(name, seed32, password);
    password = '';
    const entry = await entryPromise;
    store.wallets.push(entry);
    ksSave(store);
    // One seedS encoding for the immediate signing session, then the seed's
    // raw bytes are scrubbed — the caller owns the seedS copy it receives.
    return { name, pubkeyG: entry.pubkey, seedS: encodeSeed(seed32) };
  } finally {
    scrub(seed32);
  }
}

// Unlock → returns the raw 32-byte seed for in-memory signing.
export async function keystoreUnlock(name, password) {
  const store = ksLoad();
  const entry = store.wallets.find(w => w.name === name);
  if (!entry) throw new Error(`wallet '${name}' not found`);
  const salt = unb64(entry.kdf.salt);
  const keyPromise = deriveKey(password, salt);
  password = '';
  const key = await keyPromise;
  let plain;
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(entry.nonce) }, key, unb64(entry.box));
  } catch {
    throw new Error('wrong password');
  }
  const plainBytes = new Uint8Array(plain);
  let seed;
  let returned = false;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(plainBytes));
    seed = decodeSeed(parsed.seedS);
    // Integrity: the on-chain identity we SIGN with (derived from the unlocked
    // seed) must equal the address the UI displays (entry.pubkey). A tampered
    // or merged keystore that pairs a display address with a different key is
    // a phishing primitive — refuse it here, at the unlock boundary.
    const derivedG = encodeG(ed25519Keypair(seed).pub32);
    if (derivedG !== entry.pubkey) {
      throw new Error('keystore integrity failure: stored address does not match the signing key');
    }
    returned = true;
    return seed;
  } finally {
    plainBytes.fill(0);
    if (seed && !returned) scrub(seed);
  }
}

// Encrypted backup export (the ciphertext blob itself — safe to download).
export function keystoreExport() {
  return WALLET_STORAGE.getItem(KS_KEY) || '';
}
export function keystoreRestore(blob) {
  const parsed = JSON.parse(blob);
  if (parsed.v !== 1 || !Array.isArray(parsed.wallets)) {
    throw new Error('not a web keystore file');
  }
  // Fail closed BEFORE overwriting the live keystore: a manipulated backup
  // must never install malformed entries (a wrong-type `box`, a garbage
  // pubkey shown as the account address, or fields that would crash the
  // unlock path later).
  const ok = (b) => typeof b === 'string' && b.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(b);
  const names = new Set();
  for (const w of parsed.wallets) {
    if (!w) throw new Error('malformed keystore entry');
    if (typeof w.name !== 'string' || !w.name) throw new Error('malformed keystore entry: name');
    if (names.has(w.name)) throw new Error(`malformed keystore entry: duplicate wallet '${w.name}'`);
    names.add(w.name);
    if (!/^G[A-Z2-7]{55}$/.test(w.pubkey || '')) throw new Error(`malformed keystore entry: pubkey of '${w.name}'`);
    if (!w.kdf || w.kdf.algo !== 'PBKDF2-HMAC-SHA256') throw new Error(`malformed keystore entry: kdf of '${w.name}'`);
    if (typeof w.kdf.iterations !== 'number' || w.kdf.iterations !== PBKDF2_ITER) throw new Error(`malformed keystore entry: kdf iterations of '${w.name}'`);
    if (w.aead !== 'AES-GCM-256') throw new Error(`malformed keystore entry: encryption of '${w.name}'`);
    if (!ok(w.kdf.salt) || unb64(w.kdf.salt).length !== 16
      || !ok(w.nonce) || unb64(w.nonce).length !== 12
      || !ok(w.box) || unb64(w.box).length <= 16) {
      throw new Error(`malformed keystore entry: ciphertext of '${w.name}'`);
    }
  }
  WALLET_STORAGE.setItem(KS_KEY, blob);
}


// ---------------- history (per wallet, localStorage) ----------------
const histKey = name => `scw-web-history-${name}`;
export function historyLoad(name) {
  try { return JSON.parse(WALLET_STORAGE.getItem(histKey(name)) || '[]'); }
  catch { return []; }
}
export function historyPush(name, entry) {
  const h = historyLoad(name);
  h.unshift(entry);
  WALLET_STORAGE.setItem(histKey(name), JSON.stringify(h.slice(0, 200)));
}

// Patch one stored entry by transaction hash. Used when a transfer that was
// recorded as "unconfirmed" later gets an exact ledger verdict; the hash is the
// key, so a reorder in the list cannot patch the wrong row.
export function historyPatch(name, txHashHex, patch) {
  const h = historyLoad(name);
  let changed = false;
  const next = h.map((entry) => {
    if (entry.txhash !== txHashHex) return entry;
    changed = true;
    return { ...entry, ...patch };
  });
  if (changed) WALLET_STORAGE.setItem(histKey(name), JSON.stringify(next.slice(0, 200)));
  return next;
}

// ---------------- transaction build + sign ----------------
async function fetchSeq(nodeUrlOrFetch, pubkeyG) {
  if (typeof nodeUrlOrFetch === 'function') {
    const d = await nodeUrlOrFetch(pubkeyG);
    if (d.status !== 'ok') throw new Error(`source account missing (${d.status})`);
    // The gateway proxies the core's account resource as `seqnum`
    // (the gateway's own legacy RPC shape used `sequence`).
    const seq = d.seqnum ?? d.sequence;
    if (seq == null || !Number.isSafeInteger(Number(seq)))
      throw new Error('account response missing seqnum');
    return Number(seq) + 1;
  }
  const d = await (await fetch(
    `${nodeUrlOrFetch}/account?acc=${encodeURIComponent(pubkeyG)}`)).json();
  if (d.status !== 'ok') throw new Error(`source account missing (${d.status})`);
  return Number(d.seqnum) + 1;
}

// Build + sign one transparent operation. Returns
// { envelopeBase64, txHashHex, seq, fee }.
export async function buildSignedTx({ seed32, netPassphrase, destG, amount,
  fee = 10, create = false, seq = null, nodeUrl = null, seqFetch = null,
  shouldCancel = () => false }) {
  const checkCancelled = () => {
    if (shouldCancel()) throw new Error('Wallet locked — transaction signing cancelled.');
  };
  checkCancelled();
  if (!/^\d+$/.test(String(amount)) || BigInt(amount) < 0n) {
    throw new Error('amount must be a non-negative integer (stroops)');
  }
  let dst32;
  try { dst32 = decodeG(destG); }
  catch { throw new Error('invalid destination G… strkey'); }
  const pub32 = (await ed25519Keypair(seed32)).pub32;
  const pubkeyG = encodeG(pub32);

  let effectiveSeq = seq;
  if (effectiveSeq == null) {
    effectiveSeq = nodeUrl
      ? await fetchSeq(nodeUrl, pubkeyG)
      : await fetchSeq(seqFetch, pubkeyG);
  }
  checkCancelled();

  // Wire identity = the DERIVED public key; the seed bytes exist only to
  // sign. (Passing the seed here also put the seed into the signature hint.)
  const op = create ? opCreateAccount(pub32, dst32, BigInt(amount))
    : opPayment(pub32, dst32, BigInt(amount));
  const txV0 = buildTxV0(pub32, fee, effectiveSeq, [op]);

  const netId = await sha256(new TextEncoder().encode(netPassphrase));
  checkCancelled();
  const input = await sha256(concat(netId, u32Bytes(ENVELOPE_TYPE_TX),
    u32Bytes(ENVELOPE_TYPE_TX_V0), txV0));
  checkCancelled();
  const sig = await ed25519Sign(seed32, input);
  let envelope;
  try {
    checkCancelled();
    envelope = buildEnvelopeV0(pub32, fee, effectiveSeq, [op], sig);
  } finally {
    sig.fill(0);
  }
  return {
    envelopeBase64: b64Of(envelope),
    txHashHex: hexOf(input),
    pubkeyG,
    seq: effectiveSeq,
    fee,
  };
}

// Poll until finalized; `seqNow()` must return the account's current
// sequence number (the account seq advances ONLY when a tx with that seq is
// applied in a closed ledger). Resolves true when the account's seq reaches
// `seq`, false on timeout.
export async function waitSeqReached(seqNow, seq, timeoutMs = 90000,
  stepMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (Number(await seqNow()) >= seq) return true;
    } catch { /* transient */ }
    await new Promise(r => setTimeout(r, stepMs));
  }
  return false;
}
