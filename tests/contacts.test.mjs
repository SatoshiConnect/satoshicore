// Contacts are the first messenger feature that writes to the database, so they
// are pinned the way the profile and the wallet links are: an exact document
// shape, a planned set of writes (not an ad-hoc payload), a server-side block
// check, and a discovery lookup that stores a hash instead of an address.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONTACT_LIMIT,
  DISCOVERY_COLLECTION,
  DISCOVERY_MIN_INTERVAL_MS,
  blockDocument,
  blockPath,
  classifyTarget,
  contactDocument,
  contactPath,
  contactStateFor,
  createFirestoreContactsStore,
  describeContactFailure,
  discoveryDocument,
  discoveryPath,
  emailHashHex,
  inboxPath,
  normalizeBlock,
  normalizeContact,
  normalizeEmail,
  normalizeRequest,
  normalizeUid,
  outboxPath,
  planAcceptRequest,
  planBlock,
  planCancelRequest,
  planEmailDiscovery,
  planRejectRequest,
  planRemoveContact,
  planSendRequest,
  planUnblock,
  requestDocument,
} from '../lib/contacts.js';

const RULES = readFileSync(join(process.cwd(), 'firestore.rules'), 'utf8');
const MODULE = readFileSync(join(process.cwd(), 'lib', 'contacts.js'), 'utf8');

const ADDRESS = `G${'A'.repeat(55)}`;
const A = 'uid-aaa';
const B = 'uid-bbb';
const NOW = 1_800_000_000_000;

// ---------------- the search field ----------------

test('one search field recognises an email, a handle and a wallet address', () => {
  assert.deepEqual(classifyTarget('  Somchai@Example.com '), { kind: 'email', value: 'somchai@example.com' });
  assert.deepEqual(classifyTarget('@Somchai'), { kind: 'handle', value: '@somchai' });
  assert.deepEqual(classifyTarget(` ${ADDRESS} `), { kind: 'address', value: ADDRESS });

  // @ is a handle prefix, not an email local part.
  assert.match(classifyTarget('@').error, /lowercase/);
  assert.match(classifyTarget('not-an-address').error, /56 characters/);
  assert.match(classifyTarget('name@').error, /email/);
  assert.match(classifyTarget('name@host').error, /email/);
  assert.match(classifyTarget('').error, /Enter/);
  assert.match(classifyTarget(null).error, /Enter/);
});

test('an email is normalised before it is hashed, and the hash is deterministic', async () => {
  assert.equal(normalizeEmail('  Somchai@Example.COM '), 'somchai@example.com');
  for (const bad of ['', 'name@', '@host.com', 'a b@host.com', 'x'.repeat(250) + '@host.com', null, 42]) {
    assert.equal(normalizeEmail(bad), null, `${String(bad)} must be rejected`);
  }
  // Pinned vectors: the same address typed with different case and spacing lands
  // on one document, and this build must never silently change the derivation.
  assert.equal(await emailHashHex('somchai@example.com'),
    '1c8d95ac71b24ddb6c7492a06b25f00d999a75d68da10f17c707b9f423703e6b');
  // Case and surrounding space fold before hashing, so this is sha256("a@example.com").
  assert.equal(await emailHashHex('  A@Example.com '),
    '08168cd80dfd534ab0f10af10f1303fe00af2d43ab5c1432360d137f8197e17a');
  await assert.rejects(() => emailHashHex('nope'), /full email address/);
  await assert.rejects(() => emailHashHex('a@b.co', { subtle: null }), /Web Crypto/);
});

test('a discovery document holds the uid and nothing that identifies the person', () => {
  assert.deepEqual(discoveryDocument({ uid: B }), { uid: B });
  assert.deepEqual(Object.keys(discoveryDocument({ uid: B })), ['uid']);
  assert.throws(() => discoveryDocument({ uid: '' }), /signed-in account/);
  assert.throws(() => discoveryDocument({ uid: 'has space' }), /signed-in account/);
  assert.equal(normalizeUid(' uid-1 '), 'uid-1');
  assert.equal(normalizeUid('a/b'), null);
  // The module never puts an address or a wallet into the discovery payload.
  assert.doesNotMatch(MODULE, /discoveryDocument\([^)]*email/i);
});

// ---------------- document shapes ----------------

