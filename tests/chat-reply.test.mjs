import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_REPLY_QUOTE, createReplyText, displayMessageText, parseReplyText,
} from '../lib/chatReply.js';
import { MAX_TEXT_LENGTH } from '../lib/e2eChat.js';

test('a reply round-trips its target, quote and body', () => {
  const text = createReplyText({ to: 'm42', quote: 'Are we still on?', text: 'Yes — at six.' });
  assert.deepEqual(parseReplyText(text), {
    kind: 'reply', to: 'm42', quote: 'Are we still on?', text: 'Yes — at six.',
  });
  assert.equal(displayMessageText(text), 'Yes — at six.');
  assert.equal(displayMessageText('ordinary text'), 'ordinary text');
});

test('malformed payloads are inert rather than thrown', () => {
  assert.equal(parseReplyText('ordinary'), null);
  assert.equal(parseReplyText('NSAT-REPLY/1\n{not json').kind, 'invalid');
  assert.equal(parseReplyText('NSAT-REPLY/1\n{"to":"m1","quote":"q"}').kind, 'invalid');
  assert.equal(parseReplyText('NSAT-REPLY/1\n{"to":"m1","quote":"q","text":""}').kind, 'invalid');
  assert.equal(parseReplyText('NSAT-REPLY/1\n{"to":"../x","quote":"q","text":"t"}').kind, 'invalid');
});

test('reply creation refuses an empty body, missing target or empty quote', () => {
  assert.throws(() => createReplyText({ to: '', quote: 'q', text: 't' }), /message it answers/);
  assert.throws(() => createReplyText({ to: 'm1', quote: '', text: 't' }), /needs a quote/);
  assert.throws(() => createReplyText({ to: 'm1', quote: 'q', text: '' }), /cannot be empty/);
});

test('the quote and the whole encrypted payload stay bounded', () => {
  assert.throws(
    () => createReplyText({ to: 'm1', quote: 'q'.repeat(MAX_REPLY_QUOTE + 1), text: 't' }),
    /quote is limited/,
  );
  assert.throws(
    () => createReplyText({ to: 'm1', quote: 'q'.repeat(MAX_REPLY_QUOTE), text: 't'.repeat(MAX_TEXT_LENGTH) }),
    /including the quote/,
  );
});

test('a nested reply quotes the body, not the wire format', () => {
  const first = createReplyText({ to: 'm1', quote: 'first', text: 'first body' });
  const second = createReplyText({ to: 'm2', quote: displayMessageText(first), text: 'second body' });
  assert.equal(parseReplyText(second).quote, 'first body');
});
