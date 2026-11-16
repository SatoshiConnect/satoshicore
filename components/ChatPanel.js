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
import { createPaymentRequestText, parsePaymentRequestText } from '../lib/chatPaymentRequest';
import { createTransactionCardText, parseTransactionCardText } from '../lib/chatTransaction';
import ChatTransactionCard from './ChatTransactionCard';
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
  const [request, setRequest] = useState({ amount: '', busy: false, note: '', error: '' });
  // Blocking is a relay-side control: the list lives with the wallet address,
  // not with this screen, so it is read back rather than remembered here.
  const [gate, setGate] = useState({ busy: false, blocked: false, note: '', error: '' });

  const relayConfigured = Boolean(relayOrigin);
  const readOnly = !seed32;
  const coinDigits = coin.amount.replace(/[,_ ]/g, '');
  const coinAmountOk = /^\d+$/.test(coinDigits) && BigInt(coinDigits || '0') > 0n;
  const requestDigits = request.amount.replace(/[,_ ]/g, '');
  const requestAmountOk = /^\d+$/.test(requestDigits) && BigInt(requestDigits || '0') > 0n;

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
    setGate({ busy: false, blocked: false, note: '', error: '' });
    if (!client.current || !seed32) return;
    setInboxState({ phase: 'loading', error: '' });
    try {
      const blockedList = await client.current.blocks({ seed32, address });
      setGate({ busy: false, blocked: blockedList.includes(String(target).toUpperCase()), note: '', error: '' });
    } catch {
      // An unreadable block list must not look like "not blocked": say so and
      // leave the send path alone rather than inventing a state.
      setGate({ busy: false, blocked: false, note: '', error: 'Could not read the block list for this wallet.' });
    }
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

  /** Block or unblock the person in this thread, on the relay itself. */
  async function toggleBlock() {
    if (!client.current || !seed32 || !peer) return;
    const next = !gate.blocked;
    setGate((current) => ({ ...current, busy: true, note: '', error: '' }));
    try {
      if (next) await client.current.block({ seed32, address, peer });
      else await client.current.unblock({ seed32, address, peer });
      setGate({
        busy: false,
        blocked: next,
        note: next
          ? 'Blocked. The relay will not store messages between this wallet and that address, and queued mail was cleared. They are not told.'
          : 'Unblocked. Messages can be delivered again; nothing else is restored.',
        error: '',
      });
    } catch (error) {
      setGate((current) => ({ ...current, busy: false, error: String(error?.message || error) }));
    }
  }

  /** Ask the other wallet for an exact integer amount; this never signs. */
  async function sendPaymentRequest(event) {
    event.preventDefault();
    if (!client.current || !seed32 || !peer || !requestAmountOk) return;
    setRequest((current) => ({ ...current, busy: true, note: '', error: '' }));
    try {
      const text = createPaymentRequestText({ amount: requestDigits, address });
      await client.current.send({ seed32, from: address, to: peer, text });
      setThread((current) => [...current, {
        id: `r${Date.now()}`, peer, from: address, text, at: Date.now(), own: true,
      }]);
      setRequest({ amount: '', busy: false, note: 'Payment request sent. It does not debit the other wallet.', error: '' });
    } catch (error) {
      setRequest((current) => ({ ...current, busy: false, error: String(error?.message || error) }));
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
      // The transaction hash is a pointer, not a verdict. Both sides get the
      // exact same structured claim; the card will query the indexer on each
      // device and show Finalized/Failed only after the matching hash, amount,
      // sender and destination all verify against the closed ledger.
      const cardText = createTransactionCardText({
        hash: result.hash, amount, from: address, to: peer,
      });
      setThread((current) => [...current, {
        id: `c${Date.now()}`, peer, from: address, text: cardText, at: Date.now(), own: true,
      }]);
      setCoin({ amount: '', phase: 'idle', note: 'Transaction card added. The indexer is checking the exact hash.', error: '' });
      if (client.current && seed32) {
        try {
          await client.current.send({ seed32, from: address, to: peer, text: cardText });
        } catch { /* the ledger transaction is already independent of chat delivery */ }
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
        {readOnly ? null : (
          <div style={{ marginTop: 8 }}>
            <div className="nw-btn-row" style={{ marginTop: 0 }}>
              <button type="button" className="nw-chip-btn" onClick={toggleBlock}
                disabled={gate.busy} aria-pressed={gate.blocked}>
                {gate.blocked ? 'Unblock this address' : 'Block this address'}
              </button>
              {gate.blocked ? <span className="nw-badge warn">blocked</span> : null}
            </div>
            {gate.note ? (
              <p className="nw-small nw-dim" style={{ margin: '6px 0 0' }} role="status">{gate.note}</p>
            ) : null}
            {gate.error ? (
              <p className="nw-small" style={{ margin: '6px 0 0', color: 'var(--warn)' }} role="alert">{gate.error}</p>
            ) : null}
          </div>
        )}
        <p className="nw-small nw-dim" style={{ margin: '8px 0 0' }}>
          To send coins you only need this address. An email is never stored here — the profile keeps
          an @id and a public address and nothing else — so ask for an email directly if you need one.
        </p>

        {onSendTo ? (
          <form className="nw-txf" onSubmit={sendPaymentRequest} style={{ marginTop: 12 }}>
            <label className="nw-small nw-dim" htmlFor="nw-chat-payment-request">
              Request an amount from {shortAddr(peer)}
            </label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input id="nw-chat-payment-request" className="nw-chat-input"
                value={request.amount} inputMode="numeric" placeholder="Amount in NSAT"
                aria-label="NSAT amount to request" style={{ maxWidth: 160 }}
                onChange={(event) => setRequest({
                  amount: event.target.value.replace(/[^\d,_ ]/g, ''),
                  busy: false, note: '', error: '',
                })}
                disabled={readOnly || request.busy || gate.blocked} />
              <button type="submit" className="nw-chip-btn"
                disabled={readOnly || request.busy || gate.blocked || !requestAmountOk}>
                {request.busy ? 'Sending request…' : 'Request payment'}
              </button>
            </div>
            {request.error ? <p className="nw-small" role="alert" style={{ margin: 0, color: 'var(--warn)' }}>{request.error}</p> : null}
            {request.note ? <p className="nw-small nw-dim" role="status" style={{ margin: 0 }}>{request.note}</p> : null}
          </form>
        ) : null}

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
          {thread.map((message) => {
            const paymentRequest = parsePaymentRequestText(message.text, message.from);
            const transactionCard = parseTransactionCardText(message.text, message.from);
            return (
              <li key={message.id} className={'nw-chat-bubble' + (message.own ? ' is-own' : '')}>
                {transactionCard?.kind === 'transaction-card'
                  && transactionCard.from === message.from
                  && ((transactionCard.from === address && transactionCard.to === peer)
                    || (transactionCard.from === peer && transactionCard.to === address)) ? (
                  <ChatTransactionCard card={transactionCard} sentAt={message.at} />
                ) : transactionCard ? (
                  <div className="nw-chat-text">
                    <strong>Unverified transaction message</strong>
                    <div className="nw-small nw-dim">{transactionCard.reason}</div>
                  </div>
                ) : paymentRequest?.kind === 'payment-request' ? (
                  <div className="nw-chat-text">
                    <strong>Payment request · {paymentRequest.amount} NSAT</strong>
                    <div className="nw-small nw-dim nw-mono" style={{ wordBreak: 'break-all', marginTop: 4 }}>
                      Requested receiving address: {paymentRequest.address}
                    </div>
                    {!message.own && onSendTo ? (
                      <button type="button" className="nw-send-btn" style={{ marginTop: 8 }}
                        disabled={readOnly || gate.blocked}
                        onClick={() => onSendTo(paymentRequest.address, paymentRequest.amount)}>
                        Review payment · {paymentRequest.amount} NSAT
                      </button>
                    ) : (
                      <div className="nw-small nw-dim" style={{ marginTop: 6 }}>
                        Request sent. Waiting for the recipient to review it; no funds have moved.
                      </div>
                    )}
                  </div>
                ) : paymentRequest?.kind === 'invalid' ? (
                  <div className="nw-chat-text">
                    <strong>Invalid payment request</strong>
                    <div className="nw-small nw-dim">{paymentRequest.reason}</div>
                  </div>
                ) : (
                  <div className="nw-chat-text">{message.text}</div>
                )}
                <div className="nw-small nw-dim">
                  {message.own ? 'sent' : shortAddr(message.from)}
                  {message.at ? ` · ${new Date(message.at).toLocaleTimeString()}` : ''}
                </div>
              </li>
            );
          })}
        </ul>

        <form className="nw-txf" onSubmit={send} style={{ marginTop: 12 }}>
          <textarea className="nw-chat-input" value={draft} maxLength={MAX_TEXT_LENGTH}
            placeholder={readOnly ? 'Unlock the wallet to send' : gate.blocked ? 'Blocked — unblock to write' : 'Write an encrypted message…'}
            onChange={(event) => setDraft(event.target.value)}
            disabled={readOnly || state.busy || gate.blocked}
            rows={2} aria-label="Encrypted message" />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="nw-send-btn" type="submit"
              disabled={readOnly || state.busy || gate.blocked || !draft.trim()}>
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
