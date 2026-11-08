import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForConfirmation } from '../lib/confirmationPoller.mjs';
import { readFileSync } from 'node:fs';
const hash = 'a'.repeat(64);

test('waits for the exact hash and preserves a failed ledger verdict', async () => {
  const verdicts = [
    { status: 'pending' },
    { status: 'confirmed', ledger: 18, result_code: 'txSUCCESS' },
  ];
  const requested = [];
  const result = await waitForConfirmation(async (...args) => {
    requested.push(args);
    return verdicts.shift();
  }, hash, { submittedAt: 123 });
  assert.equal(result.status, 'confirmed');
  assert.deepEqual(requested, [[hash, 123], [hash, 123]]);

  const failed = await waitForConfirmation(async () => ({
    status: 'failed', ledger: 19, result_code: 'txFAILED',
  }), hash);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.result_code, 'txFAILED');
});

test('stops after a caught-up index says the exact hash is absent', async () => {
  let attempts = 0;
  const result = await waitForConfirmation(async () => {
    attempts += 1;
    return { status: 'not_found' };
  }, hash);
  assert.equal(result.status, 'not_found');
  assert.equal(attempts, 1);
});

test('wallet send does not infer a ledger result from sequence or balance changes', () => {
  const source = readFileSync('components/WalletPanel.js', 'utf8');
  const start = source.indexOf('async function submitSend()');
  const end = source.indexOf('\n  function openReview()', start);
  assert.ok(start >= 0 && end > start, 'send function was not found');
  const submitSend = source.slice(start, end);
  assert.match(submitSend, /waitForConfirmation\(signed\.txHashHex/);
  assert.doesNotMatch(submitSend, /waitSeqReached|prevBalance|afterBal/);
});
