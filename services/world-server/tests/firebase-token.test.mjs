// The ID token is the account credential; every check that makes it trustworthy
// is pinned here with a locally generated RSA key, so nothing about this test
// depends on Google being reachable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { createFirebaseVerifier } from '../lib/firebaseToken.mjs';

const PROJECT = 'satoshicore-test';
const KID = 'test-kid-1';
const NOW = 1_700_000_000_000;
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = publicKey.export({ type: 'spki', format: 'pem' });

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

function jwt({ header = { alg: 'RS256', kid: KID, typ: 'JWT' }, payload = {} } = {}) {
  const body = {
    aud: PROJECT,
    iss: `https://securetoken.google.com/${PROJECT}`,
    sub: 'uid-1',
    iat: Math.floor(NOW / 1000) - 10,
    exp: Math.floor(NOW / 1000) + 300,
    email: 'a@example.com',
    email_verified: true,
    ...payload,
  };
  const unsigned = `${b64(header)}.${b64(body)}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  return `${unsigned}.${signer.sign(privateKey).toString('base64url')}`;
}

function verifier({ certs = { [KID]: PEM }, calls = { count: 0 } } = {}) {
  const fetchImpl = async () => {
    calls.count += 1;
    return {
      ok: true,
      status: 200,
      json: async () => certs,
      headers: { get: () => 'public, max-age=3600, must-revalidate' },
    };
  };
  return {
    calls,
    verify: createFirebaseVerifier({ projectId: PROJECT, fetchImpl, now: () => NOW }),
  };
}

test('a well-formed token yields the uid', async () => {
  const { verify } = verifier();
  const claims = await verify(jwt());
  assert.equal(claims.uid, 'uid-1');
  assert.equal(claims.emailVerified, true);
});

test('audience, issuer and uid are all required', async () => {
  const { verify } = verifier();
  assert.equal(await verify(jwt({ payload: { aud: 'someone-else' } })), null);
  assert.equal(await verify(jwt({ payload: { iss: 'https://securetoken.google.com/other' } })), null);
  assert.equal(await verify(jwt({ payload: { sub: '' } })), null);
});

test('expired and future tokens are refused', async () => {
  const { verify } = verifier();
  assert.equal(await verify(jwt({ payload: { exp: Math.floor(NOW / 1000) - 120 } })), null);
  assert.equal(await verify(jwt({ payload: { iat: Math.floor(NOW / 1000) + 600 } })), null);
});

test('unsigned, symmetric and unknown-key tokens are refused', async () => {
  const { verify } = verifier();
  assert.equal(await verify(jwt({ header: { alg: 'none', kid: KID } })), null);
  assert.equal(await verify(jwt({ header: { alg: 'HS256', kid: KID } })), null);
  assert.equal(await verify(jwt({ header: { alg: 'RS256', kid: 'missing' } })), null);
});

test('editing the payload after signing is refused', async () => {
  const { verify } = verifier();
  const token = jwt();
  const [header, body, signature] = token.split('.');
  const decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  const edited = Buffer.from(JSON.stringify({ ...decoded, sub: 'uid-2' })).toString('base64url');
  assert.equal(await verify(`${header}.${edited}.${signature}`), null);
});

test('certificates are cached between verifications', async () => {
  const { verify, calls } = verifier();
  await verify(jwt());
  await verify(jwt());
  assert.equal(calls.count, 1);
});
