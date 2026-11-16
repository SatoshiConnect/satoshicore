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
//
// Layout follows the shape people already know from a messenger: a list of
// people, then one room with a header, bubbles and a single composer. The
// wallet-specific details (address, blocking, payment request) sit behind the
// details panel instead of in the middle of the conversation.
import { useCallback, useEffect, useRef, useState } from 'react';

import { createChatClient } from '../lib/chatClient';
import {
  FRIEND_LIMIT, addFriend, mergeContacts, parseFriendTarget, readFriends, removeFriend,
} from '../lib/chatFriends';
import { MAX_TEXT_LENGTH } from '../lib/e2eChat';
import { cleanAmount, validateAmount } from '../lib/nsatSendPreflight';
import { createPaymentRequestText, parsePaymentRequestText } from '../lib/chatPaymentRequest';
import { createTransactionCardText, parseTransactionCardText } from '../lib/chatTransaction';
import ChatTransactionCard from './ChatTransactionCard';
import { resolveProfileHandle } from '../lib/profile';

const shortAddr = (value) => (value ? `${value.slice(0, 6)}…${value.slice(-4)}` : '');

// Avatar letters: a handle keeps its first two letters, a G… address skips the
// network prefix so the circle does not read as "GA" for everyone.
const initials = (value, handle) => {
  const source = String(handle || value || '').replace(/^@/, '');
  const letters = /^G[A-Z2-7]{55}$/.test(source) ? source.slice(1, 3) : source.slice(0, 2);
  return (letters || '?').toUpperCase();
};

const clock = (at) => (at
  ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  : '');

// A transfer bubble is only this chat's when the authenticated sender wrote it
// and its two parties are the two wallets in the room.
const cardInThisChat = (card, message, me, them) => card?.kind === 'transaction-card'
  && card.from === message.from
  && ((card.from === me && card.to === them) || (card.from === them && card.to === me));

