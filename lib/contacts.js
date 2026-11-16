// Messenger contacts: friend requests, the contact graph, blocks and the
// consent-first email lookup.
//
// Three rules shaped this module.
//
// 1. It cannot sign, spend or touch a wallet. A contact is an account-level
//    relationship between two Firebase uids; it says nothing about who owns
//    which wallet. Messaging still authenticates with the wallet key, and every
//    payment still goes through the wallet's own pipeline.
// 2. No email address is stored. Discovery is a document keyed by the SHA-256
//    of the normalised address, created only when the owner turns it on, so a
//    lookup that finds nothing cannot tell "no account" from "not consenting".
// 3. Every write is a plan built here, not an ad-hoc payload from a component:
//    `plan*()` returns the exact operations, the store executes them, and the
//    tests assert the operations rather than the UI. That is also what keeps the
//    rules honest — each planned path is one the rules check.
//
// State lives in four places, all keyed by uid:
//
//   contacts/{uid}/people/{peer}   = { state: "friend", since }        (both sides)
//   requests/{to}/inbox/{from}     = { state: "pending"|"accepted"|"rejected", at }
//   requests/{from}/outbox/{to}    = { state: "pending"|"accepted"|"rejected", at }
//   blocks/{uid}/people/{peer}     = { at }
//   discoveryEmails/{sha256(email)} = { uid }                            (opt-in only)
//
// The inbox and the outbox hold the same state on purpose: each side can list
// its own documents (Firestore cannot list another user's inbox), and the
// accepting side writes both in one plan so the two cannot disagree for long.
import { normalizeAddress, normalizeProfileId } from './profile.js';
import { withTimeout } from './withTimeout.js';

export const CONTACTS_COLLECTION = 'contacts';
export const PEOPLE_SUBCOLLECTION = 'people';
export const REQUESTS_COLLECTION = 'requests';
export const INBOX_SUBCOLLECTION = 'inbox';
export const OUTBOX_SUBCOLLECTION = 'outbox';
export const BLOCKS_COLLECTION = 'blocks';
export const DISCOVERY_COLLECTION = 'discoveryEmails';

export const CONTACT_LIMIT = 200;
export const BLOCK_LIMIT = 200;
export const REQUEST_STATES = ['pending', 'accepted', 'rejected'];
// A signed-in account can ask about one address at a time, no faster than this.
// It is a client-side brake, not a server control: the honest statement is that
// bulk enumeration is slowed, not prevented (ARCHITECTURE.md §7).
export const DISCOVERY_MIN_INTERVAL_MS = 1200;

const UID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;
export const EMAIL_HASH_RE = /^[a-f0-9]{64}$/;
const TEXT_ENCODER = new TextEncoder();

export function normalizeUid(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return UID_RE.test(text) ? text : null;
}

/** Trimmed, lowercased address if it is a usable email, otherwise null. */
export function normalizeEmail(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!text || text.length > 254 || !EMAIL_RE.test(text)) return null;
  return text;
}

/**
 * SHA-256 of the normalised address, hex. Deterministic across devices: the
 * same person typing `Somchai@Example.com ` and `somchai@example.com` lands on
 * one document, and the plaintext never leaves the device.
 */
