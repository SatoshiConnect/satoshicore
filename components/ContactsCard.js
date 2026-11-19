'use client';

// Contacts: one search field, the requests I owe an answer to, the people I can
// message, and the block list.
//
// What this screen is not: a wallet. It never unlocks a keystore, never reads a
// seed and cannot sign. A contact is an account-level relationship between two
// Google uids; adding somebody here does not give them the ability to spend, and
// sending NSAT still goes through the wallet's own review and confirmation.
//
// Every write goes through `lib/contacts.js`, which builds the exact documents
// the rules check. The client is a convenience: `firestore.rules` refuses a
// friendship without an accepted request, refuses any other document shape, and
// refuses a new request from an account its recipient blocked.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { isFirebaseWebConfigured, loadFirestore, loadGoogleAuth } from '../lib/firebaseAuth';
import {
  contactStateFor, classifyTarget, createFirestoreContactsStore, describeContactFailure,
} from '../lib/contacts';
import { profileDisplayLabel, resolveProfileHandle } from '../lib/profile';

const configured = isFirebaseWebConfigured();
const shortId = (value) => (value ? `${value.slice(0, 8)}…` : '');
const shortAddress = (value) => (value ? `${value.slice(0, 6)}…${value.slice(-6)}` : '');
// One label lookup per visible peer, capped so a long list cannot fan out into
// hundreds of reads just by being opened.
const LABEL_LOOKUPS = 20;

const EMPTY_GRAPH = { people: {}, incoming: {}, outgoing: {}, blocked: {} };

