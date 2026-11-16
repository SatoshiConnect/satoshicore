'use client';

// Encrypted chat screen.
//
// The wallet keeps the plaintext: it is encrypted to the recipient here, with a
// key the relay never has, and decrypted here with this wallet's seed. The relay
// only sees two addresses, a size and a timestamp (docs/E2E-CHAT-DESIGN.md).
//
// The thread lives in this session only: nothing readable is written to
// localStorage, so losing the tab loses the transcript unless the person opted
// into saved chat history. Reading never deletes by itself; a message leaves the
// relay when this device has stored a copy in that history, or after the relay's
// 7-day retention, whichever comes first.
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
import { archiveMessages, readArchivedThread, readArchivePrefs } from '../lib/chatArchive';
import {
  countUnread, formatUnreadAge, markPeerSeen, mergeUnreadSnapshots, newestArrivalByPeer,
  readCursor, readReadMarks, readUnreadSnapshot, writeCursor, writeUnreadSnapshot,
} from '../lib/chatUnread';
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

// A list preview is one line of human text, so a transaction or payment request
// reads as its amount instead of as its wire format.
const previewText = (text, from) => {
  const card = parseTransactionCardText(text, from);
  if (card?.kind === 'transaction-card') return `${card.amount} NSAT`;
  const request = parsePaymentRequestText(text, from);
  if (request?.kind === 'payment-request') return `Payment request · ${request.amount} NSAT`;
  return text;
};

// One line per id, oldest first: the session transcript, the saved history and
// a fresh relay read can all describe the same message.
const mergeById = (...lists) => {
  const byId = new Map();
  for (const list of lists) {
    for (const message of list) if (message?.id) byId.set(message.id, message);
  }
  return [...byId.values()].sort((a, b) => (a.at || 0) - (b.at || 0));
};

// Saving is opt-in and best-effort: a full disk or a blocked origin must never
// stop a message from being sent or shown.
function rememberIfEnabled({ seed32, address, peer, messages }) {
  if (!seed32 || !peer || !messages?.length || !readArchivePrefs().enabled) return;
  void archiveMessages({ seed32, address, peer, messages }).catch(() => {});
}

const relayIdOf = (message) => Number(
  typeof message?.id === 'string' ? message.id.replace(/^[mr]/, '') : message?.id,
);

