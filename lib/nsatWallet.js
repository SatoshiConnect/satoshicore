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

// ---------------- helpers ----------------
const hexOf = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const b64Of = b => { let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s); };
const unb64 = s => { const bin = atob(s); const o = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i); return o; };

// ---------------- keystore ----------------
function ksLoad() {
  try { return JSON.parse(localStorage.getItem(KS_KEY) || '{"v":1,"wallets":[]}'); }
  catch { return { v: 1, wallets: [] }; }
}
function ksSave(store) {
  localStorage.setItem(KS_KEY, JSON.stringify(store));
}

export function keystoreList() {
  return ksLoad().wallets.map(w => ({ name: w.name, pubkey: w.pubkey }));
}
export function keystoreHas(name) {
  return ksLoad().wallets.some(w => w.name === name);
}

async function deriveKey(password, salt) {
  const base = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITER, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

function walletEntry(name, seed32, password) {
  return (async () => {
    // pubkey is DERIVED from the seed — never passed in separately,
    // code-impossible for stored key and displayed address to diverge.
    const pubkeyG = encodeG(ed25519Keypair(seed32).pub32);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(password, salt);
    const plaintext = new TextEncoder().encode(JSON.stringify({ seedS: encodeSeed(seed32) }));
    const box = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, key, plaintext));
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
  const store = ksLoad();
  if (store.wallets.some(w => w.name === name)) {
    throw new Error(`wallet '${name}' already exists`);
  }
  const seed32 = crypto.getRandomValues(new Uint8Array(32));
  const entry = await walletEntry(name, seed32, password);
  store.wallets.push(entry);
  ksSave(store);
  const ret = { name, pubkeyG: entry.pubkey, seedS: encodeSeed(seed32) };
  // zero the in-memory copy immediately after the single backup encoding
  scrub(seed32);
  return ret;
}

// Import an existing S… seed; same encrypted storage.
export async function keystoreImport(name, seedS, password) {
  const store = ksLoad();
  if (store.wallets.some(w => w.name === name)) {
    throw new Error(`wallet '${name}' already exists`);
  }
  const seed32 = decodeSeed(seedS.trim());
  const entry = await walletEntry(name, seed32, password);
  store.wallets.push(entry);
  ksSave(store);
  // One seedS encoding for the immediate signing session, then the seed's
  // raw bytes are scrubbed — the caller owns the seedS copy it receives.
  const retSeedS = encodeSeed(seed32);
  scrub(seed32);
  return { name, pubkeyG: entry.pubkey, seedS: retSeedS };
}

// Unlock → returns the raw 32-byte seed for in-memory signing.
export async function keystoreUnlock(name, password) {
  const store = ksLoad();
  const entry = store.wallets.find(w => w.name === name);
  if (!entry) throw new Error(`wallet '${name}' not found`);
  const salt = unb64(entry.kdf.salt);
  const key = await deriveKey(password, salt);
  let plain;
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(entry.nonce) }, key, unb64(entry.box));
  } catch {
    throw new Error('wrong password');
  }
  const parsed = JSON.parse(new TextDecoder().decode(plain));
  const seed = decodeSeed(parsed.seedS);
  // Integrity: the on-chain identity we SIGN with (derived from the unlocked
  // seed) must equal the address the UI displays (entry.pubkey). A tampered
  // or merged keystore that pairs a display address with a different key is
  // a phishing primitive — refuse it here, at the unlock boundary.
  const derivedG = encodeG(ed25519Keypair(seed).pub32);
  if (derivedG !== entry.pubkey) {
    scrub(seed);
    throw new Error('keystore integrity failure: stored address does not match the signing key');
  }
  return seed;
}

