import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BALANCE_REFRESH_MS, startBalanceRefresh,
} from '../lib/walletBalanceRefresh.mjs';

test('active wallet balance is refreshed every 10 seconds and polling stops on cleanup', () => {
  let tick;
  let cleared;
  const calls = [];
  const timers = {
    setInterval(callback, delay) {
      assert.equal(delay, BALANCE_REFRESH_MS);
      tick = callback;
      return 17;
    },
    clearInterval(id) { cleared = id; },
  };

  const stop = startBalanceRefresh('GTEST', (pubkey) => calls.push(pubkey), timers);
  tick();
  assert.deepEqual(calls, ['GTEST']);
  stop();
  assert.equal(cleared, 17);
});
