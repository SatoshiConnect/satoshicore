'use client';

import { useEffect, useState } from 'react';
import {
  getFirebaseWebConfig, isFirebaseWebConfigured, loadGoogleAuth,
  setGoogleSessionPersistence, setRememberGoogleSession, shouldRememberGoogleSession,
} from '../lib/firebaseAuth';
import {
  currentTheme, disableThemeSync, enableThemeSync, pullThemeForUser,
  syncEnabledFor,
} from '../lib/themeSync';
import { keystoreList } from '../lib/nsatWallet';
import {
  describeLinkFailure, diagnoseFirestoreProblem, linkAddressForUser,
  linkedAddressForCurrentUser, unlinkAddressForUser,
} from '../lib/walletLinks';
import DriveFailureDialog from './DriveFailureDialog';

const configured = isFirebaseWebConfigured();

function friendlyAuthError(error) {
  if (error?.code === 'auth/popup-closed-by-user') return 'Sign-in was cancelled.';
  if (error?.code === 'auth/popup-blocked') return 'The browser blocked the sign-in window. Allow pop-ups and try again.';
  if (error?.code === 'auth/unauthorized-domain') return 'This domain is not authorized yet. Add it under Firebase Authentication → Settings → Authorized domains.';
  if (error?.code === 'auth/operation-not-allowed') return 'Google sign-in is not enabled in the Firebase project yet.';
  return 'Google sign-in failed. Check the Firebase project settings and try again.';
}

const shortAddress = (address) => (address ? `${address.slice(0, 6)}…${address.slice(-6)}` : '');