// Encrypted backup export (the ciphertext blob itself — safe to download).
export function keystoreExport() {
  return localStorage.getItem(KS_KEY) || '';
}
export function keystoreRestore(blob) {
  const parsed = JSON.parse(blob);
  if (parsed.v !== 1 || !Array.isArray(parsed.wallets)) {
    throw new Error('not a web keystore file');
  }
  // Merge only non-conflicting wallets; a backup cannot replace existing
  // ciphertext or erase locally stored wallet entries.
  let current;
  try {
    current = JSON.parse(localStorage.getItem(KS_KEY) || '{"v":1,"wallets":[]}');
  } catch {
    throw new Error('existing keystore is malformed; restore refused');
  }
  if (current.v !== 1 || !Array.isArray(current.wallets)) {
    throw new Error('existing keystore is malformed; restore refused');
  }
  const names = new Set(current.wallets.map((w) => w?.name));
  const backupNames = new Set();
  const ok = (b, size) => {
    if (typeof b !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b)) return false;
    try { return atob(b).length === size || (size === undefined && atob(b).length > 0); }
    catch { return false; }
  };
  for (const w of parsed.wallets) {
    if (!w) throw new Error('malformed keystore entry');
    if (typeof w.name !== 'string' || !w.name) throw new Error('malformed keystore entry: name');
    if (names.has(w.name) || backupNames.has(w.name)) throw new Error(`wallet '${w.name}' already exists; restore refused`);
    backupNames.add(w.name);
    if (!/^G[A-Z2-7]{55}$/.test(w.pubkey || '')) throw new Error(`malformed keystore entry: pubkey of '${w.name}'`);
    if (!w.kdf || w.kdf.algo !== 'PBKDF2-HMAC-SHA256') throw new Error(`malformed keystore entry: kdf of '${w.name}'`);
    if (w.kdf.iterations !== PBKDF2_ITER) throw new Error(`malformed keystore entry: kdf iterations of '${w.name}'`);
    if (w.aead !== 'AES-GCM-256' || !ok(w.kdf.salt, 16) || !ok(w.nonce, 12) || !ok(w.box)) {
      throw new Error(`malformed keystore entry: ciphertext of '${w.name}'`);
    }
  }
  localStorage.setItem(KS_KEY, JSON.stringify({ v: 1, wallets: [...current.wallets, ...parsed.wallets] }));
}

// ---------------- history (per wallet, localStorage) ----------------
const histKey = name => `scw-web-history-${name}`;
export function historyLoad(name) {
  try { return JSON.parse(localStorage.getItem(histKey(name)) || '[]'); }
  catch { return []; }
}
export function historyPush(name, entry) {
  const h = historyLoad(name);
  h.unshift(entry);
  localStorage.setItem(histKey(name), JSON.stringify(h.slice(0, 200)));
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
  fee = 10, create = false, seq = null, nodeUrl = null, seqFetch = null }) {
  if (!/^\d+$/.test(String(amount)) || BigInt(amount) <= 0n
    || BigInt(amount) > 0x7FFFFFFFFFFFFFFFn) {
    throw new Error('amount must be a positive integer within the per-operation limit');
  }
  if (!Number.isSafeInteger(fee) || fee <= 0 || fee > 0xFFFFFFFF)
    throw new Error('fee must be a positive uint32 from the verified network');
  if (typeof netPassphrase !== 'string' || !netPassphrase)
    throw new Error('verified network identity is required');
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
  if (!Number.isSafeInteger(effectiveSeq) || effectiveSeq <= 0)
    throw new Error('sequence number must be a positive safe integer');

  // Wire identity = the DERIVED public key; the seed bytes exist only to
  // sign. (Passing the seed here also put the seed into the signature hint.)
  const op = create ? opCreateAccount(pub32, dst32, BigInt(amount))
    : opPayment(pub32, dst32, BigInt(amount));
  const txV0 = buildTxV0(pub32, fee, effectiveSeq, [op]);

  const netId = await sha256(new TextEncoder().encode(netPassphrase));
  const input = await sha256(concat(netId, u32Bytes(ENVELOPE_TYPE_TX),
    u32Bytes(ENVELOPE_TYPE_TX_V0), txV0));
  const sig = await ed25519Sign(seed32, input);
  const envelope = buildEnvelopeV0(pub32, fee, effectiveSeq, [op], sig);
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
