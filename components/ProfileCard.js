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
  profileLabel, readMyProfile, saveMyProfile,
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
  const [idInput, setIdInput] = useState('@');
  const [primaryPick, setPrimaryPick] = useState('');
  const [editing, setEditing] = useState(false);
  const [editProfileId, setEditProfileId] = useState('');
  const [editPrimary, setEditPrimary] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState(null);          // describeProfileFailure result

  const loadProfile = useCallback(async () => {
    try {
      const doc = await readMyProfile();
      setProfile(doc);
      setEditProfileId(doc?.profileId || '');
      setEditPrimary(doc?.primaryAddress || '');
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
          setEditProfileId('');
          setEditPrimary('');
          setEditing(false);
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
        if (!alive) return;
        setLinked(list);
        setProfile((current) => {
          if (current?.primaryAddress && !list.includes(current.primaryAddress)) {
            setEditPrimary('');
            return { ...current, primaryAddress: '' };
          }
          return current;
        });
      }).catch(() => {});
    };
    window.addEventListener('nsat:links-changed', reload);
    return () => { alive = false; window.removeEventListener('nsat:links-changed', reload); };
  }, [account?.uid]);

  const idProblem = idInput && idInput !== '@' ? describeProfileIdProblem(idInput) : '';

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
      setEditProfileId(doc.profileId);
      setEditPrimary(doc.primaryAddress);
      setIdInput('@');
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

  async function saveChanges() {
    setBusy(true);
    setNote('');
    setProblem(null);
    try {
      const id = normalizeProfileId(editProfileId);
      if (!id) {
        setNote(describeProfileIdProblem(editProfileId));
        return;
      }
      const doc = await saveMyProfile({
        profileId: id,
        primaryAddress: editPrimary,
        linked,
      });
      const oldId = profile?.profileId;
      setProfile(doc);
      setEditProfileId(doc.profileId);
      setEditPrimary(doc.primaryAddress);
      setEditing(false);
      announceProfileChanged();
      setNote(oldId !== doc.profileId
        ? `Saved ${profileLabel(doc.profileId)}. The previous ID was released.`
        : 'Profile changes saved.');
    } catch (error) {
      if (/link that wallet/.test(String(error?.message || ''))) {
        setNote(String(error.message));
      } else {
        setProblem(describeProfileFailure(error, { action: 'save', projectId: getFirebaseWebConfig().projectId }));
      }
    } finally {
      setBusy(false);
    }
  }

  function cancelChanges() {
    setEditProfileId(profile?.profileId || '');
    setEditPrimary(profile?.primaryAddress || '');
    setEditing(false);
    setNote('');
    setProblem(null);
  }

  async function remove() {
    setBusy(true);
    setNote('');
    setProblem(null);
    try {
      const removed = await deleteProfileForUser();
      setProfile(null);
      setIdInput('@');
      setPrimaryPick('');
      setEditProfileId('');
      setEditPrimary('');
      setEditing(false);
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
              {!editing ? (
                <>
                  <div className="nw-kv">
                    <span className="nw-k">ID</span>
                    <span className="nw-v nw-mono">{profileLabel(profile.profileId)}</span>
                  </div>
                  <div className="nw-kv">
                    <span className="nw-k">Primary wallet</span>
                    <span className="nw-v nw-small nw-mono">
                      {profile.primaryAddress ? shortAddress(profile.primaryAddress) : 'none chosen'}
                    </span>
                  </div>
                  <div className="nw-btn-row" style={{ margin: '8px 0 0' }}>
                    <button type="button" className="nw-chip-btn"
                      onClick={() => {
                        setEditProfileId(profile.profileId);
                        setEditPrimary(profile.primaryAddress);
                        setEditing(true);
                        setNote('');
                        setProblem(null);
                      }} disabled={busy || !account.emailVerified}>
                      Edit profile
                    </button>
                    <button type="button" className="nw-chip-btn" onClick={remove} disabled={busy}>
                      Delete profile
                    </button>
                  </div>
                  {!account.emailVerified ? (
                    <p className="nw-small" style={{ margin: '8px 0 0', color: 'var(--warn)' }}>
                      Editing is disabled because the provider no longer reports this email as
                      verified. Verify it with the provider and sign in again.
                    </p>
                  ) : null}
                </>
              ) : (
                <>
                  <label className="nw-label" htmlFor="nw-profile-id-edit">Profile ID</label>
                  <input id="nw-profile-id-edit" value={editProfileId} spellCheck={false}
                    autoComplete="off" disabled={busy}
                    onChange={(event) => setEditProfileId(event.target.value.startsWith('@')
                      ? event.target.value : `@${event.target.value}`)} />
                  {editProfileId && describeProfileIdProblem(editProfileId) ? (
                    <p className="nw-small" style={{ margin: '6px 0 0', color: 'var(--warn)' }}>
                      {describeProfileIdProblem(editProfileId)}
                    </p>
                  ) : (
                    <p className="nw-small nw-dim" style={{ margin: '6px 0 0' }}>
                      {`Start with @, then ${PROFILE_ID_MIN}–${PROFILE_ID_MAX} lowercase letters, digits, “-” or “_”. Cancelling keeps your current ID.`}
                    </p>
                  )}
                  {linked.length > 0 ? (
                    <div className="nw-kv" style={{ marginTop: 8 }}>
                      <span className="nw-k">Primary wallet</span>
                      <span className="nw-v">
                        <select aria-label="Primary wallet" value={editPrimary}
                          disabled={busy} onChange={(event) => setEditPrimary(event.target.value)}>
                          <option value="">— none —</option>
                          {Array.from(new Set([profile.primaryAddress, ...linked].filter(Boolean)))
                            .map((address) => (
                              <option key={address} value={address}>{shortAddress(address)}</option>
                            ))}
                        </select>
                      </span>
                    </div>
                  ) : (
                    <p className="nw-small nw-dim" style={{ margin: '8px 0 0' }}>
                      No linked wallets. The saved primary wallet will be cleared.
                    </p>
                  )}
                  <p className="nw-small nw-dim" style={{ margin: '8px 0 0' }}>
                    The email is verified by your sign-in provider and cannot be edited here.
                    The ID must be available; your previous ID is released only after Save succeeds.
                  </p>
                  <div className="nw-btn-row" style={{ margin: '10px 0 0' }}>
                    <button type="button" className="nw-send-btn" onClick={saveChanges}
                      disabled={busy || !normalizeProfileId(editProfileId)}>
                      {busy ? 'Saving…' : 'Save changes'}
                    </button>
                    <button type="button" className="nw-chip-btn" onClick={cancelChanges}
                      disabled={busy}>
                      Cancel
                    </button>
                    <button type="button" className="nw-chip-btn" onClick={remove}
                      disabled={busy}>
                      Delete profile
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="nw-profile-body">
              <label className="nw-label" htmlFor="nw-profile-id">Profile ID</label>
              <input id="nw-profile-id" value={idInput} spellCheck={false} autoComplete="off"
                placeholder="@somchai" disabled={busy || !account.emailVerified}
                onChange={(event) => setIdInput(event.target.value.startsWith('@')
                  ? event.target.value : `@${event.target.value}`)} />
              <p className="nw-small nw-dim" style={{ margin: '6px 0 0' }}>
                {`Start with @, then use ${PROFILE_ID_MIN}–${PROFILE_ID_MAX} lowercase letters, digits, “-” or “_”. IDs are unique; you can change yours later.`}
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
                <button type="button" className="nw-send-btn" onClick={create}
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
