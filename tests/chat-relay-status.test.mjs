import { test } from 'node:test';
import assert from 'node:assert/strict';

import { describeChatFailure } from '../lib/chatRelayStatus.js';

test('a network failure explains that nothing was queued and the draft remains', () => {
  const notice = describeChatFailure(new Error('Failed to fetch'), { action: 'send' });
  assert.equal(notice.kind, 'offline');
  assert.match(notice.title, /unreachable/i);
  assert.match(notice.message, /not sent/);
  assert.match(notice.message, /draft is still here/);
  assert.equal(notice.retry, false, 'send retry is pressing Send again, not reopening');
});

test('a read failure keeps the room and offers a retry', () => {
  const notice = describeChatFailure(new Error('timeout'), { action: 'read' });
  assert.equal(notice.kind, 'offline');
  assert.match(notice.message, /last messages stay visible/);
  assert.equal(notice.retry, true);
});

test('a server error has a stable title and does not invent a cause', () => {
  const notice = describeChatFailure(new Error('500'), { action: 'read' });
  assert.equal(notice.kind, 'error');
  assert.match(notice.title, /could not be opened/);
  assert.match(notice.message, /500/);
  assert.equal(notice.retry, true);
});

test('a 429 is reported as a wait with the server’s own delay', () => {
  const error = Object.assign(new Error('Chat relay refused the request: rate limit exceeded'), {
    status: 429, retryAfterMs: 12_000,
  });
  const read = describeChatFailure(error, { action: 'read' });
  assert.equal(read.kind, 'rate-limited');
  assert.match(read.title, /busy/i);
  assert.match(read.message, /12 s/);
  assert.match(read.message, /wait/i);
  assert.doesNotMatch(read.message, /could not be opened/, 'a wait is not a broken conversation');
  assert.equal(read.retryAfterMs, 12_000);

  // Sending is queued and retried by the client, so it may say so.
  const send = describeChatFailure(error, { action: 'send' });
  assert.match(send.message, /retries automatically/);
});

test('a 429 without a delay still avoids inventing a cause', () => {
  const notice = describeChatFailure(Object.assign(new Error('rate limit exceeded'), { status: 429 }));
  assert.equal(notice.kind, 'rate-limited');
  assert.match(notice.message, /a moment/);
  assert.equal(notice.retryAfterMs, 0);
});

test('a missing error still gives a usable message', () => {
  const notice = describeChatFailure(null, { action: 'send' });
  assert.equal(notice.kind, 'error');
  assert.match(notice.message, /returned an error/);
});
