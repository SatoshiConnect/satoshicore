'use client';

// Encrypted chat screen.
//
// The wallet keeps the plaintext: it is encrypted to the recipient here, with a
// key the relay never has, and decrypted here with this wallet's seed. The relay
// only sees two addresses, a size and a timestamp (docs/E2E-CHAT-DESIGN.md).
//
// The thread lives in this session only: nothing readable is written to
// localStorage, so losing the tab loses the transcript unless the person opted
// into saved chat history. Fetching never deletes by itself; opening a room
// acknowledges this device's copies, and a saved copy acknowledges them sooner.
// Other devices keep their own deliveries, or lose them at the 7-day retention.
//
// Layout follows the shape people already know from a messenger: a list of
// people, then one room with a header, bubbles and a single composer. The
// wallet-specific details (address, blocking, payment request) sit behind the
// details panel instead of in the middle of the conversation.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createChatClient } from '../lib/chatClient';
import { getChatDeviceId } from '../lib/chatDevice';
import {
  FRIEND_LIMIT, addFriend, mergeContacts, parseFriendTarget, readFriends, removeFriend,
} from '../lib/chatFriends';
import { MAX_TEXT_LENGTH } from '../lib/e2eChat';
import { archiveMessages, readArchivedThread, readArchivePrefs } from '../lib/chatArchive';
import {
  ackIds, archiveAndClearRelay, relayIdOf,
} from '../lib/chatRelayArchive';
import { createAckQueue, createRoomGuard } from '../lib/chatRoomGuards';
import { createChatTabSync } from '../lib/chatTabSync';
import {
  countNewMessages, formatUnreadAge, markPeerSeen, mergeUnreadSnapshots,
  readCursor, readReadMarks, readUnreadSnapshot, sanitizeUnreadCounts,
  writeCursor, writeUnreadSnapshot,
} from '../lib/chatUnread';
import { cleanAmount, validateAmount } from '../lib/nsatSendPreflight';
import { createPaymentRequestText, parsePaymentRequestText } from '../lib/chatPaymentRequest';
import {
  paymentRequestFromMessage, paymentRequestStatusAt,
  paymentRequestTiming, readPaymentRequests, requestKeyFor, setPaymentRequestStatus,
  settlePaymentRequestForCard, upsertPaymentRequests,
} from '../lib/chatPaymentInbox';
import { createTransactionCardText, parseTransactionCardText, verifyTransactionCard } from '../lib/chatTransaction';
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

// The queue is about time, not about a new message. Keep the remaining window
// readable without making the poll timer do double duty.
const remainingLabel = (request, now = Date.now()) => {
  const { msLeft, expired } = paymentRequestTiming(request, now);
  if (expired) return 'Expired';
  if (msLeft < 60 * 60 * 1000) return `${Math.max(1, Math.ceil(msLeft / 60000))}m left`;
  if (msLeft < 24 * 60 * 60 * 1000) return `${Math.ceil(msLeft / 3600000)}h left`;
  return `${Math.ceil(msLeft / 86400000)}d left`;
};

const requestStatusLabel = (status) => ({
  pending: 'Pending', paid: 'Paid', declined: 'Declined', expired: 'Expired',
}[status] || 'Pending');

// A list preview is one line of human text, so a transaction or payment request
// reads as its amount instead of as its wire format.
const previewText = (text, from) => {
  const card = parseTransactionCardText(text, from);
  if (card?.kind === 'transaction-card') return `${card.amount} NSAT`;
  const request = parsePaymentRequestText(text, from);
  if (request?.kind === 'payment-request') return `Payment request · ${request.amount} NSAT`;
  return text;
};