// `variant="row"` is the wallet-screen entry point: one line with the account
// state and its single action, so signing in does not require Settings.
// The full card stays in Settings, where there is room to explain each choice.
export default function GoogleAccount({ variant = 'card' } = {}) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(!configured);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [rememberDevice, setRememberDevice] = useState(false);
  // Theme sync is a separate, opt-in choice; signing in alone uploads nothing.
  const [syncOn, setSyncOn] = useState(false);
  const [syncNote, setSyncNote] = useState('');
  // A link that could not be saved says why in a dialog: the usual cause is a
  // disabled database or a rules denial, and both have a page that fixes them.
  const [linkDialog, setLinkDialog] = useState(null);
  // Optional watch-only address link. Also separate from sign-in: nothing is
  // stored until the user links an address here.
  const [linked, setLinked] = useState('');
  const [linkTarget, setLinkTarget] = useState('');
  const [linkNote, setLinkNote] = useState('');
  const [localWallets, setLocalWallets] = useState([]);

  useEffect(() => {
    setLocalWallets(keystoreList());
  }, [user]);

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
        setRememberDevice(shouldRememberGoogleSession());
        setReady(true);
        // An opted-in account brings its theme to this device. A miss just
        // leaves the local theme as it is.
        if (uid) void pullThemeForUser(uid).catch(() => {});
        // A linked address only pre-fills the field; it is never applied to a
        // wallet or used to sign anything.
        if (uid) {
          void linkedAddressForCurrentUser().then((address) => {
            if (mounted) setLinked(address || '');
          }).catch(() => { if (mounted) setLinked(''); });
        } else {
          setLinked('');
        }
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
      // Persistence is set before starting OAuth so a completed sign-in is
      // stored only according to the explicit checkbox state. The helper
      // refuses LOCAL persistence if the opt-in flag cannot be saved locally.
      await setGoogleSessionPersistence(rememberDevice);
      const provider = new authSdk.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      await authSdk.signInWithPopup(auth, provider);
    } catch (err) {
      // A cancelled/failed OAuth attempt must not leave persistent sign-in
      // enabled as a side effect of the pre-login checkbox.
      if (!user) {
        try { await setGoogleSessionPersistence(false); } catch { /* auth may never have initialized */ }
        setRememberGoogleSession(false);
        setRememberDevice(false);
      }
      setError(friendlyAuthError(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggleRememberDevice() {
    const next = !rememberDevice;
    setBusy(true);
    setError('');
    try {
      // Firebase migrates the currently signed-in user to the selected mode.
      // If it fails, leave the checkbox unchanged and explain that the current
      // session is unaffected.
      await setGoogleSessionPersistence(next);
      setRememberDevice(next);
    } catch {
      setError('Could not change this device’s sign-in setting. Your current session is unchanged.');
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    setError('');
    try {
      const { auth, authSdk } = await loadGoogleAuth();
      // Switch this user back to session-only before signing out, so an
      // explicit sign-out never leaves Firebase's persistent auth record.
      try { await authSdk.setPersistence(auth, authSdk.browserSessionPersistence); }
      catch { /* sign out still removes the existing persisted Firebase session */ }
      await authSdk.signOut(auth);
      setRememberGoogleSession(false);
      setRememberDevice(false);
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
    } catch (err) {
      setError(/did not complete/.test(String(err?.message || ''))
        ? 'The theme change was not confirmed as saved. Reload to check.'
        : 'Could not change theme sync. The site database may not be configured yet.');
    } finally {
      setBusy(false);
    }
  }

  async function linkAddress() {
    const uid = user?.uid;
    const target = (linkTarget || localWallets[0]?.pubkey || '').trim();
    if (!uid) return;
    setBusy(true);
    setError('');
    setLinkNote('');
    try {
      const saved = await linkAddressForUser(uid, target);
      setLinked(saved);
      setLinkTarget('');
      setLinkNote(`Linked ${shortAddress(saved)}. Balance and receive now work on another device after Google sign-in; sending still needs this wallet's key.`);
    } catch (err) {
      const message = String(err?.message || '');
      if (/account id/.test(message)) {
        setError('That is not a wallet address. Use the full 56-character address starting with G.');
      } else {
        // Ask the API itself rather than guessing from a deadline: a disabled
        // database and a rules denial need different pages to fix.
        const { code } = await diagnoseFirestoreProblem();
        setLinkDialog(describeLinkFailure(code, { action: 'link', projectId: getFirebaseWebConfig().projectId }));
      }
    } finally {
      setBusy(false);
    }
  }

  async function unlinkAddress() {
    const uid = user?.uid;
    if (!uid) return;
    setBusy(true);
    setError('');
    setLinkNote('');
    try {
      await unlinkAddressForUser(uid);
      setLinked('');
      setLinkNote('Address unlinked and deleted from your account.');
    } catch (err) {
      const { code } = await diagnoseFirestoreProblem();
      setLinkDialog(describeLinkFailure(code, { action: 'unlink', projectId: getFirebaseWebConfig().projectId }));
    } finally {
      setBusy(false);
    }
  }

  if (variant === 'row') {
    return (
      <div className="nw-signin-row">
        <span className="nw-signin-row-main">
          <span className="nw-signin-row-title">Website account</span>
          <span className="nw-small nw-dim">
            {!configured ? 'Google sign-in is not configured in this build.'
              : !ready ? 'Checking sign-in session…'
                : user ? (user.email || 'signed in') : 'not signed in'}
          </span>
        </span>
        {configured && ready ? (
          user ? (
            <button type="button" className="nw-chip-btn" onClick={signOut} disabled={busy}>
              {busy ? 'Signing out…' : 'Sign out'}
            </button>
          ) : (
            <button type="button" className="nw-chip-btn nw-signin-row-btn"
              onClick={signIn} disabled={busy}>
              {busy ? 'Opening Google…' : 'Sign in'}
            </button>
          )
        ) : null}
      </div>
    );
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
        <>
          <button type="button" className="nw-send-btn" onClick={signIn} disabled={busy}>
            {busy ? 'Opening Google…' : 'Continue with Google'}
          </button>
          <label className="nw-small" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 10 }}>
            <input type="checkbox" checked={rememberDevice} onChange={(e) => setRememberDevice(e.target.checked)}
              disabled={busy} style={{ marginTop: 2, width: 'auto' }} />
            <span>
              <strong>Remember this device</strong>
              <span className="nw-dim"> — stay signed in to this website on this browser. Do not use on a shared device. This does not unlock the wallet or remember its password.</span>
            </span>
          </label>
        </>
      )}
      {error ? <p className="nw-small nw-google-error" role="alert">{error}</p> : null}
      {user ? (
        <div className="nw-google-sync" style={{ marginTop: 10 }}>
          <label className="nw-small" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <input type="checkbox" checked={rememberDevice} onChange={toggleRememberDevice}
              disabled={busy} style={{ marginTop: 2, width: 'auto' }} />
            <span>
              <strong>Remember this device</strong>
              <span className="nw-dim"> — stay signed in to this website on this browser. Do not use on a shared device. This does not unlock the wallet or remember its password.</span>
            </span>
          </label>
          <p className="nw-small nw-dim" style={{ margin: '6px 0 0' }}>
            {rememberDevice
              ? 'Remembered on this browser. Sign out to remove the saved session.'
              : 'Off — Google sign-in ends when this browser session closes.'}
          </p>
        </div>
      ) : null}
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
      {user ? (
        <div className="nw-google-sync">
          <div className="nw-kv">
            <span className="nw-k">Wallet address</span>
            <span className="nw-v nw-mono nw-small">{linked ? shortAddress(linked) : 'not linked'}</span>
          </div>
          <p className="nw-small nw-dim" style={{ margin: '8px 0 0' }}>
            Optional. Stores this public address with your website account so you can see
            its balance and receive screen after signing in on another device. An address is
            public and cannot move funds, so this is not backup or recovery: sending still
            needs the wallet password and key on the device that signs. No balance, history,
            wallet name or seed is stored, and unlinking deletes the entry.
          </p>
          {linked ? (
            <div className="nw-btn-row" style={{ margin: '8px 0 0' }}>
              <button type="button" className="nw-chip-btn" onClick={unlinkAddress} disabled={busy}>
                Unlink address
              </button>
            </div>
          ) : (
            <>
              {localWallets.length > 0 ? (
                <div className="nw-kv" style={{ marginTop: 8 }}>
                  <span className="nw-k">Use</span>
                  <span className="nw-v">
                    <select
                      aria-label="Wallet address to link"
                      value={linkTarget}
                      onChange={(e) => setLinkTarget(e.target.value)}>
                      <option value="">{`${localWallets[0].name} (this device)`}</option>
                      {localWallets.slice(1).map((w) => (
                        <option key={w.name} value={w.pubkey}>{w.name} (this device)</option>
                      ))}
                    </select>
                  </span>
                </div>
              ) : (
                <input
                  type="text"
                  spellCheck={false}
                  aria-label="Public wallet address to link"
                  placeholder="G… public address"
                  value={linkTarget}
                  onChange={(e) => setLinkTarget(e.target.value)}
                  style={{ marginTop: 8 }} />
              )}
              <div className="nw-btn-row" style={{ margin: '8px 0 0' }}>
                <button type="button" className="nw-chip-btn" onClick={linkAddress} disabled={busy}>
                  Link address
                </button>
              </div>
            </>
          )}
          {linkNote ? <p className="nw-small nw-dim" role="status" style={{ margin: '6px 0 0' }}>{linkNote}</p> : null}
        </div>
      ) : null}
      <DriveFailureDialog dialog={linkDialog} onClose={() => setLinkDialog(null)}
        step="WEBSITE ACCOUNT · LINKED ADDRESS" />
    </section>
  );
}