export default function ChatPanel({
  seed32, address, addresses = [], contacts, relayOrigin, onSendTo, onSendCoins,
  fee, balance, netVerified = false, networkIdentity = '',
  canApproveWithPasskey = false, onRequestUnlock = null,
}) {
  const client = useRef(null);
  const [peer, setPeer] = useState('');
  const [thread, setThread] = useState([]);          // { id, from, text, ts|at, own }
  const [draft, setDraft] = useState('');
  const [state, setState] = useState({ busy: false, note: '', published: false });
  const [inboxError, setInboxError] = useState('');
  // Saved chats per wallet address. The list is readable while the wallet is
  // locked: these are public addresses this device already stored, not keys.
  const [friendsByOwner, setFriendsByOwner] = useState({});
  // A chat tapped while locked; after unlocking it opens on its own.
  const [pendingPeer, setPendingPeer] = useState('');
  const [addTarget, setAddTarget] = useState('');
  const [addState, setAddState] = useState({ busy: false, note: '', error: '' });
  // Which @id resolved to which address, for the lifetime of this screen.
  const [peerIds, setPeerIds] = useState({});
  const [copyState, setCopyState] = useState('');
  const [coin, setCoin] = useState({ amount: '', phase: 'idle', error: '' });
  const [approvalPassword, setApprovalPassword] = useState('');
  const [approvalMethod, setApprovalMethod] = useState(canApproveWithPasskey ? 'passkey' : 'password');
  // Presentation: the add form, the room's details panel, and which composer
  // option (send NSAT / request NSAT) is open.
  const [showAdd, setShowAdd] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [sheet, setSheet] = useState('none');        // none | menu | pay | request
  const threadRef = useRef(null);
  // Blocking is a relay-side control: the list lives with the wallet address,
  // not with this screen, so it is read back rather than remembered here.
  const [gate, setGate] = useState({ busy: false, blocked: false, note: '', error: '' });
  const [request, setRequest] = useState({ amount: '', busy: false, note: '', error: '' });

  useEffect(() => {
    setApprovalMethod(canApproveWithPasskey ? 'passkey' : 'password');
    setApprovalPassword('');
  }, [address, canApproveWithPasskey]);

  const relayConfigured = Boolean(relayOrigin);
  const readOnly = !seed32;
  const coinDigits = cleanAmount(coin.amount);
  const coinAmountOk = validateAmount(coin.amount).ok;
  const requestDigits = cleanAmount(request.amount);
  const requestAmountOk = validateAmount(request.amount).ok;
  const peerName = peerIds[peer] || shortAddr(peer);
  // The only thing that may be disabled by a missing secret: approval. The
  // message box and the chat list never depend on it.
  const approvalReady = !readOnly && netVerified && fee != null && balance != null
    && (approvalMethod === 'passkey' ? canApproveWithPasskey : Boolean(approvalPassword));

  // Friends are public addresses the person named themselves; the transcript
  // stays in this session. Every wallet this session may see contributes its
  // own saved list, so a locked wallet still shows the chats it saved instead of
  // looking like it never had any. Loading is deferred to an effect so the first
  // render matches the static export.
  const ownerKey = [address, ...addresses].filter(Boolean).join(',');
  useEffect(() => {
    if (!ownerKey || typeof window === 'undefined') return;
    const next = {};
    for (const owner of ownerKey.split(',')) {
      next[owner] = readFriends(window.localStorage, owner);
    }
    setFriendsByOwner(next);
  }, [ownerKey]);

  const ownAddresses = new Set(ownerKey.split(',').map((value) => value.toUpperCase()));
  const friendList = [...new Set(Object.values(friendsByOwner).flat())]
    .filter((contact) => !ownAddresses.has(String(contact).toUpperCase()));
  const known = mergeContacts(contacts, friendList);

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

  // A new message should be visible without hunting for it: keep the end of the
  // transcript in view, the way a chat app opens on the latest line.
  useEffect(() => {
    const list = threadRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [thread.length, peer]);

  const openThread = useCallback(async (target) => {
    setPeer(target);
    setThread((current) => current.filter((message) => message.peer === target));
    setGate({ busy: false, blocked: false, note: '', error: '' });
    setSheet('none');
    if (!client.current || !seed32) return;
    setInboxError('');
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
      setInboxError(undecryptable.length
        ? `${undecryptable.length} message(s) stayed on the relay: this wallet cannot open them.`
        : '');
    } catch (error) {
      setInboxError(String(error?.message || error));
    }
  }, [address, seed32]);

  // A chat tapped while the wallet was locked: opening it was the reason for the
  // unlock, so it opens as soon as the key exists instead of asking for a
  // second tap.
  useEffect(() => {
    if (!seed32 || !pendingPeer) return;
    const target = pendingPeer;
    setPendingPeer('');
    void publishOwnKey();
    void openThread(target);
  }, [seed32, pendingPeer, publishOwnKey, openThread]);

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
      setFriendsByOwner((current) => ({ ...current, [address]: stored.friends }));
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

  /** Send NSAT to the person in this conversation; only this signs. */
  async function sendMoney() {
    const amount = cleanAmount(coin.amount);
    if (!onSendCoins || !peer) return;
    setCoin((current) => ({ ...current, phase: 'sending', error: '' }));
    try {
      const pendingApproval = onSendCoins(peer, amount, approvalPassword, approvalMethod);
      setApprovalPassword('');
      const result = await pendingApproval;
      const status = String(result?.status || '');
      if (!result?.ok || !result.hash || status === 'rejected') {
        setCoin((current) => ({
          ...current, phase: 'idle',
          error: result?.error || (status === 'rejected'
            ? 'The node rejected this payment, so nothing moved. See the message the wallet showed.'
            : 'The wallet did not submit this payment — nothing moved. See the message the wallet showed.'),
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
      setCoin({ amount: '', phase: 'idle', error: '' });
      setApprovalMethod(canApproveWithPasskey ? 'passkey' : 'password');
      // The transfer bubble in the thread is the record; the sheet has done its
      // job and the conversation comes back.
      setSheet('none');
      if (client.current && seed32) {
        try {
          await client.current.send({ seed32, from: address, to: peer, text: cardText });
        } catch { /* the ledger transaction is already independent of chat delivery */ }
      }
    } catch (error) {
      setCoin((current) => ({ ...current, phase: 'idle', error: String(error?.message || error) }));
    } finally {
      setApprovalPassword('');
    }
  }

  /** Opening a conversation needs the wallet key; the list itself never does. */
  function requestUnlock(contact = '') {
    if (contact) setPendingPeer(contact);
    onRequestUnlock?.(contact);
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
    // The address can live in more than one visible wallet's list; remove it
    // from each list that holds it rather than only the active wallet's.
    const next = { ...friendsByOwner };
    for (const [owner, list] of Object.entries(friendsByOwner)) {
      if (list.includes(target)) next[owner] = removeFriend(window.localStorage, owner, target);
    }
    setFriendsByOwner(next);
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
      setSheet('none');
    } catch (error) {
      setState((current) => ({ ...current, note: String(error?.message || error) }));
    } finally {
      setState((current) => ({ ...current, busy: false }));
    }
  }

  if (!relayConfigured) {
    return (
      <section className="nw-card" aria-label="Chats">
        <h2 style={{ margin: 0 }}>Chats</h2>
        <p className="nw-small nw-dim" style={{ margin: '8px 0 0' }}>
          Chats are not available in this version of the wallet. Nothing is uploaded and nothing is
          queued, so your messages and keys stay on this device.
        </p>
      </section>
    );
  }

  if (!peer) {
    return (
      <section className="nw-chat-shell" aria-label="Chats">
        <div className="nw-chat-bar">
          <h2>Chats</h2>
          <button type="button" className="nw-chat-iconbtn"
            aria-label={showAdd ? 'Close add chat' : 'Start a new chat'}
            aria-expanded={showAdd}
            onClick={() => {
              // A new chat is saved against the wallet that owns it, so it needs
              // an unlocked wallet to know whose list to write to.
              if (readOnly) { requestUnlock(); return; }
              setShowAdd((value) => !value);
              setAddState({ busy: false, note: '', error: '' });
            }}>
            {showAdd ? '×' : '＋'}
          </button>
        </div>
        <p className="nw-small nw-dim nw-chat-hint">
          Only you and the person you write to can read these messages.
        </p>
        {readOnly && (
          <p className="nw-small" style={{ color: 'var(--warn)', margin: '8px 0 0' }}>
            {known.length
              ? 'Your saved chats are below. Unlock the wallet to open one.'
              : 'Unlock the wallet to start a chat.'}
          </p>
        )}

        {showAdd && (
          <>
            <form className="nw-txf" onSubmit={addFriendTarget} style={{ marginTop: 10 }}>
              <input value={addTarget} onChange={(event) => {
                setAddTarget(event.target.value);
                if (addState.error) setAddState({ busy: false, note: '', error: '' });
              }} placeholder="@profile or G… address"
                aria-label="Friend profile ID or wallet address" spellCheck={false}
                disabled={addState.busy} />
              <button className="nw-send-btn" type="submit"
                disabled={addState.busy || !addTarget.trim()}>
                {addState.busy ? 'Adding…' : 'Start chat'}
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
          </>
        )}

        {known.length === 0 ? (
          <div className="nw-chat-empty">
            <strong>No chats yet</strong>
            {readOnly
              ? 'Unlock the wallet to start one with someone’s @profile or G… address.'
              : `Tap ＋ to start one with someone’s @profile or G… address.`}
          </div>
        ) : (
          <ul className="nw-chat-list">
            {known.map((contact) => {
              const added = friendList.includes(contact);
              return (
                <li key={contact} className="nw-chat-row">
                  <button type="button" className="nw-chat-rowmain"
                    onClick={() => {
                      // Opening a conversation needs the wallet key (the messages
                      // are encrypted with it), so that — and only that — asks
                      // for the unlock. The list itself never does.
                      if (readOnly) { requestUnlock(contact); return; }
                      void publishOwnKey();
                      void openThread(contact);
                    }}>
                    <span className="nw-chat-avatar" aria-hidden>
                      {initials(contact, peerIds[contact])}
                    </span>
                    <span className="nw-chat-rowtext">
                      <span className="nw-chat-rowname">{peerIds[contact] || shortAddr(contact)}</span>
                      <span className="nw-chat-rowsub">
                        {readOnly
                          ? 'Locked · unlock to open'
                          : added ? 'Encrypted chat' : 'From your transfers · encrypted'}
                      </span>
                    </span>
                    <span className="nw-chat-rowchev" aria-hidden>›</span>
                  </button>
                  {added ? (
                    <button type="button" className="nw-chip-btn nw-chat-remove"
                      title={`Remove ${contact} from your chat list`}
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
          {`Your chat list keeps only public wallet addresses on this device (up to ${FRIEND_LIMIT}). Messages themselves are never stored.`}
        </p>
      </section>
    );
  }

  return (
    <section className="nw-chat-room" aria-label={`Chat with ${peerName}`}>
      <header className="nw-chat-roomhead">
        <button type="button" className="nw-chat-iconbtn nw-chat-back" aria-label="Back to chats"
          onClick={() => {
            setPeer('');
            setThread([]);
            setDetailsOpen(false);
            setSheet('none');
          }}>
          ‹
        </button>
        <span className="nw-chat-avatar" aria-hidden>{initials(peer, peerIds[peer])}</span>
        <div className="nw-chat-who">
          <span className="nw-chat-whoname">{peerName}</span>
          <span className="nw-chat-whosub">Encrypted chat</span>
        </div>
        <button type="button" className="nw-chat-iconbtn" aria-label="Refresh messages"
          disabled={state.busy || readOnly} onClick={() => void openThread(peer)}>↻</button>
        <button type="button" className="nw-chat-iconbtn" aria-label="Chat details"
          aria-expanded={detailsOpen} onClick={() => setDetailsOpen((value) => !value)}>ⓘ</button>
      </header>

      {detailsOpen && (
        <div className="nw-chat-details">
          <div className="nw-kv">
            <span className="nw-k">Wallet address</span>
            <span className="nw-v nw-small nw-mono" style={{ wordBreak: 'break-all' }}>{peer}</span>
          </div>
          {peerIds[peer] ? (
            <div className="nw-kv">
              <span className="nw-k">Profile</span>
              <span className="nw-v nw-small nw-mono">{peerIds[peer]}</span>
            </div>
          ) : null}
          <div className="nw-btn-row" style={{ marginTop: 2 }}>
            <button type="button" className="nw-chip-btn" onClick={copyPeerAddress}>
              {copyState === 'done' ? 'Address copied ✓' : copyState === 'failed' ? 'Copy failed — select it above' : 'Copy address'}
            </button>
            {onSendTo ? (
              <button type="button" className="nw-chip-btn" onClick={() => onSendTo(peer)}>
                Open in Send
              </button>
            ) : null}
            {readOnly || !onSendTo ? null : (
              <button type="button" className="nw-chip-btn" onClick={() => setSheet('request')}>
                Request NSAT
              </button>
            )}
            {readOnly ? null : (
              <button type="button" className="nw-chip-btn" onClick={toggleBlock}
                disabled={gate.busy} aria-pressed={gate.blocked}>
                {gate.blocked ? 'Unblock' : 'Block'}
              </button>
            )}
          </div>
          {gate.blocked ? <span className="nw-badge warn">blocked</span> : null}
          {gate.note ? (
            <p className="nw-small nw-dim" style={{ margin: 0 }} role="status">{gate.note}</p>
          ) : null}
          {gate.error ? (
            <p className="nw-small" style={{ margin: 0, color: 'var(--warn)' }} role="alert">{gate.error}</p>
          ) : null}
          <p className="nw-small nw-dim" style={{ margin: 0 }}>
            An email is never stored here. The profile keeps an @id and this public address only.
          </p>
        </div>
      )}

      {inboxError ? (
        <p className="nw-small" style={{ margin: 0, color: 'var(--warn)' }} role="alert">
          {inboxError}
        </p>
      ) : null}

      <ul ref={threadRef} className="nw-chat-thread" aria-live="polite">
        {thread.length === 0 && (
          <li className="nw-chat-empty">
            <strong>No messages yet</strong>
            {`Say hello — only you and ${peerName} can read this chat.`}
          </li>
        )}
        {thread.map((message) => {
          const paymentRequest = parsePaymentRequestText(message.text, message.from);
          const transactionCard = parseTransactionCardText(message.text, message.from);
          return (
            <li key={message.id} className={'nw-chat-bubble' + (message.own ? ' is-own' : '')}>
              {cardInThisChat(transactionCard, message, address, peer) ? (
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
              <div className="nw-chat-meta">{clock(message.at)}</div>
            </li>
          );
        })}
      </ul>

      {/* Attachments sit beside the conversation, the way a photo or a sticker
       * does: money is one more thing you can send to the person, not a mode
       * the chat switches into. Only the transfer itself asks for approval. */}
      {sheet === 'menu' ? (
        <div className="nw-chat-attach" role="group" aria-label="Send an attachment">
          {onSendCoins ? (
            <button type="button" className="nw-chat-attachitem" onClick={() => setSheet('pay')}>
              <span className="nw-chat-attachicon" aria-hidden>◎</span>
              <span>Send money</span>
            </button>
          ) : null}
          {onSendTo ? (
            <button type="button" className="nw-chat-attachitem" onClick={() => setSheet('request')}>
              <span className="nw-chat-attachicon" aria-hidden>↓</span>
              <span>Request money</span>
            </button>
          ) : null}
        </div>
      ) : null}

      {sheet === 'pay' && onSendCoins ? (
        <div className="nw-chat-sheet">
          <div className="nw-chat-bar">
            <strong>Send money</strong>
            <button type="button" className="nw-chat-iconbtn" aria-label="Close send money"
              onClick={() => {
                setSheet('none');
                setCoin({ amount: '', phase: 'idle', error: '' });
                setApprovalPassword('');
              }}>×</button>
          </div>
          {coin.phase === 'confirm' ? (
            <div aria-label="Confirm NSAT transfer">
              <p className="nw-small nw-dim" style={{ margin: '0 0 6px' }}>
                {`${coinDigits} NSAT to ${peerName} · signing needs your approval`}
              </p>
              <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', margin: '0 0 8px' }}>
                <dt>To</dt><dd className="nw-mono" style={{ margin: 0, wordBreak: 'break-all' }}>{peer}</dd>
                <dt>Amount</dt><dd style={{ margin: 0 }}>{coinDigits} NSAT</dd>
                <dt>Network fee</dt><dd style={{ margin: 0 }}>{fee == null ? 'Unavailable' : `${String(fee)} NSAT`}</dd>
                <dt>Total</dt><dd style={{ margin: 0 }}>{fee == null ? 'Unavailable' : `${(BigInt(coinDigits || '0') + BigInt(fee)).toString()} NSAT`}</dd>
                <dt>Network</dt><dd className="nw-mono" style={{ margin: 0, wordBreak: 'break-all' }}>{netVerified ? networkIdentity : 'Not verified'}</dd>
                <dt>Balance</dt><dd style={{ margin: 0 }}>{balance == null ? 'Unavailable' : `${String(balance)} NSAT`}</dd>
              </dl>
              {canApproveWithPasskey ? (
                <>
                  <p className="nw-small nw-dim">Choose how to approve this payment.</p>
                  <div className="nw-btn-row" style={{ marginTop: 0 }}>
                    <button type="button" className="nw-chip-btn" aria-pressed={approvalMethod === 'passkey'}
                      onClick={() => { setApprovalMethod('passkey'); setApprovalPassword(''); }}>
                      Face ID / passkey
                    </button>
                    <button type="button" className="nw-chip-btn" aria-pressed={approvalMethod === 'password'}
                      onClick={() => setApprovalMethod('password')}>
                      Wallet password
                    </button>
                  </div>
                </>
              ) : null}
              {approvalMethod === 'password' ? (
                <label className="nw-small" style={{ display: 'grid', gap: 4 }}>
                  Wallet password
                  <input className="nw-chat-input" type="password" autoComplete="current-password"
                    value={approvalPassword} onChange={(event) => setApprovalPassword(event.target.value)}
                    aria-label="Wallet password to approve payment" />
                </label>
              ) : <p className="nw-small nw-dim">Confirm with Face ID / device passkey to sign.</p>}
              <div className="nw-btn-row" style={{ marginTop: 8 }}>
                <button type="button" className="nw-send-btn" onClick={sendMoney}
                  disabled={coin.phase === 'sending' || !approvalReady}>
                  {coin.phase === 'sending' ? 'Waiting for approval…' : approvalMethod === 'passkey' ? 'Approve with Face ID' : 'Approve and send'}
                </button>
                <button type="button" className="nw-chip-btn"
                  onClick={() => {
                    setCoin((current) => ({ ...current, phase: 'idle', error: '' }));
                    setApprovalPassword('');
                  }}
                  disabled={coin.phase === 'sending'}>Cancel</button>
              </div>
            </div>
          ) : (
            <>
              <div className="nw-chat-amount">
                <input className="nw-chat-amountinput" value={coin.amount} inputMode="numeric"
                  placeholder="0" aria-label="Amount of NSAT to send"
                  onChange={(event) => setCoin({
                    amount: event.target.value.replace(/[^\d,_ ]/g, ''),
                    phase: 'idle', error: '',
                  })}
                  disabled={readOnly || coin.phase === 'sending'} />
                <span className="nw-small nw-dim">NSAT</span>
              </div>
              <p className="nw-small nw-dim" style={{ margin: 0 }}>
                {balance == null ? 'Balance unavailable' : `Available ${String(balance)} NSAT`}
              </p>
              <button type="button" className="nw-send-btn"
                onClick={() => setCoin((current) => ({ ...current, phase: 'confirm', error: '' }))}
                disabled={readOnly || coin.phase === 'sending' || !coinAmountOk}>
                Next
              </button>
            </>
          )}
          {coin.error ? (
            <p className="nw-small" style={{ margin: 0, color: 'var(--warn)' }} role="alert">{coin.error}</p>
          ) : null}
        </div>
      ) : null}

      {sheet === 'request' && onSendTo ? (
        <form className="nw-chat-sheet" onSubmit={sendPaymentRequest}>
          <div className="nw-chat-bar">
            <strong>{`Request from ${peerName}`}</strong>
            <button type="button" className="nw-chat-iconbtn" aria-label="Close payment request"
              onClick={() => setSheet('none')}>×</button>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input className="nw-chat-input" value={request.amount} inputMode="numeric"
              placeholder="Amount in NSAT" aria-label="NSAT amount to request" style={{ maxWidth: 160 }}
              onChange={(event) => setRequest({
                amount: event.target.value.replace(/[^\d,_ ]/g, ''),
                busy: false, note: '', error: '',
              })}
              disabled={readOnly || request.busy || gate.blocked} />
            <button type="submit" className="nw-send-btn"
              disabled={readOnly || request.busy || gate.blocked || !requestAmountOk}>
              {request.busy ? 'Sending…' : 'Send request'}
            </button>
          </div>
          {request.error ? (
            <p className="nw-small" style={{ margin: 0, color: 'var(--warn)' }} role="alert">{request.error}</p>
          ) : null}
          {request.note ? (
            <p className="nw-small nw-dim" style={{ margin: 0 }} role="status">{request.note}</p>
          ) : null}
        </form>
      ) : null}

      <form className="nw-chat-composer" onSubmit={send}>
        <button type="button" className="nw-chat-iconbtn" aria-label="More actions"
          aria-expanded={sheet !== 'none'}
          disabled={readOnly || gate.blocked || (!onSendCoins && !onSendTo)}
          onClick={() => setSheet((value) => (value === 'none' ? 'menu' : 'none'))}>＋</button>
        <textarea className="nw-chat-input" value={draft} maxLength={MAX_TEXT_LENGTH}
          placeholder={readOnly ? 'Unlock the wallet to send' : gate.blocked ? 'Blocked — unblock to write' : 'Message'}
          onChange={(event) => setDraft(event.target.value)}
          disabled={readOnly || state.busy || gate.blocked}
          rows={1} aria-label="Encrypted message" />
        <button className="nw-chat-send" type="submit" aria-label="Send message"
          disabled={readOnly || state.busy || gate.blocked || !draft.trim()}>
          ➤
        </button>
      </form>
      {state.note ? (
        <p className="nw-small" style={{ margin: 0, color: 'var(--warn)' }} role="status">{state.note}</p>
      ) : null}
    </section>
  );
}