// A relay row and a saved line are different shapes; the thread uses one.
const toThreadMessage = (message) => ({
  id: `m${message.id}`, peer: message.from, from: message.from,
  text: message.text, at: message.ts, receivedAt: message.receivedAt, own: false,
});

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
  // Polls and room reads have separate epochs: opening/leaving invalidates a
  // poll, while a newer poll must not cancel a room read already on screen.
  // peerRef remains the room-identity check for the read itself.
  const roomGuard = useMemo(() => createRoomGuard(), []);
  const ackQueue = useMemo(() => createAckQueue(), []);
  const tabSyncRef = useRef(null);
  const [pollLeader, setPollLeader] = useState(false);
  const peerRef = useRef('');
  useEffect(() => { peerRef.current = peer; }, [peer]);
  // Blocking is a relay-side control: the list lives with the wallet address,
  // not with this screen, so it is read back rather than remembered here.
  const [gate, setGate] = useState({ busy: false, blocked: false, note: '', error: '' });
  const [request, setRequest] = useState({ amount: '', busy: false, note: '', error: '' });
  // New-message signal for the list: counts and decrypted previews live in this
  // session only; the persisted snapshot holds addresses, counts and a time and
  // is what the locked list shows.
  const [unreadByPeer, setUnreadByPeer] = useState({});
  const [unreadPreview, setUnreadPreview] = useState({});
  const [lockedUnread, setLockedUnread] = useState({ at: 0, counts: {} });
  // The encrypted request ledger is local and survives read/ack. Only the
  // unlocked session can decrypt it, so a locked wallet shows no payment queue.
  const [paymentRequests, setPaymentRequests] = useState([]);
  const [paymentBusy, setPaymentBusy] = useState('');
  const [paymentError, setPaymentError] = useState('');
  const [, setClockTick] = useState(0);
  const paymentView = useRef(0);

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
  // The payer's queue is the actionable part of the inbox. Outgoing requests
  // keep their status in the thread; they do not need a second copy here.
  const pendingIncoming = paymentRequests
    .map((request) => ({ ...request, status: paymentRequestStatusAt(request) }))
    .filter((request) => request.direction === 'incoming' && request.status === 'pending')
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const expiringSoon = pendingIncoming.filter((request) => paymentRequestTiming(request).warning).length;
  // A settled or lapsed request leaves the queue but remains readable in the
  // encrypted ledger; show a short history so it is not an invisible status.
  const recentRequests = paymentRequests
    .map((request) => ({ ...request, status: paymentRequestStatusAt(request) }))
    .filter((request) => request.status !== 'pending')
    .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))
    .slice(0, 5);

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
  // One stable id per browser profile: the relay keeps a delivery per device,
  // so reading here never acknowledges the copy another device still needs.
  const deviceId = useMemo(
    () => (typeof window === 'undefined' ? '' : getChatDeviceId()),
    [],
  );

  // Another tab that owns the wallet's poll lock sends its snapshot here. It is
  // deliberately just addresses, counts and a time; this tab only filters the
  // room it is reading and updates the same state its own poll would.
  const applyTabSnapshot = useCallback((snapshot) => {
    if (!address || !snapshot || typeof snapshot !== 'object') return;
    const at = Number(snapshot.at);
    if (!Number.isFinite(at) || at <= 0) return;
    // A room clear can land between the leader's write and this message. Never
    // let that older snapshot put the badge back on screen.
    if (readUnreadSnapshot(address).at > at) return;
    const counts = sanitizeUnreadCounts(snapshot.counts);
    const open = peerRef.current;
    if (open) delete counts[open];
    setUnreadByPeer(counts);
    if (readOnly) setLockedUnread({ at, counts });
    setUnreadPreview((current) => {
      const next = {};
      for (const [peer, preview] of Object.entries(current)) {
        if (counts[peer]) next[peer] = preview;
      }
      return next;
    });
  }, [address, readOnly]);

  // One tab per wallet polls. Web Locks elect the leader and BroadcastChannel
  // carries its snapshot to followers; a follower never calls peek/ack on the
  // 15-second timer. When the leader locks or closes, the next tab inherits it.
  useEffect(() => {
    if (!address || !relayConfigured) {
      setPollLeader(false);
      return undefined;
    }
    const sync = createChatTabSync({
      wallet: address,
      canLead: Boolean(seed32),
      onSnapshot: applyTabSnapshot,
      onLeaderChange: setPollLeader,
    });
    tabSyncRef.current = sync;
    sync.prime(readUnreadSnapshot(address));
    sync.start();
    return () => {
      sync.close();
      if (tabSyncRef.current === sync) tabSyncRef.current = null;
    };
  }, [address, relayConfigured, seed32, applyTabSnapshot]);

  const refreshPaymentRequests = useCallback(async () => {
    if (!seed32 || !address) {
      setPaymentRequests([]);
      return;
    }
    const view = paymentView.current + 1;
    paymentView.current = view;
    try {
      const list = await readPaymentRequests({ seed32, address });
      if (view === paymentView.current) setPaymentRequests(list);
    } catch {
      // A locked or unavailable archive must not make the chat itself fail.
    }
  }, [address, seed32]);

  // Expiry is materialized by a read, so the once-a-minute tick both refreshes
  // the remaining-time labels and persists a pending row as expired on time.
  useEffect(() => {
    if (!seed32 || !address) return undefined;
    const timer = window.setInterval(() => {
      setClockTick((value) => value + 1);
      void refreshPaymentRequests();
    }, 60000);
    return () => window.clearInterval(timer);
  }, [address, refreshPaymentRequests, seed32]);

  useEffect(() => {
    if (!seed32 || !address) {
      paymentView.current += 1;
      setPaymentRequests([]);
      return undefined;
    }
    void refreshPaymentRequests();
    return () => { paymentView.current += 1; };
  }, [address, refreshPaymentRequests, seed32]);

  // A request is stored as soon as its decrypted line arrives, before the
  // relay copy is acknowledged. A transaction card can settle a pending request.
  const collectPaymentMessages = useCallback(async (messages, { strict = false } = {}) => {
    if (!seed32 || !address || !Array.isArray(messages) || messages.length === 0) return;
    const requests = [];
    const cards = [];
    for (const message of messages) {
      const request = paymentRequestFromMessage({ message, owner: address });
      if (request) requests.push(request);
      const card = parseTransactionCardText(message.text, message.from);
      if (card?.kind === 'transaction-card') {
        cards.push({ card, at: message.at ?? message.ts ?? message.receivedAt });
      }
    }
    if (requests.length === 0 && cards.length === 0) return;
    let changed = false;
    if (requests.length) {
      try {
        const added = await upsertPaymentRequests({ seed32, address, requests });
        changed = added > 0 || changed;
      } catch (error) {
        // Never acknowledge a request we could not store. The relay copy is the
        // only remaining source, so a strict caller stops before ack.
        if (strict) throw error;
      }
    }
    for (const { card, at } of cards) {
      try {
        // A card parsed from peer ciphertext is only a claim. Ask the indexer for
        // the exact hash and settle only a finalized native payment; an unknown,
        // pending, failed or wrong-party card leaves the request pending for the
        // person to settle explicitly with Mark paid.
        const settled = await settlePaymentRequestForCard({
          seed32,
          address,
          card,
          verifyCard: (candidate) => verifyTransactionCard(candidate, {
            submittedAt: Number.isSafeInteger(at) && at > 0 ? Math.floor(at / 1000) : null,
          }),
        });
        changed = Boolean(settled) || changed;
      } catch {
        // A card is a claim; failing to update local bookkeeping does not make
        // the ledger transaction disappear. Chat delivery still continues.
      }
    }
    if (changed) await refreshPaymentRequests();
  }, [address, refreshPaymentRequests, seed32]);

  useEffect(() => {
    if (!relayConfigured) return undefined;
    client.current = createChatClient({ origin: relayOrigin, deviceId });
    return () => { client.current = null; };
  }, [relayOrigin, relayConfigured, deviceId]);

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
    setUnreadByPeer(readUnreadSnapshot(address).counts);
    setUnreadPreview({});
  }, [address]);

  // Poll the mailbox for the list badges. Reading changes only this device's
  // read mark; a copy leaves the relay when saved history has stored it here,
  // or when the relay's 7-day retention expires.
  const pollInbox = useCallback(async () => {
    if (!client.current || !seed32) return;
    // An in-flight poll must not write after another tab took over the lock.
    const tabSync = tabSyncRef.current;
    if (!tabSync?.isLeader()) return;
    const pollStartedAt = Date.now();
    const pollToken = roomGuard.beginPoll();
    try {
      // Only what arrived after this device's cursor: re-reading the whole
      // mailbox every 15 s would be waste.
      const since = readCursor(address, undefined, deviceId);
      const { messages } = await client.current.peek({ seed32, address, since });
      if (!roomGuard.isCurrentPoll(pollToken)) return;
      const marks = readReadMarks(address, undefined, deviceId);
      // A fresh device (cursor 0) sees the whole mailbox, so counts are rebuilt
      // from it; after that they are incremental. The open room is excluded on
      // purpose: its lines are on screen, so they have been read here.
      const { counts, newest } = countNewMessages({
        messages,
        marks,
        openPeer: peer,
        previous: readUnreadSnapshot(address).counts,
        reset: since === 0,
      });
      const previews = {};
      const fresh = [];
      let maxId = since;
      for (const message of messages) {
        if (message.id > maxId) maxId = message.id;
        const from = String(message.from || '').toUpperCase();
        // The open conversation is on screen, so it is being read now: it never
        // carries a badge, and its lines go straight into the thread.
        if (peer && from === peer) {
          fresh.push(toThreadMessage(message));
          continue;
        }
        const previous = previews[from];
        if (!previous || (message.ts || 0) > previous.at) {
          previews[from] = { text: previewText(message.text, message.from), at: message.ts || 0 };
        }
      }
      // Store request obligations before acknowledging the relay copy. Reading
      // a room must never be the thing that loses a request.
      await collectPaymentMessages(messages, { strict: true });
      // A stored copy lets this device free its relay copy of the message; the
      // helper keeps it when saving failed.
      if (messages.length) {
        await ackQueue.run(() => archiveAndClearRelay({
          seed32,
          address,
          messages,
          ack: async (args) => {
            if (!roomGuard.isCurrentPoll(pollToken)) return 0;
            return client.current.ack(args);
          },
        }));
      }
      // A newer poll, a room switch, or a room read while this was in flight
      // bumps the generation and makes these counts stale. Dropping them is
      // safer than writing an older view over a newer one; the next poll reads
      // from the same cursor.
      if (!roomGuard.isCurrentPoll(pollToken)) return;
      // The open room is on screen, so advance its read mark before the cursor:
      // a crash between the two must not leave mail counted yet never re-read.
      if (fresh.length) markPeerSeen(address, peer, newest[peer] || 0, undefined, deviceId);
      // A different tab may have cleared a room while this poll was in flight.
      // Its snapshot is newer than this poll's start, so keep it and publish the
      // next poll instead of putting the old badge back. A tab that lost the
      // lock must not write at all: the new leader owns the cursor and badges.
      if (tabSync !== tabSyncRef.current || !tabSync.isLeader()) return;
      if (readUnreadSnapshot(address).at <= pollStartedAt) {
        const at = Date.now();
        setUnreadByPeer(counts);
        setUnreadPreview((current) => ({ ...current, ...previews }));
        const saved = writeUnreadSnapshot(address, { counts, at });
        tabSync.publish(saved);
      }
      if (maxId > since) writeCursor(address, maxId, undefined, deviceId);
      if (fresh.length) {
        // The room is on screen, so these lines have been read here. With saved
        // history the archive step above already acknowledged what it stored;
        // without it they are acknowledged now, otherwise this device keeps a
        // copy nobody needs and a later list poll could count it again.
        setThread((current) => mergeById(current, fresh));
        if (!readArchivePrefs().enabled) {
          await ackQueue.run(() => ackIds({
            seed32,
            address,
            ids: fresh.map(relayIdOf),
            ack: async (args) => {
              if (!roomGuard.isCurrentPoll(pollToken)) return 0;
              return client.current.ack(args);
            },
          }));
        }
      }
    } catch {
      // A failed poll keeps the last known counts: a stale badge is better than a
      // false "nothing new".
    }
  }, [address, peer, seed32, deviceId, collectPaymentMessages, roomGuard, ackQueue]);

  useEffect(() => {
    if (!relayConfigured || !seed32 || !pollLeader) return undefined;
    void pollInbox();
    const timer = window.setInterval(() => { void pollInbox(); }, 15000);
    return () => window.clearInterval(timer);
  }, [pollInbox, relayConfigured, seed32, pollLeader]);

  // A new message should be visible without hunting for it: keep the end of the
  // transcript in view, the way a chat app opens on the latest line.
  useEffect(() => {
    const list = threadRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [thread.length, peer]);

  const openThread = useCallback(async (target) => {
    // A poll that was counting this room as unread before the tap must not write
    // its counts after the room has been read.
    const roomToken = roomGuard.beginRoomRead();
    peerRef.current = target;
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
      if (peerRef.current !== target || !roomGuard.isCurrentRoomRead(roomToken)) return;
      if (archived.length) {
        setThread((current) => mergeById(current.filter((message) => message.peer === target), archived));
        await collectPaymentMessages(archived, { strict: true });
        if (peerRef.current !== target || !roomGuard.isCurrentRoomRead(roomToken)) return;
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
      // Read this conversation's pending mail only, not the whole mailbox:
      // opening a room must not page through every other room's backlog.
      const { messages, undecryptable } = await client.current.peek({ seed32, address, peer: target });
      // The room may have changed while the read was in flight; its lines must
      // not be merged into (or acknowledged from) another conversation.
      if (peerRef.current !== target || !roomGuard.isCurrentRoomRead(roomToken)) return;
      const incoming = messages.map(toThreadMessage);
      setThread((current) => mergeById(current, incoming));
      await collectPaymentMessages(incoming, { strict: true });
      if (peerRef.current !== target || !roomGuard.isCurrentRoomRead(roomToken)) return;
      setInboxError(undecryptable.length
        ? `${undecryptable.length} message(s) stayed on the relay: this wallet cannot open them.`
        : '');
      // This device has now read the room. Opening it only moves the local read
      // mark; the ciphertext stays on the relay until somebody clears it.
      const { newest } = countNewMessages({ messages: incoming, reset: true });
      if (newest[target]) markPeerSeen(address, target, newest[target], undefined, deviceId);
      // Saved history means this device's relay copy can go now; without it the
      // copy stays until the retention window ends.
      await ackQueue.run(() => archiveAndClearRelay({
        seed32,
        address,
        messages: incoming,
        ack: async (args) => {
          if (peerRef.current !== target || !roomGuard.isCurrentRoomRead(roomToken)) return 0;
          return client.current.ack(args);
        },
      }));
      // Opening a room is reading it: without saved history this is where this
      // device's relay copies for these lines are dropped (with history, they
      // were dropped as soon as the archive write succeeded).
      if (!readArchivePrefs().enabled && incoming.length) {
        await ackQueue.run(() => ackIds({
          seed32,
          address,
          ids: incoming.map(relayIdOf),
          ack: async (args) => {
            if (peerRef.current !== target || !roomGuard.isCurrentRoomRead(roomToken)) return 0;
            return client.current.ack(args);
          },
        }));
      }
      if (peerRef.current !== target || !roomGuard.isCurrentRoomRead(roomToken)) return;
      // Opening a room clears its own badge. Other badges keep what this device
      // last counted: their mail may already be stored here and gone from the
      // relay, so a relay-only recount would wrongly zero them.
      const counts = { ...readUnreadSnapshot(address).counts };
      delete counts[target];
      const at = Date.now();
      setUnreadByPeer(counts);
      setUnreadPreview((current) => {
        const next = { ...current };
        delete next[target];
        return next;
      });
      const saved = writeUnreadSnapshot(address, { counts, at });
      tabSyncRef.current?.publish(saved);
      const maxId = messages.reduce((max, message) => (message.id > max ? message.id : max), readCursor(address, undefined, deviceId));
      if (maxId > 0) writeCursor(address, maxId, undefined, deviceId);
    } catch (error) {
      setInboxError(String(error?.message || error));
    }
  }, [address, seed32, deviceId, collectPaymentMessages, roomGuard, ackQueue]);

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

  /** Review only prefills the existing Send page; nothing is signed here. */
  function reviewPaymentRequest(request) {
    if (!onSendTo || !request?.to) return;
    onSendTo(request.to, request.amount);
  }

  /** Local inbox bookkeeping. The ledger remains the source of truth. */
  async function changePaymentStatus(request, status) {
    if (!seed32 || !request?.requestKey) return;
    setPaymentBusy(request.requestKey);
    setPaymentError('');
    try {
      const updated = await setPaymentRequestStatus({
        seed32, address, requestKey: request.requestKey, status,
      });
      if (updated) {
        setPaymentRequests((current) => current.map((item) => (
          item.requestKey === updated.requestKey ? updated : item
        )));
      }
    } catch (error) {
      setPaymentError(String(error?.message || error));
    } finally {
      setPaymentBusy('');
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
      await collectPaymentMessages([message]);
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
      await collectPaymentMessages([transferMessage]);
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

        {!readOnly && pendingIncoming.length > 0 ? (
          <section className="nw-payqueue" aria-label="Waiting to pay">
            <div className="nw-payqueue-head">
              <strong>Waiting to pay</strong>
              <span className="nw-badge warn">{pendingIncoming.length}</span>
            </div>
            <p className="nw-small nw-dim" style={{ margin: 0 }}>
              Reading a request does not clear it. It leaves this queue when you mark it paid or
              decline it, or automatically after 7 days. These records are encrypted on this device,
              separately from chat history.
            </p>
            {expiringSoon > 0 ? (
              <p className="nw-small nw-payqueue-warning" role="status">
                {`${expiringSoon} request${expiringSoon === 1 ? '' : 's'} expire within 48 hours.`}
              </p>
            ) : null}
            {paymentError ? (
              <p className="nw-small" style={{ margin: 0, color: 'var(--warn)' }} role="alert">
                {paymentError}
              </p>
            ) : null}
            <ul className="nw-payqueue-list">
              {pendingIncoming.map((request) => {
                const soon = paymentRequestTiming(request).warning;
                const busy = paymentBusy === request.requestKey;
                return (
                  <li key={request.requestKey} className="nw-payqueue-row">
                    <button type="button" className="nw-payqueue-main"
                      onClick={() => { void openThread(request.peer); }}>
                      <span className="nw-payqueue-name">
                        {peerIds[request.peer] || shortAddr(request.peer)}
                      </span>
                      <span className="nw-payqueue-meta">
                        {`${request.amount} NSAT · `}
                        <span style={{ color: soon ? 'var(--warn)' : undefined }}>
                          {remainingLabel(request)}
                        </span>
                      </span>
                    </button>
                    <div className="nw-payqueue-actions">
                      <button type="button" className="nw-chip-btn" disabled={busy || !onSendTo}
                        onClick={() => reviewPaymentRequest(request)}>
                        Review
                      </button>
                      <button type="button" className="nw-chip-btn" disabled={busy}
                        onClick={() => void changePaymentStatus(request, 'declined')}>
                        {busy ? '…' : 'Decline'}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        {!readOnly && recentRequests.length > 0 ? (
          <details className="nw-payqueue-recent">
            <summary>{`Recent payment requests (${recentRequests.length})`}</summary>
            <ul className="nw-payqueue-list">
              {recentRequests.map((request) => (
                <li key={request.requestKey} className="nw-payqueue-row">
                  <div className="nw-payqueue-main">
                    <span className="nw-payqueue-name">
                      {peerIds[request.peer] || shortAddr(request.peer)}
                    </span>
                    <span className="nw-payqueue-meta">
                      {`${request.amount} NSAT · ${request.direction === 'outgoing' ? 'requested' : 'received'}`}
                    </span>
                  </div>
                  <span className={`nw-badge ${
                    request.status === 'paid' ? 'ok' : request.status === 'declined' ? 'err' : 'info'
                  }`}>
                    {requestStatusLabel(request.status)}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}

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
              const checked = readOnly ? formatUnreadAge(lockedUnread.at) : '';
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
            Opening a chat clears this device's copies; other devices keep theirs until they open it.
            With chat history on, saving a copy clears this device's copy sooner.
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
            // Leaving the room invalidates a poll still counting its mail.
            roomGuard.leaveRoom();
            peerRef.current = '';
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
            Opening this chat removes the messages you have seen from the relay. Anything left expires
            after 7 days, and with chat history on a saved copy clears the relay sooner — a device that
            has not fetched a message in that window loses it.
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
          const requestKey = paymentRequest?.kind === 'payment-request'
            ? requestKeyFor(message.own ? 'outgoing' : 'incoming', message.id) : '';
          const requestRecord = requestKey
            ? paymentRequests.find((request) => request.requestKey === requestKey) || null
            : null;
          const requestClock = requestRecord || {
            status: 'pending', createdAt: message.receivedAt || message.at || Date.now(),
          };
          const requestStatus = requestRecord
            ? paymentRequestStatusAt(requestRecord)
            : (paymentRequest?.kind === 'payment-request' ? paymentRequestStatusAt(requestClock) : '');
          const requestTiming = requestRecord || paymentRequest?.kind === 'payment-request'
            ? paymentRequestTiming(requestClock)
            : null;
          const requestBadge = requestStatus === 'paid' ? 'ok'
            : requestStatus === 'pending' ? 'warn'
              : requestStatus === 'declined' ? 'err' : 'info';
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
                  <div className="nw-chat-requeststate" style={{ marginTop: 6 }}>
                    <span className={`nw-badge ${requestBadge}`}>{requestStatusLabel(requestStatus)}</span>
                    {requestStatus === 'pending' ? (
                      <span className="nw-small"
                        style={{ color: requestTiming?.warning ? 'var(--warn)' : 'var(--text-dim)' }}>
                        {requestTiming?.warning ? 'Expires soon · ' : ''}
                        {remainingLabel(requestClock)}
                      </span>
                    ) : null}
                  </div>
                  {requestStatus === 'pending' && !message.own && onSendTo ? (
                    <div className="nw-btn-row" style={{ marginTop: 8 }}>
                      <button type="button" className="nw-send-btn"
                        disabled={readOnly || gate.blocked || paymentBusy === requestKey}
                        onClick={() => reviewPaymentRequest(requestRecord || {
                          to: paymentRequest.address, amount: paymentRequest.amount,
                        })}>
                        Review payment · {paymentRequest.amount} NSAT
                      </button>
                      <button type="button" className="nw-chip-btn"
                        disabled={readOnly || gate.blocked || paymentBusy === requestKey}
                        onClick={() => void changePaymentStatus(requestRecord || { requestKey }, 'declined')}>
                        Decline
                      </button>
                      <button type="button" className="nw-chip-btn"
                        disabled={readOnly || gate.blocked || paymentBusy === requestKey}
                        onClick={() => void changePaymentStatus(requestRecord || { requestKey }, 'paid')}>
                        Mark paid
                      </button>
                    </div>
                  ) : requestStatus === 'pending' && message.own ? (
                    <div className="nw-btn-row" style={{ marginTop: 8 }}>
                      <span className="nw-small nw-dim">Waiting for payment; no funds have moved.</span>
                      <button type="button" className="nw-chip-btn"
                        disabled={readOnly || paymentBusy === requestKey}
                        onClick={() => void changePaymentStatus(requestRecord || { requestKey }, 'paid')}>
                        Mark paid
                      </button>
                    </div>
                  ) : null}
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
