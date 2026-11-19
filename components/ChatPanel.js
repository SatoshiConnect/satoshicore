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
import dynamic from 'next/dynamic';

// Upstream UI, not a lookalike: emoji-picker-react (MIT, v4.14.1) is the picker
// the inspected telegram-clone uses. Loaded lazily so a person who never opens
// it never downloads it.
const EmojiPicker = dynamic(
  () => import('emoji-picker-react').then((module) => module.default),
  { ssr: false },
);

import { createChatClient, createClientId } from '../lib/chatClient';
import {
  enqueueOutbox, markOutboxFailure, readOutbox, removeOutbox,
} from '../lib/chatOutbox';
import { getChatDeviceId } from '../lib/chatDevice';
import {
  FRIEND_LIMIT, addFriend, mergeContacts, parseFriendTarget, readFriends, removeFriend,
} from '../lib/chatFriends';
import { MAX_TEXT_LENGTH } from '../lib/e2eChat';
import {
  archiveMessages, deleteArchivedMessage, readArchivedRows, readArchivedThread, readArchivePrefs,
  rewriteArchivedMessage,
} from '../lib/chatArchive';
import {
  archiveIdOf, expiryLabel, keepMessage, keptIds,
} from '../lib/chatKeep';
import {
  acceptSender, dropPending, isRequestSender, notePending, readRequests,
  withoutRequestCounts,
} from '../lib/chatRequests';
import { decodeControl, encodeControl } from '../lib/chatControl';
import {
  ackIds, archiveAndClearRelay, relayIdOf,
} from '../lib/chatRelayArchive';
import { createAckQueue, createRoomGuard } from '../lib/chatRoomGuards';
import { createChatTabSync } from '../lib/chatTabSync';
import { chatIdentityStorageKey, ensureChatIdentityAcrossTabs, readChatIdentity } from '../lib/chatIdentity';
import { filterConversations } from '../lib/chatSearch';
import { describeChatFailure } from '../lib/chatRelayStatus';
import { POLL_COALESCE_MS, nextReconnectDelay, retryAfterMsOf } from '../lib/chatRetry';
import { forwardTargets } from '../lib/chatForward';
import { readPinned, togglePin } from '../lib/chatPins';
import { readPresencePref, writePresencePref } from '../lib/chatPresence';
import { readMuted, toggleMuted } from '../lib/chatMute';
import {
  notificationSupported, readNotifyPref, requestNotificationPermission,
  showEncryptedNotification, writeNotifyPref,
} from '../lib/chatNotify';
import {
  pushEnvironment, pushSubscriptionBody, readPushPref, subscribeWebPush,
  syncAppBadge, unsubscribeWebPush, writePushPref,
} from '../lib/webPush';
import { copyTextToClipboard } from '../lib/clipboard';
import { migrateChatData } from '../lib/chatMigration';
import {
  countNewMessages, formatUnreadAge, markPeerSeen, mergeUnreadSnapshots,
  readCursor, readReadMarks, readUnreadSnapshot,
  withoutSelfUnread, writeCursor, writeUnreadSnapshot,
} from '../lib/chatUnread';
import {
  SAVED_MESSAGES_LABEL, isSavedMessagesPeer, readReceiptLabel, savedMessagesAddress,
} from '../lib/chatSavedMessages';
import { cleanAmount, validateAmount } from '../lib/nsatSendPreflight';
import { createPaymentRequestText, parsePaymentRequestText } from '../lib/chatPaymentRequest';
import {
  MAX_REPLY_QUOTE, createReplyText, displayMessageText, parseReplyText,
} from '../lib/chatReply';
import {
  paymentRequestFromMessage, paymentRequestStatusAt,
  paymentRequestTiming, readPaymentRequests, requestKeyFor, setPaymentRequestStatus,
  settlePaymentRequestForCard, upsertPaymentRequests,
} from '../lib/chatPaymentInbox';
import { createTransactionCardText, parseTransactionCardText, verifyTransactionCard } from '../lib/chatTransaction';
import ChatTransactionCard from './ChatTransactionCard';
import { profileDisplayLabel, resolveProfileHandle } from '../lib/profile';

const shortAddr = (value) => (value ? `${value.slice(0, 6)}…${value.slice(-4)}` : '');

// One place for the honest reason a device cannot receive background alerts.
function pushReasonText(reason) {
  return {
    'not-configured': 'This build has no push key configured.',
    unsupported: 'This browser cannot receive alerts while it is closed.',
    insecure: 'Background alerts need HTTPS on this origin.',
    'install-first': 'Add this site to the Home Screen first (iOS).',
    checking: 'Checking this browser…',
  }[String(reason || '')] || '';
}

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
  const reply = parseReplyText(text);
  if (reply?.kind === 'reply') return `↳ ${reply.text}`;
  if (reply?.kind === 'invalid') return 'Invalid reply';
  return text;
};

// A relay row and a saved line are different shapes; the thread uses one.
// `own` compares the sender with the wallet reading the row, so Saved Messages
// shows its own lines on the right without a second special case.
const toThreadMessage = (message, owner = '') => ({
  id: `m${message.id}`, peer: message.from, from: message.from,
  text: message.text, at: message.ts, receivedAt: message.receivedAt,
  own: Boolean(owner) && String(message.from || '').toUpperCase() === String(owner).toUpperCase(),
});

// One line per id, oldest first: the session transcript, the saved history and
// a fresh relay read can all describe the same message.
const splitControls = (messages) => {
  const visible = [];
  const controls = [];
  for (const message of messages || []) {
    const control = decodeControl(message?.text);
    if (control) controls.push({ message, control });
    else visible.push(message);
  }
  return { visible, controls };
};

const mergeById = (...lists) => {
  const byId = new Map();
  for (const list of lists) {
    for (const message of list) if (message?.id) byId.set(message.id, message);
  }
  return [...byId.values()].sort((a, b) => (a.at || 0) - (b.at || 0));
};

// Saving is opt-in and best-effort: a full disk or a blocked origin must never
// stop a message from being sent or shown.
function rememberIfEnabled({ seed32, address, peer, messages, scope = 'v1' }) {
  if (!seed32 || !peer || !messages?.length || !readArchivePrefs().enabled) return;
  void archiveMessages({ seed32, address, peer, messages, scope }).catch(() => {});
}

// A transfer bubble is only this chat's when the authenticated sender wrote it
// and its two parties are the two wallets in the room.
const cardInThisChat = (card, message, me, them) => card?.kind === 'transaction-card'
  && card.from === message.from
  && ((card.from === me && card.to === them) || (card.from === them && card.to === me));

