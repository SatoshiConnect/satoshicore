// Email/password authentication for the website account.
//
// The core is provider-agnostic on purpose: `createEmailAuth({ provider })`
// implements validation, policy, error mapping and the operation order, while a
// thin adapter talks to Firebase. That keeps every rule below testable in Node
// without a live Firebase project, an API key, or an inbox.
//
// What this module does NOT do:
//   - it does not hash passwords; the provider does (Firebase uses its own
//     server-side hashing, never this code);
//   - it does not issue or validate reset/verification tokens; the provider
//     mints short-lived, single-use action codes and its hosted action page
//     consumes them;
//   - it is not a brute-force control. Client-side throttling is not a security
//     boundary; provider-side protection must be verified separately.
//
// Sign-in is allowed before the email is verified so the visitor is never locked
// out of their own account, but `needsVerification` is returned and the site's
// Firestore rules already refuse profile/contact writes without
// `email_verified`. See docs/messenger/MEMBERSHIP_FEATURE_CHECKLIST.md (A1.3).

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
export const EMAIL_MAX_LENGTH = 254;

// Deliberately conservative: one @, no whitespace, a dot in the domain. The
// provider performs the authoritative check; this only stops obvious typos
// before a network round trip.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const RESET_NEUTRAL_MESSAGE =
  'If an account exists for that address, a password reset link is on its way.';

/** Trim and lowercase; the address is stored/compared in this form only. */
export function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * `{ ok: true, email }` or `{ ok: false, code, message, email }`.
 * Messages are shown to the visitor and never include the password.
 */
export function validateEmail(value) {
  const email = normalizeEmail(value);
  if (!email) {
    return { ok: false, code: 'EMAIL_REQUIRED', message: 'Enter your email address.', email };
  }
  if (email.length > EMAIL_MAX_LENGTH) {
    return { ok: false, code: 'EMAIL_TOO_LONG', message: 'That email address is too long.', email };
  }
  if (!EMAIL_RE.test(email)) {
    return { ok: false, code: 'EMAIL_INVALID', message: 'That does not look like an email address.', email };
  }
  return { ok: true, email };
}

/**
 * Password policy. Applied before every create/reset/change request, so a weak
 * password never reaches the provider.
 *
 * Rules: 12–128 characters, at least one letter and one digit, no leading or
 * trailing whitespace, and not containing the email name (when it is long
 * enough to be meaningful). A breach check is a separate injected hook because
 * it requires a real compromised-password service.
 */
export function validatePassword(value, { email = '' } = {}) {
  const password = typeof value === 'string' ? value : '';
  if (!password) {
    return { ok: false, code: 'PASSWORD_REQUIRED', message: 'Enter a password.' };
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    return {
      ok: false,
      code: 'PASSWORD_TOO_SHORT',
      message: `Use at least ${PASSWORD_MIN_LENGTH} characters.`,
    };
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return {
      ok: false,
      code: 'PASSWORD_TOO_LONG',
      message: `Use at most ${PASSWORD_MAX_LENGTH} characters.`,
    };
  }
  if (password.trim() !== password) {
    return {
      ok: false,
      code: 'PASSWORD_WHITESPACE',
      message: 'Do not start or end the password with a space.',
    };
  }
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    return {
      ok: false,
      code: 'PASSWORD_WEAK',
      message: 'Include at least one letter and one number.',
    };
  }
  const local = normalizeEmail(email).split('@')[0];
  if (local.length >= 3 && password.toLowerCase().includes(local)) {
    return {
      ok: false,
      code: 'PASSWORD_CONTAINS_EMAIL',
      message: 'The password must not contain the email name.',
    };
  }
  return { ok: true };
}

