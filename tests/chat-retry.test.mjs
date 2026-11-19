// The stream reconnects on its own, so its delay schedule is the difference
// between "one rate-limited handshake" and "a reconnect loop that keeps the
// limiter closed". These tests pin the growth, the jitter bounds, and that the
// server's Retry-After is never undercut.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  POLL_COALESCE_MS,
  SSE_BASE_DELAY_MS,
  SSE_MAX_DELAY_MS,
  nextReconnectDelay,
  retryAfterMsOf,
} from '../lib/chatRetry.js';

test('reconnect delays grow exponentially from the base', () => {
  const noJitter = () => 1; // 100% of the step
  const delays = [0, 1, 2, 3, 4].map((attempt) => nextReconnectDelay(attempt, {
    random: noJitter,
  }));
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16_000]);
  assert.equal(delays[0], SSE_BASE_DELAY_MS);
});

test('the delay is capped even after many failures', () => {
  const delay = nextReconnectDelay(20, { random: () => 1 });
  assert.equal(delay, SSE_MAX_DELAY_MS);
});

test('jitter stays inside 50–100% of the step, so tabs do not retry in lockstep', () => {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const step = Math.min(SSE_MAX_DELAY_MS, SSE_BASE_DELAY_MS * 2 ** attempt);
    const low = nextReconnectDelay(attempt, { random: () => 0 });
    const high = nextReconnectDelay(attempt, { random: () => 1 });
    assert.equal(low, step * 0.5, `attempt ${attempt} lower bound`);
    assert.equal(high, step, `attempt ${attempt} upper bound`);
    assert.ok(low < high, `attempt ${attempt} must actually jitter`);
  }
});

test('a server Retry-After is never undercut', () => {
  // Our own schedule would allow 1 s; the server asked for 20 s.
  assert.equal(nextReconnectDelay(0, { retryAfterMs: 20_000 }), 20_000);
  // Later attempts are longer than the server's ask, so ours wins.
  assert.equal(nextReconnectDelay(4, { retryAfterMs: 1_000, random: () => 1 }), 16_000);
});

test('Retry-After is read from the error field, seconds, and the header', () => {
  assert.equal(retryAfterMsOf({ retryAfterMs: 1500 }), 1500);
  assert.equal(retryAfterMsOf({ retryAfter: 3 }), 3000);
  assert.equal(retryAfterMsOf({ headers: { 'retry-after': '7' } }), 7000);
  assert.equal(retryAfterMsOf({ status: 429 }), 0);
  assert.equal(retryAfterMsOf(null), 0);
});

test('a negative or missing attempt still starts at the base delay', () => {
  assert.equal(nextReconnectDelay(-5, { random: () => 1 }), SSE_BASE_DELAY_MS);
  assert.equal(nextReconnectDelay(undefined, { random: () => 1 }), SSE_BASE_DELAY_MS);
});

test('frames are coalesced rather than polling once per frame', () => {
  assert.ok(POLL_COALESCE_MS >= 1000, 'a coalescing window shorter than a second is not a window');
  assert.ok(POLL_COALESCE_MS < 15_000, 'coalescing must not delay mail past the poll interval');
});