test('each document has one exact shape, and anything else is dropped on read', () => {
  assert.deepEqual(contactDocument({ since: NOW }), { state: 'friend', since: NOW });
  assert.deepEqual(requestDocument({ state: 'pending', at: NOW }), { state: 'pending', at: NOW });
  assert.deepEqual(blockDocument({ at: NOW }), { at: NOW });
  for (const doc of [contactDocument({ since: NOW }), requestDocument({ at: NOW }), blockDocument({ at: NOW })]) {
    assert.ok(!/seed|password|email|wallet|message/i.test(JSON.stringify(doc)));
  }
  assert.throws(() => requestDocument({ state: 'maybe', at: NOW }), /pending, accepted or rejected/);
  assert.throws(() => contactDocument({ since: 0 }), /timestamp/);

  assert.deepEqual(normalizeContact({ state: 'friend', since: NOW }), { state: 'friend', since: NOW });
  assert.equal(normalizeContact({ state: 'pending', since: NOW }), null);
  assert.deepEqual(normalizeContact({ state: 'friend', since: NOW, extra: 'x' }),
    { state: 'friend', since: NOW }, 'unknown fields are dropped, never carried back');
  assert.equal(normalizeContact({ state: 'friend' }), null);
  assert.deepEqual(normalizeRequest({ state: 'rejected', at: NOW }), { state: 'rejected', at: NOW });
  assert.equal(normalizeRequest({ state: 'friend', at: NOW }), null);
  assert.deepEqual(normalizeBlock({ at: NOW }), { at: NOW });
  assert.equal(normalizeBlock({}), null);
  for (const bad of [null, 'x', [], 7]) {
    assert.equal(normalizeContact(bad), null);
    assert.equal(normalizeRequest(bad), null);
    assert.equal(normalizeBlock(bad), null);
  }
});

// ---------------- what the screen shows ----------------

test('a block wins over a friendship, and pending directions are separate', () => {
  const base = { me: A, peer: B };
  assert.equal(contactStateFor({ ...base }), 'none');
  assert.equal(contactStateFor({ ...base, peer: A }), 'self');
  assert.equal(contactStateFor({ ...base, outgoing: { [B]: 'pending' } }), 'pending_out');
  assert.equal(contactStateFor({ ...base, incoming: { [B]: 'pending' } }), 'pending_in');
  assert.equal(contactStateFor({ ...base, people: { [B]: 'friend' }, outgoing: { [B]: 'pending' } }), 'friend');
  assert.equal(contactStateFor({
    ...base, people: { [B]: 'friend' }, blocked: { [B]: true },
  }), 'blocked', 'a block is shown even while the old friendship document exists');
  assert.equal(contactStateFor({ ...base, outgoing: { [B]: 'rejected' } }), 'rejected_out');
  assert.equal(contactStateFor({ ...base, incoming: { [B]: 'rejected' } }), 'rejected_in');
});

// ---------------- plans ----------------

test('a request is two documents with the same pending state, and duplicates are refused', () => {
  const plan = planSendRequest({ me: A, peer: B, now: NOW });
  assert.equal(plan.state, 'pending_out');
  assert.deepEqual(plan.ops, [
    { type: 'set', path: inboxPath(B, A), data: { state: 'pending', at: NOW } },
    { type: 'set', path: outboxPath(A, B), data: { state: 'pending', at: NOW } },
  ]);

  assert.throws(() => planSendRequest({ me: A, peer: A }), (error) => error.code === 'SELF');
  assert.throws(() => planSendRequest({ me: '', peer: B }), (error) => error.code === 'INVALID_ME');
  assert.throws(() => planSendRequest({ me: A, peer: 'not a uid' }), (error) => error.code === 'INVALID_PEER');
  assert.throws(() => planSendRequest({ me: A, peer: B, people: { [B]: 'friend' } }),
    (error) => error.code === 'ALREADY_FRIEND');
  assert.throws(() => planSendRequest({ me: A, peer: B, outgoing: { [B]: 'pending' } }),
    (error) => error.code === 'DUPLICATE');
  // They asked first: the screen must offer Accept, not a second request.
  assert.throws(() => planSendRequest({ me: A, peer: B, incoming: { [B]: 'pending' } }),
    (error) => error.code === 'INCOMING_PENDING');
});

