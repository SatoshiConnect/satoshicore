// The character record is the only place a payment recipient can come from, so
// it is pinned like the profile: exact document shape, an opaque stable id, a
// binding that must verify with the wallet's own key, and no path that deletes a
// key or silently re-points an address.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import { encodeG } from '../lib/nsatCodec.js';
import {
  APPEARANCE_SLOTS,
  BACKUP_MAX_AGE_MS,
  CHARACTER_ID_RE,
  CHARACTER_LIMIT,
  addressHolder,
  bindWallet,
  bindingBytes,
  canCreateCharacter,
  characterDocument,
  createWalletBinding,
  defaultAppearance,
  describeCharacterFailure,
  describeCharacterNameProblem,
  newCharacterId,
  normalizeAppearance,
  normalizeCharacterName,
  planDeleteCharacter,
  planUnlinkWallet,
  renameCharacter,
  resolveRecipient,
  restyleCharacter,
  verifyWalletBinding,
} from '../lib/characters.js';

const RULES = readFileSync(join(process.cwd(), 'firestore.rules'), 'utf8');

const OWNER = 'uid-alice';
const OTHER_OWNER = 'uid-bob';
const seedOf = (fill) => new Uint8Array(32).fill(fill);
const addressOf = (seed) => encodeG(nacl.sign.keyPair.fromSeed(seed).publicKey);
const ALICE_SEED = seedOf(7);
const ALICE_ADDRESS = addressOf(ALICE_SEED);
const BOB_ADDRESS = addressOf(seedOf(9));
const ID = `ch_${'ab'.repeat(16)}`;
const ID_B = `ch_${'cd'.repeat(16)}`;

const bindingFor = (over = {}) => createWalletBinding({
  walletSeed32: ALICE_SEED, characterId: ID, owner: OWNER, address: ALICE_ADDRESS,
  issuedAt: 1_700_000_000_000, ...over,
});

const characterWith = (over = {}) => characterDocument({
  characterId: ID, owner: OWNER, name: 'Mali', createdAt: 1_700_000_000_000, ...over,
});

test('character ids are opaque, stable and independent of the display name', () => {
  const bytes = new Uint8Array(16).fill(0xab);
  assert.equal(newCharacterId(() => bytes), ID);
  assert.match(ID, CHARACTER_ID_RE);
  // A different random draw yields a different id; nothing is derived from the name.
  assert.notEqual(newCharacterId(() => new Uint8Array(16).fill(1)), newCharacterId(() => bytes));
  const base = characterWith();
  assert.equal(renameCharacter({ character: base, name: 'Mali Prime' }).characterId, ID);
  assert.equal(restyleCharacter({
    character: base, appearance: { ...defaultAppearance(), skin: 5 },
  }).characterId, ID);
});

test('names are trimmed and bounded, with an actionable rejection', () => {
  assert.equal(normalizeCharacterName('  Nong   Mali '), 'Nong Mali');
  assert.equal(normalizeCharacterName('a'), null);
  assert.equal(normalizeCharacterName('x'.repeat(25)), null);
  assert.equal(normalizeCharacterName('bad\u0000name'), null);
  assert.match(describeCharacterNameProblem('a'), /at least/);
  assert.equal(describeCharacterNameProblem('Mali'), '');
});

test('appearance is an exact, bounded shape', () => {
  assert.deepEqual(normalizeAppearance(defaultAppearance()), defaultAppearance());
  assert.equal(normalizeAppearance({ ...defaultAppearance(), skin: APPEARANCE_SLOTS.skin }), null);
  assert.equal(normalizeAppearance({ ...defaultAppearance(), skin: -1 }), null);
  assert.equal(normalizeAppearance({ ...defaultAppearance(), skin: 1.5 }), null);
  assert.equal(normalizeAppearance({ ...defaultAppearance(), v: 2 }), null);
});

test('the document never carries a seed, password or location', () => {
  const doc = characterWith();
  assert.deepEqual(Object.keys(doc).sort(), [
    'appearance', 'characterId', 'createdAt', 'deletedAt', 'lastWallet', 'name',
    'owner', 'updatedAt', 'walletBinding',
  ]);
  const text = JSON.stringify(doc);
  for (const secret of ['seed', 'password', 'passphrase', 'location', 'lat', 'lng']) {
    assert.equal(text.includes(secret), false, `document must not contain ${secret}`);
  }
});

test('a binding verifies only for the character, account, address and time it was signed for', () => {
  const binding = bindingFor();
  assert.equal(verifyWalletBinding({ characterId: ID, owner: OWNER, binding }), true);

  // Re-pointed at another address.
  assert.equal(verifyWalletBinding({
    characterId: ID, owner: OWNER, binding: { ...binding, address: BOB_ADDRESS },
  }), false);
  // Replayed onto another character or another account.
  assert.equal(verifyWalletBinding({ characterId: `ch_${'cd'.repeat(16)}`, owner: OWNER, binding }), false);
  assert.equal(verifyWalletBinding({ characterId: ID, owner: OTHER_OWNER, binding }), false);
  // Edited timestamp invalidates the signature.
  assert.equal(verifyWalletBinding({
    characterId: ID, owner: OWNER, binding: { ...binding, issuedAt: binding.issuedAt + 1 },
  }), false);
  // Bob's signature over Bob's address cannot be relabelled as Alice's.
  const bobBinding = bindingFor({ walletSeed32: seedOf(9), address: BOB_ADDRESS });
  assert.equal(verifyWalletBinding({
    characterId: ID, owner: OWNER, binding: { ...bobBinding, address: ALICE_ADDRESS },
  }), false);
});

