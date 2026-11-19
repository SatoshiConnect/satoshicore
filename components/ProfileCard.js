'use client';

// Settings → Profile: a self-chosen public ID, the verified email it belongs to,
// and the wallet chosen as primary.
//
// The controls here are a convenience, not the control: firestore.rules requires
// a verified email claim for every write and proves the primary address is a
// wallet this account already linked. A modified page cannot get around either.
import { useCallback, useEffect, useState } from 'react';

import { downloadAccountExport } from '../lib/accountExport';
import { copyTextToClipboard } from '../lib/clipboard';
import { getFirebaseWebConfig, isFirebaseWebConfigured, loadGoogleAuth } from '../lib/firebaseAuth';
import { pullLinkedAddressesForUser } from '../lib/walletLinks';
import {
  BIO_MAX, DEFAULT_PROFILE_VISIBILITY, DISPLAY_NAME_MAX, PROFILE_ID_MAX, PROFILE_ID_MIN,
  STATUS_MAX, createProfileForUser, deleteProfileForUser, describeProfileFailure,
  describeProfileIdProblem, normalizeProfileId, profileLabel, readMyProfile,
  saveMyProfile, validateProfileText,
} from '../lib/profile';
import {
  buildProfileShareUrl, profileShareText, profileShareWarning,
} from '../lib/profileShare';

