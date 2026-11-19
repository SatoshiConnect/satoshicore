import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MAX_REQUEST_AMOUNT, createPaymentRequestText, parsePaymentRequestText,
} from '../lib/chatPaymentRequest.js';

const FROM = `G${'A'.repeat(55)}`;
const OTHER = `G${'B'.repeat(55)}`;

test('a request carries an exact positive integer and its creator wallet', () => {
  const text = createPaymentRequestText({ amount: '125000000', address: FROM });
  assert.deepEqual(parsePaymentRequestText(text, FROM), {
    kind: 'payment-request', amount: '125000000', address: FROM,
  });
});

test('a request normalizes a valid address and preserves the largest signed NativeAmount128 exactly', () => {
  const amount = MAX_REQUEST_AMOUNT.toString();
  assert.equal(amount, '170141183460469231731687303715884105727');
  const text = createPaymentRequestText({ amount, address: FROM.toLowerCase() });
  assert.deepEqual(parsePaymentRequestText(text, FROM), {
    kind: 'payment-request', amount, address: FROM,
  });
});

test('a request cannot name another wallet than its authenticated sender', () => {
  const text = createPaymentRequestText({ amount: '1', address: OTHER });
  assert.deepEqual(parsePaymentRequestText(text, FROM), {
    kind: 'invalid', reason: 'This request address does not match the verified sender.',
  });
});

test('ordinary chat text is not a payment request', () => {
  assert.equal(parsePaymentRequestText('hello', FROM), null);
  assert.equal(parsePaymentRequestText('', FROM), null);
  assert.equal(parsePaymentRequestText(null, FROM), null);
});

test('malformed or extended request data stays inert', () => {
  const prefix = 'NSAT-PAY-REQUEST/1\n';
  assert.equal(parsePaymentRequestText(`${prefix}{`, FROM).kind, 'invalid');
  assert.equal(parsePaymentRequestText(`${prefix}${JSON.stringify({ amount: '1', address: FROM, memo: 'unexpected' })}`, FROM).kind, 'invalid');
  assert.equal(parsePaymentRequestText(`${prefix}${JSON.stringify({ amount: '01', address: FROM })}`, FROM).kind, 'invalid');
  assert.equal(parsePaymentRequestText(`${prefix}${JSON.stringify({ amount: '0', address: FROM })}`, FROM).kind, 'invalid');
  assert.equal(parsePaymentRequestText(`${prefix}${JSON.stringify({ amount: '1', address: 'not-an-address' })}`, FROM).kind, 'invalid');
});

test('request creation refuses zero, signed, fractional, unsafe or invalid inputs', () => {
  for (const amount of ['0', '-1', '+1', '1.5', '01', '', '1e9', (MAX_REQUEST_AMOUNT + 1n).toString()]) {
    assert.throws(() => createPaymentRequestText({ amount, address: FROM }));
  }
  assert.throws(() => createPaymentRequestText({ amount: '5', address: '' }), /valid wallet address/);
});
