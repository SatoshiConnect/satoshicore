'use client';

import { useEffect, useState } from 'react';
import {
  getFirebaseWebConfig, isFirebaseWebConfigured, loadGoogleAuth,
  setGoogleSessionPersistence, setRememberGoogleSession, shouldRememberGoogleSession,
  signOutGoogleSession,
} from '../lib/firebaseAuth';
import {
  currentTheme, disableThemeSync, enableThemeSync, pullThemeForUser,
  syncEnabledFor,
} from '../lib/themeSync';
import { keystoreList } from '../lib/nsatWallet';
import {
  MAX_LINKED_ADDRESSES, addLinkedAddressForUser, classifyLinkFailure,
  describeLinkFailure, diagnoseFirestoreProblem, linkedAddressesForCurrentUser,
  removeLinkedAddressForUser, unlinkAddressForUser,
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
export default function GoogleAccount({ variant = 'card', onUseStandalone } = {}) {
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
  // Optional watch-only address links. Also separate from sign-in: nothing is
  // stored until the user links a wallet here, and one account can link several
  // because one person usually holds more than one wallet.
  const [linked, setLinked] = useState([]);
  const [linkTarget, setLinkTarget] = useState('');
  const [linkNote, setLinkNote] = useState('');
  const [localWallets, setLocalWallets] = useState([]);

  useEffect(() => {
    setLocalWallets(keystoreList());
  }, [user]);

  // Wallets on this device that the account is not watching yet: only those are
  // offered, so linking never duplicates an address.
  const unlinkedLocal = localWallets.filter((wallet) => !linked.includes(wallet.pubkey));

  // Ask the API only when the write itself did not say why: an anonymous probe
  // always gets "permission denied" once the rules are owner-only, so it must
  // never override the SDK's own explanation.
  async function linkFailureDialog(err, action) {
    let code = classifyLinkFailure(err, '');
    if (!code) code = classifyLinkFailure(err, (await diagnoseFirestoreProblem()).code);
    return describeLinkFailure(code, { action, projectId: getFirebaseWebConfig().projectId });
  }

  // Settings is not the only screen that cares: the wallet home shows a
  // watch-only view from the same list, so a change here has to reach it without
  // a reload.
  function announceLinksChanged() {
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('nsat:links-changed'));
  }

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
          void linkedAddressesForCurrentUser().then((list) => {
            if (mounted) setLinked(list);
          }).catch(() => { if (mounted) setLinked([]); });
        } else {
          setLinked([]);
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
      // The shared helper announces the sign-out before it reaches Firebase, so
      // the wallet locks and wipes its session immediately.
      await signOutGoogleSession();
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
    const target = (linkTarget || unlinkedLocal[0]?.pubkey || '').trim();
    if (!uid) return;
    setBusy(true);
    setError('');
    setLinkNote('');
    try {
      const saved = await addLinkedAddressForUser(uid, target);
      setLinked(saved);
      setLinkTarget('');
      announceLinksChanged();
      setLinkNote(`${shortAddress(target)} is linked. ${saved.length} wallet${saved.length === 1 ? '' : 's'} on this account can now be watched and receive after Google sign-in on another device; sending still needs the wallet's key.`);
    } catch (err) {
      const message = String(err?.message || '');
      if (err?.code === 'LINK_LIMIT') {
        setError(`This account already links ${MAX_LINKED_ADDRESSES} wallets, which is the limit. Remove one first.`);
      } else if (/account id/.test(message)) {
        setError('That is not a wallet address. Use the full 56-character address starting with G.');
      } else {
        setLinkDialog(await linkFailureDialog(err, 'link'));
      }
    } finally {
      setBusy(false);
    }
  }

  // One wallet at a time: removing wallet A must leave B linked.
  async function unlinkOne(address) {
    const uid = user?.uid;
    if (!uid) return;
    setBusy(true);
    setError('');
    setLinkNote('');
    try {
      const remaining = await removeLinkedAddressForUser(uid, address);
      setLinked(remaining);
      announceLinksChanged();
      setLinkNote(`${shortAddress(address)} is no longer linked. ${remaining.length ? `${remaining.length} wallet${remaining.length === 1 ? '' : 's'} still linked.` : 'No wallets are linked to this account now.'}`);
    } catch (err) {
      setLinkDialog(await linkFailureDialog(err, 'unlink'));
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
      setLinked([]);
      announceLinksChanged();
      setLinkNote('All linked addresses were removed from your account.');
    } catch (err) {
      setLinkDialog(await linkFailureDialog(err, 'unlink'));
    } finally {
      setBusy(false);
    }
  }

  // The gate is the wallet's front door: a browser that is not signed in shows
  // this instead of the wallet screen. A Google account is one of two ways in —
  // the directive requires that a visitor who does not want Google can still
  // use the standalone wallet — so the card offers both choices and says what
  // each one reveals on a shared device.
  if (variant === 'gate') {
    return (
      <section className="nw-card nw-gate" aria-labelledby="nw-gate-title">
        <h2 id="nw-gate-title" style={{ color: 'var(--text)' }}>Open your wallet</h2>
        <p className="nw-small nw-dim" style={{ margin: '8px 0 14px' }}>
          Sign in with Google to identify your website session, or use the wallets on this
          device without an account. Signing out locks the wallet and clears this session,
          so the next person on this device starts here instead of in your wallet.
        </p>
        {!configured ? (
          <p className="nw-small nw-dim" role="status">
            Google sign-in is not configured in this build, so the wallet opens without it.
          </p>
        ) : !ready ? (
          <p className="nw-small nw-dim" role="status">Checking sign-in session…</p>
        ) : user ? (
          <p className="nw-small nw-dim" role="status">
            {`Signed in as ${user.email || 'your Google account'}. Opening your wallet…`}
          </p>
        ) : (
          <>
            <button type="button" className="nw-send-btn nw-gate-btn"
              onClick={signIn} disabled={busy}>
              {busy ? 'Opening Google…' : 'Continue with Google'}
            </button>
            <label className="nw-small" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 12 }}>
              <input type="checkbox" checked={rememberDevice} disabled={busy}
                onChange={(e) => setRememberDevice(e.target.checked)}
                style={{ marginTop: 2, width: 'auto' }} />
              <span>
                <strong>Remember this device</strong>
                <span className="nw-dim"> — stay signed in on this browser. Do not use on a shared device. This does not remember the wallet password or unlock the wallet.</span>
              </span>
            </label>
          </>
        )}
        {error ? <p className="nw-small nw-google-error" role="alert">{error}</p> : null}
        {onUseStandalone ? (
          <>
            <button type="button" className="nw-ghost-btn nw-gate-skip"
              onClick={onUseStandalone} disabled={busy}>
              Use without an account
            </button>
            <p className="nw-small nw-dim" style={{ margin: '8px 0 0' }}>
              Without an account, only wallets that are not linked to a website account are
              listed here. A wallet that belongs to a Google account stays hidden, not deleted,
              until that account signs in.
            </p>
          </>
        ) : null}
        <p className="nw-small nw-dim" style={{ margin: '12px 0 0' }}>
          Your encrypted wallet stays on this device and is never uploaded; the Google account
          only identifies the session. Signing out deletes no wallet.
        </p>
      </section>
    );
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
            <span className="nw-k">Linked wallets</span>
            <span className="nw-v nw-mono nw-small">
              {linked.length ? `${linked.length} of ${MAX_LINKED_ADDRESSES}` : 'not linked'}
            </span>
          </div>
          {linked.length ? (
            <ul className="nw-link-list">
              {linked.map((address) => (
                <li key={address} className="nw-link-row">
                  <span className="nw-mono nw-small">{shortAddress(address)}</span>
                  <button type="button" className="nw-chip-btn" disabled={busy}
                    aria-label={`Stop watching ${address}`}
                    onClick={() => unlinkOne(address)}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="nw-small nw-dim" style={{ margin: '8px 0 0' }}>
            {`Optional. Stores these public addresses with your website account so each wallet's `
              + `balance and receive screen work after signing in on another device — one account `
              + `can link up to ${MAX_LINKED_ADDRESSES} wallets. An address is public and cannot `
              + 'move funds, so this is not backup or recovery: sending still needs the wallet '
              + 'password and key on the device that signs. No balance, history, wallet name or '
              + 'seed is stored, and Remove deletes that one entry.'}
          </p>
          {linked.length < MAX_LINKED_ADDRESSES ? (
            unlinkedLocal.length > 0 || localWallets.length === 0 ? (
              <>
                {localWallets.length > 0 ? (
                  <div className="nw-kv" style={{ marginTop: 8 }}>
                    <span className="nw-k">Add</span>
                    <span className="nw-v">
                      <select
                        aria-label="Wallet address to link"
                        value={linkTarget || unlinkedLocal[0]?.pubkey || ''}
                        onChange={(e) => setLinkTarget(e.target.value)}>
                        {unlinkedLocal.map((wallet) => (
                          <option key={wallet.name} value={wallet.pubkey}>
                            {`${wallet.name} (this device)`}
                          </option>
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
                    {linked.length ? 'Link another wallet' : 'Link address'}
                  </button>
                </div>
              </>
            ) : (
              <p className="nw-small nw-dim" style={{ margin: '8px 0 0' }}>
                Every wallet on this device is already linked.
              </p>
            )
          ) : (
            <p className="nw-small nw-dim" style={{ margin: '8px 0 0' }}>
              {`This account links ${MAX_LINKED_ADDRESSES} wallets, which is the limit. Remove one to add another.`}
            </p>
          )}
          {linked.length > 1 ? (
            <div className="nw-btn-row" style={{ margin: '8px 0 0' }}>
              <button type="button" className="nw-chip-btn" onClick={unlinkAddress} disabled={busy}>
                Remove all
              </button>
            </div>
          ) : null}
          {linkNote ? <p className="nw-small nw-dim" role="status" style={{ margin: '6px 0 0' }}>{linkNote}</p> : null}
        </div>
      ) : null}
      <DriveFailureDialog dialog={linkDialog} onClose={() => setLinkDialog(null)}
        step="WEBSITE ACCOUNT · LINKED WALLETS" />
    </section>
  );
}
