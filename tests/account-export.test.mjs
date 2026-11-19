import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ACCOUNT_EXPORT_FORMAT,
  ACCOUNT_EXPORT_VERSION,
  accountExportFileName,
  buildAccountExport,
  serializeAccountExport,
} from '../lib/accountExport.js';

const ADDRESS = `G${'A'.repeat(55)}`;
const AT = '2026-11-16T10:00:00.000Z';

test('the export contains only the documented account data and sorts peer ids', () => {
  const data = buildAccountExport({
    exportedAt: AT,
    profile: {
      profileId: '@alice',
      primaryAddress: ADDRESS,
      displayName: 'Alice',
      bio: 'builds things',
      status: 'ready',
    },
    people: { 'uid-z': 'friend', 'uid-a': 'friend' },
    incoming: { 'uid-b': 'pending', 'uid-a': 'accepted', 'uid-c': 'bogus' },
    outgoing: { 'uid-z': 'rejected', 'uid-y': 'pending' },
    blocked: { 'uid-q': true, 'uid-b': true },
  });

  assert.equal(data.format, ACCOUNT_EXPORT_FORMAT);
  assert.equal(data.version, ACCOUNT_EXPORT_VERSION);
  assert.equal(data.exportedAt, AT);
  assert.deepEqual(data.profile, {
    profileId: '@alice',
    primaryAddress: ADDRESS,
    displayName: 'Alice',
    bio: 'builds things',
    status: 'ready',
  });
  assert.deepEqual(data.contacts, ['uid-a', 'uid-z']);
  assert.deepEqual(data.requests, {
    incoming: { 'uid-a': 'accepted', 'uid-b': 'pending' },
    outgoing: { 'uid-y': 'pending', 'uid-z': 'rejected' },
  });
  assert.deepEqual(data.blocked, ['uid-b', 'uid-q']);
});

test('the export never carries secrets, email or key material', () => {
  const json = serializeAccountExport({
    exportedAt: AT,
    profile: {
      profileId: '@alice',
      primaryAddress: ADDRESS,
      displayName: 'Alice',
      email: 'alice@example.com',
      seed: 'should-not-be-exported',
      password: 'should-not-be-exported',
      token: 'should-not-be-exported',
    },
    people: { 'uid-a': 'friend' },
  });
  assert.doesNotMatch(json, /alice@example\.com/i);
  assert.doesNotMatch(json, /should-not-be-exported/);
  assert.doesNotMatch(json, /"(email|seed|password|token|privateKey)"\s*:/i);
});

test('an absent or invalid profile is exported as null rather than invented', () => {
  const empty = buildAccountExport({ exportedAt: AT });
  assert.equal(empty.profile, null);
  assert.deepEqual(empty.contacts, []);
  assert.deepEqual(empty.requests, { incoming: {}, outgoing: {} });
  assert.deepEqual(empty.blocked, []);

  const invalid = buildAccountExport({
    exportedAt: AT,
    profile: { profileId: 'not-a-handle', primaryAddress: ADDRESS },
  });
  assert.equal(invalid.profile, null);
});

test('the filename uses the export date and is stable', () => {
  assert.equal(accountExportFileName(AT), 'nsat-account-export-2026-11-16.json');
  assert.match(accountExportFileName('not-a-date'),
    /^nsat-account-export-\d{4}-\d{2}-\d{2}\.json$/);
});