test('a seed that does not control the address cannot sign a binding for it', () => {
  assert.throws(
    () => bindingFor({ walletSeed32: seedOf(9) }),
    (error) => error.code === 'seed-mismatch',
  );
});

test('binding refuses another account, an unverified binding and a silent re-point', () => {
  const character = characterWith();
  assert.throws(
    () => bindWallet({ character, owner: OTHER_OWNER, binding: bindingFor() }),
    (error) => error.code === 'owner-mismatch',
  );
  assert.throws(
    () => bindWallet({ character, owner: OWNER, binding: { ...bindingFor(), sig: 'AAAA' } }),
    (error) => error.code === 'unverified-binding',
  );

  const bound = bindWallet({ character, owner: OWNER, binding: bindingFor(), now: 1_700_000_100_000 });
  assert.equal(bound.walletBinding.address, ALICE_ADDRESS);
  assert.equal(verifyWalletBinding({ characterId: ID, owner: OWNER, binding: bound.walletBinding }), true);

  const otherBinding = bindingFor({
    walletSeed32: seedOf(9), address: BOB_ADDRESS,
  });
  assert.throws(
    () => bindWallet({ character: bound, owner: OWNER, binding: otherBinding }),
    (error) => error.code === 'already-bound',
  );
});

test('one address cannot be bound to two live characters', () => {
  const first = bindWallet({ character: characterWith(), owner: OWNER, binding: bindingFor() });
  const secondBase = characterDocument({
    characterId: ID_B, owner: OWNER, name: 'Somsak', createdAt: 1_700_000_000_000,
  });
  const secondBinding = bindingFor({ characterId: ID_B });

  assert.throws(
    () => bindWallet({
      character: secondBase, owner: OWNER, binding: secondBinding, characters: [first, secondBase],
    }),
    (error) => error.code === 'address-in-use',
  );
  // The holder keeps its binding untouched.
  assert.equal(first.walletBinding.address, ALICE_ADDRESS);
  assert.equal(addressHolder([first, secondBase], ALICE_ADDRESS).characterId, ID);
  assert.equal(addressHolder([first], ALICE_ADDRESS, { exceptCharacterId: ID }), null);

  // Re-binding the same address to the same character stays a no-op, not a clash.
  const again = bindWallet({ character: first, owner: OWNER, binding: bindingFor(), characters: [first] });
  assert.equal(again.walletBinding.address, ALICE_ADDRESS);

  // A different address is fine on a second character.
  const otherBinding = bindingFor({
    walletSeed32: seedOf(9), characterId: ID_B, address: BOB_ADDRESS,
  });
  const second = bindWallet({
    character: secondBase, owner: OWNER, binding: otherBinding, characters: [first, secondBase],
  });
  assert.equal(second.walletBinding.address, BOB_ADDRESS);
});

test('a deleted character releases its address for a new character', () => {
  const now = 1_700_000_000_000;
  const first = bindWallet({ character: characterWith(), owner: OWNER, binding: bindingFor() });
  const tombstone = planDeleteCharacter({ character: first, backupVerifiedAt: now, now });
  assert.equal(tombstone.deletedAt, now);

  // The tombstone no longer counts as a holder, even though it remembers where
  // the assets are, so the same wallet can be bound to a new character.
  assert.equal(addressHolder([tombstone], ALICE_ADDRESS), null);
  const replacement = characterDocument({
    characterId: ID_B, owner: OWNER, name: 'Mali II', createdAt: now,
  });
  const rebound = bindWallet({
    character: replacement,
    owner: OWNER,
    binding: bindingFor({ characterId: ID_B }),
    characters: [tombstone, replacement],
    now,
  });
  assert.equal(rebound.walletBinding.address, ALICE_ADDRESS);
  assert.equal(rebound.lastWallet, ALICE_ADDRESS);
});

test('unlinking a wallet also releases the address', () => {
  const now = 1_700_000_000_000;
  const first = bindWallet({ character: characterWith(), owner: OWNER, binding: bindingFor() });
  const unlinked = planUnlinkWallet({
    character: first, address: ALICE_ADDRESS, backupVerifiedAt: now, now,
  });
  const secondBase = characterDocument({
    characterId: ID_B, owner: OWNER, name: 'Somsak', createdAt: now,
  });
  assert.equal(addressHolder([unlinked], ALICE_ADDRESS), null);
  const second = bindWallet({
    character: secondBase,
    owner: OWNER,
    binding: bindingFor({ characterId: ID_B }),
    characters: [unlinked, secondBase],
    now,
  });
  assert.equal(second.walletBinding.address, ALICE_ADDRESS);
});

