import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPaymentRequestText } from '../lib/chatPaymentRequest.js';
import {
  REQUEST_TTL_MS, REQUEST_WARNING_MS, paymentRequestForCard, paymentRequestFromMessage,
  paymentRequestStatusAt, paymentRequestTiming, requestKeyFor,
} from '../lib/chatPaymentInbox.js';

const OWN = `G${'A'.repeat(55)}`;
const PEER = `G${'B'.repeat(55)}`;
const OTHER = `G${'C'.repeat(55)}`;

const incoming = (overrides = {}) => ({
  id: 'm42',
  from: PEER,
  peer: PEER,
  text: createPaymentRequestText({ amount: '125', address: PEER }),
  at: 1_000,
  receivedAt: 2_000,
  own: false,
  ...overrides,
});

test('a decrypted incoming request becomes a pending obligation at relay receive time', () => {
  const request = paymentRequestFromMessage({ message: incoming(), owner: OWN });
  assert.deepEqual(request, {
    requestKey: 'incoming:42',
    direction: 'incoming',
    peer: PEER,
    to: PEER,
    amount: '125',
    status: 'pending',
    createdAt: 2_000,
    updatedAt: 2_000,
    messageId: '42',
  });
});

test('an outgoing request keeps its local id and is not treated as a request to pay', () => {
  const request = paymentRequestFromMessage({
    owner: OWN,
    message: {
      id: 'r123', from: OWN, peer: PEER, own: true, at: 5_000, receivedAt: 9_000,
      text: createPaymentRequestText({ amount: '9', address: OWN }),
    },
  });
  assert.equal(request.direction, 'outgoing');
  assert.equal(request.requestKey, 'outgoing:r123');
  assert.equal(request.createdAt, 5_000);
  assert.equal(request.to, OWN);
});

test('normal chat and a mismatched requester never enter the inbox', () => {
  assert.equal(paymentRequestFromMessage({ owner: OWN, message: incoming({ text: 'hello' }) }), null);
  const mismatched = createPaymentRequestText({ amount: '1', address: OTHER });
  assert.equal(paymentRequestFromMessage({ owner: OWN, message: incoming({ text: mismatched }) }), null);
});

test('expiry is seven days from creation, with a 48-hour warning window', () => {
  const request = { status: 'pending', createdAt: 1_000 };
  const justBefore = 1_000 + REQUEST_TTL_MS - 1;
  assert.equal(paymentRequestTiming(request, justBefore).expired, false);
  assert.equal(paymentRequestTiming(request, justBefore).warning, true);
  assert.equal(paymentRequestTiming(request, 1_000 + REQUEST_TTL_MS).expired, true);
  assert.equal(paymentRequestTiming(request, 1_000 + REQUEST_TTL_MS - REQUEST_WARNING_MS).warning, true);
  assert.equal(paymentRequestTiming(request, 1_000 + REQUEST_TTL_MS - REQUEST_WARNING_MS - 1).warning, false);
  assert.equal(paymentRequestStatusAt(request, 1_000 + REQUEST_TTL_MS), 'expired');
  assert.equal(paymentRequestStatusAt({ ...request, status: 'paid' }, 1_000 + REQUEST_TTL_MS), 'paid');
});

test('a transaction card settles only the exact payer, payee and amount', () => {
  const requests = [
    { requestKey: 'incoming:1', direction: 'incoming', peer: PEER, amount: '10', status: 'pending', createdAt: 1 },
    { requestKey: 'outgoing:2', direction: 'outgoing', peer: PEER, amount: '20', status: 'pending', createdAt: 2 },
  ];
  const paidIncoming = { kind: 'transaction-card', from: OWN, to: PEER, amount: '10' };
  assert.equal(paymentRequestForCard({ card: paidIncoming, requests, owner: OWN, now: 3 }).requestKey, 'incoming:1');
  assert.equal(paymentRequestForCard({ card: { ...paidIncoming, amount: '11' }, requests, owner: OWN, now: 3 }), null);
  assert.equal(paymentRequestForCard({ card: { ...paidIncoming, from: PEER }, requests, owner: OWN, now: 3 }), null);

  const paidOutgoing = { kind: 'transaction-card', from: PEER, to: OWN, amount: '20' };
  assert.equal(paymentRequestForCard({ card: paidOutgoing, requests, owner: OWN, now: 3 }).requestKey, 'outgoing:2');
  assert.equal(paymentRequestForCard({
    card: paidIncoming,
    requests: [{ ...requests[0], status: 'expired' }],
    owner: OWN,
    now: 10,
  }), null);
});

test('relay ids and thread ids name the same request', () => {
  assert.equal(requestKeyFor('incoming', 42), 'incoming:42');
  assert.equal(requestKeyFor('incoming', 'm42'), 'incoming:42');
  assert.equal(requestKeyFor('outgoing', 'r123'), 'outgoing:r123');
  assert.equal(requestKeyFor('sideways', 'm42'), '');
});