'use client';

// Encrypted chat screen.
//
// The wallet keeps the plaintext: it is encrypted to the recipient here, with a
// key the relay never has, and decrypted here with this wallet's seed. The relay
// only sees two addresses, a size and a timestamp (docs/E2E-CHAT-DESIGN.md).
//
// The thread lives in this session only. Messages are deleted from the relay as
// soon as they are read, and nothing is written to localStorage — losing the tab
// loses the transcript, which is the price of not keeping plaintext chats at
// rest on a shared device.
import { useCallback, useEffect, useRef, useState } from 'react';

import { createChatClient } from '../lib/chatClient';
import {
  FRIEND_LIMIT, addFriend, mergeContacts, parseFriendTarget, readFriends, removeFriend,
} from '../lib/chatFriends';
import { MAX_TEXT_LENGTH } from '../lib/e2eChat';
import { resolveProfileHandle } from '../lib/profile';

const shortAddr = (value) => (value ? `${value.slice(0, 6)}…${value.slice(-4)}` : '');

export default function ChatPanel({ seed32, address, contacts, relayOrigin, onSendTo, onSendCoins, onBack }) {
  const client = useRef(null);
  const [peer, setPeer] = useState('');
  const [thread, setThread] = useState([]);          // { id, from, text, ts|at, own }
  const [draft, setDraft] = useState('');
  const [state, setState] = useState({ busy: false, note: '', published: false });
  const [inboxState, setInboxState] = useState({ phase: 'idle', error: '' });
  const [friends, setFriends] = useState([]);
  const [addTarget, setAddTarget] = useState('');
  const [addState, setAddState] = useState({ busy: false, note: '', error: '' });
  // Which @id resolved to which address, for the lifetime of this screen.
  const [peerIds, setPeerIds] = useState({});
  const [copyState, setCopyState] = useState('');
  const [coin, setCoin] = useState({ amount: '', phase: 'idle', note: '', error: '' });

  const relayConfigured = Boolean(relayOrigin);
  const readOnly = !seed32;
  const coinDigits = coin.amount.replace(/[,_ ]/g, '');
  const coinAmountOk = /^\d+$/.test(coinDigits) && BigInt(coinDigits || '0') > 0n;

  // Friends are public addresses the person named themselves; the transcript
  // stays in this session. Loading is deferred to an effect so the first render
  // matches the static export.
  useEffect(() => {
    if (!address || typeof window === 'undefined') return;
    setFriends(readFriends(window.localStorage, address));
  }, [address]);

  const known = mergeContacts(contacts, friends);

  useEffect(() => {
    if (!relayConfigured) return undefined;
    client.current = createChatClient({ origin: relayOrigin });
    return () => { client.current = null; };
  }, [relayOrigin, relayConfigured]);

  const publishOwnKey = useCallback(async () => {
    if (!client.current || !seed32 || state.published) return;
    try {
      await client.current.publishKey({ seed32, address });
      setState((current) => ({ ...current, published: true }));
    } catch (error) {
      setState((current) => ({ ...current, note: String(error?.message || error) }));
    }
  }, [address, seed32, state.published]);

  // Publish this wallet's messaging key as soon as the screen opens, so someone
  // else can write to it without having to wait for a first reply.
  useEffect(() => {
    if (!relayConfigured || !seed32) return;
    void publishOwnKey();
  }, [publishOwnKey, relayConfigured, seed32]);

  const openThread = useCallback(async (target) => {
    setPeer(target);
    setThread((current) => current.filter((message) => message.peer === target));
    if (!client.current || !seed32) return;
    setInboxState({ phase: 'loading', error: '' });
    try {
      const { messages, undecryptable } = await client.current.inbox({ seed32, address });
      setThread((current) => {
        const known = new Set(current.map((message) => message.id).filter(Boolean));
        const incoming = messages
          .filter((message) => message.from === target && !known.has(`m${message.id}`))
          .map((message) => ({
            id: `m${message.id}`, peer: message.from, from: message.from,
            text: message.text, at: message.ts, own: false,
          }));
        return [...current, ...incoming].sort((a, b) => (a.at || 0) - (b.at || 0));
      });
      setInboxState({
        phase: undecryptable.length ? 'partial' : 'ready',
        error: undecryptable.length
          ? `${undecryptable.length} message(s) stayed on the relay: this wallet cannot open them.`
          : '',
      });
    } catch (error) {
      setInboxState({ phase: 'unavailable', error: String(error?.message || error) });
    }
  }, [address, seed32]);

  /** @id → the wallet its profile points at, else the address as typed. */
  async function resolveTarget(parsed) {
    if (parsed.kind === 'address') return parsed.value;
    let profile;
    try {
      profile = await resolveProfileHandle(parsed.value);
    } catch (error) {
      if (String(error?.code || '') === 'PROFILE_NOT_FOUND') {
        throw new Error(`No profile ${parsed.value} exists yet.`);
      }
      throw new Error(
        `Could not look up ${parsed.value}. Sign in with Google above (profiles are read by the signed-in account), or paste the wallet address instead.`,
      );
    }
    if (!profile.primaryAddress) {
      throw new Error(`${parsed.value} has not chosen a primary wallet yet — ask them for their G… address.`);
    }
    return profile.primaryAddress;
  }

  async function addFriendTarget(event) {
    event.preventDefault();
    const parsed = parseFriendTarget(addTarget);
    if (parsed.error) {
      setAddState({ busy: false, note: '', error: parsed.error });
      return;
    }
    setAddState({ busy: true, note: '', error: '' });
    try {
      const walletAddress = await resolveTarget(parsed);
      const stored = addFriend(typeof window === 'undefined' ? null : window.localStorage, address, walletAddress);
      setFriends(stored.friends);
      if (parsed.kind === 'id') setPeerIds((current) => ({ ...current, [walletAddress]: parsed.value }));
      setAddTarget('');
      const label = parsed.kind === 'id' ? `${parsed.value} · ${shortAddr(walletAddress)}` : shortAddr(walletAddress);
      setAddState({
        busy: false,
        error: '',
        note: stored.added ? `${label} added.` : `${label} was already in the list.`,
      });
    } catch (error) {
      setAddState({ busy: false, note: '', error: String(error?.message || error) });
    }
  }

  /** A coin "sticker": send NSAT to the person in this conversation. */
  async function sendCoinSticker() {
    const amount = coin.amount.replace(/[,_ ]/g, '');
    if (!onSendCoins || !peer) return;
    setCoin((current) => ({ ...current, phase: 'sending', error: '', note: '' }));
    try {
      const result = await onSendCoins(peer, amount);
      const status = String(result?.status || '');
      if (!result?.ok || !result.hash || status === 'rejected') {
        setCoin((current) => ({
          ...current, phase: 'idle',
          error: status === 'rejected'
            ? 'The node rejected this payment, so nothing moved. See the message the wallet showed.'
            : 'The wallet did not submit this payment — nothing moved. See the message the wallet showed.',
        }));
        return;
      }
      const shortHash = `${result.hash.slice(0, 10)}…${result.hash.slice(-8)}`;
      // Say exactly what the ledger said: a submitted payment that has not been
      // confirmed (or that failed on chain) must not read as "sent and done".
      const label = status === 'confirmed'
        ? `🪙 Sent ${amount} NSAT · tx ${shortHash}`
        : status === 'failed'
          ? `🪙 ${amount} NSAT failed on-chain · tx ${shortHash}`
          : `🪙 ${amount} NSAT submitted (${status || 'pending'}) · tx ${shortHash}`;
      setThread((current) => [...current, {
        id: `c${Date.now()}`, peer, from: address, text: label, at: Date.now(), own: true,
      }]);
      setCoin({ amount: '', phase: 'idle', note: `${label}`, error: '' });
      // Best effort: tell the other side in the conversation too. The payment
      // itself is already on the chain, so a failed message loses no money.
      if (client.current && seed32) {
        try {
          await client.current.send({
            seed32, from: address, to: peer, text: `🪙 ${amount} NSAT — tx ${result.hash}`,
          });
        } catch { /* the transfer is what matters; the note can wait */ }
      }
    } catch (error) {
      setCoin((current) => ({ ...current, phase: 'idle', error: String(error?.message || error) }));
    }
  }

  async function copyPeerAddress() {
    try {
      await navigator.clipboard.writeText(peer);
      setCopyState('done');
    } catch {
      setCopyState('failed');
    }
    setTimeout(() => setCopyState(''), 2500);
  }

  function forgetFriend(target) {
    if (typeof window === 'undefined') return;
    setFriends(removeFriend(window.localStorage, address, target));
    setAddState({ busy: false, note: `${shortAddr(target)} removed from your list.`, error: '' });
  }

  async function send(event) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !client.current || !seed32 || !peer) return;
    setState((current) => ({ ...current, busy: true, note: '' }));
    try {
      await client.current.send({ seed32, from: address, to: peer, text });
      setThread((current) => [...current, {
        id: `s${Date.now()}`, peer, from: address, text, at: Date.now(), own: true,
      }]);
      setDraft('');
    } catch (error) {
      setState((current) => ({ ...current, note: String(error?.message || error) }));
    } finally {
      setState((current) => ({ ...current, busy: false }));
    }
  }

  if (!relayConfigured) {
    return (
      <div>
        <button type="button" className="nw-chip-btn" onClick={onBack}>← Back</button>
        <section className="nw-card" style={{ marginTop: 12 }}>
          <h2 style={{ color: 'var(--text)', margin: 0 }}>Messages</h2>
          <p className="nw-small nw-dim" style={{ margin: '8px 0 0' }}>
            This build has no chat relay configured, so messages cannot be delivered. Nothing is
            uploaded and nothing is queued.
          </p>
        </section>
      </div>
    );
  }

  if (!peer) {
    return (
      <div>
        <button type="button" className="nw-chip-btn" onClick={onBack}>← Back</button>
        <section className="nw-card" style={{ marginTop: 12 }}>
          <h2 style={{ color: 'var(--text)', margin: 0 }}>Messages</h2>
          <p className="nw-small nw-dim" style={{ margin: '8px 0 0' }}>
            End-to-end encrypted: the wallet encrypts on this device and the relay only stores
            ciphertext. Pick a past counterparty, or add a friend by @profile ID or wallet address.
          </p>
          {readOnly && (
            <p className="nw-small" style={{ color: 'var(--warn)', margin: '8px 0 0' }}>
              Unlock the wallet to read and send messages.
            </p>
          )}
          <form className="nw-txf" onSubmit={addFriendTarget} style={{ marginTop: 12, gap: 8 }}>
            <input value={addTarget} onChange={(event) => {
              setAddTarget(event.target.value);
              if (addState.error) setAddState({ busy: false, note: '', error: '' });
            }} placeholder="@profile or G… address"
              aria-label="Friend profile ID or wallet address" spellCheck={false}
              disabled={addState.busy} />
            <button className="nw-send-btn" type="submit"
              disabled={addState.busy || !addTarget.trim()}>
              {addState.busy ? 'Adding…' : 'Add friend'}
            </button>
          </form>
          {addState.error ? (
            <p className="nw-small" style={{ margin: '6px 0 0', color: 'var(--warn)' }} role="alert">
              {addState.error}
            </p>
          ) : null}
          {addState.note ? (
            <p className="nw-small nw-dim" style={{ margin: '6px 0 0' }} role="status">
              {addState.note}
            </p>
          ) : null}

          {known.length === 0 ? (
            <p className="nw-small nw-dim" style={{ margin: '10px 0 0' }}>
              No one to message yet — add a friend above, or wait for a transfer to appear in the
              index.
            </p>
          ) : (
            <ul className="nw-tx-list" style={{ marginTop: 8 }}>
              {known.map((contact) => {
                const added = friends.includes(contact);
                return (
                  <li key={contact} className="nw-tx-row">
                    <div className="nw-tx-dir rec" aria-hidden>✉</div>
                    <div style={{ flex: 1 }}>
                      <div className="nw-notice-title">
                        {shortAddr(contact)}{' '}
                        {added ? <span className="nw-badge info">friend</span> : null}
                      </div>
                      <div className="nw-small nw-dim">
                        {added ? 'added by you · encrypted message' : 'from your transfers · encrypted message'}
                      </div>
                    </div>
                    <button type="button" className="nw-chip-btn"
                      onClick={() => { void publishOwnKey(); void openThread(contact); }}>
                      Open
                    </button>
                    {added ? (
                      <button type="button" className="nw-chip-btn"
                        title={`Remove ${contact} from your friend list`}
                        onClick={() => forgetFriend(contact)}>
                        Remove
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          <p className="nw-small nw-dim" style={{ margin: '10px 0 0' }}>
            {`Your friend list keeps only public wallet addresses on this device (up to ${FRIEND_LIMIT}). Messages themselves are never stored.`}
          </p>
        </section>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button type="button" className="nw-chip-btn" onClick={() => { setPeer(''); setThread([]); }}>
          ← Messages
        </button>
        <span className="nw-small nw-dim">{shortAddr(peer)}</span>
      </div>

      <section className="nw-card" style={{ marginTop: 12 }}>
        <h2 style={{ color: 'var(--text)', margin: 0, display: 'flex', gap: 8, alignItems: 'center' }}>
          {shortAddr(peer)}
          <span className="nw-badge ok">end-to-end encrypted</span>
        </h2>
        <p className="nw-small nw-dim" style={{ margin: '6px 0 0' }}>
          Ciphertext only on the relay. Keys come from this wallet — nobody else can read these.
        </p>

        {/* Everything needed to pay this person, in one place: the public
         * address is the only thing the chat can hand over — the site never
         * stores an email, and a profile is an @id plus this same address. */}
        <div className="nw-kv" style={{ marginTop: 10 }}>
          <span className="nw-k">Wallet address</span>
          <span className="nw-v nw-small nw-mono" style={{ wordBreak: 'break-all' }}>{peer}</span>
        </div>
        {peerIds[peer] ? (
          <div className="nw-kv">
            <span className="nw-k">Profile</span>
            <span className="nw-v nw-small nw-mono">{peerIds[peer]}</span>
          </div>
        ) : null}
        <div className="nw-btn-row" style={{ marginTop: 8 }}>
          <button type="button" className="nw-chip-btn" onClick={copyPeerAddress}>
            {copyState === 'done' ? 'Address copied ✓' : copyState === 'failed' ? 'Copy failed — select it above' : 'Copy address'}
          </button>
          {onSendTo ? (
            <button type="button" className="nw-send-btn" onClick={() => onSendTo(peer)}>
              Send NSAT to this address
            </button>
          ) : null}
        </div>
        <p className="nw-small nw-dim" style={{ margin: '8px 0 0' }}>
          To send coins you only need this address. An email is never stored here — the profile keeps
          an @id and a public address and nothing else — so ask for an email directly if you need one.
        </p>

        {/* Sending from the conversation: the same wallet pipeline the Send
         * page uses, with an explicit confirm in between. Nothing moves from a
         * stray tap, and the payment itself is the signature — not a message. */}
        {onSendCoins ? (
          <div style={{ marginTop: 12 }}>
            {coin.phase === 'confirm' ? (
              <>
                <p className="nw-small" style={{ margin: 0 }}>
                  {`Send ${coinDigits} NSAT to ${shortAddr(peer)}? The network fee is charged on top, and this is signed with the key already unlocked in this tab.`}
                </p>
                <div className="nw-btn-row" style={{ marginTop: 8 }}>
                  <button type="button" className="nw-send-btn" onClick={sendCoinSticker}
                    disabled={readOnly || coin.phase === 'sending'}>
                    {coin.phase === 'sending' ? 'Signing & sending…' : 'Confirm payment'}
                  </button>
                  <button type="button" className="nw-chip-btn"
                    onClick={() => setCoin({ amount: '', phase: 'idle', note: '', error: '' })}
                    disabled={coin.phase === 'sending'}>
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <input className="nw-chat-input" value={coin.amount} inputMode="numeric"
                  placeholder="Amount in NSAT" aria-label="Amount of NSAT to send"
                  style={{ maxWidth: 160 }}
                  onChange={(event) => setCoin({
                    amount: event.target.value.replace(/[^\d,_ ]/g, ''),
                    phase: 'idle', note: '', error: '',
                  })}
                  disabled={readOnly || coin.phase === 'sending'} />
                <button type="button" className="nw-chip-btn"
                  onClick={() => setCoin((current) => ({ ...current, phase: 'confirm', note: '', error: '' }))}
                  disabled={readOnly || coin.phase === 'sending' || !coinAmountOk}>
                  {coin.phase === 'sending' ? 'Sending…' : '🪙 Send coins'}
                </button>
              </div>
            )}
            {coin.error ? (
              <p className="nw-small" style={{ margin: '6px 0 0', color: 'var(--warn)' }} role="alert">
                {coin.error}
              </p>
            ) : null}
            {coin.note ? (
              <p className="nw-small nw-dim" style={{ margin: '6px 0 0' }} role="status">{coin.note}</p>
            ) : null}
          </div>
        ) : null}

        {inboxState.phase === 'loading' && (
          <p className="nw-small nw-dim" style={{ margin: '10px 0 0' }}>Checking for messages…</p>
        )}
        {inboxState.error ? (
          <p className="nw-small" style={{ margin: '8px 0 0', color: 'var(--warn)' }}>{inboxState.error}</p>
        ) : null}

        <ul className="nw-chat-thread" aria-live="polite" style={{ marginTop: 10 }}>
          {thread.length === 0 && (
            <li className="nw-small nw-dim" style={{ padding: '6px 2px' }}>
              No messages in this session yet.
            </li>
          )}
          {thread.map((message) => (
            <li key={message.id} className={'nw-chat-bubble' + (message.own ? ' is-own' : '')}>
              <div className="nw-chat-text">{message.text}</div>
              <div className="nw-small nw-dim">
                {message.own ? 'sent' : shortAddr(message.from)}
                {message.at ? ` · ${new Date(message.at).toLocaleTimeString()}` : ''}
              </div>
            </li>
          ))}
        </ul>

        <form className="nw-txf" onSubmit={send} style={{ marginTop: 12 }}>
          <textarea className="nw-chat-input" value={draft} maxLength={MAX_TEXT_LENGTH}
            placeholder={readOnly ? 'Unlock the wallet to send' : 'Write an encrypted message…'}
            onChange={(event) => setDraft(event.target.value)} disabled={readOnly || state.busy}
            rows={2} aria-label="Encrypted message" />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="nw-send-btn" type="submit"
              disabled={readOnly || state.busy || !draft.trim()}>
              {state.busy ? 'Sending…' : 'Send encrypted'}
            </button>
            <button type="button" className="nw-chip-btn" disabled={state.busy}
              onClick={() => void openThread(peer)}>
              Check inbox
            </button>
          </div>
          {state.note ? (
            <p className="nw-small" style={{ margin: 0, color: 'var(--warn)' }}>{state.note}</p>
          ) : null}
          <p className="nw-small nw-dim" style={{ margin: 0 }}>
            The other wallet receives this only when it opens its own messages; the relay keeps it
            for up to 30 days and deletes it after it is read.
          </p>
        </form>
      </section>
    </div>
  );
}