test('renaming and restyling keep the verified wallet intact', () => {
  const bound = bindWallet({ character: characterWith(), owner: OWNER, binding: bindingFor() });
  const renamed = renameCharacter({ character: bound, name: 'Mali The Second' });
  const restyled = restyleCharacter({
    character: renamed, appearance: { ...defaultAppearance(), hair: 3, outfit: 7 },
  });
  assert.equal(restyled.walletBinding.address, ALICE_ADDRESS);
  assert.equal(restyled.characterId, ID);
  assert.equal(restyled.name, 'Mali The Second');
  assert.equal(restyled.appearance.outfit, 7);
});

test('unlinking needs a recent verified backup and keeps the address reachable', () => {
  const now = 1_700_000_000_000;
  const bound = bindWallet({ character: characterWith(), owner: OWNER, binding: bindingFor() });
  assert.throws(
    () => planUnlinkWallet({ character: bound, address: ALICE_ADDRESS, now }),
    (error) => error.code === 'backup-required',
  );
  assert.throws(
    () => planUnlinkWallet({ character: bound, address: ALICE_ADDRESS, backupVerifiedAt: now - BACKUP_MAX_AGE_MS - 1, now }),
    (error) => error.code === 'backup-required',
  );
  assert.throws(
    () => planUnlinkWallet({ character: bound, address: BOB_ADDRESS, backupVerifiedAt: now, now }),
    (error) => error.code === 'address-mismatch',
  );
  const unlinked = planUnlinkWallet({
    character: bound, address: ALICE_ADDRESS, backupVerifiedAt: now - 60_000, now,
  });
  assert.equal(unlinked.walletBinding, null);
  assert.equal(unlinked.lastWallet, ALICE_ADDRESS);
  assert.equal(unlinked.characterId, ID);
});

test('deleting a character is a tombstone that keeps assets reachable', () => {
  const now = 1_700_000_000_000;
  const bound = bindWallet({ character: characterWith(), owner: OWNER, binding: bindingFor() });
  assert.throws(
    () => planDeleteCharacter({ character: bound, now }),
    (error) => error.code === 'backup-required',
  );
  const tombstone = planDeleteCharacter({ character: bound, backupVerifiedAt: now, now });
  assert.equal(tombstone.deletedAt, now);
  assert.equal(tombstone.walletBinding, null);
  assert.equal(tombstone.lastWallet, ALICE_ADDRESS);
  assert.equal(tombstone.characterId, ID);
  assert.equal(tombstone.name, '');
  assert.throws(
    () => planDeleteCharacter({ character: tombstone, backupVerifiedAt: now, now }),
    (error) => error.code === 'already-deleted',
  );
  // A tombstone can never be used as a payment target.
  assert.throws(
    () => resolveRecipient({ character: tombstone }),
    (error) => error.code === 'no-character',
  );
});

test('payments resolve from the verified binding only, never from a name', () => {
  const unbound = characterWith();
  assert.throws(
    () => resolveRecipient({ character: unbound }),
    (error) => error.code === 'unverified-wallet',
  );
  assert.throws(
    () => resolveRecipient({ character: unbound, nameOnly: true }),
    (error) => error.code === 'name-not-an-address',
  );
  const bound = bindWallet({ character: unbound, owner: OWNER, binding: bindingFor() });
  assert.deepEqual(resolveRecipient({ character: bound }), {
    address: ALICE_ADDRESS, characterId: ID,
  });
  // A tampered document no longer resolves, even though an address is present.
  const tampered = { ...bound, owner: OTHER_OWNER };
  assert.throws(
    () => resolveRecipient({ character: tampered }),
    (error) => error.code === 'unverified-wallet',
  );
});

test('the character limit counts live characters only', () => {
  const alive = Array.from({ length: CHARACTER_LIMIT }, () => characterWith());
  assert.deepEqual(canCreateCharacter(alive), { allowed: false, count: CHARACTER_LIMIT, limit: CHARACTER_LIMIT });
  assert.equal(canCreateCharacter([...alive, { deletedAt: 1 }]).allowed, false);
  assert.equal(canCreateCharacter(alive.slice(1)).allowed, true);
});

test('the signed bytes include every field that must not move', () => {
  const text = new TextDecoder().decode(bindingBytes({
    characterId: ID, owner: OWNER, address: ALICE_ADDRESS, issuedAt: 5,
  }));
  assert.equal(text, `nsc-character|1|${ID}|${OWNER}|${ALICE_ADDRESS}|5`);
});

test('failures are described in words a person can act on', () => {
  const message = describeCharacterFailure({ code: 'backup-required' });
  assert.match(message, /Back up/);
  assert.equal(typeof describeCharacterFailure({ code: 'unknown' }), 'string');
});

test('firestore rules keep characters owner-scoped and never hard-deleted', () => {
  assert.match(RULES, /match \/characters\/\{owner\}\/list\/\{characterId\}/);
  assert.match(RULES, /allow delete: if false/);
  assert.match(RULES, /request\.auth\.uid == owner/);
  // The address shape is enforced in the rules, not only in the module.
  assert.match(RULES, /value\.address\.matches\('\^G\[A-Z2-7\]\{55\}\$'\)/);
});