export default function ContactsCard({ onSendTo, onOpenSettings } = {}) {
  const [account, setAccount] = useState(null);      // { uid, email, emailVerified }
  const [ready, setReady] = useState(!configured);
  const [graph, setGraph] = useState(EMPTY_GRAPH);
  const [labels, setLabels] = useState({});          // uid → { profileId, primaryAddress }
  const [query, setQuery] = useState('');
  const [result, setResult] = useState(null);        // { kind, uid, profileId, primaryAddress }
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState(null);      // describeContactFailure result
  const [discovery, setDiscovery] = useState({ on: false, busy: false, known: false });
  const store = useRef(null);

  const refresh = useCallback(async () => {
    if (!store.current) return;
    try {
      setGraph(await store.current.snapshot());
    } catch (error) {
      setProblem(describeContactFailure(error));
    }
  }, []);

  useEffect(() => {
    if (!configured) return undefined;
    let alive = true;
    loadGoogleAuth().then(({ auth, authSdk }) => {
      if (!alive) return;
      authSdk.onAuthStateChanged(auth, async (user) => {
        if (!alive) return;
        store.current = null;
        setGraph(EMPTY_GRAPH);
        setLabels({});
        setResult(null);
        if (!user?.uid) {
          setAccount(null);
          setReady(true);
          return;
        }
        setAccount({
          uid: user.uid,
          email: user.email || '',
          emailVerified: Boolean(user.emailVerified),
        });
        try {
          const { sdk, db } = await loadFirestore();
          store.current = createFirestoreContactsStore(user.uid, {
            sdk: { ...sdk, db }, emailVerified: Boolean(user.emailVerified),
          });
          setReady(true);
          await refresh();
          // Is my own address currently discoverable? Asking for my own address
          // is the only way to find out without storing a flag that could lie.
          if (user.email) {
            try {
              const found = await store.current.discoverEmail(user.email);
              if (alive) setDiscovery({ on: found.uid === user.uid, busy: false, known: true });
            } catch (error) {
              if (alive && String(error?.code || '') === 'NO_CONSENT') {
                setDiscovery({ on: false, busy: false, known: true });
              }
            }
          }
        } catch (error) {
          setReady(true);
          setProblem(describeContactFailure(error));
        }
      });
    }).catch(() => {
      if (alive) {
        setReady(true);
        setProblem({ title: 'Sign-in is unavailable', message: 'Google sign-in could not start. Reload and try again.', tone: 'warn' });
      }
    });
    return () => { alive = false; };
  }, [refresh]);

  // Handles for the people in the lists, resolved from their public profile.
  const peerIds = useMemo(() => {
    const out = [];
    for (const bucket of [graph.incoming, graph.outgoing, graph.people, graph.blocked]) {
      for (const uid of Object.keys(bucket || {})) if (!out.includes(uid)) out.push(uid);
    }
    return out.slice(0, LABEL_LOOKUPS);
  }, [graph]);

  useEffect(() => {
    let alive = true;
    if (!store.current || peerIds.length === 0) return () => { alive = false; };
    Promise.all(peerIds.map(async (uid) => [uid, await store.current.peerProfile(uid)]))
      .then((entries) => {
        if (!alive) return;
        setLabels((current) => {
          const next = { ...current };
          for (const [uid, profile] of entries) next[uid] = profile;
          return next;
        });
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [peerIds]);

  const label = (uid) => profileDisplayLabel(labels[uid], shortId(uid));
  const state = (uid) => contactStateFor({ me: account?.uid, peer: uid, ...graph });

  async function search(event) {
    event.preventDefault();
    setProblem(null);
    setNote('');
    setResult(null);
    const target = classifyTarget(query);
    if (target.error) {
      setProblem({ title: 'Check what you typed', message: target.error, tone: 'warn' });
      return;
    }
    setSearching(true);
    try {
      if (target.kind === 'handle') {
        const profile = await resolveProfileHandle(target.value);
        setResult({ kind: 'handle', ...profile });
      } else if (target.kind === 'address') {
        // An address is a payment destination, not a person: no uid, so no
        // request can be sent to it and it is not shown as a verified contact.
        setResult({ kind: 'address', uid: '', profileId: '', primaryAddress: target.value });
      } else {
        if (!store.current) throw Object.assign(new Error('sign in first'), { code: 'NO_CONSENT' });
        const found = await store.current.discoverEmail(target.value);
        setResult({ kind: 'email', ...found });
      }
    } catch (error) {
      if (String(error?.code || '') === 'PROFILE_NOT_FOUND') {
        setProblem({ title: 'No such profile', message: 'That @profile ID does not exist. Check the spelling.', tone: 'warn' });
      } else if (String(error?.code || '') === 'permission-denied') {
        setProblem({
          title: 'This profile is not public',
          message: 'They limit who can read their profile. Ask them for their wallet address instead.',
          tone: 'warn',
        });
      } else {
        setProblem(describeContactFailure(error));
      }
    } finally {
      setSearching(false);
    }
  }

  async function act(action, peerUid) {
    if (!store.current || !peerUid) return;
    setBusy(action + peerUid);
    setProblem(null);
    setNote('');
    try {
      const next = await store.current[action](peerUid);
      setGraph(next);
      const said = {
        sendRequest: 'Request sent. They have to accept before either of you is in the other’s list.',
        accept: 'Contact added. You can both message now.',
        reject: 'Request refused.',
        cancel: 'Request withdrawn.',
        remove: 'Removed from your contacts. Their list is unchanged.',
        block: 'Blocked. Their list is unchanged, and they cannot send you a new request.',
        unblock: 'Unblocked. Nothing else is restored automatically.',
      };
      setNote(said[action] || 'Saved.');
    } catch (error) {
      setProblem(describeContactFailure(error));
    } finally {
      setBusy('');
    }
  }

  async function toggleDiscovery(next) {
    if (!store.current) return;
    setDiscovery((current) => ({ ...current, busy: true }));
    setProblem(null);
    setNote('');
    try {
      const state = await store.current.setEmailDiscovery(next, account?.email || '');
      setDiscovery({ on: state === 'on', busy: false, known: true });
      setNote(state === 'on'
        ? 'People who already know your email can now find this account. Your address itself is never stored.'
        : 'Email discovery is off. Nothing about your address is stored.');
    } catch (error) {
      setDiscovery((current) => ({ ...current, busy: false }));
      setProblem(describeContactFailure(error));
    }
  }

  if (!configured) return null;

  if (!account) {
    return (
      <section className="nw-card">
        <h2 style={{ color: 'var(--text)' }}>Contacts</h2>
        <p className="nw-small nw-dim" style={{ margin: '8px 0 10px' }}>
          Contacts belong to a signed-in account, so that a request can reach the person
          rather than this browser. The wallet works without an account; contacts do not.
        </p>
        <button type="button" className="nw-chip-btn" onClick={onOpenSettings}>
          Go to Settings to sign in
        </button>
      </section>
    );
  }

  const resultState = result?.uid ? state(result.uid) : '';
  const listBusy = (action, uid) => busy === action + uid;

  return (
    <section className="nw-card">
      <h2 style={{ color: 'var(--text)' }}>Contacts</h2>
      <p className="nw-small nw-dim" style={{ margin: '8px 0 10px' }}>
        Find someone by <strong>@profile ID</strong>, wallet address or — only if they
        turned it on — email. A relationship here cannot sign, spend or unlock anything.
      </p>

      <form className="nw-txf" onSubmit={search} style={{ marginTop: 0 }}>
        <label className="nw-label" htmlFor="nw-contact-search">
          Find a person
        </label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input id="nw-contact-search" className="nw-chat-input" value={query}
            placeholder="@profile, G… or email" autoComplete="off"
            onChange={(e) => setQuery(e.target.value)} disabled={searching}
            style={{ flex: 1, minWidth: 180 }} />
          <button type="submit" className="nw-chip-btn" disabled={searching || !ready}>
            {searching ? 'Looking…' : 'Search'}
          </button>
        </div>
      </form>

      {problem ? (
        <div role="alert" style={{ marginTop: 10 }}>
          <div className="nw-small" style={{ color: 'var(--warn)' }}>{problem.title}</div>
          <div className="nw-small nw-dim">{problem.message}</div>
        </div>
      ) : null}
      <div className="nw-small nw-dim" role="status" aria-live="polite" style={{ marginTop: 6 }}>
        {note}
      </div>

      {result ? (
        <div className="nw-tx-row" style={{ marginTop: 10 }}>
          <div style={{ flex: 1 }}>
            <div className="nw-notice-title">
              {profileDisplayLabel(result,
                result.profileId || (result.kind === 'address' ? 'Wallet address' : shortId(result.uid)))}
              {result.displayName && result.profileId ? (
                <span className="nw-small nw-dim nw-mono"> {result.profileId}</span>
              ) : null}
              {resultState === 'friend' ? <span className="nw-badge ok"> contact</span> : null}
              {result.kind === 'email' ? <span className="nw-badge info"> found by consent</span> : null}
              {result.kind === 'address' ? <span className="nw-badge info"> address only</span> : null}
            </div>
            {result.primaryAddress ? (
              <div className="nw-small nw-dim nw-mono" style={{ wordBreak: 'break-all' }}>
                {shortAddress(result.primaryAddress)}
              </div>
            ) : (
              <div className="nw-small nw-dim">
                This profile has no primary wallet yet, so it cannot receive NSAT.
              </div>
            )}
            {!result.uid ? (
              <div className="nw-small nw-dim">
                An address is a payment destination, not a person. To add a contact, search
                their @profile ID instead.
              </div>
            ) : null}
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {result.uid && resultState === 'none' ? (
              <button type="button" className="nw-chip-btn"
                disabled={listBusy('sendRequest', result.uid)}
                onClick={() => act('sendRequest', result.uid)}>Add contact</button>
            ) : null}
            {result.uid && resultState === 'rejected_out' ? (
              <button type="button" className="nw-chip-btn"
                disabled={listBusy('sendRequest', result.uid)}
                onClick={() => act('sendRequest', result.uid)}>Ask again</button>
            ) : null}
            {result.uid && resultState === 'pending_in' ? (
              <>
                <button type="button" className="nw-send-btn"
                  disabled={listBusy('accept', result.uid)}
                  onClick={() => act('accept', result.uid)}>Accept</button>
                <button type="button" className="nw-chip-btn"
                  disabled={listBusy('reject', result.uid)}
                  onClick={() => act('reject', result.uid)}>Refuse</button>
              </>
            ) : null}
            {result.uid && resultState === 'pending_out' ? (
              <button type="button" className="nw-chip-btn"
                disabled={listBusy('cancel', result.uid)}
                onClick={() => act('cancel', result.uid)}>Cancel request</button>
            ) : null}
            {result.uid && resultState === 'friend' ? (
              <button type="button" className="nw-chip-btn"
                disabled={listBusy('remove', result.uid)}
                onClick={() => act('remove', result.uid)}>Remove</button>
            ) : null}
            {result.uid && resultState === 'blocked' ? (
              <button type="button" className="nw-chip-btn"
                disabled={listBusy('unblock', result.uid)}
                onClick={() => act('unblock', result.uid)}>Unblock</button>
            ) : null}
            {result.primaryAddress && onSendTo ? (
              <button type="button" className="nw-chip-btn"
                onClick={() => onSendTo(result.primaryAddress)}>Send NSAT</button>
            ) : null}
            {result.uid && resultState !== 'blocked' ? (
              <button type="button" className="nw-chip-btn"
                disabled={listBusy('block', result.uid)}
                onClick={() => act('block', result.uid)}>Block</button>
            ) : null}
          </div>
        </div>
      ) : null}

      {Object.entries(graph.incoming).filter(([, state]) => state === 'pending').length > 0 ? (
        <>
          <h3 className="nw-section-title" style={{ marginTop: 18 }}>Requests to answer</h3>
          <ul className="nw-tx-list">
            {Object.entries(graph.incoming)
              .filter(([, value]) => value === 'pending')
              .map(([uid]) => (
                <li key={uid} className="nw-tx-row">
                  <div style={{ flex: 1 }}>
                    <div className="nw-notice-title">{label(uid)}</div>
                    <div className="nw-small nw-dim">wants to be a contact</div>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button type="button" className="nw-send-btn"
                      disabled={listBusy('accept', uid)}
                      onClick={() => act('accept', uid)}>Accept</button>
                    <button type="button" className="nw-chip-btn"
                      disabled={listBusy('reject', uid)}
                      onClick={() => act('reject', uid)}>Refuse</button>
                  </div>
                </li>
              ))}
          </ul>
        </>
      ) : null}

      {Object.entries(graph.outgoing).filter(([, value]) => value === 'pending').length > 0 ? (
        <>
          <h3 className="nw-section-title" style={{ marginTop: 18 }}>Waiting for an answer</h3>
          <ul className="nw-tx-list">
            {Object.entries(graph.outgoing)
              .filter(([, value]) => value === 'pending')
              .map(([uid]) => (
                <li key={uid} className="nw-tx-row">
                  <div style={{ flex: 1 }}>
                    <div className="nw-notice-title">{label(uid)}</div>
                    <div className="nw-small nw-dim">no answer yet</div>
                  </div>
                  <button type="button" className="nw-chip-btn"
                    disabled={listBusy('cancel', uid)}
                    onClick={() => act('cancel', uid)}>Withdraw</button>
                </li>
              ))}
          </ul>
        </>
      ) : null}

      <h3 className="nw-section-title" style={{ marginTop: 18 }}>Your contacts</h3>
      {Object.keys(graph.people).length === 0 ? (
        <p className="nw-small nw-dim" style={{ margin: '6px 0' }}>
          Nobody yet. Search above, or accept a request.
        </p>
      ) : (
        <ul className="nw-tx-list">
          {Object.keys(graph.people).map((uid) => (
            <li key={uid} className="nw-tx-row">
              <div style={{ flex: 1 }}>
                <div className="nw-notice-title">{label(uid)}</div>
                <div className="nw-small nw-dim nw-mono">
                  {labels[uid]?.primaryAddress
                    ? shortAddress(labels[uid].primaryAddress)
                    : 'no primary wallet published'}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                {labels[uid]?.primaryAddress && onSendTo ? (
                  <button type="button" className="nw-chip-btn"
                    onClick={() => onSendTo(labels[uid].primaryAddress)}>Send NSAT</button>
                ) : null}
                <button type="button" className="nw-chip-btn"
                  disabled={listBusy('remove', uid)}
                  onClick={() => act('remove', uid)}>Remove</button>
                <button type="button" className="nw-chip-btn"
                  disabled={listBusy('block', uid)}
                  onClick={() => act('block', uid)}>Block</button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {Object.keys(graph.blocked).length > 0 ? (
        <>
          <h3 className="nw-section-title" style={{ marginTop: 18 }}>Blocked</h3>
          <ul className="nw-tx-list">
            {Object.keys(graph.blocked).map((uid) => (
              <li key={uid} className="nw-tx-row">
                <div style={{ flex: 1 }}>
                  <div className="nw-notice-title">{label(uid)}</div>
                  <div className="nw-small nw-dim">cannot send you a new request</div>
                </div>
                <button type="button" className="nw-chip-btn"
                  disabled={listBusy('unblock', uid)}
                  onClick={() => act('unblock', uid)}>Unblock</button>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <h3 className="nw-section-title" style={{ marginTop: 18 }}>Being found</h3>
      <label className="nw-small" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 6 }}>
        <input type="checkbox" checked={discovery.on}
          disabled={discovery.busy || !account.emailVerified}
          onChange={(e) => toggleDiscovery(e.target.checked)} />
        <span>
          Let people who already know my email address find this account.
          <span className="nw-dim" style={{ display: 'block' }}>
            Only a hash of the address is stored, never the address itself. Off by default;
            @profile IDs and wallet addresses work without it.
          </span>
        </span>
      </label>
      {!account.emailVerified ? (
        <p className="nw-small nw-dim" style={{ margin: '6px 0 0' }}>
          This account&apos;s email is not verified by the provider, so discovery cannot be
          turned on.
        </p>
      ) : null}
      {!discovery.known && account.email ? (
        <p className="nw-small nw-dim" style={{ margin: '6px 0 0' }}>
          Current state unknown — reload to check before relying on it.
        </p>
      ) : null}
    </section>
  );
}
