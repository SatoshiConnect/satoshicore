'use client';

// Settings → Profile: a self-chosen public ID, the verified email it belongs to,
// and the wallet chosen as primary.
//
// The controls here are a convenience, not the control: firestore.rules requires
// a verified email claim for every write and proves the primary address is a
// wallet this account already linked. A modified page cannot get around either.
import { useCallback, useEffect, useState } from 'react';

import { getFirebaseWebConfig, isFirebaseWebConfigured, loadGoogleAuth } from '../lib/firebaseAuth';
import { pullLinkedAddressesForUser } from '../lib/walletLinks';
import {
  PROFILE_ID_MAX, PROFILE_ID_MIN, createProfileForUser, deleteProfileForUser,
  describeProfileFailure, describeProfileIdProblem, normalizeProfileId,
  profileLabel, readMyProfile, renameProfileIdForUser, setPrimaryWalletForUser,
} from '../lib/profile';

const configured = isFirebaseWebConfigured();
const shortAddress = (value) => (value ? `${value.slice(0, 6)}…${value.slice(-6)}` : '');

// The wallet screen keeps the primary wallet as its default watch address, so a
// change here has to reach it without a reload.
function announceProfileChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('nsat:profile-changed'));
}

export default function ProfileCard() {
  const [account, setAccount] = useState(null);          // { uid, email, emailVerified }
  const [ready, setReady] = useState(!configured);
  const [profile, setProfile] = useState(null);          // { profileId, primaryAddress }
  const [loaded, setLoaded] = useState(false);
  const [linked, setLinked] = useState([]);
  const [idInput, setIdInput] = useState('');
  const [primaryPick, setPrimaryPick] = useState('');
  // Renaming is a separate field so the current ID stays visible while a new
  // one is typed; a typo is the usual reason to change it.
  const [renameInput, setRenameInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState(null);          // describeProfileFailure result

  const loadProfile = useCallback(async () => {
    try {
      const doc = await readMyProfile();
      setProfile(doc);
    } catch {
      // No database yet, or offline: the card says it has not been created and
      // never invents one.
      setProfile(null);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!configured) return undefined;
    let alive = true;
    let unsubscribe = () => {};
    loadGoogleAuth().then(({ auth, authSdk }) => {
      if (!alive) return;
      unsubscribe = authSdk.onAuthStateChanged(auth, (user) => {
        if (!alive) return;
        setAccount(user ? {
          uid: user.uid, email: user.email || '', emailVerified: Boolean(user.emailVerified),
        } : null);
        setReady(true);
        if (user?.uid) {
          void loadProfile();
          void pullLinkedAddressesForUser(user.uid).then((list) => {
            if (alive) setLinked(list);
          }).catch(() => { if (alive) setLinked([]); });
        } else {
          setProfile(null);
          setLinked([]);
          setLoaded(true);
        }
      }, () => { if (alive) setReady(true); });
    }).catch(() => { if (alive) setReady(true); });
    return () => { alive = false; unsubscribe(); };
  }, [loadProfile]);

  // Unlinking a wallet must not leave the profile pointing at it.
  useEffect(() => {
    if (!account?.uid) return undefined;
    let alive = true;
    const reload = () => {
      void pullLinkedAddressesForUser(account.uid).then((list) => {
        if (alive) setLinked(list);
      }).catch(() => {});
    };
    window.addEventListener('nsat:links-changed', reload);
    return () => { alive = false; window.removeEventListener('nsat:links-changed', reload); };
  }, [account?.uid]);

  const idProblem = idInput ? describeProfileIdProblem(idInput) : '';

  async function create() {
    setBusy(true);
    setNote('');
    setProblem(null);
    try {
      const id = normalizeProfileId(idInput);
      if (!id) {
        setNote(describeProfileIdProblem(idInput));
        return;
      }
      const doc = await createProfileForUser({ profileId: id, primaryAddress: primaryPick });
      setProfile(doc);
      setIdInput('');
      announceProfileChanged();
      setNote(`Profile ${profileLabel(doc.profileId)} created.`);
    } catch (error) {
      if (String(error?.code || '') === 'ID_TAKEN') {
        setProblem(describeProfileFailure(error, { action: 'save', projectId: getFirebaseWebConfig().projectId }));
      } else if (/link that wallet|create a profile first/.test(String(error?.message || ''))) {
        setNote(String(error.message));
      } else {
        setProblem(describeProfileFailure(error, { action: 'save', projectId: getFirebaseWebConfig().projectId }));
      }
    } finally {
      setBusy(false);
    }
  }

  async function rename() {
    setBusy(true);
    setNote('');
    setProblem(null);
    try {
      const id = normalizeProfileId(renameInput);
      if (!id) {
        setNote(describeProfileIdProblem(renameInput));
        return;
      }
      const doc = await renameProfileIdForUser(id);
      setProfile(doc);
      setRenameInput('');
      announceProfileChanged();
      setNote(`Profile ID is now ${profileLabel(doc.profileId)} — the old ID was released.`);
    } catch (error) {
      setProblem(describeProfileFailure(error, { action: 'save', projectId: getFirebaseWebConfig().projectId }));
    } finally {
      setBusy(false);
    }
  }

  async function savePrimary() {
    setBusy(true);
    setNote('');
    setProblem(null);
    try {
      const doc = await setPrimaryWalletForUser(primaryPick, { linked });
      setProfile(doc);
      announceProfileChanged();
      setNote(doc.primaryAddress
        ? `${shortAddress(doc.primaryAddress)} is now the primary wallet for this profile.`
        : 'The profile no longer names a primary wallet.');
    } catch (error) {
      setProblem(describeProfileFailure(error, { action: 'save', projectId: getFirebaseWebConfig().projectId }));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setNote('');
    setProblem(null);
    try {
      const removed = await deleteProfileForUser();
      setProfile(null);
      setIdInput('');
      setPrimaryPick('');
      announceProfileChanged();
      setNote(removed
        ? `Profile ${profileLabel(removed.profileId)} was deleted and its ID released. No wallet was changed.`
        : 'There was no profile to delete.');
    } catch (error) {
      setProblem(describeProfileFailure(error, { action: 'delete', projectId: getFirebaseWebConfig().projectId }));
    } finally {
      setBusy(false);
    }
  }

  const primaryOptions = Array.from(new Set([profile?.primaryAddress, ...linked].filter(Boolean)));

  return (
    <section className="nw-card nw-profile" aria-labelledby="nw-profile-title">
      <h2 id="nw-profile-title" style={{ color: 'var(--text)' }}>Profile</h2>
      <p className="nw-small nw-dim" style={{ margin: '8px 0 12px' }}>
        A public ID of your own, tied to a verified email and to the wallet you choose as
        primary. It cannot sign or move anything — sending still needs this device&apos;s
        encrypted key and password.
      </p>

      {!configured ? (
        <div className="nw-small nw-dim" role="status">
          Accounts are not configured in this build, so there is no profile.
        </div>
      ) : !ready ? (
        <div className="nw-small nw-dim" role="status">Checking the account…</div>
      ) : !account ? (
        <div className="nw-small nw-dim" role="status">
          Sign in above to create a profile.
        </div>
      ) : (
        <>
          <div className="nw-kv">
            <span className="nw-k">Email</span>
            <span className="nw-v nw-small">
              {account.email || 'signed in'}
              {' '}
              <span className={'nw-badge ' + (account.emailVerified ? 'ok' : 'warn')}>
                {account.emailVerified ? 'verified' : 'not verified'}
              </span>
            </span>
          </div>
          {!account.emailVerified ? (
            <p className="nw-small" style={{ margin: '6px 0 0', color: 'var(--warn)' }}>
              A profile can only be created by an account whose email the sign-in provider has
              verified. This site cannot send a verification email of its own, so verify the
              address with the provider, then sign in again.
            </p>
          ) : null}

          {!loaded ? (
            <p className="nw-small nw-dim" style={{ margin: '10px 0 0' }} role="status">
              Reading the profile…
            </p>
          ) : profile ? (
            <div className="nw-profile-body">
              <div className="nw-kv">
                <span className="nw-k">ID</span>
                <span className="nw-v nw-mono">{profileLabel(profile.profileId)}</span>
              </div>
              <div className="nw-kv">
                <span className="nw-k">Primary wallet</span>
                <span className="nw-v nw-small nw-mono">
                  {profile.primaryAddress
                    ? shortAddress(profile.primaryAddress)
                    : 'none chosen'}
                </span>
              </div>
              {linked.length === 0 ? (
                <p className="nw-small nw-dim" style={{ margin: '8px 0 0' }}>
                  Link a wallet under Linked wallets first — a primary wallet must be one this
                  account already links.
                </p>
              ) : (
                <div className="nw-kv" style={{ marginTop: 8 }}>
                  <span className="nw-k">Choose primary</span>
                  <span className="nw-v">
                    <select aria-label="Primary wallet" value={primaryPick}
                      onChange={(event) => setPrimaryPick(event.target.value)}>
                      <option value="">— none —</option>
                      {primaryOptions.map((address) => (
                        <option key={address} value={address}>{shortAddress(address)}</option>
                      ))}
                    </select>
                  </span>
                </div>
              )}
              {/* Delete stays available with no linked wallet: a profile that
                * names no primary wallet must still be removable. */}
              <div className="nw-btn-row" style={{ margin: '8px 0 0' }}>
                {linked.length > 0 ? (
                  <button type="button" className="nw-chip-btn" onClick={savePrimary}
                    disabled={busy}>
                    {busy ? 'Saving…' : 'Save primary wallet'}
                  </button>
                ) : null}
                <button type="button" className="nw-chip-btn" onClick={remove} disabled={busy}>
                  Delete profile
                </button>
              </div>
              <div className="nw-profile-rename">
                <label className="nw-label" htmlFor="nw-profile-rename">Change ID</label>
                <input id="nw-profile-rename" value={renameInput} spellCheck={false}
                  autoComplete="off" placeholder={profile.profileId} disabled={busy}
                  onChange={(event) => setRenameInput(event.target.value)} />
                <div className="nw-btn-row" style={{ margin: '8px 0 0' }}>
                  <button type="button" className="nw-chip-btn" onClick={rename}
                    disabled={busy || !normalizeProfileId(renameInput)
                      || normalizeProfileId(renameInput) === profile.profileId}>
                    {busy ? 'Saving…' : 'Change ID'}
                  </button>
                </div>
                <p className="nw-small nw-dim" style={{ margin: '6px 0 0' }}>
                  The new ID must be free. Your primary wallet choice is kept, and the old ID is
                  released only after the new one is saved.
                </p>
              </div>
            </div>
          ) : (
            <div className="nw-profile-body">
              <label className="nw-label" htmlFor="nw-profile-id">Profile ID</label>
              <input id="nw-profile-id" value={idInput} spellCheck={false} autoComplete="off"
                placeholder="e.g. somchai" disabled={busy || !account.emailVerified}
                onChange={(event) => setIdInput(event.target.value)} />
              <p className="nw-small nw-dim" style={{ margin: '6px 0 0' }}>
                {`${PROFILE_ID_MIN}–${PROFILE_ID_MAX} characters: lowercase letters, digits, “-” and “_”. IDs are unique; you can change yours later under Change ID.`}
              </p>
              {idProblem ? (
                <p className="nw-small" style={{ margin: '6px 0 0', color: 'var(--warn)' }}>
                  {idProblem}
                </p>
              ) : null}
              {linked.length > 0 ? (
                <div className="nw-kv" style={{ marginTop: 8 }}>
                  <span className="nw-k">Primary wallet</span>
                  <span className="nw-v">
                    <select aria-label="Primary wallet for this profile" value={primaryPick}
                      disabled={busy} onChange={(event) => setPrimaryPick(event.target.value)}>
                      <option value="">— choose later —</option>
                      {linked.map((address) => (
                        <option key={address} value={address}>{shortAddress(address)}</option>
                      ))}
                    </select>
                  </span>
                </div>
              ) : (
                <p className="nw-small nw-dim" style={{ margin: '8px 0 0' }}>
                  No linked wallet yet. You can create the profile now and choose the primary
                  wallet after linking one under Linked wallets.
                </p>
              )}
              <div className="nw-btn-row" style={{ margin: '10px 0 0' }}>
                <button type="button" className="nw-chip-btn" onClick={create}
                  disabled={busy || !account.emailVerified || !normalizeProfileId(idInput)}>
                  {busy ? 'Creating…' : 'Create profile'}
                </button>
              </div>
            </div>
          )}

          {note ? (
            <p className="nw-small nw-dim" role="status" style={{ margin: '8px 0 0' }}>{note}</p>
          ) : null}
          {problem ? (
            <div role="alert" className="nw-profile-problem">
              <strong className="nw-small">{problem.title}</strong>
              <p className="nw-small nw-dim" style={{ margin: '4px 0 0' }}>{problem.message}</p>
              {problem.fix ? (
                <a className="nw-small" href={problem.fix.url} target="_blank" rel="noreferrer">
                  {problem.fix.label}
                </a>
              ) : null}
            </div>
          ) : null}
          <p className="nw-small nw-dim" style={{ margin: '8px 0 0' }}>
            Stored: the ID, the claim that keeps it unique, and the public address you pick. The
            email itself is never written to the database — only the provider&apos;s “verified”
            claim is checked. No balance, history, name, seed or password is stored, and deleting
            the profile deletes both documents.
          </p>
        </>
      )}
    </section>
  );
}
