import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NEXT_PUBLIC_API_SAME_ORIGIN = '1';
const {
  createTransactionCardText, parseTransactionCardText, verifyTransactionCard,
} = await import('../lib/chatTransaction.js');
const { EXPECTED_NETWORK_ID } = await import('../lib/nsatClient.js');

const FROM = `G${'A'.repeat(55)}`;
const TO = `G${'B'.repeat(55)}`;
const HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);
const AMOUNT = '170141183460469231731687303715884105727';

const cardText = () => createTransactionCardText({ hash: HASH, amount: AMOUNT, from: FROM, to: TO });
const card = () => parseTransactionCardText(cardText(), FROM);
const transaction = (overrides = {}) => ({
  hash: HASH,
  ledger: 420,
  close_time: 1_800_000_000,
  source: FROM,
  fee: 10,
  memo_type: null,
  memo: null,
  success: true,
  result_code: 'txSUCCESS',
  ops: [{
    idx: 0, kind: 'payment', source: FROM, destination: TO,
    amount_stroops: AMOUNT, asset: 'native',
  }],
  ...overrides,
});
const goodNetwork = async () => ({ ok: true, network: EXPECTED_NETWORK_ID });
const verifyCard = (options = {}) => verifyTransactionCard(card(), {
  verifyNetwork: goodNetwork,
  readConfirmation: async (hash) => ({ hash, status: 'confirmed', ledger: 420, result_code: 'txSUCCESS' }),
  readDetail: async () => transaction(),
  ...options,
});

test('a transaction card contains only a hash, exact amount and destination', () => {
  const text = cardText();
  assert.match(text, /^NSAT-TX\/1\n/);
  assert.deepEqual(card(), { kind: 'transaction-card', hash: HASH, amount: AMOUNT, from: FROM, to: TO });
});

test('a sender cannot set its own identity or inject a status', () => {
  const prefix = 'NSAT-TX/1\n';
  const extra = `${prefix}${JSON.stringify({ hash: HASH, amount: '1', from: FROM, to: TO, status: 'confirmed' })}`;
  assert.equal(parseTransactionCardText(extra, FROM).kind, 'invalid');
  const noSenderField = `${prefix}${JSON.stringify({ hash: HASH, amount: '1', to: FROM })}`;
  assert.deepEqual(parseTransactionCardText(noSenderField, TO), {
    kind: 'transaction-card', hash: HASH, amount: '1', from: TO, to: FROM,
  }, 'the envelope signer supplies `from`; the payload has no sender field');
});

test('a malformed, non-native, mismatched or out-of-range card remains inert', () => {
  const prefix = 'NSAT-TX/1\n';
  assert.equal(parseTransactionCardText(`${prefix}{`, FROM).kind, 'invalid');
  assert.equal(parseTransactionCardText('hello', FROM), null);
  for (const body of [
    { hash: 'nope', amount: '1', to: TO },
    { hash: HASH, amount: '0', to: TO },
    { hash: HASH, amount: '01', to: TO },
    { hash: HASH, amount: '170141183460469231731687303715884105728', to: TO },
    { hash: HASH, amount: '1.0', to: TO },
    { hash: HASH, amount: '1', to: FROM },
  ]) {
    assert.equal(parseTransactionCardText(`${prefix}${JSON.stringify(body)}`, FROM).kind, 'invalid');
  }
  assert.throws(() => createTransactionCardText({ hash: HASH, amount: '1', from: FROM, to: FROM }));
});

test('only the exact matching hash, amount, parties and native payment finalizes', async () => {
  const calls = [];
  const verified = await verifyCard({
    readDetail: async (hash) => { calls.push(hash); return transaction(); },
  });
  assert.deepEqual(calls, [HASH]);
  assert.deepEqual(verified, {
    status: 'finalized', hash: HASH, amount: AMOUNT, from: FROM, to: TO,
    ledger: 420, closeTime: 1_800_000_000, network: EXPECTED_NETWORK_ID,
  });
});

test('a matching closed-ledger failure is failed, never finalized', async () => {
  const failed = await verifyCard({
    readConfirmation: async (hash) => ({ hash, status: 'failed', ledger: 420, result_code: 'txFAILED' }),
    readDetail: async () => transaction({ success: false, result_code: 'txFAILED' }),
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.resultCode, 'txFAILED');
});

test('a wallet-reported word does not make an unknown hash finalized', async () => {
  const unknown = await verifyCard({
    readConfirmation: async (hash) => ({ hash, status: 'unknown', reason: 'index_gap' }),
  });
  assert.deepEqual(unknown, { status: 'unknown', reason: 'index_gap' });
});

test('a pending exact hash stays pending until its closed-ledger verdict arrives', async () => {
  const pending = await verifyCard({
    readConfirmation: async (hash) => ({ hash, status: 'pending', reason: 'not_yet_observed' }),
    readDetail: async () => { throw new Error('must not ask detail before confirmation'); },
  });
  assert.deepEqual(pending, { status: 'pending', hash: HASH });
});

test('the message time reaches the indexer only as an exact-hash freshness hint', async () => {
  let seen = null;
  const result = await verifyCard({
    submittedAt: 1_800_000_000,
    readConfirmation: async (...args) => {
      seen = args;
      return { hash: HASH, status: 'confirmed', ledger: 420, result_code: 'txSUCCESS' };
    },
  });
  assert.deepEqual(seen, [HASH, 1_800_000_000]);
  assert.equal(result.status, 'finalized');

  let invalidHint = 'unset';
  await verifyCard({
    submittedAt: Number.NaN,
    readConfirmation: async (hash, hint) => {
      invalidHint = hint;
      return { hash, status: 'pending' };
    },
    readDetail: async () => transaction(),
  });
  assert.equal(invalidHint, null, 'a malformed clock value is never sent');
});

test('wrong network, hash, party, amount, operation kind, or asset all fail closed', async () => {
  const wrongNetwork = await verifyCard({
    verifyNetwork: async () => ({ ok: true, network: 'some other network' }),
  });
  assert.deepEqual(wrongNetwork, { status: 'unknown', reason: 'network_unverified' });

  for (const bad of [
    transaction({ hash: OTHER_HASH }),
    transaction({ ops: [{ ...transaction().ops[0], destination: FROM }] }),
    transaction({ ops: [{ ...transaction().ops[0], amount_stroops: '2' }] }),
    transaction({ ops: [{ ...transaction().ops[0], kind: 'create_account' }] }),
    transaction({ ops: [{ ...transaction().ops[0], asset: 'credit:ABC' }] }),
    transaction({ success: true, result_code: 'txFAILED' }),
    transaction({ success: false, result_code: 'txSUCCESS' }),
    transaction({ ledger: 0 }),
    transaction({ ops: [] }),
  ]) {
    const result = await verifyCard({ readDetail: async () => bad });
    assert.equal(result.status, 'unknown');
  }
});