export async function emailHashHex(email, { subtle = globalThis.crypto?.subtle } = {}) {
  const normalized = normalizeEmail(email);
  if (!normalized) throw new Error('Enter a full email address, like name@example.com.');
  if (!subtle || typeof subtle.digest !== 'function') {
    throw new Error('This browser cannot hash an address (Web Crypto is unavailable).');
  }
  const digest = await subtle.digest('SHA-256', TEXT_ENCODER.encode(normalized));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * What other accounts may learn when discovery is on: the uid behind the
 * address, and nothing else. There is no email, no name and no wallet here —
 * the profile document is the only place an address is published.
 */
export function discoveryDocument({ uid } = {}) {
  const owner = normalizeUid(uid);
  if (!owner) throw new Error('a signed-in account is required for discovery');
  return { uid: owner };
}

// ---------------- the search field ----------------

/**
 * One input, three target kinds. The caller does not have to guess which one the
 * person typed; it gets `{ kind, value }` or a sentence that says what is wrong.
 */
export function classifyTarget(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return { error: 'Enter an @profile ID, a wallet address (G…) or an email address.' };
  if (text.includes('@') && !text.startsWith('@')) {
    const email = normalizeEmail(text);
    return email ? { kind: 'email', value: email } : { error: 'That does not look like an email address.' };
  }
  if (text.startsWith('@')) {
    const id = normalizeProfileId(text);
    return id ? { kind: 'handle', value: id } : { error: 'Use @, then 3–20 lowercase letters, digits, “-” or “_”.' };
  }
  const address = normalizeAddress(text);
  if (address) return { kind: 'address', value: address };
  return { error: 'A wallet address is 56 characters and starts with G. Use @ for a profile ID.' };
}

// ---------------- document shapes ----------------

export function contactDocument({ since = Date.now() } = {}) {
  const at = Number(since);
  if (!Number.isFinite(at) || at <= 0) throw new Error('a contact needs a timestamp');
  return { state: 'friend', since: at };
}

export function requestDocument({ state = 'pending', at = Date.now() } = {}) {
  if (!REQUEST_STATES.includes(state)) throw new Error('a request state must be pending, accepted or rejected');
  const when = Number(at);
  if (!Number.isFinite(when) || when <= 0) throw new Error('a request needs a timestamp');
  return { state, at: when };
}

export function blockDocument({ at = Date.now() } = {}) {
  const when = Number(at);
  if (!Number.isFinite(when) || when <= 0) throw new Error('a block needs a timestamp');
  return { at: when };
}

/** Read-back guards: anything that is not exactly one of these shapes is dropped. */
export function normalizeContact(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.state !== 'friend') return null;
  const since = Number(raw.since);
  if (!Number.isFinite(since) || since <= 0) return null;
  return { state: 'friend', since };
}

export function normalizeRequest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!REQUEST_STATES.includes(raw.state)) return null;
  const at = Number(raw.at);
  if (!Number.isFinite(at) || at <= 0) return null;
  return { state: raw.state, at };
}

export function normalizeBlock(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const at = Number(raw.at);
  if (!Number.isFinite(at) || at <= 0) return null;
  return { at };
}

// ---------------- paths and operations ----------------

export const contactPath = (owner, peer) => [CONTACTS_COLLECTION, owner, PEOPLE_SUBCOLLECTION, peer];
export const inboxPath = (owner, from) => [REQUESTS_COLLECTION, owner, INBOX_SUBCOLLECTION, from];
export const outboxPath = (owner, to) => [REQUESTS_COLLECTION, owner, OUTBOX_SUBCOLLECTION, to];
export const blockPath = (owner, peer) => [BLOCKS_COLLECTION, owner, PEOPLE_SUBCOLLECTION, peer];
export const discoveryPath = (hash) => [DISCOVERY_COLLECTION, hash];

const setOp = (path, data) => ({ type: 'set', path, data });
const deleteOp = (path) => ({ type: 'delete', path });

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function requirePair(me, peer) {
  const owner = normalizeUid(me);
  const other = normalizeUid(peer);
  if (!owner) throw fail('INVALID_ME', 'sign in before managing contacts');
  if (!other) throw fail('INVALID_PEER', 'that account is not a valid contact');
  if (owner === other) throw fail('SELF', 'This is your own account.');
  return { owner, other };
}

// ---------------- what the screen shows ----------------

/**
 * One answer for one peer, in the order the UI must respect: a block wins over
 * everything, then friendship, then the two directions of a pending request.
 */
export function contactStateFor({ me, peer, people = {}, incoming = {}, outgoing = {}, blocked = {} } = {}) {
  const owner = normalizeUid(me);
  const other = normalizeUid(peer);
  if (!owner || !other) return 'none';
  if (owner === other) return 'self';
  if (blocked[other]) return 'blocked';
  if (people[other] === 'friend') return 'friend';
  if (outgoing[other] === 'pending') return 'pending_out';
  if (incoming[other] === 'pending') return 'pending_in';
  if (outgoing[other] === 'rejected') return 'rejected_out';
  if (incoming[other] === 'rejected') return 'rejected_in';
  return 'none';
}

// ---------------- plans ----------------

