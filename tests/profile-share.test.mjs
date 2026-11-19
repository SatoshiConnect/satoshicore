import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROFILE_SHARE_PARAM, buildProfileShareUrl, isLimitedShare, profileShareTarget,
  profileShareText, profileShareWarning,
} from '../lib/profileShare.js';

const ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

test('a public profile shares its handle when one exists', () => {
  const profile = { profileId: '@alice', primaryAddress: ADDRESS, visibility: 'signed-in' };
  assert.equal(profileShareTarget(profile), '@alice');
  assert.equal(profileShareTarget({ profileId: '@alice' }), '@alice', 'old documents default to public-to-signed-in');
  assert.equal(
    buildProfileShareUrl('https://nsat.example/wallet/?old=1#top', profile),
    `https://nsat.example/wallet/?${PROFILE_SHARE_PARAM}=%40alice`,
  );
});

test('a limited profile shares its address so the receiver can still start a chat', () => {
  const profile = { profileId: '@alice', primaryAddress: ADDRESS, visibility: 'contacts' };
  assert.equal(profileShareTarget(profile), ADDRESS);
  assert.equal(isLimitedShare(profile), false, 'an address is usable by anyone with the link');
  assert.match(buildProfileShareUrl('https://nsat.example/wallet/', profile), /add=G/);
});

test('a private handle without an address is flagged as limited', () => {
  const profile = { profileId: '@alice', primaryAddress: '', visibility: 'private' };
  assert.equal(profileShareTarget(profile), '@alice');
  assert.equal(isLimitedShare(profile), true);
});

test('an address-only profile still produces a link', () => {
  const profile = { profileId: '', primaryAddress: ADDRESS, visibility: 'signed-in' };
  assert.equal(profileShareTarget(profile), ADDRESS);
  assert.match(buildProfileShareUrl('https://nsat.example/base/wallet/', profile), /base\/wallet\/\?add=G/);
});

test('invalid hrefs and empty profiles produce no link', () => {
  assert.equal(buildProfileShareUrl('not a url', { profileId: '@alice' }), '');
  assert.equal(buildProfileShareUrl('javascript:alert(1)', { profileId: '@alice' }), '');
  assert.equal(buildProfileShareUrl('https://nsat.example/wallet/', {}), '');
});

test('the warning distinguishes limited from a missing primary wallet', () => {
  assert.equal(profileShareWarning({ profileId: '@alice', primaryAddress: ADDRESS }), '');
  assert.match(profileShareWarning({ profileId: '@alice', visibility: 'private', primaryAddress: '' }), /limited/);
  assert.match(profileShareWarning({ profileId: '@alice', visibility: 'signed-in', primaryAddress: '' }), /has no primary wallet/);
});

test('share text names the profile without exposing anything else', () => {
  assert.equal(profileShareText({ displayName: 'Alice', profileId: '@alice' }), 'Chat with Alice on NSAT');
  assert.equal(profileShareText({ profileId: '@alice' }), 'Chat with @alice on NSAT');
});