test('the contact list has a hard cap', () => {
  const people = {};
  for (let i = 0; i < CONTACT_LIMIT; i += 1) people[`uid-${i}`] = 'friend';
  assert.throws(() => planSendRequest({ me: A, peer: B, people }), (error) => error.code === 'LIMIT');
});

test('accepting writes both halves of the friendship and closes the request', () => {
  const plan = planAcceptRequest({ me: B, peer: A, incoming: { [A]: 'pending' }, now: NOW });
  assert.equal(plan.state, 'friend');
  assert.deepEqual(plan.ops, [
    { type: 'set', path: inboxPath(B, A), data: { state: 'accepted', at: NOW } },
    { type: 'set', path: outboxPath(A, B), data: { state: 'accepted', at: NOW } },
    { type: 'set', path: contactPath(B, A), data: { state: 'friend', since: NOW } },
    { type: 'set', path: contactPath(A, B), data: { state: 'friend', since: NOW } },
  ]);
  assert.throws(() => planAcceptRequest({ me: B, peer: A }), (error) => error.code === 'NOT_PENDING');
  assert.throws(() => planAcceptRequest({ me: B, peer: A, incoming: { [A]: 'accepted' } }),
    (error) => error.code === 'NOT_PENDING');
});

test('refusing and withdrawing change only what is mine to change', () => {
  const refused = planRejectRequest({ me: B, peer: A, incoming: { [A]: 'pending' }, now: NOW });
  assert.deepEqual(refused.ops, [
    { type: 'set', path: inboxPath(B, A), data: { state: 'rejected', at: NOW } },
    { type: 'set', path: outboxPath(A, B), data: { state: 'rejected', at: NOW } },
  ]);

  const cancelled = planCancelRequest({ me: A, peer: B, outgoing: { [B]: 'pending' } });
  assert.deepEqual(cancelled.ops, [
    { type: 'delete', path: inboxPath(B, A) },
    { type: 'delete', path: outboxPath(A, B) },
  ]);
  assert.throws(() => planCancelRequest({ me: A, peer: B }), (error) => error.code === 'NOT_PENDING');

  const removed = planRemoveContact({ me: A, peer: B, people: { [B]: 'friend' } });
  assert.deepEqual(removed.ops, [{ type: 'delete', path: contactPath(A, B) }],
    'removal is one-sided: their document is not written');
  assert.throws(() => planRemoveContact({ me: A, peer: B }), (error) => error.code === 'NOT_FRIEND');
});

test('blocking clears my side of the relationship and answers a pending request', () => {
  const plan = planBlock({
    me: A, peer: B, people: { [B]: 'friend' }, outgoing: { [B]: 'pending' },
    incoming: { [B]: 'pending' }, now: NOW,
  });
  assert.equal(plan.state, 'blocked');
  assert.deepEqual(plan.ops, [
    { type: 'set', path: blockPath(A, B), data: { at: NOW } },
    { type: 'delete', path: contactPath(A, B) },
    { type: 'delete', path: inboxPath(B, A) },
    { type: 'delete', path: outboxPath(A, B) },
    { type: 'set', path: inboxPath(A, B), data: { state: 'rejected', at: NOW } },
    { type: 'set', path: outboxPath(B, A), data: { state: 'rejected', at: NOW } },
  ]);

  // Blocking twice is a no-op rather than a second write.
  assert.deepEqual(planBlock({ me: A, peer: B, blocked: { [B]: true } }).ops, []);
  assert.throws(() => planBlock({ me: A, peer: A }), (error) => error.code === 'SELF');

  assert.deepEqual(planUnblock({ me: A, peer: B, blocked: { [B]: true } }).ops,
    [{ type: 'delete', path: blockPath(A, B) }]);
  assert.throws(() => planUnblock({ me: A, peer: B }), (error) => error.code === 'NOT_BLOCKED');
});

test('discovery is opt-in, and turning it off removes the published hash', async () => {
  const on = await planEmailDiscovery({ me: A, allow: true, email: 'somchai@example.com' });
  assert.equal(on.state, 'on');
  assert.deepEqual(on.ops, [{
    type: 'set',
    path: discoveryPath('1c8d95ac71b24ddb6c7492a06b25f00d999a75d68da10f17c707b9f423703e6b'),
    data: { uid: A },
  }]);
  assert.deepEqual(await planEmailDiscovery({ me: A, allow: false }), { state: 'off', ops: [] });
  await assert.rejects(() => planEmailDiscovery({ me: '', allow: true, email: 'a@b.co' }), /sign in/);
  await assert.rejects(
    () => planEmailDiscovery({ me: A, allow: true, email: 'a@b.co', hashEmail: async () => 'not-a-hash' }),
    /SHA-256/,
  );
});

