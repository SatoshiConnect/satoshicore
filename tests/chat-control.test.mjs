import assert from 'node:assert/strict';
import test from 'node:test';

import { CONTROL_PREFIX, decodeControl, encodeControl } from '../lib/chatControl.js';

test('edit and reaction controls round-trip without leaking into normal text', () => {
  const edit = encodeControl({ kind: 'edit', id: 42, text: 'new text' });
  assert.equal(edit.startsWith(CONTROL_PREFIX), true);
  assert.deepEqual(decodeControl(edit), { kind: 'edit', id: 42, text: 'new text' });
  const reaction = encodeControl({ kind: 'reaction', id: 42, emoji: '👍' });
  assert.deepEqual(decodeControl(reaction), { kind: 'reaction', id: 42, emoji: '👍' });
  assert.equal(decodeControl('ordinary message'), null);
});

test('control parsing fails closed on bad ids, kinds, and oversized values', () => {
  assert.equal(decodeControl(`${CONTROL_PREFIX}{`), null);
  assert.equal(decodeControl(`${CONTROL_PREFIX}{"kind":"delete","id":1}`), null);
  assert.equal(decodeControl(`${CONTROL_PREFIX}{"kind":"edit","id":0,"text":"x"}`), null);
  assert.equal(decodeControl(`${CONTROL_PREFIX}{"kind":"edit","id":1,"text":""}`), null);
  assert.equal(decodeControl(`${CONTROL_PREFIX}{"kind":"reaction","id":1,"emoji":"123456789"}`), null);
  assert.throws(() => encodeControl({ kind: 'edit', id: 1, text: '' }));
  assert.throws(() => encodeControl({ kind: 'reaction', id: 1, emoji: 'too-long!!' }));
});
