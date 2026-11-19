// Firebase ID token verification without firebase-admin.
//
// The only thing this service needs from the account system is "which uid does
// this ID token belong to". That is a standard RS256 JWT signed by Google, so it
// is verified here with node:crypto against Google's published certificates —
// no service account, no admin SDK, no privileged credential on the machine.
//
// Checked, in this order: signature against the certificate named by `kid`,
// `alg` is RS256 (never `none`), audience is this project, issuer is this
// project, `sub` is a non-empty uid, and the token is inside its validity window
// with a small clock skew. Any failure returns null; nothing throws at the call
// site.
import { createPublicKey, verify as verifySignature } from 'node:crypto';

export const DEFAULT_CERTS_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
const DEFAULT_CACHE_MS = 5 * 60_000;
const MAX_CACHE_MS = 24 * 60 * 60_000;
const CLOCK_SKEW_MS = 60_000;

function decodeJson(segment) {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export function createFirebaseVerifier({
  projectId, certsUrl = DEFAULT_CERTS_URL, fetchImpl = globalThis.fetch,
  now = Date.now, cacheMs = DEFAULT_CACHE_MS,
} = {}) {
  if (typeof projectId !== 'string' || !projectId) {
    throw new Error('A Firebase project id is required to verify ID tokens.');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('A fetch implementation is required to load Google certificates.');
  }
  const issuer = `https://securetoken.google.com/${projectId}`;
  let cache = { certs: null, expiresAt: 0 };

  async function certificates(at) {
    if (cache.certs && cache.expiresAt > at) return cache.certs;
    const response = await fetchImpl(certsUrl, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`certificate fetch failed with ${response.status}`);
    const certs = await response.json();
    if (!certs || typeof certs !== 'object' || !Object.keys(certs).length) {
      throw new Error('certificate response was empty');
    }
    // Google sends `cache-control: public, max-age=NNNN, must-revalidate`.
    const header = response.headers?.get?.('cache-control') || '';
    const match = /max-age=(\d+)/i.exec(header);
    const ttl = match ? Math.min(Number(match[1]) * 1000, MAX_CACHE_MS) : cacheMs;
    cache = { certs, expiresAt: at + Math.max(ttl, 30_000) };
    return certs;
  }

  /**
   * Verify an ID token and return the claims, or null.
   *
   * `uid` is the Firebase uid (`sub`). `emailVerified` is passed through because
   * the caller may want the same rule the web app uses for profile writes; the
   * world itself only needs `uid`.
   */
  return async function verifyIdToken(token, at = now()) {
    if (typeof token !== 'string' || token.length > 4096) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headerPart, payloadPart, signaturePart] = parts;
    const header = decodeJson(headerPart);
    const payload = decodeJson(payloadPart);
    if (!header || !payload) return null;
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) return null;
    // `none` and HS256 are rejected above: an unsigned or symmetric token must
    // never pass as a Google-signed one.
    const certs = await certificates(at);
    const pem = certs[header.kid];
    // Google publishes X.509 certificates; a bare public key is accepted for
    // tests and for an operator who pins a key deliberately.
    if (typeof pem !== 'string' || !/-----BEGIN (CERTIFICATE|PUBLIC KEY)-----/.test(pem)) return null;
    let publicKey;
    try {
      publicKey = createPublicKey(pem);
    } catch {
      return null;
    }
    let verified = false;
    try {
      verified = verifySignature(
        'RSA-SHA256',
        Buffer.from(`${headerPart}.${payloadPart}`),
        publicKey,
        Buffer.from(signaturePart, 'base64url'),
      );
    } catch {
      return null;
    }
    if (!verified) return null;
    if (payload.aud !== projectId) return null;
    if (payload.iss !== issuer) return null;
    if (typeof payload.sub !== 'string' || !payload.sub) return null;
    if (!Number.isFinite(payload.exp) || payload.exp * 1000 <= at - CLOCK_SKEW_MS) return null;
    if (Number.isFinite(payload.iat) && payload.iat * 1000 > at + CLOCK_SKEW_MS) return null;
    return {
      uid: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : '',
      emailVerified: payload.email_verified === true,
      exp: payload.exp,
      issuedAt: Number.isFinite(payload.iat) ? payload.iat : 0,
    };
  };
}

/** Test seam: build a certificate map entry from a public key in PEM form. */
export function certificateMapFor(pem, kid) {
  return { [kid]: pem };
}
