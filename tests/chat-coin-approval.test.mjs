import assert from 'node:assert/strict';
import { test } from 'node:test';

import { prepareChatCoinApproval } from '../lib/chatCoinApproval.js';
import { MAX_REQUEST_AMOUNT } from '../lib/chatPaymentRequest.js';

const FROM = `G${'A'.repeat(55)}`;
const TO = `G${'B'.repeat(55)}`;
const NETWORK = 'NSAT Mainnet ; October 2026 ; bc3098829fffc717';

const validDraft = (overrides = {}) => ({
  from: FROM,
  to: TO,
  amount: '125000000',
  balance: '125,000,010',
  fee: 10,
  network: NETWORK,
  expectedNetwork: NETWORK,
  ...overrides,
});

test('chat approval computes exact amount, fee and total from integer strings', () => {
  assert.deepEqual(prepareChatCoinApproval(validDraft()), {
    ok: true,
    from: FROM,
    to: TO,
    amount: '125000000',
    fee: '10',
    total: '125000010',
    network: NETWORK,
  });
});

test('chat approval rejects invalid, self, zero, fractional and out-of-range drafts', () => {
  for (const overrides of [
    { to: 'invalid' },
    { to: FROM },
    { amount: '0' },
    { amount: '1.25' },
    { amount: (MAX_REQUEST_AMOUNT + 1n).toString(), balance: MAX_REQUEST_AMOUNT.toString() },
  ]) {
    assert.equal(prepareChatCoinApproval(validDraft(overrides)).ok, false);
  }
});

test('chat approval fails closed for mismatched network, unavailable fee/balance, or insufficient total', () => {
  for (const overrides of [
    { network: 'wrong network' },
    { network: null },
    { fee: 0 },
    { fee: Number.MAX_SAFE_INTEGER + 1 },
    { balance: null },
    { balance: '125000009' },
  ]) {
    assert.equal(prepareChatCoinApproval(validDraft(overrides)).ok, false);
  }
});