// Provider errors → stable codes and visitor-safe text. Raw provider messages
// are never shown (they can echo details) and never logged with the password.
const PROVIDER_ERRORS = {
  'auth/email-already-in-use': {
    code: 'EMAIL_IN_USE',
    message: 'An account already exists for that email. Sign in or reset the password.',
  },
  'auth/invalid-email': {
    code: 'EMAIL_INVALID',
    message: 'That does not look like an email address.',
  },
  'auth/weak-password': {
    code: 'PASSWORD_WEAK',
    message: 'The provider rejected that password as too weak. Use at least 12 characters with a letter and a number.',
  },
  'auth/user-not-found': {
    code: 'ACCOUNT_NOT_FOUND',
    message: 'Email or password is incorrect.',
  },
  'auth/wrong-password': {
    code: 'INVALID_CREDENTIALS',
    message: 'Email or password is incorrect.',
  },
  'auth/invalid-credential': {
    code: 'INVALID_CREDENTIALS',
    message: 'Email or password is incorrect.',
  },
  'auth/too-many-requests': {
    code: 'TOO_MANY_REQUESTS',
    message: 'Too many attempts. Wait a few minutes and try again.',
    retryable: true,
  },
  'auth/network-request-failed': {
    code: 'NETWORK',
    message: 'The network request failed. Check your connection and try again.',
    retryable: true,
  },
  'auth/requires-recent-login': {
    code: 'REAUTH_REQUIRED',
    message: 'For security, sign in again before changing the password.',
  },
  'auth/operation-not-allowed': {
    code: 'PROVIDER_DISABLED',
    message: 'Email and password sign-in is not enabled for this project yet.',
  },
  'auth/user-disabled': {
    code: 'ACCOUNT_DISABLED',
    message: 'This account has been disabled.',
  },
  'auth/expired-action-code': {
    code: 'RESET_EXPIRED',
    message: 'That reset link has expired. Request a new one.',
  },
  'auth/invalid-action-code': {
    code: 'RESET_INVALID',
    message: 'That reset link is invalid or was already used. Request a new one.',
  },
  'auth/missing-email': {
    code: 'EMAIL_REQUIRED',
    message: 'Enter your email address.',
  },
  'auth/missing-password': {
    code: 'PASSWORD_REQUIRED',
    message: 'Enter your password.',
  },
};

export function emailAuthFailure(code, message, { retryable = false, cause } = {}) {
  const error = new Error(message);
  error.code = code;
  error.userMessage = message;
  error.retryable = Boolean(retryable);
  if (cause) error.cause = cause;
  return error;
}

export function mapEmailAuthError(error) {
  const firebaseCode = String(error?.code || '');
  const known = PROVIDER_ERRORS[firebaseCode];
  if (known) return { ...known, firebaseCode };
  return {
    code: 'AUTH_FAILED',
    message: 'Sign-in failed. Try again.',
    retryable: false,
    firebaseCode,
  };
}

/** Visitor-safe text for any error the service or provider throws. */
export function describeEmailAuthError(error) {
  if (error?.userMessage) return error.userMessage;
  return mapEmailAuthError(error).message;
}

function rethrowMapped(error) {
  if (error?.userMessage) return error;
  const mapped = mapEmailAuthError(error);
  return emailAuthFailure(mapped.code, mapped.message, {
    retryable: mapped.retryable,
    cause: error,
  });
}

function publicUser(user) {
  if (!user || typeof user !== 'object') return null;
  return {
    uid: String(user.uid || ''),
    email: normalizeEmail(user.email || ''),
    displayName: String(user.displayName || ''),
    emailVerified: Boolean(user.emailVerified),
    providerIds: Array.isArray(user.providerIds) ? [...user.providerIds] : [],
  };
}

function requireMethod(provider, name) {
  if (typeof provider?.[name] !== 'function') {
    throw new Error(`email auth provider is missing ${name}()`);
  }
}

export const EMAIL_AUTH_PROVIDER_METHODS = [
  'register',
  'signIn',
  'signOut',
  'currentUser',
  'reload',
  'sendVerificationEmail',
  'sendPasswordReset',
  'confirmPasswordReset',
  'reauthenticate',
  'updatePassword',
  'verifyBeforeUpdateEmail',
];

/**
 * Build the email/password service around any provider.
 *
 * Provider contract (all async unless noted):
 *   register({ email, password }) -> user
 *   signIn({ email, password }) -> user
 *   signOut() -> void
 *   currentUser() -> user | null                        (sync)
 *   reload() -> user
 *   sendVerificationEmail({ continueUrl }) -> void
 *   sendPasswordReset(email, { continueUrl }) -> void
 *   confirmPasswordReset(code, newPassword) -> void
 *   reauthenticate({ email, password }) -> void
 *   updatePassword(newPassword) -> void
 *   verifyBeforeUpdateEmail(newEmail, { continueUrl }) -> void
 *   setPersistence?(remember) -> void
 *
 * A user is any `{ uid, email, emailVerified, displayName?, providerIds? }`.
 */