test('every refusal has words a person can act on', () => {
  for (const code of ['SELF', 'ALREADY_FRIEND', 'DUPLICATE', 'INCOMING_PENDING', 'NOT_PENDING',
    'NOT_FRIEND', 'NOT_BLOCKED', 'TOO_FAST', 'NO_CONSENT']) {
    const described = describeContactFailure(Object.assign(new Error('x'), { code }));
    assert.ok(described.title.length > 0 && described.message.length > 0, `${code} needs a title and a message`);
  }
  assert.match(describeContactFailure(Object.assign(new Error('x'), { code: 'INCOMING_PENDING' })).message,
    /Accept/);
  assert.match(describeContactFailure(Object.assign(new Error('x'), { code: 'NO_CONSENT' })).message,
    /discovery turned on/);
  assert.match(describeContactFailure({ code: 'permission-denied' }).message, /verified email/);
  assert.match(describeContactFailure({ code: 'unavailable' }).message, /Nothing was written/);
  assert.match(describeContactFailure(new Error('did not complete')).message, /Reload/);
});

// ---------------- store over a fake Firestore ----------------

function fakeFirestore(seed = {}) {
  const store = new Map(Object.entries(seed));
  const key = (path) => path.join('/');
  const snapshotOf = (data) => ({ exists: () => data !== undefined, data: () => data });
  const sdk = {
    store,
    writes: [],
    // Set by a test to simulate a denied/failed atomic commit.
    failNextCommit: false,
    db: {},
    doc: (_db, ...path) => ({ path }),
    getDoc: async (ref) => snapshotOf(store.get(key(ref.path))),
    setDoc: async (ref, data) => {
      store.set(key(ref.path), JSON.parse(JSON.stringify(data)));
    },
    deleteDoc: async (ref) => { store.delete(key(ref.path)); },
    collection: (_db, ...path) => ({ path }),
    getDocs: async (ref) => {
      const prefix = `${key(ref.path)}/`;
      const docs = [...store.entries()]
        .filter(([entry]) => entry.startsWith(prefix) && !entry.slice(prefix.length).includes('/'))
        .map(([entry, data]) => ({ id: entry.slice(prefix.length), data: () => data }));
      return { forEach: (fn) => docs.forEach(fn), size: docs.length };
    },
  };
  // Mirrors Firestore's WriteBatch: nothing is written until commit() and a
  // rejected commit leaves the store exactly as it was.
  sdk.writeBatch = () => {
    const ops = [];
    return {
      set: (ref, data) => { ops.push(['set', ref, data]); },
      delete: (ref) => { ops.push(['delete', ref]); },
      commit: async () => {
        if (sdk.failNextCommit) {
          sdk.failNextCommit = false;
          throw new Error('commit failed');
        }
        for (const [type, ref, data] of ops) {
          if (type === 'set') store.set(key(ref.path), JSON.parse(JSON.stringify(data)));
          else store.delete(key(ref.path));
        }
        sdk.writes.push(...ops);
      },
    };
  };
  return sdk;
}

test('two accounts complete a request through the store and see the same friendship', async () => {
  const sdk = fakeFirestore();
  const send = createFirestoreContactsStore(A, { sdk, emailVerified: true });
  const receive = createFirestoreContactsStore(B, { sdk, emailVerified: true });

  let graph = await send.sendRequest(B);
  assert.deepEqual(graph.outgoing, { [B]: 'pending' });

  graph = await receive.snapshot();
  assert.deepEqual(graph.incoming, { [A]: 'pending' });
  assert.equal(contactStateFor({ me: B, peer: A, ...graph }), 'pending_in');

  graph = await receive.accept(A);
  assert.deepEqual(graph.people, { [A]: 'friend' });
  assert.deepEqual(graph.incoming, { [A]: 'accepted' });

  graph = await send.snapshot();
  assert.deepEqual(graph.people, { [B]: 'friend' });
  assert.deepEqual(graph.outgoing, { [B]: 'accepted' });

  // Nothing about a wallet, an email or a message reached the database.
  for (const value of sdk.store.values()) {
    assert.ok(!/seed|password|@example\.com|NSAT-PAY|G[A-Z2-7]{55}/.test(JSON.stringify(value)));
  }
});

