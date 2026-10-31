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
  return decodeSeed(parsed.seedS);
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
  localStorage.setItem(KS_KEY, blob);
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