export function createEmailAuth({ provider, breachCheck = null } = {}) {
  if (!provider) throw new Error('createEmailAuth needs a provider.');
  for (const name of EMAIL_AUTH_PROVIDER_METHODS) requireMethod(provider, name);

  async function setPersistence(remember) {
    if (typeof provider.setPersistence !== 'function') return;
    try {
      await provider.setPersistence(Boolean(remember));
    } catch (error) {
      throw emailAuthFailure(
        'PERSISTENCE_FAILED',
        'Could not set how this browser remembers the sign-in. Try again.',
        { cause: error },
      );
    }
  }

  async function run(operation) {
    try {
      return await operation();
    } catch (error) {
      throw rethrowMapped(error);
    }
  }

  async function checkBreach(password) {
    if (typeof breachCheck !== 'function') return false;
    try {
      return Boolean(await breachCheck(password));
    } catch {
      // A breach service outage must not block a legitimate sign-up silently
      // claiming the password is safe: fall through as "not known breached"
      // and let the provider policy decide. The unverified status is reported
      // in the checklist, not hidden here.
      return false;
    }
  }

  return {
    /** Create the account, then request verification. Registration stands even
     *  if the verification email cannot be sent; `warning` says so. */
    async register({ email, password, remember = false, continueUrl = '' } = {}) {
      const checkedEmail = validateEmail(email);
      if (!checkedEmail.ok) throw emailAuthFailure(checkedEmail.code, checkedEmail.message);
      const checkedPassword = validatePassword(password, { email: checkedEmail.email });
      if (!checkedPassword.ok) {
        throw emailAuthFailure(checkedPassword.code, checkedPassword.message);
      }
      if (await checkBreach(password)) {
        throw emailAuthFailure(
          'PASSWORD_BREACHED',
          'That password appears in a known data breach. Choose a different one.',
        );
      }

      await setPersistence(remember);
      const user = await run(() => provider.register({
        email: checkedEmail.email,
        password,
      }));
      const safe = publicUser(user);

      let verificationSent = false;
      let warning = '';
      try {
        await provider.sendVerificationEmail({ continueUrl });
        verificationSent = true;
      } catch (error) {
        warning = `The account was created, but the verification email could not be sent: ${describeEmailAuthError(error)}`;
      }

      return {
        user: safe,
        emailVerified: Boolean(safe?.emailVerified),
        needsVerification: !safe?.emailVerified,
        verificationSent,
        warning,
      };
    },

    async signIn({ email, password, remember = false } = {}) {
      const checkedEmail = validateEmail(email);
      if (!checkedEmail.ok) throw emailAuthFailure(checkedEmail.code, checkedEmail.message);
      if (!password) {
        throw emailAuthFailure('PASSWORD_REQUIRED', 'Enter your password.');
      }
      await setPersistence(remember);
      const user = await run(() => provider.signIn({
        email: checkedEmail.email,
        password,
      }));
      const safe = publicUser(user);
      return {
        user: safe,
        emailVerified: Boolean(safe?.emailVerified),
        needsVerification: !safe?.emailVerified,
      };
    },

    async signOut() {
      await run(() => provider.signOut());
    },

    /** Re-read the provider record; verification links are applied out of band. */
    async refreshVerification() {
      const user = await run(() => provider.reload());
      const safe = publicUser(user);
      return { user: safe, emailVerified: Boolean(safe?.emailVerified) };
    },

    async resendVerification({ continueUrl = '' } = {}) {
      const current = await run(() => provider.reload());
      const safe = publicUser(current);
      if (!safe?.uid) throw emailAuthFailure('NOT_SIGNED_IN', 'Sign in first.');
      if (safe.emailVerified) return { sent: false, alreadyVerified: true };
      await run(() => provider.sendVerificationEmail({ continueUrl }));
      return { sent: true, alreadyVerified: false };
    },

    /** Always answers with the same neutral text when the account may not exist,
     *  so the form cannot be used to enumerate registered addresses. */
    async sendPasswordReset(email, { continueUrl = '' } = {}) {
      const checkedEmail = validateEmail(email);
      if (!checkedEmail.ok) throw emailAuthFailure(checkedEmail.code, checkedEmail.message);
      try {
        await provider.sendPasswordReset(checkedEmail.email, { continueUrl });
      } catch (error) {
        // A missing account is answered exactly like a sent email. Any other
        // failure (network, provider disabled, rate limit) is surfaced.
        if (error?.code !== 'ACCOUNT_NOT_FOUND' && error?.code !== 'auth/user-not-found') {
          throw rethrowMapped(error);
        }
      }
      return { sent: true, message: RESET_NEUTRAL_MESSAGE };
    },

    /** Complete a provider-issued reset code. The provider owns expiry and
     *  single-use semantics; this only enforces the local password policy. */
    async confirmPasswordReset({ code, newPassword } = {}) {
      const actionCode = String(code ?? '').trim();
      if (!actionCode || actionCode.length > 2048) {
        throw emailAuthFailure(
          'RESET_CODE_REQUIRED',
          'That reset link is invalid. Request a new one.',
        );
      }
      const checkedPassword = validatePassword(newPassword);
      if (!checkedPassword.ok) {
        throw emailAuthFailure(checkedPassword.code, checkedPassword.message);
      }
      await run(() => provider.confirmPasswordReset(actionCode, newPassword));
      return { ok: true };
    },

    /** Change the password of the signed-in account after proving the current one.
     *  Reauthentication happens before the update so a stolen session alone
     *  cannot rotate the credential. */
    async changePassword({ currentPassword, newPassword } = {}) {
      const current = provider.currentUser();
      const safe = publicUser(current);
      if (!safe?.uid) throw emailAuthFailure('NOT_SIGNED_IN', 'Sign in first.');
      if (!safe.email) {
        throw emailAuthFailure(
          'NO_PASSWORD_ACCOUNT',
          'This account does not use an email and password.',
        );
      }
      if (!currentPassword) {
        throw emailAuthFailure('CURRENT_PASSWORD_REQUIRED', 'Enter your current password.');
      }
      const checkedPassword = validatePassword(newPassword, { email: safe.email });
      if (!checkedPassword.ok) {
        throw emailAuthFailure(checkedPassword.code, checkedPassword.message);
      }
      if (currentPassword === newPassword) {
        throw emailAuthFailure(
          'PASSWORD_UNCHANGED',
          'The new password must be different from the current one.',
        );
      }
      await run(() => provider.reauthenticate({
        email: safe.email,
        password: currentPassword,
      }));
      await run(() => provider.updatePassword(newPassword));
      return { ok: true };
    },

    /** Request an email change. The provider sends a verification link to the
     *  NEW address; the current address stays active until that link is used,
     *  so a typo cannot lock the owner out. Requires the current password. */
    async changeEmail({ currentPassword, newEmail, continueUrl = '' } = {}) {
      const current = provider.currentUser();
      const safe = publicUser(current);
      if (!safe?.uid) throw emailAuthFailure('NOT_SIGNED_IN', 'Sign in first.');
      if (!safe.email) {
        throw emailAuthFailure(
          'NO_PASSWORD_ACCOUNT',
          'This account does not use an email and password.',
        );
      }
      const checkedEmail = validateEmail(newEmail);
      if (!checkedEmail.ok) throw emailAuthFailure(checkedEmail.code, checkedEmail.message);
      if (checkedEmail.email === safe.email) {
        throw emailAuthFailure('EMAIL_UNCHANGED', 'The new address must be different from the current one.');
      }
      if (!currentPassword) {
        throw emailAuthFailure('CURRENT_PASSWORD_REQUIRED', 'Enter your current password.');
      }
      await run(() => provider.reauthenticate({
        email: safe.email,
        password: currentPassword,
      }));
      await run(() => provider.verifyBeforeUpdateEmail(checkedEmail.email, { continueUrl }));
      return {
        requested: true,
        pendingEmail: checkedEmail.email,
        message: 'Check the new address for a verification link. The current address stays active until that link is opened.',
      };
    },
  };
}