// A half-applied friendship is a real failure mode: the inbox says accepted
// while the peer's outbox still says pending. One batch removes it.
test('a failed contact commit leaves no half-accepted friendship, and a retry completes it', async () => {
  const sdk = fakeFirestore();
  const send = createFirestoreContactsStore(A, { sdk, emailVerified: true });
  const receive = createFirestoreContactsStore(B, { sdk, emailVerified: true });
  await send.sendRequest(B);

  sdk.failNextCommit = true;
  await assert.rejects(() => receive.accept(A), /commit failed|did not complete/);

  const afterFailure = await receive.snapshot();
  assert.deepEqual(afterFailure.people, {}, 'no friendship document may survive a failed commit');
  assert.deepEqual(afterFailure.incoming, { [A]: 'pending' }, 'the request stays pending');
  assert.deepEqual((await send.snapshot()).outgoing, { [B]: 'pending' });

  const accepted = await receive.accept(A);
  assert.deepEqual(accepted.people, { [A]: 'friend' });
  assert.deepEqual(accepted.incoming, { [A]: 'accepted' });
  assert.deepEqual((await send.snapshot()).outgoing, { [B]: 'accepted' });
});

test('blocking through the store hides the contact and rejects the pending request', async () => {
  const sdk = fakeFirestore();
  const a = createFirestoreContactsStore(A, { sdk });
  const b = createFirestoreContactsStore(B, { sdk });

  await a.sendRequest(B);
  await b.accept(A);
  assert.deepEqual((await a.snapshot()).people, { [B]: 'friend' });

  const graph = await b.block(A);
  assert.deepEqual(graph.blocked, { [A]: true });
  assert.deepEqual(graph.people, {}, 'my half of the friendship is gone');
  // A block is not broadcast: the other side keeps its own copy of the contact
  // and is not told. Only the blocked account's own screen stops showing them.
  const aGraph = await a.snapshot();
  assert.deepEqual(aGraph.people, { [B]: 'friend' });
  assert.equal(contactStateFor({ me: A, peer: B, ...aGraph }), 'friend');

  // Refusals come back as codes the screen can explain.
  await assert.rejects(() => b.remove(A), (error) => error.code === 'NOT_FRIEND');
  await assert.rejects(() => a.remove('uid-zzz'), (error) => error.code === 'NOT_FRIEND');

  const cleared = await b.unblock(A);
  assert.deepEqual(cleared.blocked, {});
});

test('email discovery returns a profile, refuses a repeated lookup, and needs consent', async () => {
  const hash = await emailHashHex('somchai@example.com');
  const sdk = fakeFirestore({
    [`${DISCOVERY_COLLECTION}/${hash}`]: { uid: B },
    [`profiles/${B}`]: { profileId: '@bob', primaryAddress: ADDRESS },
  });
  const store = createFirestoreContactsStore(A, { sdk, emailVerified: true });

  const found = await store.discoverEmail('Somchai@Example.com');
  assert.deepEqual(found, { uid: B, profileId: '@bob', primaryAddress: ADDRESS, displayName: '' });
  await assert.rejects(() => store.discoverEmail('other@example.com'), (error) => error.code === 'TOO_FAST');

  const missing = createFirestoreContactsStore(A, { sdk });
  await assert.rejects(() => missing.discoverEmail('nobody@example.com'),
    (error) => error.code === 'NO_CONSENT');
  assert.ok(DISCOVERY_MIN_INTERVAL_MS >= 1000);

  // Publishing needs a verified address; withdrawing deletes only my document.
  const unverified = createFirestoreContactsStore(A, { sdk, emailVerified: false });
  await assert.rejects(() => unverified.setEmailDiscovery(true, 'somchai@example.com'),
    (error) => error.code === 'permission-denied');

  assert.equal(await store.setEmailDiscovery(true, 'a@b.co'), 'on');
  assert.ok(sdk.store.has(`${DISCOVERY_COLLECTION}/${await emailHashHex('a@b.co')}`));
  assert.equal(await store.setEmailDiscovery(false, 'a@b.co'), 'off');
  assert.ok(!sdk.store.has(`${DISCOVERY_COLLECTION}/${await emailHashHex('a@b.co')}`));
  assert.ok(sdk.store.has(`${DISCOVERY_COLLECTION}/${hash}`), 'someone else\'s consent is untouched');
});