const configured = isFirebaseWebConfigured();
const shortAddress = (value) => (value ? `${value.slice(0, 6)}…${value.slice(-6)}` : '');
const VISIBILITY_LABELS = {
  'signed-in': 'Any signed-in account',
  contacts: 'My contacts only',
  private: 'Only me',
};
const textProblem = (value, max) => {
  const result = validateProfileText(value, { max });
  return result.ok ? '' : result.message;
};

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
  const [displayNameInput, setDisplayNameInput] = useState('');
  const [bioInput, setBioInput] = useState('');
  const [statusInput, setStatusInput] = useState('');
  const [visibilityInput, setVisibilityInput] = useState(DEFAULT_PROFILE_VISIBILITY);
  const [primaryPick, setPrimaryPick] = useState('');
  const [editing, setEditing] = useState(false);
  const [editProfileId, setEditProfileId] = useState('');
  const [editDisplayName, setEditDisplayName] = useState('');
  const [editBio, setEditBio] = useState('');
  const [editStatus, setEditStatus] = useState('');
  const [editVisibility, setEditVisibility] = useState(DEFAULT_PROFILE_VISIBILITY);
  const [editPrimary, setEditPrimary] = useState('');
  const [busy, setBusy] = useState(false);
  const [exportState, setExportState] = useState({ busy: false, message: '', error: false });
  const [share, setShare] = useState({ url: '', qr: '', note: '', error: false });
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState(null);          // describeProfileFailure result

  const loadProfile = useCallback(async () => {
    try {
      const doc = await readMyProfile();
      setProfile(doc);
      setEditProfileId(doc?.profileId || '');
      setEditDisplayName(doc?.displayName || '');
      setEditBio(doc?.bio || '');
      setEditStatus(doc?.status || '');
      setEditVisibility(doc?.visibility || DEFAULT_PROFILE_VISIBILITY);
      setEditPrimary(doc?.primaryAddress || '');
    } catch {
      // No database yet, or offline: the card says it has not been created and
      // never invents one.
      setProfile(null);
    } finally {
      setLoaded(true);
    }
  }, []);

  // The link is built from the page the owner is on, so a deployment under a
  // base path keeps working. The QR is generated locally; the URL is not sent
  // anywhere to be rendered.
  useEffect(() => {
    if (!profile || typeof window === 'undefined') {
      setShare({ url: '', qr: '', note: '', error: false });
      return undefined;
    }
    const url = buildProfileShareUrl(window.location.href, profile);
    setShare({ url, qr: '', note: '', error: false });
    if (!url) return undefined;
    let alive = true;
    import('qrcode').then(({ toDataURL }) => toDataURL(url, {
      errorCorrectionLevel: 'M', margin: 2, width: 220,
    })).then((qr) => {
      if (alive) setShare((current) => ({ ...current, qr }));
    }).catch(() => {
      if (alive) setShare((current) => ({ ...current, qr: '' }));
    });
    return () => { alive = false; };
  }, [profile]);

  async function shareProfile() {
    if (!share.url) return;
    setShare((current) => ({ ...current, note: '', error: false }));
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
        await navigator.share({
          title: 'NSAT profile',
          text: profileShareText(profile),
          url: share.url,
        });
        setShare((current) => ({ ...current, note: 'Shared.', error: false }));
        return;
      }
      await copyTextToClipboard(share.url);
      setShare((current) => ({ ...current, note: 'This browser cannot open a share sheet; the link was copied instead.', error: false }));
    } catch (error) {
      if (error?.name === 'AbortError') return;
      setShare((current) => ({
        ...current,
        note: 'Could not open sharing or copy the link. Select the link above and copy it manually.',
        error: true,
      }));
    }
  }

  async function copyProfileLink() {
    if (!share.url) return;
    try {
      await copyTextToClipboard(share.url);
      setShare((current) => ({ ...current, note: 'Link copied. It works after you close the app.', error: false }));
    } catch {
      setShare((current) => ({
        ...current,
        note: 'Copy failed. Select the link and copy it manually.',
        error: true,
      }));
    }
  }

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
          setIdInput('@');
          setDisplayNameInput('');
          setBioInput('');
          setStatusInput('');
          setVisibilityInput(DEFAULT_PROFILE_VISIBILITY);
          setEditProfileId('');
          setEditDisplayName('');
          setEditBio('');
          setEditStatus('');
          setEditVisibility(DEFAULT_PROFILE_VISIBILITY);
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
      const checkedName = validateProfileText(displayNameInput, { max: DISPLAY_NAME_MAX, label: 'display name' });
      const checkedBio = validateProfileText(bioInput, { max: BIO_MAX, label: 'bio' });
      const checkedStatus = validateProfileText(statusInput, { max: STATUS_MAX, label: 'status' });
      if (!checkedName.ok || !checkedBio.ok || !checkedStatus.ok) {
        setNote((checkedName.ok ? '' : checkedName.message)
          || (checkedBio.ok ? '' : checkedBio.message)
          || checkedStatus.message);
        return;
      }
      const doc = await createProfileForUser({
        profileId: id,
        primaryAddress: primaryPick,
        displayName: checkedName.text,
        bio: checkedBio.text,
        status: checkedStatus.text,
        visibility: visibilityInput,
      });
      setProfile(doc);
      setEditProfileId(doc.profileId);
      setEditDisplayName(doc.displayName);
      setEditBio(doc.bio);
      setEditStatus(doc.status);
      setEditVisibility(doc.visibility);
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
        displayName: editDisplayName,
        bio: editBio,
        status: editStatus,
        visibility: editVisibility,
        linked,
      });
      const oldId = profile?.profileId;
      setProfile(doc);
      setEditProfileId(doc.profileId);
      setEditDisplayName(doc.displayName);
      setEditBio(doc.bio);
      setEditStatus(doc.status);
      setEditVisibility(doc.visibility);
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
    setEditDisplayName(profile?.displayName || '');
    setEditBio(profile?.bio || '');
    setEditStatus(profile?.status || '');
    setEditVisibility(profile?.visibility || DEFAULT_PROFILE_VISIBILITY);
    setEditPrimary(profile?.primaryAddress || '');
    setEditing(false);
    setNote('');
    setProblem(null);
  }

  async function downloadData() {
    setExportState({ busy: true, message: '', error: false });
    try {
      const { filename } = await downloadAccountExport();
      setExportState({ busy: false, message: `Downloaded ${filename}.`, error: false });
    } catch (error) {
      setExportState({
        busy: false,
        message: String(error?.message || 'Could not prepare the export.'),
        error: true,
      });
    }
  }

  async function remove() {
    setBusy(true);
    setNote('');
    setProblem(null);
    try {
      const removed = await deleteProfileForUser();
      setProfile(null);
      setIdInput('@');
      setDisplayNameInput('');
      setBioInput('');
      setStatusInput('');
      setVisibilityInput(DEFAULT_PROFILE_VISIBILITY);
      setPrimaryPick('');
      setEditProfileId('');
      setEditDisplayName('');
      setEditBio('');
      setEditStatus('');
      setEditVisibility(DEFAULT_PROFILE_VISIBILITY);
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
              verified. Use “Resend verification email” under Website account, open the link in
              your inbox, then choose “I’ve verified — refresh”.
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
                    <span className="nw-k">Display name</span>
                    <span className="nw-v">{profile.displayName || 'not set'}</span>
                  </div>
                  <div className="nw-kv">
                    <span className="nw-k">Status</span>
                    <span className="nw-v nw-small">{profile.status || 'not set'}</span>
                  </div>
                  <div className="nw-kv">
                    <span className="nw-k">Bio</span>
                    <span className="nw-v nw-small">{profile.bio || 'not set'}</span>
                  </div>
                  <div className="nw-kv">
                    <span className="nw-k">Profile visibility</span>
                    <span className="nw-v nw-small">
                      {VISIBILITY_LABELS[profile.visibility] || 'Only me'}
                    </span>
                  </div>
                  <div className="nw-kv">
                    <span className="nw-k">Primary wallet</span>
                    <span className="nw-v nw-small nw-mono">
                      {profile.primaryAddress ? shortAddress(profile.primaryAddress) : 'none chosen'}
                    </span>
                  </div>

                  <div className="nw-profile-share">
                    <div className="nw-kv">
                      <span className="nw-k">Share</span>
                      <span className="nw-v nw-small">
                        Send this link through any channel. The other person does not need NSAT open,
                        or even installed, when you send it.
                      </span>
                    </div>
                    {share.url ? (
                      <>
                        <div className="nw-share-row">
                          <input readOnly value={share.url} aria-label="Profile share link"
                            onFocus={(event) => event.currentTarget.select()} />
                          <button type="button" className="nw-chip-btn" onClick={copyProfileLink}>
                            Copy link
                          </button>
                          <button type="button" className="nw-chip-btn" onClick={shareProfile}>
                            Share…
                          </button>
                        </div>
                        {share.qr ? (
                          <img className="nw-share-qr" src={share.qr} width="180" height="180"
                            alt="QR code for this profile link" />
                        ) : null}
                        {profileShareWarning(profile) ? (
                          <p className="nw-small" style={{ margin: '6px 0 0', color: 'var(--warn)' }}>
                            {profileShareWarning(profile)}
                          </p>
                        ) : null}
                        <p className="nw-small nw-dim" style={{ margin: '6px 0 0' }}>
                          The recipient can open it later; the link does not expire and does not require
                          the sender to stay online. A limited profile still requires sign-in and permission.
                        </p>
                      </>
                    ) : (
                      <p className="nw-small nw-dim" style={{ margin: '6px 0 0' }}>
                        Choose a profile ID or a primary wallet before sharing.
                      </p>
                    )}
                    {share.note ? (
                      <p className="nw-small" role="status"
                        style={{ margin: '6px 0 0', color: share.error ? 'var(--warn)' : 'var(--text-dim)' }}>
                        {share.note}
                      </p>
                    ) : null}
                  </div>

                  <div className="nw-btn-row" style={{ margin: '8px 0 0' }}>
                    <button type="button" className="nw-chip-btn"
                      onClick={() => {
                        setEditProfileId(profile.profileId);
                        setEditDisplayName(profile.displayName || '');
                        setEditBio(profile.bio || '');
                        setEditStatus(profile.status || '');
                        setEditVisibility(profile.visibility || DEFAULT_PROFILE_VISIBILITY);
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
                      verified. Use the verification control under Website account, then refresh.
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
                  <label className="nw-label" htmlFor="nw-profile-name-edit" style={{ marginTop: 10 }}>
                    Display name
                  </label>
                  <input id="nw-profile-name-edit" value={editDisplayName} disabled={busy}
                    placeholder="What people see next to your ID"
                    onChange={(event) => setEditDisplayName(event.target.value)} />
                  <p className="nw-small nw-dim" style={{ margin: '6px 0 0' }}>
                    {`Optional, up to ${DISPLAY_NAME_MAX} characters.`}
                  </p>
                  {textProblem(editDisplayName, DISPLAY_NAME_MAX) ? (
                    <p className="nw-small" style={{ margin: '6px 0 0', color: 'var(--warn)' }}>
                      {textProblem(editDisplayName, DISPLAY_NAME_MAX)}
                    </p>
                  ) : null}

                  <label className="nw-label" htmlFor="nw-profile-status-edit" style={{ marginTop: 10 }}>
                    Status
                  </label>
                  <input id="nw-profile-status-edit" value={editStatus} disabled={busy}
                    placeholder="One short line"
                    onChange={(event) => setEditStatus(event.target.value)} />
                  <p className="nw-small nw-dim" style={{ margin: '6px 0 0' }}>
                    {`Optional, up to ${STATUS_MAX} characters.`}
                  </p>
                  {textProblem(editStatus, STATUS_MAX) ? (
                    <p className="nw-small" style={{ margin: '6px 0 0', color: 'var(--warn)' }}>
                      {textProblem(editStatus, STATUS_MAX)}
                    </p>
                  ) : null}

                  <label className="nw-label" htmlFor="nw-profile-bio-edit" style={{ marginTop: 10 }}>
                    Bio
                  </label>
                  <textarea id="nw-profile-bio-edit" rows={3} value={editBio} disabled={busy}
                    placeholder="A short description"
                    onChange={(event) => setEditBio(event.target.value)} />
                  <p className="nw-small nw-dim" style={{ margin: '6px 0 0' }}>
                    {`Optional, up to ${BIO_MAX} characters.`}
                  </p>
                  {textProblem(editBio, BIO_MAX) ? (
                    <p className="nw-small" style={{ margin: '6px 0 0', color: 'var(--warn)' }}>
                      {textProblem(editBio, BIO_MAX)}
                    </p>
                  ) : null}

                  <label className="nw-label" htmlFor="nw-profile-visibility-edit" style={{ marginTop: 10 }}>
                    Profile visibility
                  </label>
                  <select id="nw-profile-visibility-edit" value={editVisibility}
                    disabled={busy} onChange={(event) => setEditVisibility(event.target.value)}>
                    <option value="signed-in">Any signed-in account</option>
                    <option value="contacts">My contacts only</option>
                    <option value="private">Only me</option>
                  </select>
                  <p className="nw-small nw-dim" style={{ margin: '6px 0 0' }}>
                    Controls who can read this profile and its primary wallet. Existing chats are not
                    deleted; a hidden profile only falls back to the uid for its label.
                  </p>

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
                      disabled={busy || !normalizeProfileId(editProfileId)
                        || Boolean(textProblem(editDisplayName, DISPLAY_NAME_MAX))
                        || Boolean(textProblem(editStatus, STATUS_MAX))
                        || Boolean(textProblem(editBio, BIO_MAX))}>
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

              <label className="nw-label" htmlFor="nw-profile-name" style={{ marginTop: 10 }}>
                Display name
              </label>
              <input id="nw-profile-name" value={displayNameInput} disabled={busy}
                placeholder="What people see next to your ID"
                onChange={(event) => setDisplayNameInput(event.target.value)} />
              <p className="nw-small nw-dim" style={{ margin: '6px 0 0' }}>
                {`Optional, up to ${DISPLAY_NAME_MAX} characters.`}
              </p>
              {textProblem(displayNameInput, DISPLAY_NAME_MAX) ? (
                <p className="nw-small" style={{ margin: '6px 0 0', color: 'var(--warn)' }}>
                  {textProblem(displayNameInput, DISPLAY_NAME_MAX)}
                </p>
              ) : null}

              <label className="nw-label" htmlFor="nw-profile-status" style={{ marginTop: 10 }}>
                Status
              </label>
              <input id="nw-profile-status" value={statusInput} disabled={busy}
                placeholder="One short line"
                onChange={(event) => setStatusInput(event.target.value)} />
              <p className="nw-small nw-dim" style={{ margin: '6px 0 0' }}>
                {`Optional, up to ${STATUS_MAX} characters.`}
              </p>
              {textProblem(statusInput, STATUS_MAX) ? (
                <p className="nw-small" style={{ margin: '6px 0 0', color: 'var(--warn)' }}>
                  {textProblem(statusInput, STATUS_MAX)}
                </p>
              ) : null}

              <label className="nw-label" htmlFor="nw-profile-bio" style={{ marginTop: 10 }}>
                Bio
              </label>
              <textarea id="nw-profile-bio" rows={3} value={bioInput} disabled={busy}
                placeholder="A short description"
                onChange={(event) => setBioInput(event.target.value)} />
              <p className="nw-small nw-dim" style={{ margin: '6px 0 0' }}>
                {`Optional, up to ${BIO_MAX} characters.`}
              </p>
              {textProblem(bioInput, BIO_MAX) ? (
                <p className="nw-small" style={{ margin: '6px 0 0', color: 'var(--warn)' }}>
                  {textProblem(bioInput, BIO_MAX)}
                </p>
              ) : null}

              <label className="nw-label" htmlFor="nw-profile-visibility" style={{ marginTop: 10 }}>
                Profile visibility
              </label>
              <select id="nw-profile-visibility" value={visibilityInput}
                disabled={busy} onChange={(event) => setVisibilityInput(event.target.value)}>
                <option value="signed-in">Any signed-in account</option>
                <option value="contacts">My contacts only</option>
                <option value="private">Only me</option>
              </select>
              <p className="nw-small nw-dim" style={{ margin: '6px 0 0' }}>
                You can change this later. A contacts-only or private profile cannot be looked up by
                handle by everyone.
              </p>

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
                  disabled={busy || !account.emailVerified || !normalizeProfileId(idInput)
                    || Boolean(textProblem(displayNameInput, DISPLAY_NAME_MAX))
                    || Boolean(textProblem(statusInput, STATUS_MAX))
                    || Boolean(textProblem(bioInput, BIO_MAX))}>
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
            Stored: the ID, the claim that keeps it unique, the public address you pick, the
            display name, bio and status you type here, and who may read the profile. The email itself is never written to the
            database — only the provider&apos;s “verified” claim is checked. No balance, history,
            seed or password is stored, and deleting the profile deletes both documents.
          </p>
          <div className="nw-btn-row" style={{ margin: '10px 0 0' }}>
            <button type="button" className="nw-chip-btn" onClick={downloadData}
              disabled={exportState.busy}>
              {exportState.busy ? 'Preparing export…' : 'Download my data (JSON)'}
            </button>
          </div>
          <p className="nw-small nw-dim" style={{ margin: '6px 0 0' }}>
            Includes your profile, contacts, pending requests and block list. Messages and
            sign-in/session data are not part of this file.
          </p>
          {exportState.message ? (
            <p className="nw-small"
              role={exportState.error ? 'alert' : 'status'}
              style={{ margin: '6px 0 0', color: exportState.error ? 'var(--warn)' : 'var(--text-dim)' }}>
              {exportState.message}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