const FIREBASE_METHODS = [
  'createUserWithEmailAndPassword',
  'signInWithEmailAndPassword',
  'signOut',
  'sendEmailVerification',
  'sendPasswordResetEmail',
  'confirmPasswordReset',
  'reload',
  'updatePassword',
  'reauthenticateWithCredential',
  'verifyBeforeUpdateEmail',
  'EmailAuthProvider',
  'browserLocalPersistence',
  'browserSessionPersistence',
  'setPersistence',
];

function firebasePublicUser(user) {
  if (!user) return null;
  return {
    uid: String(user.uid || ''),
    email: normalizeEmail(user.email || ''),
    displayName: String(user.displayName || ''),
    emailVerified: Boolean(user.emailVerified),
    providerIds: Array.isArray(user.providerData)
      ? user.providerData.map((entry) => String(entry?.providerId || '')).filter(Boolean)
      : [],
  };
}

function actionSettings(continueUrl) {
  return continueUrl ? { url: continueUrl } : undefined;
}

/**
 * Thin Firebase adapter. Everything it needs is injected, so the glue (which
 * Firebase function receives which argument) is covered by tests with a fake
 * SDK and no network.
 */
export function createFirebaseEmailAuthProvider({ auth, authSdk } = {}) {
  if (!auth) throw new Error('createFirebaseEmailAuthProvider needs an auth instance.');
  for (const name of FIREBASE_METHODS) {
    if (authSdk?.[name] == null) throw new Error(`Firebase auth SDK is missing ${name}.`);
  }

  const currentUser = () => auth.currentUser || null;

  return {
    currentUser,

    async setPersistence(remember) {
      await authSdk.setPersistence(
        auth,
        remember ? authSdk.browserLocalPersistence : authSdk.browserSessionPersistence,
      );
    },

    async register({ email, password }) {
      const credential = await authSdk.createUserWithEmailAndPassword(auth, email, password);
      return firebasePublicUser(credential?.user);
    },

    async signIn({ email, password }) {
      const credential = await authSdk.signInWithEmailAndPassword(auth, email, password);
      return firebasePublicUser(credential?.user);
    },

    async signOut() {
      await authSdk.signOut(auth);
    },

    async reload() {
      const user = currentUser();
      if (!user) return null;
      await authSdk.reload(user);
      // `reload()` updates the user record, but Firestore rules read the ID
      // token. Force one refresh so a just-verified address is visible to the
      // rules immediately instead of after the next automatic refresh.
      if (typeof authSdk.getIdToken === 'function') {
        try {
          await authSdk.getIdToken(user, true);
        } catch {
          // The reload itself succeeded; a token refresh will retry on the next
          // authenticated request.
        }
      }
      return firebasePublicUser(user);
    },

    async sendVerificationEmail({ continueUrl = '' } = {}) {
      const user = currentUser();
      if (!user) throw emailAuthFailure('NOT_SIGNED_IN', 'Sign in first.');
      await authSdk.sendEmailVerification(user, actionSettings(continueUrl));
    },

    async sendPasswordReset(email, { continueUrl = '' } = {}) {
      await authSdk.sendPasswordResetEmail(auth, email, actionSettings(continueUrl));
    },

    async confirmPasswordReset(code, newPassword) {
      await authSdk.confirmPasswordReset(auth, code, newPassword);
    },

    async reauthenticate({ email, password }) {
      const user = currentUser();
      if (!user) throw emailAuthFailure('NOT_SIGNED_IN', 'Sign in first.');
      const credential = authSdk.EmailAuthProvider.credential(email, password);
      await authSdk.reauthenticateWithCredential(user, credential);
    },

    async updatePassword(newPassword) {
      const user = currentUser();
      if (!user) throw emailAuthFailure('NOT_SIGNED_IN', 'Sign in first.');
      await authSdk.updatePassword(user, newPassword);
    },

    async verifyBeforeUpdateEmail(newEmail, { continueUrl = '' } = {}) {
      const user = currentUser();
      if (!user) throw emailAuthFailure('NOT_SIGNED_IN', 'Sign in first.');
      // Sends the link to the NEW address; the account keeps the old address
      // until it is opened. No admin credential and no server are involved.
      await authSdk.verifyBeforeUpdateEmail(user, newEmail, actionSettings(continueUrl));
    },
  };
}
