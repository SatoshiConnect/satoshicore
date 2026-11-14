'use client';

import { useEffect, useState } from 'react';
import { isFirebaseWebConfigured, loadGoogleAuth } from '../lib/firebaseAuth';
import {
  currentTheme, disableThemeSync, enableThemeSync, pullThemeForUser,
  syncEnabledFor,
} from '../lib/themeSync';

const configured = isFirebaseWebConfigured();

function friendlyAuthError(error) {
  if (error?.code === 'auth/popup-closed-by-user') return 'Sign-in was cancelled.';
  if (error?.code === 'auth/popup-blocked') return 'The browser blocked the sign-in window. Allow pop-ups and try again.';
  if (error?.code === 'auth/unauthorized-domain') return 'This domain is not authorized yet. Add it under Firebase Authentication → Settings → Authorized domains.';
  if (error?.code === 'auth/operation-not-allowed') return 'Google sign-in is not enabled in the Firebase project yet.';
  return 'Google sign-in failed. Check the Firebase project settings and try again.';
}

export default function GoogleAccount() {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(!configured);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Theme sync is a separate, opt-in choice; signing in alone uploads nothing.
  const [syncOn, setSyncOn] = useState(false);
  const [syncNote, setSyncNote] = useState('');

  useEffect(() => {
    if (!configured) return undefined;
    let unsubscribe = () => {};
    let mounted = true;
    loadGoogleAuth().then(({ auth, authSdk }) => {
      if (!mounted) return;
      unsubscribe = authSdk.onAuthStateChanged(auth, (nextUser) => {
        const uid = nextUser?.uid || '';
        setUser(nextUser ? {
          uid,
          displayName: nextUser.displayName || '',
          email: nextUser.email || '',
        } : null);
        setSyncOn(syncEnabledFor(uid));
        setReady(true);
        // An opted-in account brings its theme to this device. A miss just
        // leaves the local theme as it is.
        if (uid) void pullThemeForUser(uid).catch(() => {});
      }, () => {
        setError('Could not read the Google sign-in session.');
        setReady(true);
      });
    }).catch(() => {
      if (!mounted) return;
      setError('Google sign-in is temporarily unavailable.');
      setReady(true);
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  async function signIn() {
    setBusy(true);
    setError('');
    try {
      const { auth, authSdk } = await loadGoogleAuth();
      const provider = new authSdk.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      await authSdk.signInWithPopup(auth, provider);
    } catch (err) {
      setError(friendlyAuthError(err));
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    setError('');
    try {
      const { auth, authSdk } = await loadGoogleAuth();
      await authSdk.signOut(auth);
    } catch {
      setError('Could not sign out. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function toggleThemeSync() {
    const uid = user?.uid;
    if (!uid) return;
    setBusy(true);
    setError('');
    setSyncNote('');
    try {
      if (syncOn) {
        await disableThemeSync(uid);
        setSyncOn(false);
        setSyncNote('Theme sync off — the stored theme was deleted from your account.');
      } else {
        const result = await enableThemeSync(uid, currentTheme());
        setSyncOn(true);
        setSyncNote(result.source === 'account'
          ? `Theme sync on — the theme saved on your account (${result.theme}) was applied to this device.`
          : `Theme sync on — this device's theme (${result.theme}) was saved to your account.`);
      }
    } catch {
      setError('Could not change theme sync. The site database may not be configured yet.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="nw-card nw-google-account" aria-labelledby="nw-google-account-title">
      <h2 id="nw-google-account-title" style={{ color: 'var(--text)' }}>Website account</h2>
      <p className="nw-small nw-dim" style={{ margin: '8px 0 12px' }}>
        Sign in with Google to identify your website session. This does not unlock,
        back up, or sync your NSAT wallet; its password and signing key stay separate.
      </p>
      {!configured ? (
        <div className="nw-small nw-dim" role="status">
          Google sign-in is not configured in this build yet. Wallet features remain available.
        </div>
      ) : !ready ? (
        <div className="nw-small nw-dim" role="status">Checking sign-in session…</div>
      ) : user ? (
        <div className="nw-google-session">
          <div className="nw-google-user">
            <strong>{user.displayName || 'Google account'}</strong>
            <span className="nw-small nw-dim">{user.email}</span>
          </div>
          <button type="button" className="nw-chip-btn" onClick={signOut} disabled={busy}>
            {busy ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      ) : (
        <button type="button" className="nw-send-btn" onClick={signIn} disabled={busy}>
          {busy ? 'Opening Google…' : 'Continue with Google'}
        </button>
      )}
      {error ? <p className="nw-small nw-google-error" role="alert">{error}</p> : null}
      {user ? <p className="nw-small nw-dim" style={{ margin: '10px 0 0' }}>Signed in for this browser session only.</p> : null}
      {user ? (
        <div className="nw-google-sync">
          <div className="nw-kv">
            <span className="nw-k">Theme sync</span>
            <span className="nw-v">
              <button type="button" className="nw-chip-btn"
                onClick={toggleThemeSync} disabled={busy}
                aria-pressed={syncOn}>
                {syncOn ? 'Turn off' : 'Turn on'}
              </button>
            </span>
          </div>
          <p className="nw-small nw-dim" style={{ margin: '8px 0 0' }}>
            Optional. Stores only your light or dark choice under this website account,
            so your other devices open the same way. No wallet name, address, balance,
            history, seed or password is uploaded, and turning it off deletes the entry.
          </p>
          {syncNote ? <p className="nw-small nw-dim" role="status" style={{ margin: '6px 0 0' }}>{syncNote}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
