'use client';

import { useState } from 'react';
import {
  createEmailAuth,
  createFirebaseEmailAuthProvider,
  describeEmailAuthError,
  PASSWORD_MIN_LENGTH,
  RESET_NEUTRAL_MESSAGE,
} from '../lib/emailAuth';
import { isFirebaseWebConfigured, loadAuthClient } from '../lib/firebaseAuth';

const configured = isFirebaseWebConfigured();

// Verification links come back to the wallet page; the reset email is left to
// the provider's hosted action page, which owns the one-time code.
function walletContinueUrl() {
  return typeof window === 'undefined' ? '' : `${window.location.origin}/wallet/`;
}

async function emailAuthService() {
  const { auth, authSdk } = await loadAuthClient();
  return createEmailAuth({
    provider: createFirebaseEmailAuthProvider({ auth, authSdk }),
  });
}

const readError = (error) => describeEmailAuthError(error);

/**
 * Email/password entry points.
 *
 * `gate`     — sign in, create an account, or request a reset (signed out).
 * `verify`   — resend the verification email for the signed-in account.
 * `password` — change the password and see verification state (settings).
 *
 * The forms never store or log the password. All policy and error mapping live
 * in lib/emailAuth.js so they are tested without Firebase.
 */
export default function EmailAccount({ variant = 'gate', user = null, onVerified = null } = {}) {
  const [mode, setMode] = useState('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [emailPassword, setEmailPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  function resetMessages() {
    setError('');
    setNote('');
  }

  function switchMode(next) {
    if (busy) return;
    setMode(next);
    setPassword('');
    setConfirm('');
    setCurrentPassword('');
    resetMessages();
  }

  async function submitSignIn(event) {
    event.preventDefault();
    setBusy(true);
    resetMessages();
    try {
      const service = await emailAuthService();
      const result = await service.signIn({ email, password, remember });
      setPassword('');
      setNote(result.needsVerification
        ? 'Signed in. Check your inbox — your email is not verified yet, so profile and contact features stay locked until it is.'
        : 'Signed in.');
    } catch (err) {
      setError(readError(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitRegister(event) {
    event.preventDefault();
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setBusy(true);
    resetMessages();
    try {
      const service = await emailAuthService();
      const result = await service.register({
        email,
        password,
        remember,
        continueUrl: walletContinueUrl(),
      });
      setPassword('');
      setConfirm('');
      setNote(result.warning || 'Account created. Check your inbox for the verification link.');
    } catch (err) {
      setError(readError(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitForgot(event) {
    event.preventDefault();
    setBusy(true);
    resetMessages();
    try {
      const service = await emailAuthService();
      const result = await service.sendPasswordReset(email);
      setNote(result.message || RESET_NEUTRAL_MESSAGE);
    } catch (err) {
      setError(readError(err));
    } finally {
      setBusy(false);
    }
  }

  async function resendVerification() {
    setBusy(true);
    resetMessages();
    try {
      const service = await emailAuthService();
      const result = await service.resendVerification({ continueUrl: walletContinueUrl() });
      setNote(result.alreadyVerified
        ? 'This email is already verified.'
        : 'Verification email sent. Check your inbox.');
    } catch (err) {
      setError(readError(err));
    } finally {
      setBusy(false);
    }
  }

  // The verification link is followed in the inbox, so this browser's cached
  // user record does not know about it. Reload from the provider, then tell the
  // parent to refresh the badge instead of leaving a stale "not verified" state.
  async function checkVerification() {
    setBusy(true);
    resetMessages();
    try {
      const service = await emailAuthService();
      const result = await service.refreshVerification();
      if (result.emailVerified) {
        setNote('Email verified.');
        if (typeof onVerified === 'function') onVerified(result.user);
      } else {
        setNote('Not verified yet. Open the link in your inbox, then try again.');
      }
    } catch (err) {
      setError(readError(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitChangeEmail(event) {
    event.preventDefault();
    setBusy(true);
    resetMessages();
    try {
      const service = await emailAuthService();
      const result = await service.changeEmail({
        currentPassword: emailPassword,
        newEmail,
        continueUrl: walletContinueUrl(),
      });
      setNewEmail('');
      setEmailPassword('');
      setNote(result.message);
    } catch (err) {
      setError(readError(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitChangePassword(event) {
    event.preventDefault();
    if (password !== confirm) {
      setError('The two new passwords do not match.');
      return;
    }
    setBusy(true);
    resetMessages();
    try {
      const service = await emailAuthService();
      await service.changePassword({ currentPassword, newPassword: password });
      setCurrentPassword('');
      setPassword('');
      setConfirm('');
      setNote('Password changed. Other devices keep their session until it expires or is revoked.');
    } catch (err) {
      setError(readError(err));
    } finally {
      setBusy(false);
    }
  }

  if (!configured) {
    return (
      <p className="nw-small nw-dim" role="status">
        Email sign-in is not configured in this build.
      </p>
    );
  }

  if (variant === 'verify') {
    if (!user || user.emailVerified) return null;
    return (
      <div className="nw-google-sync" style={{ marginTop: 8 }}>
        <p className="nw-small" role="status" style={{ margin: 0 }}>
          <strong>Verify your email.</strong>{' '}
          <span className="nw-dim">
            Profile and contact features stay locked until the address is verified.
          </span>
        </p>
        <div className="nw-btn-row" style={{ margin: '8px 0 0' }}>
          <button type="button" className="nw-chip-btn" onClick={resendVerification} disabled={busy}>
            {busy ? 'Working…' : 'Resend verification email'}
          </button>
          <button type="button" className="nw-chip-btn" onClick={checkVerification} disabled={busy}>
            I’ve verified — refresh
          </button>
        </div>
        {note ? <p className="nw-small nw-dim" role="status" style={{ margin: '6px 0 0' }}>{note}</p> : null}
        {error ? <p className="nw-small nw-google-error" role="alert" style={{ margin: '6px 0 0' }}>{error}</p> : null}
      </div>
    );
  }

  if (variant === 'password') {
    if (!user || !user.providerIds?.includes('password')) return null;
    return (
      <div className="nw-google-sync">
        <div className="nw-kv">
          <span className="nw-k">Password</span>
          <span className="nw-v nw-small">
            {user.emailVerified ? 'email verified' : 'email not verified'}
          </span>
        </div>
        {!user.emailVerified ? (
          <div className="nw-btn-row" style={{ margin: '8px 0 0' }}>
            <button type="button" className="nw-chip-btn" onClick={resendVerification} disabled={busy}>
              {busy ? 'Working…' : 'Resend verification email'}
            </button>
            <button type="button" className="nw-chip-btn" onClick={checkVerification} disabled={busy}>
              I’ve verified — refresh
            </button>
          </div>
        ) : null}
        <form onSubmit={submitChangePassword} style={{ marginTop: 10 }}>
          <label className="nw-label" htmlFor="nw-cur-pass">Current password</label>
          <input id="nw-cur-pass" type="password" autoComplete="current-password"
            value={currentPassword} disabled={busy}
            onChange={(e) => setCurrentPassword(e.target.value)} required />
          <label className="nw-label" htmlFor="nw-new-pass">New password ({PASSWORD_MIN_LENGTH}+ characters)</label>
          <input id="nw-new-pass" type="password" autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH}
            value={password} disabled={busy}
            onChange={(e) => setPassword(e.target.value)} required />
          <label className="nw-label" htmlFor="nw-new-pass2">Confirm new password</label>
          <input id="nw-new-pass2" type="password" autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH}
            value={confirm} disabled={busy}
            onChange={(e) => setConfirm(e.target.value)} required />
          <div className="nw-btn-row" style={{ margin: '8px 0 0' }}>
            <button type="submit" className="nw-chip-btn" disabled={busy}>
              {busy ? 'Changing…' : 'Change password'}
            </button>
          </div>
        </form>
        <p className="nw-small nw-dim" style={{ margin: '8px 0 0' }}>
          Changing the password needs the current one. The wallet password is separate and is
          not changed here.
        </p>

        <details style={{ marginTop: 12 }}>
          <summary className="nw-small" style={{ cursor: 'pointer' }}>Change email address</summary>
          <form onSubmit={submitChangeEmail} style={{ marginTop: 10 }}>
            <label className="nw-label" htmlFor="nw-new-email">New email</label>
            <input id="nw-new-email" type="email" autoComplete="email" spellCheck={false}
              value={newEmail} disabled={busy}
              onChange={(e) => setNewEmail(e.target.value)} required />
            <label className="nw-label" htmlFor="nw-email-pass-cur">Current password</label>
            <input id="nw-email-pass-cur" type="password" autoComplete="current-password"
              value={emailPassword} disabled={busy}
              onChange={(e) => setEmailPassword(e.target.value)} required />
            <div className="nw-btn-row" style={{ margin: '8px 0 0' }}>
              <button type="submit" className="nw-chip-btn" disabled={busy}>
                {busy ? 'Sending…' : 'Send verification link'}
              </button>
            </div>
          </form>
          <p className="nw-small nw-dim" style={{ margin: '8px 0 0' }}>
            The link goes to the new address. The current address stays active until that link
            is opened, so a typo cannot lock you out.
          </p>
        </details>

        {note ? <p className="nw-small nw-dim" role="status" style={{ margin: '6px 0 0' }}>{note}</p> : null}
        {error ? <p className="nw-small nw-google-error" role="alert" style={{ margin: '6px 0 0' }}>{error}</p> : null}
      </div>
    );
  }

  const submit = mode === 'register' ? submitRegister : mode === 'forgot' ? submitForgot : submitSignIn;

  return (
    <details className="nw-email-account" style={{ marginTop: 12 }}>
      <summary className="nw-small" style={{ cursor: 'pointer' }}>
        {mode === 'register' ? 'Create an email account'
          : mode === 'forgot' ? 'Reset a forgotten password'
            : 'Use an email and password'}
      </summary>
      <form onSubmit={submit} style={{ marginTop: 10 }}>
        <label className="nw-label" htmlFor="nw-email">Email</label>
        <input id="nw-email" type="email" autoComplete="email" spellCheck={false}
          value={email} disabled={busy}
          onChange={(e) => setEmail(e.target.value)} required />

        {mode !== 'forgot' ? (
          <>
            <label className="nw-label" htmlFor="nw-email-pass">Password</label>
            <input id="nw-email-pass" type="password"
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              minLength={mode === 'register' ? PASSWORD_MIN_LENGTH : undefined}
              value={password} disabled={busy}
              onChange={(e) => setPassword(e.target.value)} required />
          </>
        ) : null}

        {mode === 'register' ? (
          <>
            <label className="nw-label" htmlFor="nw-email-pass2">Confirm password</label>
            <input id="nw-email-pass2" type="password" autoComplete="new-password"
              minLength={PASSWORD_MIN_LENGTH} value={confirm} disabled={busy}
              onChange={(e) => setConfirm(e.target.value)} required />
            <p className="nw-small nw-dim" style={{ margin: '6px 0 0' }}>
              {`At least ${PASSWORD_MIN_LENGTH} characters, including a letter and a number. `}
              We never store this password; the account provider hashes it.
            </p>
          </>
        ) : null}

        {mode !== 'forgot' ? (
          <label className="nw-small" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 10 }}>
            <input type="checkbox" checked={remember} disabled={busy}
              onChange={(e) => setRemember(e.target.checked)}
              style={{ marginTop: 2, width: 'auto' }} />
            <span>
              <strong>Remember this device</strong>
              <span className="nw-dim"> — stay signed in on this browser. Do not use on a shared device. This does not unlock the wallet or remember the wallet password.</span>
            </span>
          </label>
        ) : null}

        <div className="nw-btn-row" style={{ margin: '10px 0 0' }}>
          <button type="submit" className="nw-send-btn" disabled={busy}>
            {busy ? 'Working…'
              : mode === 'register' ? 'Create account'
                : mode === 'forgot' ? 'Send reset link' : 'Sign in'}
          </button>
        </div>
      </form>

      <div className="nw-btn-row" style={{ margin: '6px 0 0' }}>
        {mode !== 'signin' ? (
          <button type="button" className="nw-chip-btn" disabled={busy} onClick={() => switchMode('signin')}>
            Back to sign in
          </button>
        ) : null}
        {mode !== 'register' ? (
          <button type="button" className="nw-chip-btn" disabled={busy} onClick={() => switchMode('register')}>
            Create account
          </button>
        ) : null}
        {mode !== 'forgot' ? (
          <button type="button" className="nw-chip-btn" disabled={busy} onClick={() => switchMode('forgot')}>
            Forgot password?
          </button>
        ) : null}
      </div>

      {note ? <p className="nw-small nw-dim" role="status" style={{ margin: '8px 0 0' }}>{note}</p> : null}
      {error ? <p className="nw-small nw-google-error" role="alert" style={{ margin: '8px 0 0' }}>{error}</p> : null}
    </details>
  );
}
