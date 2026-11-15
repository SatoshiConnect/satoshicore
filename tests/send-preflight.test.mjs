// Acceptance tests for lib/nsatSendPreflight.js — the shared send gate
// (reason strings identical to the Desktop/prototype contract).
// Run: node --test tests/send-preflight.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanAmount, validateAmount, validateRecipient, maxSendable, sendPreflight, fmtGroup,
} from '../lib/nsatSendPreflight.js';

const OWN = 'G' + 'NSAT2'.repeat(11);
const OTHER = 'G' + 'SATOS'.repeat(11);
const FEE = 10;

test('amounts: exact integers only, grouping normalized', () => {
  assert.equal(validateAmount('1,000').value, 1000n);
  assert.equal(validateAmount('1.5').reason, 'NSAT has no decimals — exact integers only.');
  assert.equal(validateAmount('').reason, 'Enter an amount — exact integers only.');
});

test('recipients: strkey shape + self-send refusal', () => {
  assert.ok(validateRecipient(OTHER, OWN).ok);
  assert.equal(validateRecipient('G123', OWN).ok, false);
  assert.equal(validateRecipient(OWN, OWN).reason, 'Recipient is your own address.');
});

test('maxSendable: balance − fee (BigInt), floor 0', () => {
  assert.equal(maxSendable('100', FEE), 90n);
  assert.equal(maxSendable('5', FEE), 0n);
  assert.equal(maxSendable('1'.repeat(20), FEE), BigInt('1'.repeat(20)) - 10n);
});

const state = (over = {}) => ({
  active: { name: 'Personal', pubkey: OWN },
  netOk: true,
  dest: OTHER, amount: '100', balance: '1000', fee: FEE,
  createDest: false, baseReserve: 5000000, ...over,
});

test('preflight order and reasons match the shared contract', () => {
  assert.equal(sendPreflight(state({ active: null })).block.reason, 'Unlock the wallet to send.');
  assert.match(sendPreflight(state({ netOk: false })).block.reason, /Network identity not verified/);
  assert.match(sendPreflight(state({ dest: 'G_SHORT' })).block.reason, /Address format is invalid/);
  assert.match(sendPreflight(state({ amount: '2.5' })).block.reason, /no decimals/);
  const ins = sendPreflight(state({ amount: '991' }));
  assert.match(ins.block.reason, /Insufficient balance — 1,000 NSAT available; amount \+ fee = 1,001 exceeds it\. Use Max\?/);
  // exact amount+fee == balance is sendable
  assert.equal(sendPreflight(state({ amount: '990' })).ok, true);
  assert.equal(sendPreflight(state()).ok, true);
});

test('CREATE below 2×reserve warns with the exact total and still allows review', () => {
  const r = sendPreflight(state({ createDest: true, amount: '999' }));
  assert.equal(r.block, null);
  assert.match(r.warn.reason, /10,000,000 NSAT \(2× base reserve\)/);
  assert.equal(sendPreflight(state({ createDest: true, amount: '10000000' })).warn, null);
});

test('formatting: grouping on the string', () => {
  assert.equal(fmtGroup('2100000000000000000000000'), '2,100,000,000,000,000,000,000,000');
});