/** Ask somebody to be a contact. Never overwrites an existing friendship. */
export function planSendRequest({ me, peer, people = {}, incoming = {}, outgoing = {}, now = Date.now() } = {}) {
  const { owner, other } = requirePair(me, peer);
  if (people[other] === 'friend') throw fail('ALREADY_FRIEND', 'You are already contacts.');
  if (outgoing[other] === 'pending') throw fail('DUPLICATE', 'You already asked. Waiting for an answer.');
  if (incoming[other] === 'pending') {
    throw fail('INCOMING_PENDING', 'This person already asked you. Accept their request instead.');
  }
  if (Object.keys(people).length >= CONTACT_LIMIT) {
    throw fail('LIMIT', `A contact list holds up to ${CONTACT_LIMIT} people.`);
  }
  const doc = requestDocument({ state: 'pending', at: now });
  return {
    state: 'pending_out',
    ops: [setOp(inboxPath(other, owner), doc), setOp(outboxPath(owner, other), doc)],
  };
}

/** Accept: one state on both sides, and a friendship document each way. */
export function planAcceptRequest({ me, peer, incoming = {}, now = Date.now() } = {}) {
  const { owner, other } = requirePair(me, peer);
  if (incoming[other] !== 'pending') throw fail('NOT_PENDING', 'There is no request from this person to accept.');
  const accepted = requestDocument({ state: 'accepted', at: now });
  const friendship = contactDocument({ since: now });
  return {
    state: 'friend',
    ops: [
      setOp(inboxPath(owner, other), accepted),
      setOp(outboxPath(other, owner), accepted),
      setOp(contactPath(owner, other), friendship),
      setOp(contactPath(other, owner), friendship),
    ],
  };
}

export function planRejectRequest({ me, peer, incoming = {}, now = Date.now() } = {}) {
  const { owner, other } = requirePair(me, peer);
  if (incoming[other] !== 'pending') throw fail('NOT_PENDING', 'There is no request from this person to refuse.');
  const rejected = requestDocument({ state: 'rejected', at: now });
  return {
    state: 'rejected_in',
    ops: [setOp(inboxPath(owner, other), rejected), setOp(outboxPath(other, owner), rejected)],
  };
}

/** Withdraw my own unanswered request. The other side's inbox entry goes too. */
export function planCancelRequest({ me, peer, outgoing = {} } = {}) {
  const { owner, other } = requirePair(me, peer);
  if (outgoing[other] !== 'pending') throw fail('NOT_PENDING', 'You have no unanswered request to this person.');
  return {
    state: 'none',
    ops: [deleteOp(inboxPath(other, owner)), deleteOp(outboxPath(owner, other))],
  };
}

/**
 * Remove a contact. Deliberately one-sided: my list forgets them, theirs does
 * not. Nothing is deleted on the relay either — a conversation is not a contact.
 */
export function planRemoveContact({ me, peer, people = {} } = {}) {
  const { owner, other } = requirePair(me, peer);
  if (people[other] !== 'friend') throw fail('NOT_FRIEND', 'This person is not in your contacts.');
  return { state: 'none', ops: [deleteOp(contactPath(owner, other))] };
}

/**
 * Block: my own block document, my copy of the friendship, any request I sent
 * and the request they sent me all change in one plan. Their list and their
 * block document are untouched — a block is mine to hold.
 */
export function planBlock({ me, peer, people = {}, incoming = {}, outgoing = {}, blocked = {}, now = Date.now() } = {}) {
  const { owner, other } = requirePair(me, peer);
  if (blocked[other]) return { state: 'blocked', ops: [] };
  if (Object.keys(blocked).length >= BLOCK_LIMIT) {
    throw fail('LIMIT', `A block list holds up to ${BLOCK_LIMIT} people.`);
  }
  const ops = [setOp(blockPath(owner, other), blockDocument({ at: now }))];
  if (people[other] === 'friend') ops.push(deleteOp(contactPath(owner, other)));
  if (outgoing[other] === 'pending') {
    ops.push(deleteOp(inboxPath(other, owner)), deleteOp(outboxPath(owner, other)));
  }
  if (incoming[other] === 'pending') {
    const rejected = requestDocument({ state: 'rejected', at: now });
    ops.push(setOp(inboxPath(owner, other), rejected), setOp(outboxPath(other, owner), rejected));
  }
  return { state: 'blocked', ops };
}