// Saved history is what lets the relay forget early: store the message
// encrypted-at-rest first, then acknowledge exactly the ids this device really
// stored. If saving fails the copy stays on the relay until its 7-day
// retention — an archive error must never be the reason a message is lost.
// Without saved history this is a no-op and the relay keeps the message.
async function archiveAndClearRelay({ seed32, address, messages, ack }) {
  if (!seed32 || !address || !readArchivePrefs().enabled || !messages?.length) return 0;
  if (typeof ack !== 'function') return 0;
  const byPeer = new Map();
  for (const message of messages) {
    const peer = String(message?.peer || message?.from || '').toUpperCase();
    if (!peer || typeof message.text !== 'string' || !message.text) continue;
    const relayId = relayIdOf(message);
    if (!Number.isSafeInteger(relayId)) continue;
    const group = byPeer.get(peer) || [];
    // One id shape for the archive whichever screen saved the line first.
    group.push({ ...message, id: `m${relayId}` });
    byPeer.set(peer, group);
  }
  const storedIds = [];
  for (const [peer, group] of byPeer) {
    try {
      const stored = await archiveMessages({ seed32, address, peer, messages: group });
      if (stored > 0) storedIds.push(...group.map(relayIdOf));
    } catch {
      // Keep the relay copy.
    }
  }
  if (storedIds.length === 0) return 0;
  try {
    return await ack({ seed32, address, ids: storedIds });
  } catch {
    return 0;
  }
}

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
  // New-message signal for the list: counts and decrypted previews live in this
  // session only; the persisted snapshot holds addresses, counts and a time and
  // is what the locked list shows.
  const [unreadByPeer, setUnreadByPeer] = useState({});
  const [unreadPreview, setUnreadPreview] = useState({});
  const [unreadAt, setUnreadAt] = useState(0);
  const [lockedUnread, setLockedUnread] = useState({ at: 0, counts: {} });

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
  // The unlocked list uses live counts; a locked one uses the last snapshot.
  const unreadCounts = readOnly ? lockedUnread.counts : unreadByPeer;
  const unreadCheckedAt = readOnly ? lockedUnread.at : unreadAt;

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

  // A locked wallet cannot fetch anything (every relay call is signed with the
  // seed), so its list shows the last snapshot: addresses, counts, and when the
  // check happened. Message text is never part of that snapshot.
  useEffect(() => {
    if (!readOnly || !ownerKey) { setLockedUnread({ at: 0, counts: {} }); return; }
    setLockedUnread(mergeUnreadSnapshots(ownerKey.split(',')));
  }, [readOnly, ownerKey]);

  // Counts survive a reload: they are this device's last known state, kept as
  // addresses and integers only.
  useEffect(() => {
    if (!address) return;
    const snapshot = readUnreadSnapshot(address);
    setUnreadByPeer(snapshot.counts);
    setUnreadAt(snapshot.at);
    setUnreadPreview({});
  }, [address]);

  // Poll the mailbox for the list badges. Reading changes only this device's
  // read mark; a copy leaves the relay when saved history has stored it here,
  // or when the relay's 7-day retention expires.
  const pollInbox = useCallback(async () => {
    if (!client.current || !seed32) return;
    try {
      // Only what arrived after this device's cursor: the mailbox is never
      // emptied by reading, so a full re-fetch every 15 s would be waste.
      const since = readCursor(address);
      const { messages } = await client.current.peek({ seed32, address, since });
      const marks = readReadMarks(address);
      // A fresh device (cursor 0) sees the whole mailbox, so counts are rebuilt
      // from scratch; after that they are incremental.
      const counts = since === 0
        ? countUnread(messages, marks)
        : { ...readUnreadSnapshot(address).counts };
      const previews = {};
      const fresh = [];
      let maxId = since;
      for (const message of messages) {
        if (message.id > maxId) maxId = message.id;
        const from = String(message.from || '').toUpperCase();
        // The open conversation is on screen, so it is being read now: it never
        // carries a badge, and its lines go straight into the thread.
        if (peer && from === peer) {
          fresh.push({
            id: `m${message.id}`, peer: message.from, from: message.from,
            text: message.text, at: message.ts, receivedAt: message.receivedAt, own: false,
          });
          continue;
        }
        if (since !== 0 && Number(message.receivedAt || 0) > (marks[from] || 0)) {
          counts[from] = (counts[from] || 0) + 1;
        }
        const previous = previews[from];
        if (!previous || (message.ts || 0) > previous.at) {
          previews[from] = { text: previewText(message.text, message.from), at: message.ts || 0 };
        }
      }
      // A stored copy lets this device free the relay copy of the same message;
      // the helper keeps it when saving failed.
      if (messages.length) {
        await archiveAndClearRelay({
          seed32,
          address,
          messages: messages.map((message) => ({
            id: message.id, peer: message.from, from: message.from, text: message.text, at: message.ts,
          })),
          ack: client.current.ack.bind(client.current),
        });
      }
      const at = Date.now();
      setUnreadByPeer(counts);
      setUnreadPreview((current) => ({ ...current, ...previews }));
      setUnreadAt(at);
      writeUnreadSnapshot(address, { counts, at });
      if (maxId > since) writeCursor(address, maxId);
      if (fresh.length) {
        markPeerSeen(address, peer, newestArrivalByPeer(fresh)[peer] || 0);
        setThread((current) => mergeById(current, fresh));
        rememberIfEnabled({ seed32, address, peer, messages: fresh });
      }
    } catch {
      // A failed poll keeps the last known counts: a stale badge is better than a
      // false "nothing new".
    }
  }, [address, peer, seed32]);

  useEffect(() => {
    if (!relayConfigured || !seed32) return undefined;
    void pollInbox();
    const timer = window.setInterval(() => { void pollInbox(); }, 15000);
    return () => window.clearInterval(timer);
  }, [pollInbox, relayConfigured, seed32]);

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
    // Saved history is local and the relay keeps its copy only for its retention
    // window, so the two are merged by message id: show the device's own archive
    // first, then add whatever the relay still holds.
    if (readArchivePrefs().enabled) {
      const archived = await readArchivedThread({ seed32, address, peer: target }).catch(() => []);
      if (archived.length) {
        setThread((current) => mergeById(current.filter((message) => message.peer === target), archived));
      }
    }
    try {
      const blockedList = await client.current.blocks({ seed32, address });
      setGate({ busy: false, blocked: blockedList.includes(String(target).toUpperCase()), note: '', error: '' });
    } catch {
      // An unreadable block list must not look like "not blocked": say so and
      // leave the send path alone rather than inventing a state.
      setGate({ busy: false, blocked: false, note: '', error: 'Could not read the block list for this wallet.' });
    }
    try {
      // Read the whole pending mailbox for this wallet. Nothing is deleted: the
      // relay copy is how another device — or this one after a reload — still
      // gets the conversation.
      const { messages, undecryptable } = await client.current.peek({ seed32, address });
      const incoming = messages
        .filter((message) => String(message.from).toUpperCase() === String(target).toUpperCase())
        .map((message) => ({
          id: `m${message.id}`, peer: message.from, from: message.from,
          text: message.text, at: message.ts, receivedAt: message.receivedAt, own: false,
        }));
      setThread((current) => mergeById(current, incoming));
      rememberIfEnabled({ seed32, address, peer: target, messages: incoming });
      setInboxError(undecryptable.length
        ? `${undecryptable.length} message(s) stayed on the relay: this wallet cannot open them.`
        : '');
      // This device has now read the room. Opening it only moves the local read
      // mark; the ciphertext stays on the relay until somebody clears it.
      markPeerSeen(address, target, newestArrivalByPeer(incoming)[target] || Date.now());
      // Saved history means the relay copy can go now; without it the copy stays
      // for the retention window so another device can still fetch it.
      await archiveAndClearRelay({
        seed32, address, messages: incoming, ack: client.current.ack.bind(client.current),
      });
      // Opening a room clears its own badge. Other badges keep what this device
      // last counted: their mail may already be stored here and gone from the
      // relay, so a relay-only recount would wrongly zero them.
      const counts = { ...readUnreadSnapshot(address).counts };
      delete counts[target];
      const at = Date.now();
      setUnreadByPeer(counts);
      setUnreadAt(at);
      setUnreadPreview((current) => {
        const next = { ...current };
        delete next[target];
        return next;
      });
      writeUnreadSnapshot(address, { counts, at });
      const maxId = messages.reduce((max, message) => (message.id > max ? message.id : max), readCursor(address));
      if (maxId > 0) writeCursor(address, maxId);
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
      const message = {
        id: `r${Date.now()}`, peer, from: address, text, at: Date.now(), own: true,
      };
      setThread((current) => [...current, message]);
      rememberIfEnabled({ seed32, address, peer, messages: [message] });
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
      const transferMessage = {
        id: `c${Date.now()}`, peer, from: address, text: cardText, at: Date.now(), own: true,
      };
      setThread((current) => [...current, transferMessage]);
      // The ledger transaction is the record of value; the saved transcript keeps
      // the bubble that points at it, even if chat delivery fails below.
      rememberIfEnabled({ seed32, address, peer, messages: [transferMessage] });
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
      const message = {
        id: `s${Date.now()}`, peer, from: address, text, at: Date.now(), own: true,
      };
      setThread((current) => [...current, message]);
      rememberIfEnabled({ seed32, address, peer, messages: [message] });
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
              const count = unreadCounts[contact] || 0;
              const preview = readOnly ? null : unreadPreview[contact];
              const checked = formatUnreadAge(unreadCheckedAt);
              const subtitle = readOnly
                ? (count > 0
                  ? `${count} new${checked ? ` · checked ${checked}` : ''}`
                  : 'Locked · unlock to open')
                : count > 0 && preview
                  ? `${count > 1 ? `${count} new · ` : ''}${preview.text}`
                  : added ? 'Encrypted chat' : 'From your transfers · encrypted';
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
                      <span className="nw-chat-rowsub">{subtitle}</span>
                    </span>
                    {count > 0 ? (
                      <span className="nw-chat-badge" aria-label={`${count} new message${count === 1 ? '' : 's'}`}>
                        {count > 99 ? '99+' : count}
                      </span>
                    ) : null}
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
        {readOnly && lockedUnread.at ? (
          <p className="nw-small nw-dim" style={{ margin: 0 }} role="status">
            {`New messages last checked ${formatUnreadAge(lockedUnread.at)}. Unlock to fetch again.`}
          </p>
        ) : null}
        <div style={{ display: 'grid', gap: 6, margin: '10px 0 0' }}>
          <p className="nw-small nw-dim" style={{ margin: 0 }}>
            {`Your chat list keeps only public wallet addresses on this device (up to ${FRIEND_LIMIT}).`}
          </p>
          <p className="nw-small nw-dim" style={{ margin: 0 }}>
            Messages stay on the relay for up to 7 days so your other devices can fetch them.
            With chat history on, this device removes its relay copy as soon as the message is saved here.
          </p>
        </div>
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
          <span className="nw-chat-whosub">Encrypted · relay keeps 7 days</span>
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
            Messages stay on the relay up to 7 days. With chat history on, a saved copy here lets the
            relay drop its own sooner; a device that has not fetched the message in that window loses it.
          </p>
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
