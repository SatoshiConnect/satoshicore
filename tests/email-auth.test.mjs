import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createEmailAuth,
  createFirebaseEmailAuthProvider,
  describeEmailAuthError,
  normalizeEmail,
  RESET_NEUTRAL_MESSAGE,
  validateEmail,
  validatePassword,
} from '../lib/emailAuth.js';

const STRONG = 'correct-horse-42';

function fakeUser(overrides = {}) {
  return {
    uid: 'uid-1',
    email: 'user@example.com',
    displayName: '',
    emailVerified: false,
    providerIds: ['password'],
    ...overrides,
  };
}

function fakeProvider(overrides = {}) {
  const calls = [];
  const state = { user: null, ...overrides.state };
  const provider = {
    calls,
    state,
    async setPersistence(remember) { calls.push(['setPersistence', remember]); },
    async register({ email, password }) {
      calls.push(['register', email, password]);
      if (overrides.register) return overrides.register({ email, password, state });
      state.user = fakeUser({ email, emailVerified: false });
      return state.user;
    },
    async signIn({ email, password }) {
      calls.push(['signIn', email, password]);
      if (overrides.signIn) return overrides.signIn({ email, password, state });
      state.user = fakeUser({ email, emailVerified: false });
      return state.user;
    },
    async signOut() { calls.push(['signOut']); state.user = null; },
    currentUser() { return state.user; },
    async reload() { calls.push(['reload']); return state.user; },
    async sendVerificationEmail({ continueUrl }) {
      calls.push(['sendVerificationEmail', continueUrl]);
      if (overrides.sendVerificationEmail) return overrides.sendVerificationEmail({ continueUrl });
    },
    async sendPasswordReset(email, { continueUrl }) {
      calls.push(['sendPasswordReset', email, continueUrl]);
      if (overrides.sendPasswordReset) return overrides.sendPasswordReset({ email });
    },
    async confirmPasswordReset(code, newPassword) {
      calls.push(['confirmPasswordReset', code, newPassword]);
      if (overrides.confirmPasswordReset) return overrides.confirmPasswordReset({ code });
    },
    async reauthenticate({ email, password }) {
      calls.push(['reauthenticate', email, password]);
      if (overrides.reauthenticate) return overrides.reauthenticate({ email, password });
    },
    async updatePassword(newPassword) {
      calls.push(['updatePassword', newPassword]);
      if (overrides.updatePassword) return overrides.updatePassword({ newPassword });
    },
    async verifyBeforeUpdateEmail(newEmail, { continueUrl } = {}) {
      calls.push(['verifyBeforeUpdateEmail', newEmail, continueUrl]);
      if (overrides.verifyBeforeUpdateEmail) {
        return overrides.verifyBeforeUpdateEmail({ newEmail, continueUrl });
      }
    },
  };
  return provider;
}

const service = (provider, options = {}) => createEmailAuth({ provider, ...options });
const hasCode = (code) => (error) => {
  assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
  return true;
};

// ---------------- validation ----------------

test('email normalization trims and lowercases, and validation rejects obvious typos', () => {
  assert.equal(normalizeEmail('  User@Example.COM '), 'user@example.com');
  assert.deepEqual(validateEmail(' USER@example.com '), { ok: true, email: 'user@example.com' });

  for (const value of ['', '   ', 'no-at-sign', 'a@b', 'a b@example.com']) {
    const result = validateEmail(value);
    assert.equal(result.ok, false, `${JSON.stringify(value)} must be rejected`);
  }
  assert.equal(validateEmail('a@b.co').ok, true);
  assert.equal(validateEmail(`${'x'.repeat(250)}@example.com`).code, 'EMAIL_TOO_LONG');
});

test('password policy requires length, a letter, a digit, no edge spaces and not the email name', () => {
  assert.equal(validatePassword(STRONG).ok, true);
  assert.equal(validatePassword('short1').code, 'PASSWORD_TOO_SHORT');
  assert.equal(validatePassword(`${'a1'.repeat(70)}`).code, 'PASSWORD_TOO_LONG');
  assert.equal(validatePassword('onlylettershere'.repeat(1)).code, 'PASSWORD_WEAK');
  assert.equal(validatePassword('123456789012').code, 'PASSWORD_WEAK');
  assert.equal(validatePassword(` ${STRONG}`).code, 'PASSWORD_WHITESPACE');
  assert.equal(
    validatePassword('alice-is-here-42', { email: 'alice@example.com' }).code,
    'PASSWORD_CONTAINS_EMAIL',
  );
  // A very short local part is not treated as a meaningful match.
  assert.equal(validatePassword('ab-is-here-42', { email: 'ab@example.com' }).ok, true);
  assert.equal(validatePassword('').code, 'PASSWORD_REQUIRED');
});