export default function ChatPanel({
  seed32, address, addresses = [], contacts, relayOrigin, onSendTo, onSendCoins,
  fee, balance, netVerified = false, networkIdentity = '',
  canApproveWithPasskey = false, onRequestUnlock = null, onEnableChat = null,
  addressNames = {},
}) {
  const client = useRef(null);
  const [peer, setPeer] = useState('');
  const [peerRead, setPeerRead] = useState({ peer: '', lastId: 0, at: 0 });
  const [presenceEnabled, setPresenceEnabled] = useState(false);
  const [peerPresence, setPeerPresence] = useState({ online: false, lastSeen: 0, known: false });
  const [mutedPeers, setMutedPeers] = useState([]);
  const [notifyEnabled, setNotifyEnabled] = useState(false);
  // Background alerts (Web Push) are opt-in and need a disclosure first: the
  // push service learns that this device received an alert, and when. `pushEnv`
  // resolves after mount so the static render and the browser agree.
  const [pushEnv, setPushEnv] = useState({ supported: false, reason: 'checking', key: null });
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushDisclosure, setPushDisclosure] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [thread, setThread] = useState([]);          // { id, from, text, ts|at, own }
  const threadStateRef = useRef([]);
  useEffect(() => { threadStateRef.current = thread; }, [thread]);
  const [draft, setDraft] = useState('');
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [emojiTheme, setEmojiTheme] = useState('dark');

  useEffect(() => {
    if (!emojiOpen) return;
    // The library follows its own theme prop, not our data-theme attribute.
    setEmojiTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  }, [emojiOpen]);
  const [state, setState] = useState({ busy: false, note: '', published: false });
  const [inboxError, setInboxError] = useState('');
  const [relayNotice, setRelayNotice] = useState(null);
  const [queuedCount, setQueuedCount] = useState(0);
  const outboxFlushing = useRef(new Set());
  // Saved chats per wallet address. The list is readable while the wallet is
  // locked: these are public addresses this device already stored, not keys.
  const [friendsByOwner, setFriendsByOwner] = useState({});
  // A chat tapped while locked; after unlocking it opens on its own.
  const [pendingPeer, setPendingPeer] = useState('');
  const [addTarget, setAddTarget] = useState('');
  const [addState, setAddState] = useState({ busy: false, note: '', error: '' });
  // Which @id resolved to which address, for the lifetime of this screen.
  const [peerIds, setPeerIds] = useState({});
  const [peerNames, setPeerNames] = useState({});
  const [pinned, setPinned] = useState([]);
  const [chatQuery, setChatQuery] = useState('');
  const [replyTo, setReplyTo] = useState(null);         // { id, quote }
  const [forwarding, setForwarding] = useState(null);   // { id, text }
  const [forwardState, setForwardState] = useState({ busy: false, note: '', error: '' });
  const [copyState, setCopyState] = useState('');
  const [messageCopy, setMessageCopy] = useState({ id: '', state: '' });
  // Keep: which archive ids this device holds (`anywhere` = the relay may
  // forget it, `saved` = there is a copy in Saved Messages).
  const [kept, setKept] = useState({
    saved: new Set(), anywhere: new Set(), peers: new Set(), ready: false,
  });
  const [keepBusy, setKeepBusy] = useState('');
  // Message requests: senders this device does not know yet. Addresses only.
  const [requests, setRequests] = useState({ accepted: [], pending: [] });
  const [requestsReady, setRequestsReady] = useState(false);
  const [friendsReady, setFriendsReady] = useState(false);
  const [requestBusy, setRequestBusy] = useState('');
  const [coin, setCoin] = useState({ amount: '', phase: 'idle', error: '' });
  const [approvalPassword, setApprovalPassword] = useState('');
  const [approvalMethod, setApprovalMethod] = useState(canApproveWithPasskey ? 'passkey' : 'password');
  // Presentation: the add form, the room's details panel, and which composer
  // option (send NSAT / request NSAT) is open.
  const [showAdd, setShowAdd] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [sheet, setSheet] = useState('none');        // none | menu | pay | request
  const threadRef = useRef(null);
  const messageCopyTimer = useRef(null);
  const typingSentAt = useRef(0);
  const typingTimer = useRef(null);
  const [typingPeer, setTypingPeer] = useState(false);
  // Polls and room reads have separate epochs: opening/leaving invalidates a
  // poll, while a newer poll must not cancel a room read already on screen.
  // peerRef remains the room-identity check for the read itself.
  const roomGuard = useMemo(() => createRoomGuard(), []);
  const ackQueue = useMemo(() => createAckQueue(), []);
  const tabSyncRef = useRef(null);
  const [pollLeader, setPollLeader] = useState(false);
  const peerRef = useRef('');
  useEffect(() => { peerRef.current = peer; }, [peer]);
  // A profile-share link opens the add field with its target filled in. This is
  // only a convenience: the normal add path still validates and resolves it, and
  // a limited/private profile still returns the permission message.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const target = new URLSearchParams(window.location.search).get('add');
    if (!target) return;
    setAddTarget(target);
    setShowAdd(true);
  }, []);
  useEffect(() => () => {
    if (messageCopyTimer.current) clearTimeout(messageCopyTimer.current);
    if (typingTimer.current) clearTimeout(typingTimer.current);
  }, []);
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
  // The encrypted request ledger is local and survives read/ack. It opens with
  // the chat identity, so a locked wallet still shows its payment queue.
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
  // Chat has its own identity. The wallet seed below is used only for the
  // one-time migration of old seed-encrypted data; it is never used to read or
  // write chat while the wallet is locked.
  const [chatIdentity, setChatIdentity] = useState(null);
  const [identityReady, setIdentityReady] = useState(false);
  const chatSeed32 = chatIdentity?.seed32 || null;
  const readOnly = !chatIdentity || !identityReady;
  const identityLoading = !identityReady;
  // Which wallets on this device already have a chat key. Only the presence of
  // the stored identity is read here — never the seed — so a locked wallet can
  // still say whether it needs its one-time unlock.
  const identityOwners = useMemo(
    () => [...new Set(addresses.map((value) => String(value || '').toUpperCase()).filter(Boolean))],
    [addresses],
  );
  const [identityByOwner, setIdentityByOwner] = useState({});
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const read = () => {
      const next = {};
      for (const owner of identityOwners) next[owner] = Boolean(readChatIdentity(owner));
      setIdentityByOwner(next);
    };
    read();
    // Another tab can create the key first; its storage write is the signal.
    window.addEventListener('storage', read);
    return () => window.removeEventListener('storage', read);
  }, [identityOwners, address, seed32, chatIdentity]);
  // Wallets that still need their single unlock before chat exists here.
  const needsChatSetup = readOnly && !identityLoading
    ? identityOwners.filter((owner) => !identityByOwner[owner])
    : [];

  useEffect(() => {
    let alive = true;
    setIdentityReady(false);
    const load = async () => {
      const existing = readChatIdentity(address);
      if (!alive) return;
      setChatIdentity(existing || null);
      if (!address) {
        setChatIdentity(null);
        setIdentityReady(true);
        return;
      }
      if (!seed32) {
        // Locked sessions can only read the identity already on this device.
        // Do not flash a setup prompt while doing a pointless async wait.
        setIdentityReady(true);
        return;
      }
      // Unlock is needed only to create the identity. Reading it, and every
      // later message, stays independent of the wallet seed.
      const identity = await ensureChatIdentityAcrossTabs({ address, walletSeed32: seed32 });
      if (!alive) return;
      setChatIdentity(identity || null);
      // Do not make chat wait for a potentially large archive/inbox migration.
      // New chat data already uses the identity; migration finishes in the
      // background and is safe to resume on the next unlock.
      setIdentityReady(true);
      if (identity && seed32) {
        void migrateChatData({ walletSeed32: seed32, chatIdentity: identity, address })
          .catch(() => {});
      }
    };
    void load();
    return () => { alive = false; };
  }, [address, seed32]);

  // Another tab may create the identity first. Its localStorage write is the
  // signal that this tab should adopt the same key instead of showing an
  // unreadable mailbox.
  useEffect(() => {
    if (typeof window === 'undefined' || !address) return undefined;
    const key = chatIdentityStorageKey(address);
    const onStorage = (event) => {
      if (event.key !== key) return;
      setChatIdentity(readChatIdentity(address));
      setIdentityReady(true);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [address]);
  const coinDigits = cleanAmount(coin.amount);
  const coinAmountOk = validateAmount(coin.amount).ok;
  const requestDigits = cleanAmount(request.amount);
  const requestAmountOk = validateAmount(request.amount).ok;
  const peerLabel = (value) => (isSavedMessagesPeer(address, value)
    ? SAVED_MESSAGES_LABEL
    : peerNames[value] || peerIds[value] || shortAddr(value));
  const peerName = peerLabel(peer);
  // The room this wallet writes to itself. It is a system conversation, not a
  // contact: it is never added to the friend list and never gets a read receipt.
  const savedMessages = savedMessagesAddress(address);
  const savedRoom = Boolean(peer) && isSavedMessagesPeer(address, peer);
  // With automatic history on, every line is archived anyway, so an expiry
  // warning would be noise. Read per render so the Settings toggle is felt here.
  const historyOn = readArchivePrefs().enabled;
  // The only thing that may be disabled by a missing secret: approval. The
  // message box and the chat list never depend on it.
  // Sending NSAT is a wallet action, not a chat action. A missing or still
  // loading chat identity must never disable the wallet's own approval path.
  const approvalReady = netVerified && fee != null && balance != null
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
    if (!ownerKey || typeof window === 'undefined') {
      setFriendsReady(true);
      return;
    }
    const next = {};
    for (const owner of ownerKey.split(',')) {
      next[owner] = readFriends(window.localStorage, owner);
    }
    setFriendsByOwner(next);
    setFriendsReady(true);
  }, [ownerKey]);

  const ownAddresses = new Set(ownerKey.split(',').map((value) => value.toUpperCase()));
  const friendList = [...new Set(Object.values(friendsByOwner).flat())]
    .filter((contact) => !ownAddresses.has(String(contact).toUpperCase()));
  const known = mergeContacts(contacts, friendList);
  const pinnedSet = new Set(pinned);
  const orderedKnown = [...known].sort((left, right) => {
    const a = pinnedSet.has(String(left).toUpperCase()) ? 0 : 1;
    const b = pinnedSet.has(String(right).toUpperCase()) ? 0 : 1;
    return a - b;
  });
  // An accepted request sender has a room even though they are not a friend:
  // acceptance is “this address may write to me”, not a contact entry.
  const acceptedPeers = requests.accepted.filter((peer) => !ownAddresses.has(peer));
  // Saved Messages always sits at the top of the list, above pinned chats, and
  // is available even on a wallet that has never saved a contact.
  const listTargets = [...new Set([
    savedMessages, ...acceptedPeers, ...orderedKnown,
  ].filter(Boolean))];
  const forwardChoices = forwardTargets(listTargets, peer);
  const describeConversation = (contact) => (isSavedMessagesPeer(address, contact)
    ? { address: contact, handle: '', name: SAVED_MESSAGES_LABEL }
    : { address: contact, handle: peerIds[contact] || '', name: peerNames[contact] || '' });
  const visibleKnown = filterConversations(listTargets, chatQuery, describeConversation);

  // A sender this device does not already know is a request: no badge, no
  // preview, and nothing is acknowledged until the person decides. The poll
  // reads this through a ref so its 15 s callback always sees current lists
  // without being rebuilt on every render.
  const requestLookup = useCallback((peer) => isRequestSender(peer, {
    owner: address,
    contacts,
    friends: friendList,
    accepted: requests.accepted,
    archived: kept.peers,
  }), [address, contacts, friendList, requests.accepted, kept.peers]);
  const isRequestRef = useRef(requestLookup);
  useEffect(() => { isRequestRef.current = requestLookup; }, [requestLookup]);
  // A stored request stops being one as soon as the address becomes a contact,
  // a friend, or is accepted — the row disappears with it.
  const pendingRequests = requests.pending.filter((sender) => requestLookup(sender));

  // The unlocked list uses live counts; a locked one uses the last snapshot.
  const unreadCounts = readOnly ? lockedUnread.counts : unreadByPeer;
  // The installed app's icon badge follows the same numbers the list shows.
  // Nothing is requested from the relay to compute it, and a browser without
  // the Badging API simply skips the call.
  const unreadTotal = Object.values(unreadCounts || {})
    .reduce((sum, value) => sum + (Number(value) || 0), 0);
  useEffect(() => { syncAppBadge(unreadTotal); }, [unreadTotal]);
  useEffect(() => () => syncAppBadge(0), []);
  // One stable id per browser profile: the relay keeps a delivery per device,
  // so reading here never acknowledges the copy another device still needs.
  const deviceId = useMemo(
    () => (typeof window === 'undefined' ? '' : getChatDeviceId()),
    [],
  );

  useEffect(() => {
    if (typeof window === 'undefined' || !address) {
      setPinned([]);
      return;
    }
    setPinned(readPinned(window.localStorage, address));
  }, [address]);

  function togglePinned(contact) {
    if (typeof window === 'undefined' || !address) return;
    const result = togglePin(window.localStorage, address, contact);
    setPinned(result.pins);
  }

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
    const counts = withoutSelfUnread(snapshot.counts, address);
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
      canLead: Boolean(chatIdentity),
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
  }, [address, relayConfigured, chatIdentity, applyTabSnapshot]);

  const refreshPaymentRequests = useCallback(async () => {
    if (!chatSeed32 || !address) {
      setPaymentRequests([]);
      return;
    }
    const view = paymentView.current + 1;
    paymentView.current = view;
    try {
      const list = await readPaymentRequests({ seed32: chatSeed32, address, keyScope: 'chat' });
      if (view === paymentView.current) setPaymentRequests(list);
    } catch {
      // A locked or unavailable archive must not make the chat itself fail.
    }
  }, [address, chatSeed32]);

  // Expiry is materialized by a read, so the once-a-minute tick both refreshes
  // the remaining-time labels and persists a pending row as expired on time.
  useEffect(() => {
    if (!chatSeed32 || !address) return undefined;
    const timer = window.setInterval(() => {
      setClockTick((value) => value + 1);
      void refreshPaymentRequests();
    }, 60000);
    return () => window.clearInterval(timer);
  }, [address, refreshPaymentRequests, chatSeed32]);

  useEffect(() => {
    if (!chatSeed32 || !address) {
      paymentView.current += 1;
      setPaymentRequests([]);
      return undefined;
    }
    void refreshPaymentRequests();
    return () => { paymentView.current += 1; };
  }, [address, refreshPaymentRequests, chatSeed32]);

  // A request is stored as soon as its decrypted line arrives, before the
  // relay copy is acknowledged. A transaction card can settle a pending request.
  const collectPaymentMessages = useCallback(async (messages, { strict = false } = {}) => {
    if (!chatSeed32 || !address || !Array.isArray(messages) || messages.length === 0) return;
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
        const added = await upsertPaymentRequests({
          seed32: chatSeed32, address, requests, keyScope: 'chat',
        });
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
          seed32: chatSeed32,
          address,
          card,
          keyScope: 'chat',
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
  }, [address, refreshPaymentRequests, chatSeed32]);

  useEffect(() => {
    if (!relayConfigured) return undefined;
    client.current = createChatClient({ origin: relayOrigin, deviceId });
    return () => { client.current = null; };
  }, [relayOrigin, relayConfigured, deviceId]);

  useEffect(() => {
    setQueuedCount(address ? readOutbox(address).length : 0);
  }, [address]);

  // A failed outbox flush waits longer on every attempt, and always at least as
  // long as the server's Retry-After. Without this a rate-limited device kept
  // retrying on the same 15 s tick and stayed inside the window that refused it.
  const outboxHoldUntil = useRef(0);

  // Retry prepared ciphertext without ever putting plaintext in storage. The
  // relay's clientId index makes a retry idempotent even if the earlier POST
  // was stored but its response was lost.
  const flushOutbox = useCallback(async () => {
    if (!client.current || !chatIdentity || !address) return;
    if (Date.now() < outboxHoldUntil.current) return;
    for (const item of readOutbox(address)) {
      if (outboxFlushing.current.has(item.clientId)) continue;
      outboxFlushing.current.add(item.clientId);
      try {
        const result = await client.current.sendPrepared({
          chatIdentity, address, envelope: item.envelope, clientId: item.clientId,
        });
        removeOutbox(address, item.clientId);
        setQueuedCount(readOutbox(address).length);
        setThread((current) => current.map((message) => (
          message.id === item.clientId
            ? { ...message, id: result?.id ?? message.id, pending: false }
            : message
        )));
      } catch (error) {
        const recorded = markOutboxFailure(address, item.clientId, error);
        setQueuedCount(recorded.length);
        const attempts = recorded.find((row) => row.clientId === item.clientId)?.attempts || 1;
        outboxHoldUntil.current = Date.now() + nextReconnectDelay(attempts - 1, {
          retryAfterMs: retryAfterMsOf(error),
          base: 5_000,
          max: 120_000,
        });
      } finally {
        outboxFlushing.current.delete(item.clientId);
      }
    }
  }, [address, chatIdentity]);

  useEffect(() => {
    if (!relayConfigured || !chatIdentity) return undefined;
    void flushOutbox();
    const timer = window.setInterval(() => { void flushOutbox(); }, 15_000);
    const online = () => { void flushOutbox(); };
    window.addEventListener('online', online);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('online', online);
    };
  }, [flushOutbox, relayConfigured, chatIdentity]);

  const publishOwnKey = useCallback(async () => {
    if (!client.current || !chatIdentity || state.published) return;
    try {
      await client.current.publishKey({ chatIdentity, address });
      setState((current) => ({ ...current, published: true }));
    } catch (error) {
      setState((current) => ({ ...current, note: String(error?.message || error) }));
    }
  }, [address, chatIdentity, state.published]);

  // Publish this wallet's messaging key as soon as the screen opens, so someone
  // else can write to it without having to wait for a first reply.
  useEffect(() => {
    if (!relayConfigured || !chatIdentity) return;
    void publishOwnKey();
  }, [publishOwnKey, relayConfigured, chatIdentity]);

  // Without a chat identity the list shows the last snapshot: addresses, counts,
  // and when the check happened. Message text is never part of that snapshot.
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
    setPresenceEnabled(readPresencePref(address));
    setMutedPeers(readMuted(address));
    setNotifyEnabled(readNotifyPref(address));
  }, [address]);

  // Resolve push support once, and remember this device's own choice.
  useEffect(() => {
    setPushEnv(pushEnvironment());
    setPushEnabled(address ? readPushPref(address) : false);
  }, [address]);

  // Which lines this device already holds. Read once per wallet so a kept
  // message still shows “Kept” after a reload — including when automatic chat
  // history is off, because keeping one message is an explicit choice.
  const refreshKept = useCallback(async () => {
    if (!address) {
      setKept({ saved: new Set(), anywhere: new Set(), peers: new Set(), ready: true });
      return;
    }
    const rows = await readArchivedRows(address).catch(() => []);
    // keptIds names the Saved Messages set `inSaved`; this state names it
    // `saved`. Spreading the raw result left `saved` undefined and the first
    // rendered message threw on kept.saved.has(...).
    const ids = keptIds(rows, address);
    setKept({
      saved: ids.inSaved,
      anywhere: ids.anywhere,
      // A peer with any archived line is a conversation, not a stranger.
      peers: new Set(rows.map((row) => String(row?.peer || '').toUpperCase()).filter(Boolean)),
      ready: true,
    });
  }, [address]);

  useEffect(() => { void refreshKept(); }, [refreshKept]);

  // Who is waiting for a decision, persisted per wallet (addresses only).
  const reloadRequests = useCallback(() => {
    if (!address) {
      setRequests({ accepted: [], pending: [] });
      setRequestsReady(true);
      return;
    }
    setRequests(readRequests(undefined, address));
    setRequestsReady(true);
  }, [address]);

  useEffect(() => { reloadRequests(); }, [reloadRequests]);

  /** Remember senders that are waiting for an Accept/Block/Delete decision. */
  const rememberPendingRequests = useCallback((peers) => {
    if (!address || typeof window === 'undefined' || !peers?.length) return;
    const next = notePending(window.localStorage, address, peers);
    if (next.changed) setRequests({ accepted: next.accepted, pending: next.pending });
  }, [address]);

  // Presence is opt-in and only a heartbeat; no profile field is written.
  useEffect(() => {
    if (!presenceEnabled || !client.current || !chatIdentity || !address) return undefined;
    const beat = () => {
      void client.current.presence({ seed32, chatIdentity, address, online: true }).catch(() => {});
    };
    beat();
    const timer = window.setInterval(beat, 30000);
    return () => {
      window.clearInterval(timer);
      void client.current?.presence({ seed32, chatIdentity, address, online: false }).catch(() => {});
    };
  }, [presenceEnabled, address, chatIdentity, seed32]);

  useEffect(() => {
    // Saved Messages has no other wallet to be online or offline.
    if (!peer || isSavedMessagesPeer(address, peer) || !client.current || !chatIdentity) {
      setPeerPresence({ online: false, lastSeen: 0, known: false });
      return undefined;
    }
    let stopped = false;
    const read = async () => {
      const next = await client.current.peerPresence({
        seed32, chatIdentity, address, peer,
      }).catch(() => null);
      if (!stopped && next) setPeerPresence(next);
    };
    void read();
    const timer = window.setInterval(() => { void read(); }, 30000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [peer, address, chatIdentity, seed32]);

  // Poll the mailbox for the list badges. Reading changes only this device's
  // read mark; a copy leaves the relay when saved history has stored it here,
  // or when the relay's 7-day retention expires.
  const pollInbox = useCallback(async () => {
    if (!client.current || !chatIdentity) return;
    // Wait for the lists that decide what a request is: a poll that ran while
    // the transfer history or the friend list was still loading could treat a
    // real contact as a stranger and hide their message.
    if (!kept.ready || !requestsReady || !friendsReady) return;
    // An in-flight poll must not write after another tab took over the lock.
    const tabSync = tabSyncRef.current;
    if (!tabSync?.isLeader()) return;
    const pollStartedAt = Date.now();
    const pollToken = roomGuard.beginPoll();
    try {
      // Only what arrived after this device's cursor: re-reading the whole
      // mailbox every 15 s would be waste.
      const since = readCursor(address, undefined, deviceId);
      const { messages: rawMessages } = await client.current.peek({
        chatIdentity, legacySeed32: seed32, address, since,
      });
      if (!roomGuard.isCurrentPoll(pollToken)) return;
      const { visible: allVisible, controls } = splitControls(rawMessages);
      const marks = readReadMarks(address, undefined, deviceId);
      // A stranger's mail is a message request: it is not counted, not
      // previewed, not archived and not acknowledged, so it waits on the relay
      // until the person accepts or deletes it. The cursor still moves past it,
      // which is safe because a room read is peer-scoped and ignores the cursor.
      const messages = [];
      const waiting = new Set();
      let maxId = since;
      for (const message of allVisible) {
        if (message.id > maxId) maxId = message.id;
        const from = String(message.from || '').toUpperCase();
        // The room on screen is always a conversation, never a request.
        if (from === peer || !isRequestRef.current(from)) {
          messages.push(message);
          continue;
        }
        waiting.add(from);
      }
      if (waiting.size) rememberPendingRequests([...waiting]);
      // A fresh device (cursor 0) sees the whole mailbox, so counts are rebuilt
      // from it; after that they are incremental. The open room is excluded on
      // purpose: its lines are on screen, so they have been read here.
      const { counts, newest } = countNewMessages({
        messages,
        marks,
        openPeer: peer,
        owner: address,
        previous: withoutRequestCounts(
          readUnreadSnapshot(address).counts, isRequestRef.current,
        ),
        reset: since === 0,
      });
      const previews = {};
      const fresh = [];
      for (const message of messages) {
        const from = String(message.from || '').toUpperCase();
        // The open conversation is on screen, so it is being read now: it never
        // carries a badge, and its lines go straight into the thread.
        if (peer && from === peer) {
          fresh.push(toThreadMessage(message, address));
          continue;
        }
        // The wallet's own room is not somebody writing to this wallet, so it
        // never becomes a badge or a list preview.
        if (isSavedMessagesPeer(address, from)) continue;
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
          seed32: chatSeed32,
          chatIdentity,
          address,
          messages,
          scope: 'chat',
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
      // Deletions may have arrived while this tab was closed; id-only tombstones
      // remove both the visible line and its saved archive copy.
      void applyTombstones();
      if (fresh.length) {
        // The room is on screen, so these lines have been read here. With saved
        // history the archive step above already acknowledged what it stored;
        // without it they are acknowledged now, otherwise this device keeps a
        // copy nobody needs and a later list poll could count it again.
        setThread((current) => mergeById(current, fresh));
        const readId = Math.max(0, ...fresh.map((message) => Number(relayIdOf(message)) || 0));
        if (readId > 0) {
          // A read receipt is best-effort, but send it before the ack so the
          // relay still has the row that proves this id was sent to us. Saved
          // Messages is this wallet's own room, so there is nobody to tell.
          if (!isSavedMessagesPeer(address, peer)) {
            await client.current.markRead({
              seed32: chatSeed32, chatIdentity, address, peer, id: readId,
            }).catch(() => {});
            setPeerRead((current) => (current.peer === peer && current.lastId >= readId
              ? current : { peer, lastId: readId, at: Date.now() }));
          }
        }
        if (!readArchivePrefs().enabled) {
          await ackQueue.run(() => ackIds({
            chatIdentity,
            address,
            ids: fresh.map(relayIdOf),
            ack: async (args) => {
              if (!roomGuard.isCurrentPoll(pollToken)) return 0;
              return client.current.ack(args);
            },
          }));
        }
      }
      // A control can arrive without a new visible message (an edit of a line
      // already on screen), so handle it outside the fresh-lines branch.
      const relevant = controls.filter(({ message }) => (
        peer && String(message.from || '').toUpperCase() === peer
      ));
      for (const { control } of relevant) {
        const targetMessage = fresh.find((message) => message.id === `m${control.id}`);
        await applyControl(control, peer, targetMessage);
      }
      if (relevant.length) {
        await ackQueue.run(() => ackIds({
          chatIdentity,
          address,
          ids: relevant.map(({ message }) => relayIdOf(message)),
          ack: async (args) => {
            if (!roomGuard.isCurrentPoll(pollToken)) return 0;
            return client.current.ack(args);
          },
        }));
      }
    } catch {
      // A failed poll keeps the last known counts: a stale badge is better than a
      // false "nothing new".
    }
  }, [
    address, peer, seed32, chatIdentity, chatSeed32, deviceId, collectPaymentMessages,
    roomGuard, ackQueue, kept.ready, requestsReady, friendsReady, rememberPendingRequests,
  ]);

  // The stream and its timers read the poller through a ref so a new callback
  // identity (a list finished loading, a room opened) does not tear the stream
  // down and reopen it — a reconnect storm is what a limit turns into a lockout.
  const pollInboxRef = useRef(pollInbox);
  useEffect(() => { pollInboxRef.current = pollInbox; }, [pollInbox]);

  useEffect(() => {
    if (!relayConfigured || !chatIdentity || !pollLeader) return undefined;
    void pollInboxRef.current();
    const timer = window.setInterval(() => { void pollInboxRef.current(); }, 15000);
    return () => window.clearInterval(timer);
  }, [relayConfigured, chatIdentity, pollLeader]);

  // The relay stream is a wake-up signal only. Every actual message still goes
  // through the signed fetch + local decrypt path below, so a forged or replayed
  // SSE frame cannot inject text. Polling remains as the fallback when the
  // stream is blocked by a proxy or the tab is not the leader.
  useEffect(() => {
    if (!relayConfigured || !chatIdentity || !pollLeader || !client.current) return undefined;
    let stopped = false;
    let controller = null;
    let retry = null;
    let attempt = 0;
    let coalesce = null;
    // Several frames can describe one change. Coalescing them into one mailbox
    // read, and ignoring typing frames (which carry no new mail), keeps a busy
    // peer from turning the event stream into a request loop.
    const pollSoon = () => {
      if (coalesce) return;
      coalesce = window.setTimeout(() => {
        coalesce = null;
        if (!stopped) void pollInboxRef.current();
      }, POLL_COALESCE_MS);
    };
    const reconnect = (error) => {
      if (stopped) return;
      const delay = nextReconnectDelay(attempt, { retryAfterMs: retryAfterMsOf(error) });
      attempt += 1;
      retry = window.setTimeout(connect, delay);
    };
    const connect = () => {
      if (stopped || !client.current) return;
      controller = new AbortController();
      client.current.subscribe({
        seed32, chatIdentity, address, signal: controller.signal,
        onEvent: (event) => {
          // A frame arrived, so the stream is healthy again: the next failure
          // starts from the base delay rather than the last long one.
          attempt = 0;
          if (event?.type === 'read' && event.from === peer) {
            const lastId = Number(event.lastId) || 0;
            setPeerRead((current) => (current.peer === peer && current.lastId >= lastId
              ? current : { peer, lastId, at: Date.now() }));
          }
          if (event?.type === 'deleted') {
            setThread((current) => current.filter((message) => message.id !== `m${event.id}`));
            void deleteArchivedMessage({
              address, peer: event.peer || peer, id: `m${event.id}`,
            }).catch(() => {});
          }
          if (event?.type === 'message' && notifyEnabled
            && typeof document !== 'undefined' && document.hidden
            && !mutedPeers.includes(peer)) {
            showEncryptedNotification();
          }
          if (event?.type === 'typing' && event.from === peer) {
            if (typingTimer.current) clearTimeout(typingTimer.current);
            const left = Number(event.until) - Date.now();
            if (left > 0) {
              setTypingPeer(true);
              typingTimer.current = window.setTimeout(() => setTypingPeer(false), Math.min(left + 250, 5000));
            } else {
              setTypingPeer(false);
            }
          }
          // A message, deletion or receipt means the mailbox changed; typing
          // does not, and polling for it would only spend the read budget.
          if (event?.type !== 'typing') pollSoon();
        },
      }).then(() => {
        // A clean close (proxy timeout, relay restart) is still a reason to
        // reconnect; only an explicit unmount or abort stops the loop.
        reconnect();
      }).catch((error) => {
        if (stopped || error?.name === 'AbortError') return;
        reconnect(error);
      });
    };
    connect();
    return () => {
      stopped = true;
      if (retry) window.clearTimeout(retry);
      if (coalesce) window.clearTimeout(coalesce);
      controller?.abort();
    };
  }, [relayConfigured, chatIdentity, pollLeader, seed32, address]);

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
    setPeerRead({ peer: target, lastId: 0, at: 0 });
    setTypingPeer(false);
    setThread((current) => current.filter((message) => message.peer === target));
    setGate({ busy: false, blocked: false, note: '', error: '' });
    setRelayNotice(null);
    setReplyTo(null);
    setForwarding(null);
    setForwardState({ busy: false, note: '', error: '' });
    setSheet('none');
    if (!client.current || !chatIdentity) return;
    setInboxError('');
    void applyTombstones(target);
    // Saved history is local and the relay keeps its copy only for its retention
    // window, so the two are merged by message id: show the device's own archive
    // first, then add whatever the relay still holds. This read is not gated on
    // the automatic-history toggle: a kept line (and every Saved Messages line)
    // is in the archive even when that toggle is off.
    {
      const archived = await readArchivedThread({
        seed32: chatSeed32, address, peer: target, scope: 'chat',
      }).catch(() => []);
      if (peerRef.current !== target || !roomGuard.isCurrentRoomRead(roomToken)) return;
      if (archived.length) {
        setThread((current) => mergeById(current.filter((message) => message.peer === target), archived));
        await collectPaymentMessages(archived, { strict: true });
        if (peerRef.current !== target || !roomGuard.isCurrentRoomRead(roomToken)) return;
      }
    }
    if (isSavedMessagesPeer(address, target)) {
      // There is no other party in Saved Messages to block.
      setGate({ busy: false, blocked: false, note: '', error: '' });
    } else {
      try {
        const blockedList = await client.current.blocks({ chatIdentity, address });
        setGate({ busy: false, blocked: blockedList.includes(String(target).toUpperCase()), note: '', error: '' });
      } catch {
        // An unreadable block list must not look like "not blocked": say so and
        // leave the send path alone rather than inventing a state.
        setGate({ busy: false, blocked: false, note: '', error: 'Could not read the block list for this wallet.' });
      }
    }
    try {
      // Read this conversation's pending mail only, not the whole mailbox:
      // opening a room must not page through every other room's backlog.
      const { messages, undecryptable } = await client.current.peek({
        chatIdentity, legacySeed32: seed32, address, peer: target,
      });
      // The room may have changed while the read was in flight; its lines must
      // not be merged into (or acknowledged from) another conversation.
      if (peerRef.current !== target || !roomGuard.isCurrentRoomRead(roomToken)) return;
      const { visible: visibleMessages, controls } = splitControls(messages);
      const incoming = visibleMessages.map((message) => toThreadMessage(message, address));
      setThread((current) => mergeById(current, incoming));
      const readId = Math.max(0, ...incoming.map((message) => Number(relayIdOf(message)) || 0));
      // Saved Messages is this wallet writing to itself: it still fetches and
      // acknowledges, but it never asks for a receipt from itself.
      if (readId > 0 && !isSavedMessagesPeer(address, target)) {
        // Mark before ack: the relay checks that this id was really sent from
        // `target` to this wallet, and the ack may delete that proof.
        await client.current.markRead({
          seed32: chatSeed32, chatIdentity, address, peer: target, id: readId,
        }).catch(() => {});
      }
      if (!isSavedMessagesPeer(address, target)) {
        void client.current.readReceipt({ chatIdentity, address, peer: target })
          .then((receipt) => {
            if (peerRef.current === target) {
              setPeerRead({ peer: target, lastId: Number(receipt?.lastId) || 0, at: Number(receipt?.at) || 0 });
            }
          })
          .catch(() => {});
      }
      await collectPaymentMessages(incoming, { strict: true });
      if (peerRef.current !== target || !roomGuard.isCurrentRoomRead(roomToken)) return;
      setInboxError(undecryptable.length
        ? `${undecryptable.length} message(s) stayed on the relay. ${seed32
          ? 'This wallet cannot open them.'
          : 'Unlock the wallet once to read older messages that were sent to the wallet key.'}`
        : '');
      // This device has now read the room. Opening it only moves the local read
      // mark; the ciphertext stays on the relay until somebody clears it.
      const { newest } = countNewMessages({ messages: incoming, owner: address, reset: true });
      if (newest[target]) markPeerSeen(address, target, newest[target], undefined, deviceId);
      // Saved history means this device's relay copy can go now; without it the
      // copy stays until the retention window ends.
      await ackQueue.run(() => archiveAndClearRelay({
        seed32: chatSeed32,
        chatIdentity,
        address,
        messages: incoming,
        scope: 'chat',
        ack: async (args) => {
          if (peerRef.current !== target || !roomGuard.isCurrentRoomRead(roomToken)) return 0;
          return client.current.ack(args);
        },
      }));
      // Apply controls after the archive step so an edit/reaction can rewrite
      // the row the archive just created. Then acknowledge the control rows.
      for (const { control } of controls) {
        const targetMessage = incoming.find((message) => message.id === `m${control.id}`);
        await applyControl(control, target, targetMessage);
      }
      // Controls are applied, not archived or rendered, so acknowledge them
      // explicitly; otherwise they would be fetched again on every room open.
      if (controls.length) {
        await ackQueue.run(() => ackIds({
          chatIdentity,
          address,
          ids: controls.map(({ message }) => relayIdOf(message)),
          ack: async (args) => {
            if (peerRef.current !== target || !roomGuard.isCurrentRoomRead(roomToken)) return 0;
            return client.current.ack(args);
          },
        }));
      }
      // Opening a room is reading it: without saved history this is where this
      // device's relay copies for these lines are dropped (with history, they
      // were dropped as soon as the archive write succeeded).
      if (!readArchivePrefs().enabled && incoming.length) {
        await ackQueue.run(() => ackIds({
          chatIdentity,
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
      setInboxError('');
      setRelayNotice(describeChatFailure(error, { action: 'read' }));
    }
  }, [
    address, seed32, chatIdentity, chatSeed32, deviceId, collectPaymentMessages,
    roomGuard, ackQueue,
  ]);

  // A background alert opens straight into one conversation: /wallet/?peer=G….
  // The parameter is consumed once (so a reload does not reopen it), and an
  // address that is not a valid wallet key is ignored.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const target = String(params.get('peer') || '').toUpperCase();
    if (!/^G[A-Z2-7]{55}$/.test(target)) return;
    setPendingPeer(target);
    params.delete('peer');
    const search = params.toString();
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`,
    );
  }, []);

  // A chat tapped while the wallet was locked: opening it was the reason for the
  // unlock, so it opens as soon as the key exists instead of asking for a
  // second tap.
  useEffect(() => {
    if (!chatIdentity || !pendingPeer) return;
    const target = pendingPeer;
    setPendingPeer('');
    void publishOwnKey();
    void openThread(target);
  }, [chatIdentity, pendingPeer, publishOwnKey, openThread]);

  /** @id → the wallet its profile points at, plus the label to show. */
  async function resolveTarget(parsed) {
    if (parsed.kind === 'address') {
      return { address: parsed.value, label: shortAddr(parsed.value) };
    }
    let profile;
    try {
      profile = await resolveProfileHandle(parsed.value);
    } catch (error) {
      if (String(error?.code || '') === 'PROFILE_NOT_FOUND') {
        throw new Error(`No profile ${parsed.value} exists yet.`);
      }
      if (String(error?.code || '') === 'permission-denied') {
        throw new Error(`${parsed.value} limits who can read their profile. Ask them for their wallet address instead.`);
      }
      throw new Error(
        `Could not look up ${parsed.value}. Sign in with Google above (profiles are read by the signed-in account), or paste the wallet address instead.`,
      );
    }
    if (!profile.primaryAddress) {
      throw new Error(`${parsed.value} has not chosen a primary wallet yet — ask them for their G… address.`);
    }
    return {
      address: profile.primaryAddress,
      label: profileDisplayLabel(profile, parsed.value),
    };
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
      const resolved = await resolveTarget(parsed);
      const walletAddress = resolved.address;
      const stored = addFriend(typeof window === 'undefined' ? null : window.localStorage, address, walletAddress);
      setFriendsByOwner((current) => ({ ...current, [address]: stored.friends }));
      if (parsed.kind === 'id') {
        setPeerIds((current) => ({ ...current, [walletAddress]: parsed.value }));
        setPeerNames((current) => ({ ...current, [walletAddress]: resolved.label }));
      }
      setAddTarget('');
      const label = parsed.kind === 'id'
        ? `${resolved.label} · ${shortAddr(walletAddress)}`
        : shortAddr(walletAddress);
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
    if (!client.current || !chatIdentity || !peer) return;
    const next = !gate.blocked;
    setGate((current) => ({ ...current, busy: true, note: '', error: '' }));
    try {
      if (next) await client.current.block({ chatIdentity, address, peer });
      else await client.current.unblock({ chatIdentity, address, peer });
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
  /**
   * Turn background alerts on for THIS device: ask the browser, subscribe with
   * the build's VAPID key, then hand the relay the endpoint and two keys. The
   * relay never receives anything about a message from this call.
   */
  /** The registered offline worker; push needs it to show anything. */
  async function pushRegistration() {
    const existing = await navigator.serviceWorker.getRegistration();
    if (!existing) {
      throw new Error('the offline worker is not registered on this page yet — reload once and try again');
    }
    return existing;
  }

  async function enablePush() {
    if (pushBusy || !client.current) return;
    setPushBusy(true);
    try {
      const env = pushEnvironment();
      setPushEnv(env);
      if (!env.supported) {
        setState((current) => ({ ...current, note: 'Background alerts are not available in this browser.' }));
        return;
      }
      const granted = await requestNotificationPermission();
      if (!granted) {
        setState((current) => ({ ...current, note: 'Notification permission was not granted, so no alert can be shown.' }));
        return;
      }
      const registration = await pushRegistration();
      const subscription = await subscribeWebPush({
        registration,
        applicationServerKey: env.key,
      });
      const body = pushSubscriptionBody(subscription);
      if (!body) throw new Error('the browser did not return a usable subscription');
      await client.current.registerPush({ seed32, chatIdentity, address, subscription: body });
      writePushPref(address, true);
      setPushEnabled(true);
      setPushDisclosure(false);
      setState((current) => ({ ...current, note: 'Background alerts are on for this device.' }));
    } catch (error) {
      setState((current) => ({
        ...current,
        note: `Could not turn on background alerts: ${String(error?.message || error)}`,
      }));
    } finally {
      setPushBusy(false);
    }
  }

  /** Turn them off here: unsubscribe the browser and drop this endpoint relay-side. */
  async function disablePush() {
    if (pushBusy) return;
    setPushBusy(true);
    try {
      const registration = await pushRegistration();
      const endpoint = await unsubscribeWebPush(registration);
      if (endpoint && client.current) {
        await client.current.removePush({ seed32, chatIdentity, address, endpoint }).catch(() => {});
      }
      writePushPref(address, false);
      setPushEnabled(false);
      setState((current) => ({ ...current, note: 'Background alerts are off for this device.' }));
    } catch (error) {
      setState((current) => ({
        ...current,
        note: `Could not turn off background alerts: ${String(error?.message || error)}`,
      }));
    } finally {
      setPushBusy(false);
    }
  }

  function reviewPaymentRequest(request) {
    if (!onSendTo || !request?.to) return;
    onSendTo(request.to, request.amount);
  }

  /** Local inbox bookkeeping. The ledger remains the source of truth. */
  async function changePaymentStatus(request, status) {
    if (!chatSeed32 || !request?.requestKey) return;
    setPaymentBusy(request.requestKey);
    setPaymentError('');
    try {
      const updated = await setPaymentRequestStatus({
        seed32: chatSeed32, address, requestKey: request.requestKey, status, keyScope: 'chat',
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
    if (!client.current || !chatIdentity || !peer || !requestAmountOk) return;
    setRequest((current) => ({ ...current, busy: true, note: '', error: '' }));
    try {
      const text = createPaymentRequestText({ amount: requestDigits, address });
      await client.current.send({ chatIdentity, from: address, to: peer, text });
      const message = {
        id: `r${Date.now()}`, peer, from: address, text, at: Date.now(), own: true,
      };
      setThread((current) => [...current, message]);
      rememberIfEnabled({
        seed32: chatSeed32, address, peer, messages: [message], scope: 'chat',
      });
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
      const pendingApproval = onSendCoins(peer, amount, approvalPassword, approvalMethod, address);
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
      rememberIfEnabled({
        seed32: chatSeed32, address, peer, messages: [transferMessage], scope: 'chat',
      });
      await collectPaymentMessages([transferMessage]);
      setCoin({ amount: '', phase: 'idle', error: '' });
      setApprovalMethod(canApproveWithPasskey ? 'passkey' : 'password');
      // The transfer bubble in the thread is the record; the sheet has done its
      // job and the conversation comes back.
      setSheet('none');
      if (client.current && chatIdentity) {
        try {
          await client.current.send({ chatIdentity, from: address, to: peer, text: cardText });
        } catch { /* the ledger transaction is already independent of chat delivery */ }
      }
    } catch (error) {
      setCoin((current) => ({ ...current, phase: 'idle', error: String(error?.message || error) }));
    } finally {
      setApprovalPassword('');
    }
  }

  /** Opening a conversation needs the chat identity, not the wallet password. */
  function requestUnlock(contact = '') {
    if (contact) setPendingPeer(contact);
    onRequestUnlock?.(contact);
  }

  async function copyPeerAddress() {
    try {
      await copyTextToClipboard(peer);
      setCopyState('done');
    } catch {
      setCopyState('failed');
    }
    setTimeout(() => setCopyState(''), 2500);
  }

  /** Copy one plain message, with a short visible and announced result. */
  async function copyMessage(message) {
    const text = displayMessageText(message?.text || '');
    if (!text) return;
    try {
      await copyTextToClipboard(text);
      setMessageCopy({ id: message.id, state: 'done' });
    } catch {
      setMessageCopy({ id: message.id, state: 'failed' });
    }
    if (messageCopyTimer.current) clearTimeout(messageCopyTimer.current);
    messageCopyTimer.current = setTimeout(() => {
      setMessageCopy((current) => (current.id === message.id ? { id: '', state: '' } : current));
    }, 1800);
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

  /**
   * Keep one line: the source conversation, then Saved Messages, then this
   * device's relay copy. `keepMessage` throws before the ack when either write
   * fails, so a message this device could not store stays on the relay.
   */
  async function keepOne(message) {
    if (keepBusy === message.id) return;
    if (!chatSeed32 || !chatIdentity) {
      setState((current) => ({
        ...current, note: 'Unlock the wallet once to keep messages on this device.',
      }));
      return;
    }
    const relayId = Number(relayIdOf(message)) || 0;
    setKeepBusy(message.id);
    setState((current) => ({ ...current, note: '' }));
    try {
      const result = await keepMessage({
        message,
        address,
        seed32: chatSeed32,
        scope: 'chat',
        relayId,
        archive: archiveMessages,
        // A failed ack is not a failed keep: both local copies are written, and
        // the relay copy simply stays until retention or a later read.
        ack: (id) => (client.current
          ? client.current.ack({ seed32: chatSeed32, chatIdentity, address, ids: [id] }).catch(() => 0)
          : 0),
      });
      setKept((current) => {
        const anywhere = new Set(current.anywhere);
        anywhere.add(result.id);
        const saved = new Set(current.saved);
        if (result.saved > 0) saved.add(result.id);
        return { ...current, saved, anywhere };
      });
      const where = result.saved > 0 ? 'Kept on this device and copied to Saved Messages.' : 'Kept on this device.';
      setState((current) => ({
        ...current,
        note: result.acked > 0 ? `${where} The relay copy was cleared.` : where,
      }));
    } catch (error) {
      setState((current) => ({ ...current, note: String(error?.message || error) }));
    } finally {
      setKeepBusy('');
    }
  }

  /** Accept one sender: their room joins the list, and opening it reads the mail. */
  async function acceptRequest(target) {
    if (requestBusy) return;
    setRequestBusy(target);
    try {
      if (typeof window !== 'undefined' && address) {
        const next = acceptSender(window.localStorage, address, target);
        if (next.changed) setRequests({ accepted: next.accepted, pending: next.pending });
      }
      if (readOnly) { requestUnlock(target); return; }
      void publishOwnKey();
      await openThread(target);
    } finally {
      setRequestBusy('');
    }
  }

  /** Block straight from the request row, without opening the room. */
  async function blockRequest(target) {
    if (requestBusy) return;
    if (!client.current || !chatIdentity) {
      setState((current) => ({
        ...current, note: 'Unlock the wallet once to block an address.',
      }));
      return;
    }
    setRequestBusy(target);
    try {
      await client.current.block({ chatIdentity, address, peer: target });
      if (typeof window !== 'undefined' && address) {
        const next = dropPending(window.localStorage, address, target);
        if (next.changed) setRequests({ accepted: next.accepted, pending: next.pending });
      }
      setState((current) => ({
        ...current,
        note: 'Blocked. The relay will not store messages between this wallet and that address, and queued mail was cleared.',
      }));
    } catch (error) {
      setState((current) => ({ ...current, note: String(error?.message || error) }));
    } finally {
      setRequestBusy('');
    }
  }

  /** Delete a request: drop this device's copies without accepting the sender. */
  async function deleteRequest(target) {
    if (requestBusy) return;
    if (!client.current || !chatIdentity) {
      setState((current) => ({
        ...current, note: 'Unlock the wallet once to delete a request.',
      }));
      return;
    }
    setRequestBusy(target);
    try {
      const { messages } = await client.current.peek({
        chatIdentity, legacySeed32: seed32, address, peer: target,
      });
      const acked = messages.length
        ? await ackQueue.run(() => ackIds({
          chatIdentity,
          address,
          ids: messages.map(relayIdOf),
          ack: async (args) => client.current.ack(args),
        }))
        : 0;
      // Do not hide a request this device could not clear: a failed ack leaves
      // the ciphertext on the relay, so the row stays and can be retried.
      if (messages.length && acked === 0) {
        setState((current) => ({
          ...current, note: 'The relay did not clear this request, so nothing was removed here. Try again.',
        }));
        return;
      }
      if (typeof window !== 'undefined' && address) {
        const next = dropPending(window.localStorage, address, target);
        if (next.changed) setRequests({ accepted: next.accepted, pending: next.pending });
      }
      setState((current) => ({
        ...current, note: 'Request deleted. That address can write again.',
      }));
    } catch (error) {
      setState((current) => ({ ...current, note: String(error?.message || error) }));
    } finally {
      setRequestBusy('');
    }
  }

  async function forwardTo(target) {
    if (!client.current || !chatIdentity || !forwarding || !target) return;
    setForwardState({ busy: true, note: '', error: '' });
    try {
      await client.current.send({
        chatIdentity, from: address, to: target, text: forwarding.text,
      });
      const message = {
        id: `s${Date.now()}`, peer: target, from: address,
        text: forwarding.text, at: Date.now(), own: true,
      };
      rememberIfEnabled({
        seed32: chatSeed32, address, peer: target, messages: [message], scope: 'chat',
      });
      setForwarding(null);
      setForwardState({ busy: false, note: `Forwarded to ${peerLabel(target)}.`, error: '' });
    } catch (error) {
      setForwardState({ busy: false, note: '', error: String(error?.message || error) });
    }
  }

  const applyTombstones = useCallback(async (forPeer = '') => {
    if (!client.current || !chatIdentity) return;
    const result = await client.current.tombstones({
      seed32, chatIdentity, address, since: 0, peer: forPeer,
    }).catch(() => null);
    if (!result?.deletions?.length) return;
    const ids = new Set(result.deletions.map((item) => `m${item.id}`));
    setThread((current) => current.filter((message) => !ids.has(message.id)));
    for (const item of result.deletions) {
      await deleteArchivedMessage({ address, peer: item.peer, id: `m${item.id}` }).catch(() => {});
    }
  }, [address, chatIdentity, seed32]);

  const deleteOwn = useCallback(async (message) => {
    const id = relayIdOf(message);
    if (!client.current || !chatIdentity || !Number.isSafeInteger(id) || id <= 0) return;
    // Saved Messages has no second party, so the confirmation must not claim
    // somebody else loses the line.
    const onlyMe = isSavedMessagesPeer(address, peer);
    const question = onlyMe ? 'Delete this saved message?' : 'Delete this message for everyone?';
    if (typeof window !== 'undefined' && !window.confirm(question)) return;
    try {
      await client.current.deleteMessage({ seed32, chatIdentity, address, id });
      setThread((current) => current.filter((row) => row.id !== message.id));
      await deleteArchivedMessage({ address, peer, id: message.id }).catch(() => {});
      setState((current) => ({
        ...current, note: onlyMe ? 'Saved message deleted.' : 'Message deleted for everyone.',
      }));
    } catch (error) {
      setState((current) => ({ ...current, note: describeChatFailure(error, { action: 'send' }).message }));
    }
  }, [address, chatIdentity, peer, seed32]);

  const applyControl = useCallback(async (control, fromPeer, targetHint = null) => {
    const threadId = `m${control.id}`;
    const target = targetHint
      || threadStateRef.current.find((message) => message.id === threadId)
      || null;
    if (control.kind === 'edit') {
      // Only the author of the original message may edit it.
      if (target && String(target.from).toUpperCase() !== String(fromPeer).toUpperCase()) return false;
      setThread((current) => current.map((message) => (
        message.id === threadId ? { ...message, text: control.text, edited: true } : message
      )));
      if (target) {
        await rewriteArchivedMessage({
          seed32: chatSeed32, address, peer: fromPeer, id: threadId, text: control.text,
        }).catch(() => {});
      }
      return true;
    }
    if (control.kind === 'reaction') {
      setThread((current) => current.map((message) => (
        message.id === threadId ? { ...message, reaction: control.emoji || '' } : message
      )));
      if (target) {
        await rewriteArchivedMessage({
          seed32: chatSeed32, address, peer: fromPeer, id: threadId, reaction: control.emoji || '',
        }).catch(() => {});
      }
      return true;
    }
    return false;
  }, [address, chatSeed32]);

  const sendControl = useCallback(async (control) => {
    if (!client.current || !chatIdentity || !peer) return null;
    const text = encodeControl(control);
    const prepared = await client.current.prepare({
      chatIdentity, from: address, to: peer, text,
    });
    return client.current.sendPrepared({
      seed32, chatIdentity, address, envelope: prepared.envelope, clientId: createClientId(),
    });
  }, [address, chatIdentity, peer, seed32]);

  const editOwn = useCallback(async (message) => {
    const id = relayIdOf(message);
    if (!Number.isSafeInteger(id) || id <= 0 || typeof window === 'undefined') return;
    const next = window.prompt('Edit message', displayMessageText(message.text));
    const text = String(next ?? '').trim();
    if (!text || text === displayMessageText(message.text)) return;
    try {
      await sendControl({ kind: 'edit', id, text });
      setThread((current) => current.map((row) => (
        row.id === message.id ? { ...row, text, edited: true } : row
      )));
      await rewriteArchivedMessage({
        seed32: chatSeed32, address, peer, id: message.id, text,
      }).catch(() => {});
      setState((current) => ({
        ...current,
        note: isSavedMessagesPeer(address, peer) ? 'Saved message edited.' : 'Message edited for both sides.',
      }));
    } catch (error) {
      setState((current) => ({ ...current, note: describeChatFailure(error).message }));
    }
  }, [address, chatSeed32, peer, sendControl]);

  const reactTo = useCallback(async (message, emoji) => {
    const id = relayIdOf(message);
    if (!Number.isSafeInteger(id) || id <= 0) return;
    const previous = message.reaction || '';
    const next = previous === emoji ? '' : emoji;
    try {
      await sendControl({ kind: 'reaction', id, emoji: next });
      setThread((current) => current.map((row) => (
        row.id === message.id ? { ...row, reaction: next } : row
      )));
      await rewriteArchivedMessage({
        seed32: chatSeed32, address, peer, id: message.id, reaction: next,
      }).catch(() => {});
    } catch (error) {
      setState((current) => ({ ...current, note: describeChatFailure(error).message }));
    }
  }, [address, chatSeed32, peer, sendControl]);

  const sendTyping = useCallback((active) => {
    // Nobody is on the other end of Saved Messages to show a typing line.
    if (!client.current || !chatIdentity || !peer || isSavedMessagesPeer(address, peer)) return;
    const now = Date.now();
    // One typing frame every 3 s is enough; the receiver expires it after 5 s.
    if (active && now - typingSentAt.current < 3000) return;
    typingSentAt.current = now;
    void client.current.typing({
      seed32, chatIdentity, address, peer, active,
    }).catch(() => {});
  }, [address, chatIdentity, peer, seed32]);

  async function send(event) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !client.current || !chatIdentity || !peer) return;
    sendTyping(false);
    let payload = text;
    if (replyTo) {
      try {
        payload = createReplyText({ to: replyTo.id, quote: replyTo.quote, text });
      } catch (error) {
        setState((current) => ({ ...current, note: String(error?.message || error) }));
        return;
      }
    }
    setState((current) => ({ ...current, busy: true, note: '' }));
    let prepared;
    try {
      prepared = await client.current.prepare({ chatIdentity, from: address, to: peer, text: payload });
    } catch (error) {
      setState((current) => ({ ...current, busy: false, note: '' }));
      setRelayNotice(describeChatFailure(error, { action: 'send' }));
      return;
    }

    const clientId = createClientId();
    const queuedBefore = enqueueOutbox(address, {
      clientId, to: prepared.to, envelope: prepared.envelope, createdAt: Date.now(),
    });
    const queued = queuedBefore.some((item) => item.clientId === clientId);
    setQueuedCount(queuedBefore.length);
    const pendingMessage = {
      id: clientId, peer, from: address, text: payload, at: Date.now(), own: true, pending: true,
    };
    setThread((current) => [...current, pendingMessage]);

    try {
      const result = await client.current.sendPrepared({
        chatIdentity, address, envelope: prepared.envelope, clientId,
      });
      removeOutbox(address, clientId);
      setQueuedCount(readOutbox(address).length);
      const message = { ...pendingMessage, id: result?.id ?? clientId, pending: false };
      setThread((current) => current.map((item) => (item.id === clientId ? message : item)));
      rememberIfEnabled({
        seed32: chatSeed32, address, peer, messages: [message], scope: 'chat',
      });
      setDraft('');
      setReplyTo(null);
      setSheet('none');
      setRelayNotice(null);
    } catch (error) {
      markOutboxFailure(address, clientId, error);
      setQueuedCount(readOutbox(address).length);
      const retryable = !error?.status || error.status === 429 || error.status >= 500;
      if (!retryable) {
        removeOutbox(address, clientId);
        setQueuedCount(readOutbox(address).length);
        setThread((current) => current.filter((item) => item.id !== clientId));
        setDraft(text);
        setRelayNotice(describeChatFailure(error, { action: 'send' }));
      } else if (queued) {
        setDraft('');
        setRelayNotice({
          kind: 'queued',
          title: 'Message saved on this device',
          message: 'The encrypted copy is queued here and will retry automatically when the chat server is reachable. You can close the app; the ciphertext stays on this device.',
          retry: false,
        });
      } else {
        setThread((current) => current.filter((item) => item.id !== clientId));
        setDraft(text);
        setRelayNotice({
          kind: 'error',
          title: 'Message not sent',
          message: 'The outbox could not store this message. Keep this tab open and press Send again.',
          retry: false,
        });
      }
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
              // A new chat is saved against the wallet that owns it; the chat
              // identity supplies that name without asking for the seed.
              if (readOnly) { requestUnlock(); return; }
              setShowAdd((value) => !value);
              setAddState({ busy: false, note: '', error: '' });
            }}>
            {showAdd ? '×' : '＋'}
          </button>
        </div>
        <p className="nw-small nw-dim nw-chat-hint">
          {readOnly
            ? 'Only you and the person you write to can read these messages. Your saved chats stay listed below.'
            : 'Only you and the person you write to can read these messages. Chat works while your wallet is locked; only sending NSAT asks for approval.'}
        </p>
        {readOnly && identityLoading && (
          <p className="nw-small nw-dim" style={{ margin: '8px 0 0' }}>
            Preparing encrypted chat on this device…
          </p>
        )}

        {/* One row per wallet, each a real button: the reason chat looks
         * disabled is a missing per-wallet key, so the fix has to be one click
         * away from the message that says so. */}
        {needsChatSetup.length > 0 && (
          <div className="nw-unlock-card" style={{ margin: '10px 0 0', padding: 12 }}>
            <p className="nw-small" style={{ margin: 0 }}>
              <strong>Chat is off until each wallet is unlocked once.</strong>{' '}
              Unlocking creates that wallet&apos;s chat key on this device. Chat then
              keeps working while the wallet is locked again; only sending NSAT asks
              for approval.
            </p>
            <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
              {needsChatSetup.map((owner) => (
                <div key={owner}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                  <span className="nw-small">
                    {addressNames[owner] || shortAddr(owner)}
                    {String(owner).toUpperCase() === String(address).toUpperCase()
                      ? ' · this wallet'
                      : ''}
                  </span>
                  <button type="button" className="nw-send-btn"
                    onClick={() => onEnableChat?.(owner)}>
                    Unlock to enable chat
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <details className="nw-chat-setup" style={{ margin: '10px 0 0' }}>
          <summary className="nw-small nw-dim" style={{ cursor: 'pointer' }}>
            How chat is set up per wallet
          </summary>
          <ul className="nw-small nw-dim" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            <li>
              <strong>Unlock once per wallet.</strong> Chat needs its own key for each
              address, created the first time you unlock that wallet with Chats open.
              Repeat for every wallet you chat from; other wallets stay locked out of
              this one&apos;s chat.
            </li>
            <li>
              <strong>It stays on this device.</strong> The key is stored in this
              browser only (<code>scw-chat-identity-v1:&lt;address&gt;</code>). It is
              separate from your wallet seed: it can sign chat requests, but it cannot
              move funds or approve a payment.
            </li>
            <li>
              <strong>If you clear site data.</strong> That key is deleted. Unlocking
              again creates a new one, but messages encrypted to the old key cannot be
              read here any more; the relay keeps its copies for 7 days at most, so save
              anything important first.
            </li>
          </ul>
        </details>

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
                        {peerLabel(request.peer)}
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
                      {peerLabel(request.peer)}
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

        {/* A stranger's first message is held here: address, no text, no badge.
         * Accept turns it into a normal room; Block and Delete keep it away. */}
        {pendingRequests.length > 0 ? (
          <section className="nw-payqueue" aria-label="Message requests">
            <div className="nw-payqueue-head">
              <strong>Requests</strong>
              <span className="nw-small nw-dim">{`${pendingRequests.length} waiting`}</span>
            </div>
            <p className="nw-small nw-dim" style={{ margin: 0 }}>
              From addresses this wallet has never sent to or heard from. No preview and no unread
              badge until you accept one.
            </p>
            <ul className="nw-payqueue-list">
              {pendingRequests.map((sender) => {
                const busy = requestBusy === sender;
                return (
                  <li key={sender} className="nw-payqueue-row">
                    <div className="nw-payqueue-main">
                      <span className="nw-payqueue-name nw-mono">{shortAddr(sender)}</span>
                      <span className="nw-payqueue-meta">Message request · hidden until you accept</span>
                    </div>
                    <div className="nw-payqueue-actions">
                      <button type="button" className="nw-chip-btn" disabled={busy}
                        onClick={() => void acceptRequest(sender)}>
                        {busy ? '…' : 'Accept'}
                      </button>
                      <button type="button" className="nw-chip-btn" disabled={busy}
                        onClick={() => void blockRequest(sender)}>Block</button>
                      <button type="button" className="nw-chip-btn" disabled={busy}
                        onClick={() => void deleteRequest(sender)}>Delete</button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

              {listTargets.length === 0 ? (
        <div className="nw-chat-empty">
          <strong>No chats yet</strong>
          {identityLoading
            ? 'Preparing encrypted chat…'
            : readOnly
              ? 'Unlock the wallet once to set up chat on this device.'
              : `Tap ＋ to start one with someone’s @profile or G… address.`}
        </div>
      ) : (
        <>
        <div className="nw-chat-search">
          <input className="nw-chat-input" type="search" value={chatQuery}
            placeholder="Search chats" aria-label="Search conversations"
            onChange={(event) => setChatQuery(event.target.value)} />
        </div>
        {visibleKnown.length === 0 ? (
          <div className="nw-chat-empty">
            <strong>No matches</strong>
            Try another display name, @handle or wallet address.
          </div>
        ) : (
        <ul className="nw-chat-list">
            {visibleKnown.map((contact) => {
              const isSaved = isSavedMessagesPeer(address, contact);
              const added = !isSaved && friendList.includes(contact);
              const acceptedRoom = !isSaved && acceptedPeers.includes(contact);
              const isPinned = !isSaved && pinnedSet.has(String(contact).toUpperCase());
              const count = isSaved || mutedPeers.includes(contact) ? 0 : (unreadCounts[contact] || 0);
              const preview = readOnly || mutedPeers.includes(contact) ? null : unreadPreview[contact];
              const checked = readOnly ? formatUnreadAge(lockedUnread.at) : '';
              const subtitle = isSaved
                ? 'Only you can read this'
                : identityLoading
                ? 'Preparing chat…'
                : readOnly
                  ? (count > 0
                    ? `${count} new${checked ? ` · checked ${checked}` : ''}`
                    : 'Chat not set up · unlock once')
                : count > 0 && preview
                  ? `${count > 1 ? `${count} new · ` : ''}${preview.text}`
                  : added ? 'Encrypted chat'
                    : acceptedRoom ? 'Accepted message request'
                      : 'From your transfers · encrypted';
              return (
                <li key={contact} className="nw-chat-row">
                  <button type="button" className="nw-chat-rowmain"
                    onClick={() => {
                      // Opening a conversation needs the chat identity (the
                      // messages are encrypted to it). The wallet password is
                      // only needed when the person sends NSAT.
                      if (readOnly) { requestUnlock(contact); return; }
                      void publishOwnKey();
                      void openThread(contact);
                    }}>
                    <span className="nw-chat-avatar" aria-hidden>
                      {initials(contact, isSaved ? SAVED_MESSAGES_LABEL : (peerNames[contact] || peerIds[contact]))}
                    </span>
                    <span className="nw-chat-rowtext">
                      <span className="nw-chat-rowname">{peerLabel(contact)}</span>
                      <span className="nw-chat-rowsub">{subtitle}</span>
                    </span>
                    {count > 0 ? (
                      <span className="nw-chat-badge" aria-label={`${count} new message${count === 1 ? '' : 's'}`}>
                        {count > 99 ? '99+' : count}
                      </span>
                    ) : null}
                    <span className="nw-chat-rowchev" aria-hidden>›</span>
                  </button>
                  {isSaved ? null : (
                    <button type="button" className="nw-chip-btn nw-chat-pin"
                      aria-pressed={isPinned}
                      aria-label={`${isPinned ? 'Unpin' : 'Pin'} ${peerLabel(contact)}`}
                      title={isPinned ? 'Unpin this conversation' : 'Pin this conversation'}
                      onClick={() => togglePinned(contact)}>
                      {isPinned ? 'Unpin' : 'Pin'}
                    </button>
                  )}
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
            {`New messages last checked ${formatUnreadAge(lockedUnread.at)}. Unlock once to set up chat.`}
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
        </>
      )}
      </section>
    );
  }

  return (
    <section className="nw-chat-room" aria-label={savedRoom ? SAVED_MESSAGES_LABEL : `Chat with ${peerName}`}>
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
        <span className="nw-chat-avatar" aria-hidden>
          {initials(peer, savedRoom ? SAVED_MESSAGES_LABEL : (peerNames[peer] || peerIds[peer]))}
        </span>
        <div className="nw-chat-who">
          <span className="nw-chat-whoname">{peerName}</span>
          <span className="nw-chat-whosub">
            {savedRoom
              ? 'Only you can read this'
              : peerPresence.known && peerPresence.online ? 'Online' : 'Encrypted chat'}
          </span>
        </div>
        <button type="button" className="nw-chat-iconbtn" aria-label="Refresh messages"
          disabled={state.busy || readOnly} onClick={() => void openThread(peer)}>↻</button>
        <button type="button" className="nw-chat-iconbtn" aria-label="Chat details"
          aria-expanded={detailsOpen} onClick={() => setDetailsOpen((value) => !value)}>ⓘ</button>
      </header>

      {detailsOpen && (
        <div className="nw-chat-details">
          {pushDisclosure && !pushEnabled ? (
            <div className="nw-chat-notice" role="status">
              <strong className="nw-small">Alerts while the app is closed</strong>
              <p className="nw-small nw-dim" style={{ margin: '4px 0 0' }}>
                The notification is encrypted in transit and carries no message text, no sender name
                and no unread count — what you read on screen is written by this device. The payload
                names only the conversation to open. The push service (Google, Mozilla or Apple)
                still sees that this device received an alert, and when; turning this on is your
                choice, it is per device, and turning it off never stops messages from arriving.
              </p>
              <div className="nw-btn-row" style={{ margin: '8px 0 0' }}>
                <button type="button" className="nw-chip-btn" disabled={pushBusy}
                  onClick={() => void enablePush()}>
                  {pushBusy ? 'Turning on…' : 'Turn on alerts'}
                </button>
                <button type="button" className="nw-chip-btn"
                  onClick={() => setPushDisclosure(false)}>Not now</button>
              </div>
            </div>
          ) : null}
          <div className="nw-kv">
            <span className="nw-k">Wallet address</span>
            <span className="nw-v nw-small nw-mono" style={{ wordBreak: 'break-all' }}>{peer}</span>
          </div>
          {peerNames[peer] && peerNames[peer] !== peerIds[peer] ? (
            <div className="nw-kv">
              <span className="nw-k">Display name</span>
              <span className="nw-v">{peerNames[peer]}</span>
            </div>
          ) : null}
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
            {savedRoom || !onSendTo ? null : (
              <button type="button" className="nw-chip-btn" onClick={() => onSendTo(peer)}>
                Open in Send
              </button>
            )}
            {savedRoom || readOnly || !onSendTo ? null : (
              <button type="button" className="nw-chip-btn" onClick={() => setSheet('request')}>
                Request NSAT
              </button>
            )}
            {savedRoom || readOnly ? null : (
              <button type="button" className="nw-chip-btn"
                aria-pressed={presenceEnabled}
                onClick={() => {
                  const next = !presenceEnabled;
                  setPresenceEnabled(next);
                  writePresencePref(address, next);
                  if (!next) {
                    void client.current?.presence({ seed32, chatIdentity, address, online: false }).catch(() => {});
                  }
                }}>
                {presenceEnabled ? 'Sharing online status' : 'Share online status'}
              </button>
            )}
            {savedRoom || readOnly ? null : (
              <button type="button" className="nw-chip-btn"
                aria-pressed={mutedPeers.includes(peer)}
                onClick={() => setMutedPeers(toggleMuted(address, peer))}>
                {mutedPeers.includes(peer) ? 'Unmute this chat' : 'Mute this chat'}
              </button>
            )}
            {savedRoom || readOnly ? null : (
              <button type="button" className="nw-chip-btn"
                disabled={!pushEnv.supported || pushBusy}
                aria-pressed={pushEnabled}
                title={pushEnv.supported ? undefined : pushReasonText(pushEnv.reason)}
                onClick={() => {
                  if (pushBusy || !pushEnv.supported) return;
                  if (pushEnabled) { void disablePush(); return; }
                  // Never subscribe without showing what the push service sees.
                  setPushDisclosure(true);
                }}>
                {pushEnabled ? 'Background alerts on' : 'Background alerts'}
              </button>
            )}
            {savedRoom || readOnly ? null : (
              <button type="button" className="nw-chip-btn"
                disabled={!notificationSupported()}
                aria-pressed={notifyEnabled}
                onClick={async () => {
                  if (notifyEnabled) {
                    setNotifyEnabled(false);
                    writeNotifyPref(address, false);
                    return;
                  }
                  const granted = await requestNotificationPermission();
                  if (!granted) {
                    setState((current) => ({ ...current, note: 'Browser notification permission was not granted.' }));
                    return;
                  }
                  setNotifyEnabled(true);
                  writeNotifyPref(address, true);
                }}>
                {notifyEnabled ? 'Notifications on' : 'Enable notifications'}
              </button>
            )}
            {savedRoom || readOnly ? null : (
              <button type="button" className="nw-chip-btn" onClick={toggleBlock}
                disabled={gate.busy} aria-pressed={gate.blocked}>
                {gate.blocked ? 'Unblock' : 'Block'}
              </button>
            )}
          </div>
          {savedRoom ? (
            <p className="nw-small nw-dim" style={{ margin: 0 }}>
              This room belongs to this wallet alone. Its messages are encrypted to this wallet&apos;s
              own chat key, so no other address can read them, and it never joins your contact list.
            </p>
          ) : null}
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

      {relayNotice ? (
        <div className="nw-chat-notice" role="alert">
          <strong className="nw-small">{relayNotice.title}</strong>
          <p className="nw-small nw-dim" style={{ margin: '4px 0 0' }}>{relayNotice.message}</p>
          <div className="nw-btn-row" style={{ margin: '8px 0 0' }}>
            {relayNotice.retry && peer ? (
              <button type="button" className="nw-chip-btn"
                onClick={() => { setRelayNotice(null); void openThread(peer); }}>
                Try again
              </button>
            ) : null}
            <button type="button" className="nw-chip-btn"
              onClick={() => setRelayNotice(null)}>Dismiss</button>
          </div>
        </div>
      ) : null}

      {queuedCount > 0 ? (
        <div className="nw-chat-notice" role="status">
          <strong className="nw-small">
            {`${queuedCount} message${queuedCount === 1 ? '' : 's'} queued on this device`}
          </strong>
          <p className="nw-small nw-dim" style={{ margin: '4px 0 0' }}>
            The encrypted copy will retry automatically; the message text is not stored in the outbox.
          </p>
          <div className="nw-btn-row" style={{ margin: '8px 0 0' }}>
            <button type="button" className="nw-chip-btn" onClick={() => { void flushOutbox(); }}>
              Retry now
            </button>
          </div>
        </div>
      ) : null}

      {inboxError ? (
        <p className="nw-small" style={{ margin: 0, color: 'var(--warn)' }} role="alert">
          {inboxError}
        </p>
      ) : null}

      <ul ref={threadRef} className="nw-chat-thread" aria-live="polite">
        {thread.length === 0 && (
          <li className="nw-chat-empty">
            <strong>{savedRoom ? 'Nothing saved yet' : 'No messages yet'}</strong>
            {savedRoom
              ? 'Messages you send here are readable only by this wallet.'
              : `Say hello — only you and ${peerName} can read this chat.`}
          </li>
        )}
        {thread.map((message) => {
          const paymentRequest = parsePaymentRequestText(message.text, message.from);
          const transactionCard = parseTransactionCardText(message.text, message.from);
          const reply = parseReplyText(message.text);
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
          // Protocol cards are not normal chat text; copying their serialized
          // form would be misleading, so the control is for plain messages.
          const copyable = !transactionCard && !paymentRequest && reply?.kind !== 'invalid';
          const copyResult = messageCopy.id === message.id ? messageCopy.state : '';
          // Sent/Read is about the other wallet. Saved Messages has none, so it
          // never shows a receipt line.
          const receipt = message.own && !message.pending
            ? readReceiptLabel({
              owner: address,
              peer,
              messageId: Number(relayIdOf(message)) || 0,
              lastId: peerRead.peer === peer ? peerRead.lastId : 0,
            })
            : '';
          // Keep state and the relay's countdown. A line this device holds has
          // no expiry to warn about; with automatic history on, every line is
          // archived as it arrives, so the warning would be noise.
          const keepId = archiveIdOf(message);
          const isKept = kept.anywhere.has(keepId);
          const savedCopy = kept.saved.has(keepId);
          const expiry = isKept || historyOn ? '' : expiryLabel(message);
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
                        disabled={!onSendCoins || gate.blocked || paymentBusy === requestKey}
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
              ) : reply?.kind === 'reply' ? (
                <div className="nw-chat-text">
                  <blockquote className="nw-chat-quote">{reply.quote}</blockquote>
                  <div>{reply.text}</div>
                </div>
              ) : reply?.kind === 'invalid' ? (
                <div className="nw-chat-text">
                  <strong>Invalid reply</strong>
                  <div className="nw-small nw-dim">{reply.reason}</div>
                </div>
              ) : (
                <div className="nw-chat-text">{message.text}</div>
              )}
              <div className="nw-chat-meta">
                {clock(message.at)}
                {message.pending ? (
                  <span className="nw-small nw-dim" role="status">Queued — retrying</span>
                ) : receipt ? (
                  <span className="nw-small nw-dim" role="status">{receipt}</span>
                ) : null}
                {expiry ? <span className="nw-small nw-dim">{expiry}</span> : null}
                {!message.pending && !readOnly && Number(relayIdOf(message)) > 0 ? (
                  isKept ? (
                    <span className="nw-small nw-dim" role="status">
                      {savedCopy ? 'Kept ✓' : 'Kept'}
                    </span>
                  ) : (
                    <button type="button" className="nw-chat-copy"
                      aria-label="Keep this message on this device and copy it to Saved Messages"
                      disabled={keepBusy === message.id}
                      onClick={() => void keepOne(message)}>
                      {keepBusy === message.id ? 'Keeping…' : 'Keep'}
                    </button>
                  )
                ) : null}
                {copyable ? (
                  <button type="button" className="nw-chat-copy"
                    aria-label={copyResult === 'done' ? 'Message copied'
                      : copyResult === 'failed' ? 'Copy failed' : 'Copy message'}
                    onClick={() => void copyMessage(message)}>
                    {copyResult === 'done' ? 'Copied' : copyResult === 'failed' ? 'Copy failed' : 'Copy'}
                  </button>
                ) : null}
                {copyable && !readOnly ? (
                  <button type="button" className="nw-chat-copy"
                    aria-label="Forward message"
                    onClick={() => {
                      setForwarding({ id: message.id, text: displayMessageText(message.text) });
                      setForwardState({ busy: false, note: '', error: '' });
                    }}>
                    Forward
                  </button>
                ) : null}
                {copyable && !readOnly ? (
                  <button type="button" className="nw-chat-copy"
                    aria-label="Reply to message"
                    onClick={() => setReplyTo({
                      id: message.id,
                      quote: displayMessageText(message.text).slice(0, MAX_REPLY_QUOTE),
                    })}>
                    Reply
                  </button>
                ) : null}
                {message.own && !message.pending && !readOnly && Number(relayIdOf(message)) > 0 ? (
                  <>
                    <button type="button" className="nw-chat-copy"
                      aria-label="Edit message"
                      onClick={() => void editOwn(message)}>
                      Edit
                    </button>
                    <button type="button" className="nw-chat-copy"
                      aria-label="Delete message for everyone"
                      onClick={() => void deleteOwn(message)}>
                      Delete
                    </button>
                  </>
                ) : null}
                {!message.pending && !readOnly && Number(relayIdOf(message)) > 0 ? (
                  ['👍', '❤️', '😂'].map((emoji) => (
                    <button key={emoji} type="button" className="nw-chat-copy"
                      aria-label={`React ${emoji}`}
                      aria-pressed={message.reaction === emoji}
                      onClick={() => void reactTo(message, emoji)}>
                      {emoji}
                    </button>
                  ))
                ) : null}
                {message.reaction ? (
                  <span className="nw-small" role="status">{message.reaction}</span>
                ) : null}
              </div>
              {copyable && copyResult ? (
                <span className="nw-sr-only" role="status">
                  {copyResult === 'done' ? 'Message copied' : 'Copy failed'}
                </span>
              ) : null}
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
            <button type="button" className="nw-chat-attachitem"
              disabled={readOnly}
              onClick={() => setSheet('request')}>
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
                  disabled={coin.phase === 'sending'} />
                <span className="nw-small nw-dim">NSAT</span>
              </div>
              <p className="nw-small nw-dim" style={{ margin: 0 }}>
                {balance == null ? 'Balance unavailable' : `Available ${String(balance)} NSAT`}
              </p>
              <button type="button" className="nw-send-btn"
                onClick={() => setCoin((current) => ({ ...current, phase: 'confirm', error: '' }))}
                disabled={coin.phase === 'sending' || !coinAmountOk}>
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

      {replyTo ? (
        <div className="nw-chat-replybar" role="status">
          <span className="nw-small nw-dim">Replying to “{replyTo.quote}”</span>
          <button type="button" className="nw-chat-iconbtn" aria-label="Cancel reply"
            onClick={() => setReplyTo(null)}>×</button>
        </div>
      ) : null}

      {forwarding ? (
        <div className="nw-chat-forward" role="dialog" aria-label="Forward message">
          <div className="nw-chat-bar">
            <strong>Forward to</strong>
            <button type="button" className="nw-chat-iconbtn" aria-label="Cancel forwarding"
              onClick={() => { setForwarding(null); setForwardState({ busy: false, note: '', error: '' }); }}>×</button>
          </div>
          {forwardChoices.length ? (
            <div className="nw-chat-forwardlist">
              {forwardChoices.map((target) => (
                <button key={target} type="button" className="nw-chip-btn"
                  disabled={forwardState.busy}
                  onClick={() => void forwardTo(target)}>
                  {peerLabel(target)}
                </button>
              ))}
            </div>
          ) : (
            <p className="nw-small nw-dim" style={{ margin: 0 }}>
              No other conversations yet. Add somebody from the Chats tab first.
            </p>
          )}
          {forwardState.error ? (
            <p className="nw-small" style={{ margin: 0, color: 'var(--warn)' }} role="alert">
              {forwardState.error}
            </p>
          ) : null}
        </div>
      ) : null}
      {forwardState.note ? (
        <p className="nw-small nw-dim" style={{ margin: 0 }} role="status">{forwardState.note}</p>
      ) : null}

      {typingPeer ? (
        <p className="nw-small nw-dim" style={{ margin: 0 }} role="status">
          {peerNames[peer] || peer} is typing…
        </p>
      ) : null}
      <form className="nw-chat-composer" onSubmit={send}>
        {savedRoom ? null : (
          <button type="button" className="nw-chat-iconbtn" aria-label="More actions"
            aria-expanded={sheet !== 'none'}
            disabled={gate.blocked || (!onSendCoins && !onSendTo)}
            onClick={() => setSheet((value) => (value === 'none' ? 'menu' : 'none'))}>＋</button>
        )}
        <div className="nw-emoji">
          <button type="button" className="nw-chat-iconbtn" aria-label="Insert emoji"
            aria-expanded={emojiOpen}
            disabled={readOnly || state.busy || gate.blocked}
            onClick={() => setEmojiOpen((value) => !value)}>☺</button>
          {emojiOpen ? (
            <div className="nw-emoji-pop" role="dialog" aria-label="Emoji picker">
              <EmojiPicker
                theme={emojiTheme}
                width="100%"
                height={340}
                lazyLoadEmojis
                searchPlaceHolder="Search emoji"
                onEmojiClick={(emoji) => {
                  setDraft((current) => `${current}${emoji.emoji}`.slice(0, MAX_TEXT_LENGTH));
                  setEmojiOpen(false);
                }}
              />
            </div>
          ) : null}
        </div>
        <textarea className="nw-chat-input" value={draft} maxLength={MAX_TEXT_LENGTH}
          placeholder={identityLoading
            ? 'Preparing encrypted chat…'
            : readOnly ? 'Unlock once to set up chat' : gate.blocked ? 'Blocked — unblock to write' : 'Message'}
          onChange={(event) => {
            setDraft(event.target.value);
            sendTyping(Boolean(event.target.value.trim()));
          }}
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
