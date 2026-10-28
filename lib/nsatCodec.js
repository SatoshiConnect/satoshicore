// NSAT wire-format codec — browser-side transaction builder.
//
// Byte-exact port of the PROVEN layouts in scripts/nsat-txcli.py (the same
// encoder used by every live-verified transaction on the NSAT devnets):
//   - strkey S/G (base32 + CRC16-XModem checksum)
//   - NativeAmount128 wire = [int64 hi; uint64 lo] big-endian
//   - TransactionV0 envelope: srcEd25519(32) fee(u32) seq(i64)
//     timeBounds-absent(u32 0) memo-none(u32 0) opCount ops ext(u32 0)
//   - Operation: srcAccount-present(u32 1) + AccountID + type + body
//   - SignedTransactionV0 envelope: u32(0) + txV0 + u32(1) + hint(4) + sig
//   - signature payload = SHA-256(networkId + u32(2) + u32(0) + txV0)
// Amounts use BigInt only — never floats.

const BASE32_ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// ---------- crc16-xmodem (strkey checksum) ----------
export function crc16xmodem(bytes) {
  let crc = 0x0000;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

// ---------- base32 ----------
export function base32Encode(bytes) {
  let out = '';
  let buf = 0, bits = 0;
  for (const byte of bytes) {
    buf = (buf << 8) | byte; bits += 8;
    while (bits >= 5) { out += BASE32_ALPHA[(buf >> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits) out += BASE32_ALPHA[(buf << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s) {
  const out = [];
  let buf = 0, bits = 0;
  for (const ch of s) {
    const val = BASE32_ALPHA.indexOf(ch);
    if (val === -1) throw new Error(`invalid base32 character: ${ch}`);
    buf = (buf << 5) | val; bits += 5;
    if (bits >= 8) { out.push((buf >> (bits - 8)) & 0xff); bits -= 8; }
  }
  return new Uint8Array(out);
}

// ---------- strkey ----------
export function strkeyEncode(version, payload) {
  const data = new Uint8Array(3 + payload.length);
  data[0] = version;
  data.set(payload, 1);
  const ck = crc16xmodem(data.subarray(0, payload.length + 1));
  data[payload.length + 1] = ck & 0xff;
  data[payload.length + 2] = (ck >> 8) & 0xff;
  return base32Encode(data);
}

export function strkeyDecode(expectedVersion, sk) {
  const raw = base32Decode(sk);
  const payloadLen = raw.length - 2;
  const data = raw.subarray(0, payloadLen);
  const ck = raw[payloadLen] | (raw[payloadLen + 1] << 8);
  if ((crc16xmodem(data) & 0xffff) !== ck) throw new Error('strkey checksum mismatch');
  if (data[0] !== expectedVersion) throw new Error(`strkey version mismatch (got ${data[0]})`);
  return data.slice(1);
}
export const encodeSeed = (seed32) => strkeyEncode(144, seed32); // S… (18<<3)
export const encodeG = (pub32) => strkeyEncode(48, pub32);       // G… (6<<3)
export const decodeSeed = (sk) => strkeyDecode(144, sk);
export const decodeG = (g) => strkeyDecode(48, g);

// ---------- byte helpers ----------
export function u32Bytes(v) {
  const x = Number(v) >>> 0;
  return new Uint8Array([(x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255]);
}
export function i64BytesArr(big) {
  const b = new Uint8Array(8);
  let x = BigInt.asIntN(64, big);
  for (let i = 7; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; }
  return b;
}
export function u64BytesArr(big) {
  const b = new Uint8Array(8);
  let x = BigInt.asUintN(64, big);
  for (let i = 7; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; }
  return b;
}
export function concat(...arrs) {
  const len = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
export function bytesToHex(b) {
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}
export function bytesToBase64(b) {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}
export function base64ToBytes(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------- amounts (BigInt only) ----------
// NativeAmount128 wire = [int64 hi][uint64 lo], big-endian — exact.
export function amount128BytesExact(v) {
  const big = BigInt(v);
  return concat(i64BytesArr(big >> 64n), u64BytesArr(big & 0xFFFFFFFFFFFFFFFFn));
}

// ---------- account id ----------
// AccountID = union PublicKey { ED25519 = 0 }: u32(0) + 32-byte key
export function accountIdBytes(pub32) { return concat(u32Bytes(0), pub32); }

// ---------- operations (fork layout: no trailing ext) ----------
export function opCreateAccount(srcPk32, dstPk32, amount) {
  return concat(u32Bytes(1), accountIdBytes(srcPk32), u32Bytes(0),
    accountIdBytes(dstPk32), amount128BytesExact(amount));
}
export function opPayment(srcPk32, dstPk32, amount) {
  return concat(u32Bytes(1), accountIdBytes(srcPk32), u32Bytes(1),
    accountIdBytes(dstPk32), u32Bytes(0), amount128BytesExact(amount));
}

// ---------- TransactionV0 + envelope ----------
export function buildTxV0(srcPk32, fee, seq, ops) {
  return concat(srcPk32, u32Bytes(fee), u64BytesArr(BigInt(seq)),
    u32Bytes(0), u32Bytes(0), u32Bytes(ops.length), ...ops, u32Bytes(0));
}
export function buildEnvelopeV0(srcPk32, fee, seq, ops, sig64) {
  return concat(u32Bytes(0), buildTxV0(srcPk32, fee, seq, ops), u32Bytes(1),
    srcPk32.subarray(28), u32Bytes(64), sig64);
}

// ---------- ed25519 via tweetnacl (universal: browser + node) ----------
import nacl from 'tweetnacl';

export function ed25519Keypair(seed32) {
  const kp = nacl.sign.keyPair.fromSeed(seed32);
  return { seed32, pub32: kp.publicKey };
}
export function ed25519Sign(seed32, message) {
  const kp = nacl.sign.keyPair.fromSeed(seed32);
  return nacl.sign.detached(message, kp.secretKey);
}
export function ed25519Pub(seed32) {
  return nacl.sign.keyPair.fromSeed(seed32).publicKey;
}
export function ed25519Verify(sig, message, pub32) {
  return nacl.sign.detached.verify(message, sig, pub32);
}

export async function sha256(data) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}