// ---------------- registration ----------------

test('registration normalizes the email, sends verification and never returns the password', async () => {
  const provider = fakeProvider();
  const result = await service(provider).register({
    email: '  New@Example.com ',
    password: STRONG,
    remember: true,
    continueUrl: 'https://example.org/wallet/',
  });

  assert.equal(result.user.email, 'new@example.com');
  assert.equal(result.user.uid, 'uid-1');
  assert.equal(result.needsVerification, true);
  assert.equal(result.verificationSent, true);
  assert.equal(result.warning, '');
  assert.deepEqual(provider.calls, [
    ['setPersistence', true],
    ['register', 'new@example.com', STRONG],
    ['sendVerificationEmail', 'https://example.org/wallet/'],
  ]);
  assert.equal(JSON.stringify(result).includes(STRONG), false, 'the password must not be returned');
});

test('a duplicate account is reported as EMAIL_IN_USE and no verification is sent', async () => {
  const provider = fakeProvider({
    register: () => { throw Object.assign(new Error('firebase detail'), { code: 'auth/email-already-in-use' }); },
  });
  await assert.rejects(
    service(provider).register({ email: 'used@example.com', password: STRONG }),
    (error) => {
      assert.equal(error.code, 'EMAIL_IN_USE');
      // Provider detail stays out of the text shown to the visitor.
      assert.equal(error.message.includes('firebase detail'), false);
      return true;
    },
  );
  assert.equal(provider.calls.some(([name]) => name === 'sendVerificationEmail'), false);
});

test('a weak password is rejected before any provider call', async () => {
  const provider = fakeProvider();
  await assert.rejects(
    service(provider).register({ email: 'user@example.com', password: 'short' }),
    hasCode('PASSWORD_TOO_SHORT'),
  );
  assert.deepEqual(provider.calls, []);
});

test('a verification-email failure leaves the created account usable and explains the warning', async () => {
  const provider = fakeProvider({
    sendVerificationEmail: () => { throw Object.assign(new Error('x'), { code: 'auth/network-request-failed' }); },
  });
  const result = await service(provider).register({
    email: 'user@example.com',
    password: STRONG,
  });
  assert.equal(result.user.uid, 'uid-1');
  assert.equal(result.verificationSent, false);
  assert.match(result.warning, /account was created/i);
  assert.match(result.warning, /network/i);
});

test('an injected breach check can refuse a password, and an outage does not block sign-up', async () => {
  const breached = fakeProvider();
  await assert.rejects(
    service(breached, { breachCheck: async () => true })
      .register({ email: 'user@example.com', password: STRONG }),
    hasCode('PASSWORD_BREACHED'),
  );
  assert.deepEqual(breached.calls, []);

  const outage = fakeProvider();
  const result = await service(outage, { breachCheck: async () => { throw new Error('service down'); } })
    .register({ email: 'user@example.com', password: STRONG });
  assert.equal(result.user.uid, 'uid-1');
});

// ---------------- sign-in ----------------

test('sign-in reports verification state and applies the remember-device choice first', async () => {
  const provider = fakeProvider({
    signIn: ({ email }) => fakeUser({ email, emailVerified: true }),
  });
  const verified = await service(provider).signIn({
    email: ' User@Example.com ',
    password: STRONG,
    remember: false,
  });
  assert.equal(verified.needsVerification, false);
  assert.equal(verified.emailVerified, true);
  assert.deepEqual(provider.calls, [
    ['setPersistence', false],
    ['signIn', 'user@example.com', STRONG],
  ]);

  const unverifiedProvider = fakeProvider();
  const unverified = await service(unverifiedProvider).signIn({
    email: 'user@example.com',
    password: STRONG,
  });
  assert.equal(unverified.needsVerification, true);
});

test('wrong credentials are reported without revealing whether the account exists', async () => {
  const provider = fakeProvider({
    signIn: () => { throw Object.assign(new Error('wrong'), { code: 'auth/invalid-credential' }); },
  });
  await assert.rejects(
    service(provider).signIn({ email: 'user@example.com', password: STRONG }),
    (error) => {
      assert.equal(error.code, 'INVALID_CREDENTIALS');
      assert.equal(error.userMessage, 'Email or password is incorrect.');
      return true;
    },
  );
});