export function planUnblock({ me, peer, blocked = {} } = {}) {
  const { owner, other } = requirePair(me, peer);
  if (!blocked[other]) throw fail('NOT_BLOCKED', 'This person is not blocked.');
  return { state: 'none', ops: [deleteOp(blockPath(owner, other))] };
}

/** Turn the email lookup on (writes the hash) or off (deletes the document). */
export async function planEmailDiscovery({ me, allow, email, hashEmail = emailHashHex } = {}) {
  const owner = normalizeUid(me);
  if (!owner) throw fail('INVALID_ME', 'sign in before changing discovery');
  if (!allow) return { state: 'off', ops: [] };
  const hash = await hashEmail(email);
  if (!EMAIL_HASH_RE.test(String(hash || ''))) throw new Error('the email hash is not a SHA-256 digest');
  return { state: 'on', ops: [setOp(discoveryPath(hash), discoveryDocument({ uid: owner }))] };
}

export function describeContactFailure(error) {
  const code = String(error?.code || '');
  switch (code) {
    case 'SELF':
      return { title: 'That is your own account', message: 'You cannot add yourself as a contact.', tone: 'warn' };
    case 'ALREADY_FRIEND':
      return { title: 'Already a contact', message: 'This person is already in your contact list.', tone: 'warn' };
    case 'DUPLICATE':
      return { title: 'Request already sent', message: 'You asked this person already and are waiting for an answer.', tone: 'warn' };
    case 'INCOMING_PENDING':
      return { title: 'They asked you first', message: 'Accept their request instead of sending another one.', tone: 'warn' };
    case 'NOT_PENDING':
      return { title: 'Nothing to answer', message: 'There is no pending request for this person. Reload and check again.', tone: 'warn' };
    case 'NOT_FRIEND':
      return { title: 'Not in your contacts', message: 'This person is not in your contact list.', tone: 'warn' };
    case 'NOT_BLOCKED':
      return { title: 'Not blocked', message: 'This person is not on your block list.', tone: 'warn' };
    case 'LIMIT':
      return { title: 'List is full', message: error.message, tone: 'warn' };
    case 'TOO_FAST':
      return { title: 'One lookup at a time', message: 'Wait a moment before searching another address.', tone: 'warn' };
    case 'NO_CONSENT':
      return { title: 'No account found', message: 'No account with discovery turned on matches that address. Ask for their @profile ID or wallet address instead.', tone: 'info' };
    case 'permission-denied':
      return {
        title: 'The database refused this change',
        message: 'The security rules rejected it, so nothing was written. Contact features need a signed-in account with a verified email.',
        tone: 'err',
      };
    case 'unavailable':
    case 'deadline-exceeded':
      return { title: 'The site database could not be reached', message: 'Nothing was written. Check the connection and try again.', tone: 'warn' };
    default:
      return { title: 'The change was not confirmed', message: 'The database did not answer in time. Reload to check before relying on it.', tone: 'warn' };
  }
}

// ---------------- store ----------------

/**
 * Firestore-backed store. `sdk` is the loaded `firebase/firestore` module plus
 * `db`; tests pass a stub with the same five functions. Reads and writes are all
 * bounded by `withTimeout` for the same reason the other account stores are: a
 * Firestore that cannot answer must say so, not freeze the screen.
 */
