import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addNotice, buildTransferNotice, groupDigits, isNewTransfer, noticeId, shortAddress,
} from '../lib/transferNotice.js';

const HASH = 'e94ab09e71a2c4f8b3d5e6a7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8a9b';
const SENDER = 'GDAILW75CM6I6OJHOM242PSB2NOHNBONZKOQCBTVSMHJTMYHU77LQB55';
const RECIPIENT = 'GB05VKDDKVXR5CXZT4NPWLRAXFXGBWD3FHSUXK5BK6QQGGJ2GYY24RWN';

const row = (over = {}) => ({
  hash: HASH, ledger: 313951, close_time: 1_763_100_000,
  direction: 'in', kind: 'payment', counterparty: SENDER,
  amount_stroops: '100', fee: 10, success: true, result_code: 'txSUCCESS',
  ...over,
});

// The event stream (`event: tx`) sends `amount_stroops` only; the history
// endpoint also sends `amount`. Both must build the same notice.
test('the recipient is told exactly what arrived and from whom', () => {
  const streamed = buildTransferNotice({
    hash: HASH, ledger: 313951, close_time: 1_763_100_000, direction: 'in',
    counterparty: SENDER, amount_stroops: '100', fee: 10, success: true, result_code: 'txSUCCESS',
  });
  const notice = buildTransferNotice({
    hash: HASH, ledger: 313951, close_time: 1_763_100_000, direction: 'in',
    counterparty: SENDER, amount: '100', fee: 10, success: true, result_code: 'txSUCCESS',
  });
  assert.equal(streamed.title, 'Received 100 NSAT');
  assert.deepEqual(streamed, notice);
  assert.equal(notice.direction, 'in');
  assert.equal(notice.title, 'Received 100 NSAT');
  assert.equal(notice.detail, 'from GDAILW…QB55 · ledger 313951');
  assert.equal(notice.announcement, 'Received 100 NSAT, from GDAILW…QB55.');
  assert.equal(notice.failed, false);
  assert.equal(notice.id, `${HASH}:0`);
});

test('the sender gets the same verdict for their own outgoing row', () => {
  const notice = buildTransferNotice({
    hash: HASH, ledger: 301705, direction: 'out',
    counterparty: RECIPIENT, amount: '10000000000', success: true, result_code: 'txSUCCESS',
  });
  assert.equal(notice.title, 'Sent 10,000,000,000 NSAT');
  assert.equal(notice.detail, 'to GB05VK…4RWN · ledger 301705');
  assert.equal(notice.amount, '10000000000');
});

test('large amounts stay exact digits and never become floating point', () => {
  const huge = '2099999980177749975389216';
  const notice = buildTransferNotice({ hash: HASH, ledger: 1, direction: 'in', counterparty: SENDER, amount: huge });
  assert.equal(notice.amount, huge);
  assert.equal(notice.amountText, '2,099,999,980,177,749,975,389,216 NSAT');
});

test('a failed row is reported as failed, not as a payment', () => {
  const notice = buildTransferNotice({
    hash: HASH, ledger: 12, direction: 'out', counterparty: RECIPIENT,
    amount: '500', success: false, result_code: 'txINSUFFICIENT_FUNDS',
  });
  assert.equal(notice.failed, true);
  assert.equal(notice.title, 'Payment failed (txINSUFFICIENT_FUNDS)');
  assert.match(notice.detail, /only the fee moved$/);
});

test('rows that are not a transfer of ours, or have no verifiable hash, produce nothing', () => {
  assert.equal(buildTransferNotice(null), null);
  assert.equal(buildTransferNotice({ hash: 'nothex', direction: 'in', ledger: 1 }), null);
  assert.equal(buildTransferNotice({ hash: HASH, direction: 'sideways', ledger: 1 }), null);
  assert.equal(buildTransferNotice({ hash: HASH, ledger: 1 }), null);
  assert.equal(noticeId({ hash: HASH.toUpperCase() }), `${HASH}:0`);
  assert.equal(noticeId({ hash: 'zz' }), '');
});

test('a move between your own wallets has no counterparty to name', () => {
  const notice = buildTransferNotice({
    hash: HASH, ledger: 9, direction: 'self', counterparty: SENDER, amount: '7',
  });
  assert.equal(notice.title, 'Moved 7 NSAT between your own wallets');
  assert.equal(notice.detail, 'ledger 9');
  assert.equal(notice.counterparty, null);
});

test('a stream replay of old rows is not announced as news', () => {
  const now = 1_763_100_000_000;
  // Known height wins: at or below it was already on screen.
  assert.equal(isNewTransfer(row({ ledger: 500 }), { baselineLedger: 500 }), false);
  assert.equal(isNewTransfer(row({ ledger: 501 }), { baselineLedger: 500 }), true);
  // No history yet: only rows closed inside the window count.
  assert.equal(isNewTransfer(row({ close_time: 1_763_099_900 }), { startedAt: now }), true);
  assert.equal(isNewTransfer(row({ close_time: 1_763_000_000 }), { startedAt: now }), false);
  // Unusable input never becomes a notification.
  assert.equal(isNewTransfer(row({ ledger: 0 }), { baselineLedger: 0, startedAt: now }), false);
  assert.equal(isNewTransfer(null, { startedAt: now }), false);
  assert.equal(isNewTransfer(row({ close_time: 0 }), { startedAt: 0 }), false);
});

test('the list is newest-first, de-duplicated and bounded', () => {
  const one = buildTransferNotice({ hash: HASH, ledger: 10, direction: 'in', counterparty: SENDER, amount: '1' });
  const two = buildTransferNotice({ hash: 'a'.repeat(64), ledger: 11, direction: 'out', counterparty: RECIPIENT, amount: '2' });
  let list = addNotice([], one);
  list = addNotice(list, two);
  list = addNotice(list, one);
  assert.deepEqual(list.map((notice) => notice.id), [two.id, one.id]);
  for (let i = 0; i < 5; i += 1) {
    list = addNotice(list, buildTransferNotice({
      hash: String(i).padStart(64, 'b'), ledger: 20 + i, direction: 'in', counterparty: SENDER, amount: '1',
    }), { limit: 3 });
  }
  assert.equal(list.length, 3);
});

test('address and amount helpers refuse to invent values', () => {
  assert.equal(shortAddress(SENDER), 'GDAILW…QB55');
  assert.equal(shortAddress(''), 'unknown address');
  assert.equal(shortAddress('short'), 'SHORT');
  assert.equal(groupDigits('1000'), '1,000');
  assert.equal(groupDigits('1.5'), '');
  assert.equal(groupDigits('-3'), '');
  assert.equal(groupDigits(null), '');
});

test('no notice text can carry a secret-shaped string', () => {
  const notice = buildTransferNotice(row());
  const text = `${notice.title} ${notice.detail} ${notice.announcement}`;
  // The only G… strings allowed are the counterparty address the index reported.
  assert.equal((text.match(/S[A-Z2-7]{55}/g) || []).length, 0);
  assert.match(text, /GDAILW…QB55/);
});