test('a too-many-requests error is marked retryable and does not mention credentials', async () => {
  const provider = fakeProvider({
    signIn: () => { throw Object.assign(new Error('quota'), { code: 'auth/too-many-requests' }); },
  });
  await assert.rejects(
    service(provider).signIn({ email: 'user@example.com', password: STRONG }),
    (error) => {
      assert.equal(error.code, 'TOO_MANY_REQUESTS');
      assert.equal(error.retryable, true);
      assert.equal(/password/i.test(error.userMessage), false);
      return true;
    },
  );
});

// ---------------- reset ----------------

test('a reset request answers with the same neutral text and normalizes the address', async () => {
  const provider = fakeProvider();
  const result = await service(provider).sendPasswordReset(' USER@example.com ');
  assert.equal(result.message, RESET_NEUTRAL_MESSAGE);
  assert.deepEqual(provider.calls, [['sendPasswordReset', 'user@example.com', '']]);
});

test('a missing account is indistinguishable from a sent reset', async () => {
  const provider = fakeProvider({
    sendPasswordReset: () => { throw Object.assign(new Error('nope'), { code: 'auth/user-not-found' }); },
  });
  const result = await service(provider).sendPasswordReset('nobody@example.com');
  assert.equal(result.message, RESET_NEUTRAL_MESSAGE);
});

test('a reset request surfaces network failures instead of pretending it was sent', async () => {
  const provider = fakeProvider({
    sendPasswordReset: () => { throw Object.assign(new Error('offline'), { code: 'auth/network-request-failed' }); },
  });
  await assert.rejects(
    service(provider).sendPasswordReset('user@example.com'),
    hasCode('NETWORK'),
  );
});

test('completing a reset enforces the password policy before the provider and rejects a malformed code', async () => {
  const provider = fakeProvider();
  await assert.rejects(
    service(provider).confirmPasswordReset({ code: '', newPassword: STRONG }),
    hasCode('RESET_CODE_REQUIRED'),
  );
  await assert.rejects(
    service(provider).confirmPasswordReset({ code: 'abc', newPassword: 'short' }),
    hasCode('PASSWORD_TOO_SHORT'),
  );
  assert.deepEqual(provider.calls, []);

  const result = await service(provider).confirmPasswordReset({ code: 'abc', newPassword: STRONG });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(provider.calls, [['confirmPasswordReset', 'abc', STRONG]]);
});

test('an expired or reused reset code maps to a clear, non-technical message', async () => {
  const provider = fakeProvider({
    confirmPasswordReset: () => { throw Object.assign(new Error('used'), { code: 'auth/invalid-action-code' }); },
  });
  await assert.rejects(
    service(provider).confirmPasswordReset({ code: 'abc', newPassword: STRONG }),
    (error) => {
      assert.equal(error.code, 'RESET_INVALID');
      assert.match(error.userMessage, /invalid or was already used/i);
      return true;
    },
  );
});

// ---------------- verification ----------------

test('resending verification refuses a signed-out session and is a no-op when already verified', async () => {
  const signedOut = fakeProvider();
  await assert.rejects(
    service(signedOut).resendVerification(),
    hasCode('NOT_SIGNED_IN'),
  );

  const verified = fakeProvider({ state: { user: fakeUser({ emailVerified: true }) } });
  const result = await service(verified).resendVerification();
  assert.deepEqual(result, { sent: false, alreadyVerified: true });
  assert.equal(verified.calls.some(([name]) => name === 'sendVerificationEmail'), false);

  const pending = fakeProvider({ state: { user: fakeUser({ emailVerified: false }) } });
  const sent = await service(pending).resendVerification({ continueUrl: 'https://example.org/wallet/' });
  assert.deepEqual(sent, { sent: true, alreadyVerified: false });
  assert.deepEqual(pending.calls, [
    ['reload'],
    ['sendVerificationEmail', 'https://example.org/wallet/'],
  ]);
});

// ---------------- change password ----------------

