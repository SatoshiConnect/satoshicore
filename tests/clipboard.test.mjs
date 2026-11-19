import { test } from 'node:test';
import assert from 'node:assert/strict';

import { copyTextToClipboard } from '../lib/clipboard.js';

test('copying passes the exact message text to the clipboard', async () => {
  const written = [];
  await copyTextToClipboard('hello @alice\nsecond line', {
    clipboard: { writeText: async (value) => { written.push(value); } },
  });
  assert.deepEqual(written, ['hello @alice\nsecond line']);
});

test('a missing clipboard is reported instead of silently succeeding', async () => {
  await assert.rejects(
    () => copyTextToClipboard('hello', { clipboard: null }),
    (error) => error.code === 'CLIPBOARD_UNAVAILABLE',
  );
  await assert.rejects(
    () => copyTextToClipboard('hello', { clipboard: {} }),
    (error) => error.code === 'CLIPBOARD_UNAVAILABLE',
  );
});

test('a denied clipboard write reaches the caller as a failure', async () => {
  await assert.rejects(
    () => copyTextToClipboard('hello', {
      clipboard: { writeText: async () => { throw new Error('denied'); } },
    }),
    /denied/,
  );
});