export function createFirestoreContactsStore(uid, { sdk, emailVerified = false } = {}) {
  const owner = normalizeUid(uid);
  if (!owner) throw new Error('a signed-in account is required for contacts');
  if (!sdk?.doc || !sdk?.getDoc || !sdk?.setDoc || !sdk?.deleteDoc) {
    throw new Error('a Firestore SDK is required for contacts');
  }
  let lastLookupAt = 0;

  const ref = (path) => sdk.doc(sdk.db, ...path);

  async function readDoc(path) {
    const snap = await withTimeout(sdk.getDoc(ref(path)), 'reading the contact list did not complete');
    return snap?.exists?.() ? snap.data() : null;
  }

  async function listDocs(path) {
    if (!sdk.collection || !sdk.getDocs) return [];
    const snap = await withTimeout(sdk.getDocs(sdk.collection(sdk.db, ...path)),
      'reading the contact list did not complete');
    const out = [];
    snap?.forEach?.((docSnap) => out.push({ id: docSnap.id, data: docSnap.data() }));
    return out;
  }

  async function apply(ops) {
    for (const op of ops) {
      if (op.type === 'set') {
        await withTimeout(sdk.setDoc(ref(op.path), op.data), 'saving the contact change did not complete');
      } else {
        await withTimeout(sdk.deleteDoc(ref(op.path)), 'removing the contact change did not complete');
      }
    }
  }

  /** Everything the screen needs, in the shape the planners take. */
  async function snapshot() {
    const [people, incoming, outgoing, blocks] = await Promise.all([
      listDocs([CONTACTS_COLLECTION, owner, PEOPLE_SUBCOLLECTION]),
      listDocs([REQUESTS_COLLECTION, owner, INBOX_SUBCOLLECTION]),
      listDocs([REQUESTS_COLLECTION, owner, OUTBOX_SUBCOLLECTION]),
      listDocs([BLOCKS_COLLECTION, owner, PEOPLE_SUBCOLLECTION]),
    ]);
    const graph = { people: {}, incoming: {}, outgoing: {}, blocked: {} };
    for (const { id, data } of people) if (normalizeContact(data)) graph.people[id] = 'friend';
    for (const { id, data } of blocks) if (normalizeBlock(data)) graph.blocked[id] = true;
    for (const { id, data } of incoming) {
      const request = normalizeRequest(data);
      if (request) graph.incoming[id] = request.state;
    }
    for (const { id, data } of outgoing) {
      const request = normalizeRequest(data);
      if (request) graph.outgoing[id] = request.state;
    }
    return graph;
  }

  async function withGraph(plan) {
    const graph = await snapshot();
    const { ops } = plan({ me: owner, ...graph });
    await apply(ops);
    return snapshot();
  }

  return {
    uid: owner,
    emailVerified: Boolean(emailVerified),
    snapshot,

    sendRequest: (peer) => withGraph((graph) => planSendRequest({ ...graph, peer })),
    accept: (peer) => withGraph((graph) => planAcceptRequest({ ...graph, peer })),
    reject: (peer) => withGraph((graph) => planRejectRequest({ ...graph, peer })),
    cancel: (peer) => withGraph((graph) => planCancelRequest({ ...graph, peer })),
    remove: (peer) => withGraph((graph) => planRemoveContact({ ...graph, peer })),
    block: (peer) => withGraph((graph) => planBlock({ ...graph, peer })),
    unblock: (peer) => withGraph((graph) => planUnblock({ ...graph, peer })),

    /** Publish or withdraw this account's consent to be found by email. */
    async setEmailDiscovery(allow, email) {
      if (allow && !emailVerified) throw fail('permission-denied', 'a verified email is required for discovery');
      if (!allow) {
        const hash = email ? await emailHashHex(email) : '';
        const current = hash ? await readDoc(discoveryPath(hash)) : null;
        if (current && current.uid === owner) await apply([deleteOp(discoveryPath(hash))]);
        return 'off';
      }
      const { ops } = await planEmailDiscovery({ me: owner, allow: true, email });
      await apply(ops);
      return 'on';
    },

    /**
     * Email → uid → the profile's public handle and primary address.
     *
     * A miss is `NO_CONSENT` whether the address has no account or an account
     * that never opted in: one answer for both, because telling them apart is
     * the enumeration oracle this design refuses to be.
     */
    async discoverEmail(email) {
      const now = Date.now();
      if (now - lastLookupAt < DISCOVERY_MIN_INTERVAL_MS) throw fail('TOO_FAST', 'one lookup at a time');
      lastLookupAt = now;
      const hash = await emailHashHex(email);
      const found = await readDoc(discoveryPath(hash));
      if (!found) throw fail('NO_CONSENT', 'no consenting account for that address');
      const foundUid = normalizeUid(found.uid);
      if (!foundUid) throw fail('NO_CONSENT', 'no consenting account for that address');
      const profile = await readDoc(['profiles', foundUid]);
      const profileId = normalizeProfileId(profile?.profileId);
      const primaryAddress = normalizeAddress(profile?.primaryAddress);
      return {
        uid: foundUid,
        profileId: profileId || '',
        primaryAddress: primaryAddress || '',
      };
    },
  };
}
