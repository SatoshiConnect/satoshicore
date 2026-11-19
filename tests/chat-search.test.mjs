import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  conversationMatches, filterConversations, normalizeConversationQuery,
} from '../lib/chatSearch.js';

const ADDRESS = `G${'A'.repeat(55)}`;

test('an empty query matches every conversation', () => {
  assert.equal(normalizeConversationQuery('   '), '');
  assert.equal(conversationMatches({ address: ADDRESS, handle: '@alice', name: 'Alice' }, ''), true);
  assert.deepEqual(filterConversations(['a', 'b'], '  '), ['a', 'b']);
});

test('matching is case-insensitive over name, handle and address', () => {
  const chat = { address: ADDRESS, handle: '@Alice', name: 'Alice Smith' };
  assert.equal(conversationMatches(chat, 'alice'), true);
  assert.equal(conversationMatches(chat, 'SMITH'), true);
  assert.equal(conversationMatches(chat, '@alice'), true);
  assert.equal(conversationMatches(chat, ADDRESS.toLowerCase()), true);
  assert.equal(conversationMatches(chat, 'bob'), false);
});

test('filtering preserves the caller order and supports a descriptor', () => {
  const rows = [
    { id: 'one', label: { name: 'Alice', handle: '@alice', address: ADDRESS } },
    { id: 'two', label: { name: 'Bob', handle: '@bob', address: `G${'B'.repeat(55)}` } },
  ];
  assert.deepEqual(filterConversations(rows, 'ali', (row) => row.label), [rows[0]]);
  assert.deepEqual(filterConversations(rows, '', (row) => row.label), rows);
});

test('a missing name or handle does not make the address unmatchable', () => {
  assert.equal(conversationMatches({ address: ADDRESS }, 'AAAA'), true);
  assert.equal(conversationMatches({}, 'anything'), false);
});