test('changing a password reauthenticates with the current one before updating it', async () => {
  const provider = fakeProvider({ state: { user: fakeUser({ emailVerified: true }) } });
  const result = await service(provider).changePassword({
    currentPassword: 'old-password-42',
    newPassword: STRONG,
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(provider.calls, [
    ['reauthenticate', 'user@example.com', 'old-password-42'],
    ['updatePassword', STRONG],
  ]);
});

test('changing a password requires a session, the current password, and a different new password', async () => {
  await assert.rejects(
    service(fakeProvider()).changePassword({ currentPassword: 'x', newPassword: STRONG }),
    hasCode('NOT_SIGNED_IN'),
  );

  const provider = fakeProvider({ state: { user: fakeUser() } });
  await assert.rejects(
    service(provider).changePassword({ currentPassword: '', newPassword: STRONG }),
    hasCode('CURRENT_PASSWORD_REQUIRED'),
  );
  await assert.rejects(
    service(provider).changePassword({ currentPassword: STRONG, newPassword: STRONG }),
    hasCode('PASSWORD_UNCHANGED'),
  );
  await assert.rejects(
    service(provider).changePassword({ currentPassword: 'old-password-42', newPassword: 'short' }),
    hasCode('PASSWORD_TOO_SHORT'),
  );
  assert.deepEqual(provider.calls, []);
});

test('a wrong current password fails at reauthentication and never updates the password', async () => {
  const provider = fakeProvider({
    state: { user: fakeUser() },
    reauthenticate: () => { throw Object.assign(new Error('wrong'), { code: 'auth/wrong-password' }); },
  });
  await assert.rejects(
    service(provider).changePassword({ currentPassword: 'wrong-pass-42', newPassword: STRONG }),
    hasCode('INVALID_CREDENTIALS'),
  );
  assert.equal(provider.calls.some(([name]) => name === 'updatePassword'), false);
});

test('changing an email requires a session, a different valid address and the current password', async () => {
  await assert.rejects(
    service(fakeProvider()).changeEmail({ currentPassword: 'x', newEmail: 'new@example.com' }),
    hasCode('NOT_SIGNED_IN'),
  );

  const provider = fakeProvider({ state: { user: fakeUser({ emailVerified: true }) } });
  await assert.rejects(
    service(provider).changeEmail({ currentPassword: 'old-42', newEmail: 'not-an-email' }),
    hasCode('EMAIL_INVALID'),
  );
  await assert.rejects(
    service(provider).changeEmail({ currentPassword: 'old-42', newEmail: 'user@example.com' }),
    hasCode('EMAIL_UNCHANGED'),
  );
  await assert.rejects(
    service(provider).changeEmail({ currentPassword: '', newEmail: 'new@example.com' }),
    hasCode('CURRENT_PASSWORD_REQUIRED'),
  );
  assert.deepEqual(provider.calls, []);
});

test('changing an email reauthenticates first and verifies the new address without switching it yet', async () => {
  const provider = fakeProvider({ state: { user: fakeUser({ emailVerified: true }) } });
  const result = await service(provider).changeEmail({
    currentPassword: 'old-42',
    newEmail: ' New@Example.com ',
    continueUrl: 'https://example.org/wallet/',
  });

  assert.equal(result.requested, true);
  assert.equal(result.pendingEmail, 'new@example.com');
  assert.match(result.message, /current address stays active/i);
  assert.deepEqual(provider.calls, [
    ['reauthenticate', 'user@example.com', 'old-42'],
    ['verifyBeforeUpdateEmail', 'new@example.com', 'https://example.org/wallet/'],
  ]);
});

test('a duplicate address during an email change is reported without provider detail', async () => {
  const provider = fakeProvider({
    state: { user: fakeUser() },
    verifyBeforeUpdateEmail: () => {
      throw Object.assign(new Error('taken'), { code: 'auth/email-already-in-use' });
    },
  });
  await assert.rejects(
    service(provider).changeEmail({ currentPassword: 'old-42', newEmail: 'taken@example.com' }),
    (error) => {
      assert.equal(error.code, 'EMAIL_IN_USE');
      assert.equal(error.message.includes('taken'), false);
      return true;
    },
  );
});

test('error text never contains the password that was submitted', async () => {
  const provider = fakeProvider({
    register: () => { throw Object.assign(new Error('boom'), { code: 'auth/email-already-in-use' }); },
  });
  try {
    await service(provider).register({ email: 'user@example.com', password: STRONG });
    assert.fail('expected a rejection');
  } catch (error) {
    assert.equal(JSON.stringify(error.message).includes(STRONG), false);
    assert.equal(describeEmailAuthError(error).includes(STRONG), false);
  }
});

// ---------------- Firebase adapter glue ----------------

function fakeSdk() {
  const calls = [];
  const sdk = {
    calls,
    browserLocalPersistence: 'local',
    browserSessionPersistence: 'session',
    EmailAuthProvider: {
      credential: (email, password) => {
        calls.push(['credential', email, password]);
        return { email, password };
      },
    },
    async setPersistence(auth, mode) { calls.push(['setPersistence', auth, mode]); },
    async createUserWithEmailAndPassword(auth, email, password) {
      calls.push(['createUserWithEmailAndPassword', auth, email, password]);
      return { user: { uid: 'u', email, emailVerified: false, providerData: [{ providerId: 'password' }] } };
    },
    async signInWithEmailAndPassword(auth, email, password) {
      calls.push(['signInWithEmailAndPassword', auth, email, password]);
      return { user: { uid: 'u', email, emailVerified: true, providerData: [{ providerId: 'password' }] } };
    },
    async signOut(auth) { calls.push(['signOut', auth]); },
    async reload(user) { calls.push(['reload', user]); },
    async getIdToken(user, forceRefresh) { calls.push(['getIdToken', user, forceRefresh]); },
    async sendEmailVerification(user, settings) { calls.push(['sendEmailVerification', user, settings]); },
    async sendPasswordResetEmail(auth, email, settings) { calls.push(['sendPasswordResetEmail', auth, email, settings]); },
    async confirmPasswordReset(auth, code, password) { calls.push(['confirmPasswordReset', auth, code, password]); },
    async reauthenticateWithCredential(user, credential) { calls.push(['reauthenticateWithCredential', user, credential]); },
    async updatePassword(user, password) { calls.push(['updatePassword', user, password]); },
    async verifyBeforeUpdateEmail(user, email, settings) { calls.push(['verifyBeforeUpdateEmail', user, email, settings]); },
  };
  return sdk;
}

test('the Firebase adapter maps every operation to the documented SDK call', async () => {
  const auth = { name: 'auth', currentUser: null };
  const sdk = fakeSdk();
  const provider = createFirebaseEmailAuthProvider({ auth, authSdk: sdk });

  const user = await provider.register({ email: 'user@example.com', password: STRONG });
  assert.equal(user.email, 'user@example.com');
  assert.deepEqual(user.providerIds, ['password']);
  auth.currentUser = user;

  await provider.setPersistence(true);
  await provider.setPersistence(false);

  const signedIn = await provider.signIn({ email: 'user@example.com', password: STRONG });
  assert.equal(signedIn.emailVerified, true);

  const reloaded = await provider.reload();
  assert.equal(reloaded.email, 'user@example.com');

  await provider.sendVerificationEmail({ continueUrl: 'https://example.org/wallet/' });
  await provider.sendVerificationEmail({});
  await provider.sendPasswordReset('user@example.com', { continueUrl: '' });
  await provider.confirmPasswordReset('code-1', STRONG);
  await provider.reauthenticate({ email: 'user@example.com', password: 'old-42' });
  await provider.updatePassword(STRONG);
  await provider.verifyBeforeUpdateEmail('new@example.com', { continueUrl: 'https://example.org/wallet/' });

  const names = sdk.calls.map(([name]) => name);
  assert.deepEqual(names, [
    'createUserWithEmailAndPassword',
    'setPersistence',
    'setPersistence',
    'signInWithEmailAndPassword',
    'reload',
    'getIdToken',
    'sendEmailVerification',
    'sendEmailVerification',
    'sendPasswordResetEmail',
    'confirmPasswordReset',
    'credential',
    'reauthenticateWithCredential',
    'updatePassword',
    'verifyBeforeUpdateEmail',
  ]);
  assert.deepEqual(sdk.calls[1], ['setPersistence', auth, 'local']);
  assert.deepEqual(sdk.calls[2], ['setPersistence', auth, 'session']);
  assert.deepEqual(sdk.calls[5], ['getIdToken', auth.currentUser, true]);
  assert.deepEqual(sdk.calls[6][2], { url: 'https://example.org/wallet/' });
  assert.equal(sdk.calls[7][2], undefined);
});

test('the Firebase adapter refuses to exist without the functions it needs', () => {
  assert.throws(
    () => createFirebaseEmailAuthProvider({ auth: {}, authSdk: {} }),
    /missing createUserWithEmailAndPassword/,
  );
  assert.throws(() => createFirebaseEmailAuthProvider({}), /needs an auth instance/);
});