test('the store refuses a missing SDK and bounds every call', () => {
  assert.throws(() => createFirestoreContactsStore('', {}), /signed-in account/);
  assert.throws(() => createFirestoreContactsStore(A, {}), /Firestore SDK/);
  assert.throws(
    () => createFirestoreContactsStore(A, { sdk: { doc: () => {}, getDoc: () => {} } }),
    /writeBatch/,
    'an SDK without batches must be refused, not silently written sequentially',
  );
  for (const call of ['sdk.getDoc(', 'sdk.getDocs(', 'batch.commit(']) {
    assert.ok(MODULE.includes(`withTimeout(${call}`), `${call} must be bounded by the deadline`);
  }
  assert.ok(MODULE.includes('sdk.writeBatch('), 'contact writes must be atomic');
});

// ---------------- the rules ----------------

test('the rules gate the contact graph, the requests and the blocks', () => {
  assert.match(RULES, /match \/contacts\/\{owner\}\/people\/\{peer\}/);
  assert.match(RULES, /match \/requests\/\{owner\}\/inbox\/\{from\}/);
  assert.match(RULES, /match \/requests\/\{owner\}\/outbox\/\{to\}/);
  assert.match(RULES, /match \/blocks\/\{owner\}\/people\/\{peer\}/);
  assert.match(RULES, /match \/discoveryEmails\/\{emailHash\}/);

  // Shapes: no extra field can ride along.
  assert.match(RULES, /hasOnly\(\['state', 'since'\]\)/);
  assert.match(RULES, /hasOnly\(\['state', 'at'\]\)/);
  assert.match(RULES, /hasOnly\(\['at'\]\)/);
  assert.match(RULES, /hasOnly\(\['uid'\]\)/);

  // A friendship document needs an accepted request behind it.
  assert.match(RULES, /requestIsAccepted\(owner, peer\)/);
  assert.match(RULES, /requestIsAccepted\(peer, owner\)/);
  assert.match(RULES, /data\.state == 'accepted'/);

  // The client now commits the answer and the contact in one batch, so the
  // rule must inspect the post-batch state. get() would still see "pending".
  const acceptedRule = RULES.slice(
    RULES.indexOf('function requestIsAccepted'),
    RULES.indexOf('function hasBlocked'),
  );
  assert.match(acceptedRule, /existsAfter\(/, 'a batched accept needs existsAfter()');
  assert.match(acceptedRule, /getAfter\(/, 'a batched accept needs getAfter()');
  assert.doesNotMatch(acceptedRule, /\bget\(/, 'get() cannot see the other write in the batch');

  // A blocked sender cannot create a request; that is the server-side half of
  // blocking, which the client alone cannot provide.
  assert.match(RULES, /!hasBlocked\(owner, from\)/);
  assert.match(RULES, /documents\/blocks\/\$\(owner\)\/people\/\$\(peer\)/);

  // A handle lookup exists, but who opted into email discovery cannot be listed.
  assert.match(RULES, /match \/discoveryEmails\/\{emailHash\}[\s\S]*?allow list: if false/);
  assert.match(RULES, /emailHash\.matches\('\^\[a-f0-9\]\{64\}\$'\)/);

  // The fallback is still closed, and nothing is simply allowed.
  assert.match(RULES, /match \/\{document=\*\*\}/);
  assert.match(RULES, /allow read, write: if false;/);
  assert.doesNotMatch(RULES, /allow (read|write)(, (read|write))?: if true/);
});

test('the contacts module holds no key material and cannot reach a signing path', () => {
  for (const needle of ['nsatWallet', 'nsatCodec', 'submitSend', 'buildSignedTx',
    'keystoreUnlock', 'seed32', 'chatClient', 'signTransaction']) {
    assert.ok(!MODULE.includes(needle), `the contacts module must not reference ${needle}`);
  }
  // The plaintext address is hashed, never written.
  assert.ok(!/setDoc\([^)]*email:/.test(MODULE));
  assert.ok(!/email\s*:\s*(email|text|normalized)/.test(MODULE));
  assert.ok(!MODULE.includes('localStorage'), 'contacts are server state, not device state');
});
