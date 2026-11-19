// Characters: a person's in-world identities, and the single public wallet
// address each one is allowed to receive NSAT at.
//
// One account → many characters. One character → one bound address. The
// character id is opaque and stable (`ch_` + 128 random bits): renaming the
// character, restyling it, or moving it to another city never changes the id or
// the wallet, and a display name is never what a payment resolves against.
//
// The binding is a signature, not a label. The wallet key signs
//
//   nsc-character|1|<characterId>|<owner uid>|<address>|<issuedAt>
//
// so anybody who holds the public address can check that whoever controls that
// wallet intended this character, in this account. It proves authorship and
// cannot spend: receiving needs no key, and the seed never leaves the browser.
// (lib/walletBinding.js is the older local label — a hint for Settings, not a
// proof. This module is what a transfer recipient may be resolved from.)
//
// Deleting a character is a tombstone, never a hard delete: the document keeps
// its id, the last verified address and the wallet history so assets stay
// reachable. Private keys are never in Firestore to begin with, and a bound
// wallet can only be unlinked after a backup that was verified recently.
//
// Nothing here stores a real-world location. The world server keeps presence in
// memory, and a character document carries only what other players may see.
import nacl from 'tweetnacl';
import { bytesToBase64, base64ToBytes, decodeG, encodeG } from './nsatCodec.js';

export const CHARACTERS_COLLECTION = 'characters';
export const CHARACTER_LIST_SUBCOLLECTION = 'list';
export const CHARACTER_ID_PREFIX = 'ch_';
export const CHARACTER_ID_RE = /^ch_[0-9a-f]{32}$/;
export const NAME_MIN = 2;
export const NAME_MAX = 24;
export const CHARACTER_LIMIT = 16;
export const APPEARANCE_VERSION = 1;
export const BINDING_VERSION = 1;
// Mirrors firestore.rules: a canonical 56-character G… account id.
export const ADDRESS_RE = /^G[A-Z2-7]{55}$/;
// A backup older than this is not "recent": unlinking or deleting a character
// with a bound wallet is refused until a fresh backup has been verified.
export const BACKUP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Palette sizes. The renderer reads these indexes; keeping the bounds here and
// in the rules means a modified page cannot store an index the client would
// then fail to draw.
export const APPEARANCE_SLOTS = Object.freeze({
  skin: 6, hair: 10, outfit: 12, accessory: 8,
});

const TEXT_ENCODER = new TextEncoder();
const HEX = '0123456789abcdef';

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

const toHex = (bytes) => {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 15];
  return out;
};

/** A fresh opaque character id. Random, not derived from the name. */
export function newCharacterId(random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))) {
  const bytes = random(16);
  if (!(bytes instanceof Uint8Array) || bytes.length !== 16) {
    throw new Error('A 16-byte random source is required for a character id.');
  }
  return `${CHARACTER_ID_PREFIX}${toHex(bytes)}`;
}

/** Trimmed, whitespace-collapsed display name, or null when unusable. */
export function normalizeCharacterName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/\s+/g, ' ');
  if (name.length < NAME_MIN || name.length > NAME_MAX) return null;
  // Control characters would break the chat bubble and the world nameplate.
  if (/[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

/** Why a name was rejected, in words a person can act on. */
export function describeCharacterNameProblem(value) {
  const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!text) return 'Choose a character name.';
  if (/[\u0000-\u001f\u007f]/.test(text)) return 'A name cannot contain control characters.';
  if (text.length < NAME_MIN) return `Use at least ${NAME_MIN} characters.`;
  if (text.length > NAME_MAX) return `Use at most ${NAME_MAX} characters.`;
  return '';
}

export function defaultAppearance() {
  return { v: APPEARANCE_VERSION, skin: 0, hair: 0, outfit: 0, accessory: 0 };
}

/** Exact appearance shape, or null. Indexes must be integers in range. */
export function normalizeAppearance(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.v !== APPEARANCE_VERSION) return null;
  const out = { v: APPEARANCE_VERSION };
  for (const [slot, size] of Object.entries(APPEARANCE_SLOTS)) {
    const value = raw[slot];
    if (!Number.isInteger(value) || value < 0 || value >= size) return null;
    out[slot] = value;
  }
  return out;
}

export function normalizeOwner(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value.trim())
    ? value.trim()
    : null;
}

export function normalizeCharacterAddress(value) {
  const text = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return ADDRESS_RE.test(text) ? text : null;
}

/** The exact document written to `characters/{owner}/list/{characterId}`. */
export function characterDocument({
  characterId, owner, name, appearance = defaultAppearance(),
  walletBinding = null, lastWallet = null, createdAt = Date.now(), updatedAt = createdAt,
}) {
  if (!CHARACTER_ID_RE.test(String(characterId || ''))) {
    throw fail('bad-character-id', 'That character id is not valid.');
  }
  const cleanOwner = normalizeOwner(owner);
  if (!cleanOwner) throw fail('bad-owner', 'A character needs an owning account.');
  const cleanName = normalizeCharacterName(name);
  if (!cleanName) throw fail('bad-name', describeCharacterNameProblem(name));
  const cleanAppearance = normalizeAppearance(appearance);
  if (!cleanAppearance) throw fail('bad-appearance', 'That appearance is not valid.');
  const cleanLastWallet = lastWallet ? normalizeCharacterAddress(lastWallet) : null;
  if (lastWallet && !cleanLastWallet) throw fail('bad-address', 'That wallet address is not valid.');
  return {
    characterId,
    owner: cleanOwner,
    name: cleanName,
    appearance: cleanAppearance,
    walletBinding: walletBinding ? normalizeStoredBinding(walletBinding) : null,
    lastWallet: cleanLastWallet,
    createdAt,
    updatedAt,
    deletedAt: null,
  };
}

function normalizeStoredBinding(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const address = normalizeCharacterAddress(raw.address);
  if (!address) return null;
  return {
    v: BINDING_VERSION,
    address,
    issuedAt: Number.isInteger(raw.issuedAt) ? raw.issuedAt : 0,
    sig: typeof raw.sig === 'string' ? raw.sig : '',
  };
}

export function characterPath(owner, characterId) {
  return [CHARACTERS_COLLECTION, owner, CHARACTER_LIST_SUBCOLLECTION, characterId];
}

/** The bytes a wallet signs. Every field that must not move is inside them. */
export function bindingBytes({ characterId, owner, address, issuedAt }) {
  return TEXT_ENCODER.encode(
    `nsc-character|${BINDING_VERSION}|${characterId}|${owner}|${address}|${issuedAt}`,
  );
}

/**
 * Sign a character↔wallet binding with the wallet's own key.
 *
 * The caller has to have unlocked the wallet already; this only borrows the seed
 * for the signature and wipes the derived secret key afterwards.
 */
export function createWalletBinding({
  walletSeed32, characterId, owner, address, issuedAt = Date.now(),
}) {
  if (!(walletSeed32 instanceof Uint8Array) || walletSeed32.length !== 32) {
    throw fail('bad-seed', 'A 32-byte wallet seed is required to bind a character.');
  }
  if (!CHARACTER_ID_RE.test(String(characterId || ''))) {
    throw fail('bad-character-id', 'That character id is not valid.');
  }
  const cleanOwner = normalizeOwner(owner);
  if (!cleanOwner) throw fail('bad-owner', 'A character needs an owning account.');
  const cleanAddress = normalizeCharacterAddress(address);
  if (!cleanAddress) throw fail('bad-address', 'That wallet address is not valid.');
  const pair = nacl.sign.keyPair.fromSeed(walletSeed32);
  try {
    if (encodeG(pair.publicKey) !== cleanAddress) {
      throw fail('seed-mismatch', 'The wallet seed does not match that address.');
    }
    const sig = nacl.sign.detached(
      bindingBytes({ characterId, owner: cleanOwner, address: cleanAddress, issuedAt }),
      pair.secretKey,
    );
    return { v: BINDING_VERSION, address: cleanAddress, issuedAt, sig: bytesToBase64(sig) };
  } finally {
    pair.secretKey.fill(0);
  }
}

/**
 * Check a stored binding against the character it claims to belong to.
 *
 * Returns false for every malformed case instead of throwing: an address that
 * does not decode, a signature over different fields, a binding moved to another
 * character or another account, and a missing signature all fail the same way.
 */
export function verifyWalletBinding({ characterId, owner, binding }) {
  try {
    if (!binding || typeof binding !== 'object') return false;
    if (binding.v !== BINDING_VERSION) return false;
    if (!CHARACTER_ID_RE.test(String(characterId || ''))) return false;
    const cleanOwner = normalizeOwner(owner);
    if (!cleanOwner) return false;
    const address = normalizeCharacterAddress(binding.address);
    if (!address) return false;
    if (!Number.isInteger(binding.issuedAt) || binding.issuedAt <= 0) return false;
    if (typeof binding.sig !== 'string' || !binding.sig) return false;
    const publicKey = decodeG(address);
    if (!publicKey || publicKey.length !== 32) return false;
    // The address must be the strkey of that very public key (version+checksum).
    if (encodeG(publicKey) !== address) return false;
    const sig = base64ToBytes(binding.sig);
    if (!sig || sig.length !== 64) return false;
    return nacl.sign.detached.verify(
      bindingBytes({ characterId, owner: cleanOwner, address, issuedAt: binding.issuedAt }),
      sig,
      publicKey,
    );
  } catch {
    return false;
  }
}

/**
 * The live character currently holding an address, or null.
 *
 * Uniqueness is deliberately scoped to one account's characters: a person may
 * restore the same seed under two accounts, and blocking that would block a
 * legitimate owner. What must never happen is two characters of one account
 * claiming the same address, because then "pay this character" would be
 * ambiguous inside that account.
 *
 * Tombstones do not hold anything: `planDeleteCharacter` clears the binding, and
 * the `deletedAt` test here keeps a malformed document from blocking an address
 * forever. `lastWallet` is not a claim either — after `planUnlinkWallet` the
 * address is free to be bound again somewhere else.
 */
export function addressHolder(characters = [], address, { exceptCharacterId = '' } = {}) {
  const cleanAddress = normalizeCharacterAddress(address);
  if (!cleanAddress) return null;
  for (const candidate of characters) {
    if (!candidate || candidate.deletedAt) continue;
    if (exceptCharacterId && candidate.characterId === exceptCharacterId) continue;
    const bound = candidate.walletBinding && candidate.walletBinding.address
      ? normalizeCharacterAddress(candidate.walletBinding.address)
      : '';
    if (bound === cleanAddress) return candidate;
  }
  return null;
}

/**
 * Attach a verified binding to a character.
 *
 * Refuses another account's character, a binding that does not verify, a silent
 * re-point at a second address, and an address that another live character of
 * the same account already holds. Unlinking is an explicit, backup-gated step
 * (`planUnlinkWallet`), never a side effect of binding again.
 *
 * `characters` is the account's character list (including `character` itself);
 * pass it so the one-address-one-character rule can be enforced. It is optional
 * only so a caller with a single document can still verify a binding.
 */
export function bindWallet({ character, owner, binding, characters = [], now = Date.now() }) {
  if (!character) throw fail('no-character', 'That character does not exist.');
  const cleanOwner = normalizeOwner(owner);
  if (!cleanOwner || character.owner !== cleanOwner) {
    throw fail('owner-mismatch', 'You can only bind a wallet to your own character.');
  }
  if (character.deletedAt) throw fail('deleted', 'That character has been deleted.');
  if (!verifyWalletBinding({ characterId: character.characterId, owner: cleanOwner, binding })) {
    throw fail('unverified-binding', 'That wallet binding could not be verified.');
  }
  const current = character.walletBinding;
  if (current && current.address !== binding.address) {
    throw fail('already-bound', 'Unlink the current wallet before binding another.');
  }
  const holder = addressHolder(characters, binding.address, {
    exceptCharacterId: character.characterId,
  });
  if (holder) {
    throw fail('address-in-use',
      'That wallet address is already bound to another character.');
  }
  return {
    ...character,
    walletBinding: normalizeStoredBinding(binding),
    lastWallet: character.lastWallet || normalizeCharacterAddress(binding.address),
    updatedAt: now,
  };
}

const freshBackup = (backupVerifiedAt, now, maxAgeMs) => Number.isFinite(backupVerifiedAt)
  && backupVerifiedAt <= now
  && now - backupVerifiedAt <= maxAgeMs;

/**
 * Detach the wallet, after a backup that was verified recently.
 *
 * The address is kept in `lastWallet` so the receive screen and the explorer can
 * still show where the assets are. Keys are never touched by this module.
 */
export function planUnlinkWallet({
  character, address, backupVerifiedAt = 0, now = Date.now(), maxAgeMs = BACKUP_MAX_AGE_MS,
}) {
  if (!character) throw fail('no-character', 'That character does not exist.');
  const current = character.walletBinding;
  if (!current) throw fail('no-binding', 'That character has no wallet bound.');
  const cleanAddress = normalizeCharacterAddress(address);
  if (!cleanAddress || cleanAddress !== current.address) {
    throw fail('address-mismatch', 'That is not the wallet bound to this character.');
  }
  if (!freshBackup(backupVerifiedAt, now, maxAgeMs)) {
    throw fail('backup-required',
      'Back up this wallet and verify the backup before unlinking it from a character.');
  }
  return {
    ...character,
    walletBinding: null,
    lastWallet: current.address,
    updatedAt: now,
  };
}

/**
 * Turn a character into a tombstone. Never a hard delete and never a key loss.
 *
 * A bound wallet blocks deletion until a recent backup has been verified, so the
 * last copy of a key cannot disappear together with the label that pointed at it.
 */
export function planDeleteCharacter({ character, backupVerifiedAt = 0, now = Date.now() }) {
  if (!character) throw fail('no-character', 'That character does not exist.');
  if (character.deletedAt) throw fail('already-deleted', 'That character is already deleted.');
  if (character.walletBinding && !freshBackup(backupVerifiedAt, now, BACKUP_MAX_AGE_MS)) {
    throw fail('backup-required',
      'Back up the bound wallet and verify the backup before deleting this character.');
  }
  return {
    ...character,
    name: '',
    appearance: null,
    walletBinding: null,
    lastWallet: character.walletBinding?.address || character.lastWallet || null,
    deletedAt: now,
    updatedAt: now,
  };
}

/** Renaming never touches the id or the wallet. */
export function renameCharacter({ character, name, now = Date.now() }) {
  if (!character || character.deletedAt) throw fail('no-character', 'That character does not exist.');
  const cleanName = normalizeCharacterName(name);
  if (!cleanName) throw fail('bad-name', describeCharacterNameProblem(name));
  return { ...character, name: cleanName, updatedAt: now };
}

/** Restyling never touches the id or the wallet. */
export function restyleCharacter({ character, appearance, now = Date.now() }) {
  if (!character || character.deletedAt) throw fail('no-character', 'That character does not exist.');
  const cleanAppearance = normalizeAppearance(appearance);
  if (!cleanAppearance) throw fail('bad-appearance', 'That appearance is not valid.');
  return { ...character, appearance: cleanAppearance, updatedAt: now };
}

export function canCreateCharacter(characters = []) {
  const alive = characters.filter((c) => c && !c.deletedAt);
  return { allowed: alive.length < CHARACTER_LIMIT, count: alive.length, limit: CHARACTER_LIMIT };
}

/**
 * The only way a transfer may learn a recipient address from a character.
 *
 * A display name on its own is never an address (`nameOnly` is rejected), an
 * unverified or absent binding is rejected, and the returned address is the one
 * inside the verified binding — not something the caller supplied alongside it.
 */
export function resolveRecipient({ character, nameOnly = false } = {}) {
  if (nameOnly) {
    throw fail('name-not-an-address',
      'A character name is not an address. Ask for the verified profile instead.');
  }
  if (!character || character.deletedAt) {
    throw fail('no-character', 'That character does not exist.');
  }
  const binding = character.walletBinding;
  if (!binding || !binding.address) {
    throw fail('unverified-wallet', 'That character has no verified wallet.');
  }
  if (!verifyWalletBinding({
    characterId: character.characterId, owner: character.owner, binding,
  })) {
    throw fail('unverified-wallet', 'That character’s wallet binding could not be verified.');
  }
  return { address: normalizeCharacterAddress(binding.address), characterId: character.characterId };
}

/** Human-readable reason, for a toast or a dialog. */
export function describeCharacterFailure(error) {
  const code = error && typeof error === 'object' ? error.code : '';
  switch (code) {
    case 'no-character': return 'That character no longer exists.';
    case 'deleted': return 'That character has been deleted.';
    case 'owner-mismatch': return 'That character belongs to another account.';
    case 'unverified-binding': return 'The wallet binding could not be verified.';
    case 'seed-mismatch': return 'That wallet does not match the address.';
    case 'already-bound': return 'Unlink the current wallet before binding another.';
    case 'address-in-use': return 'That wallet is already bound to another character.';
    case 'backup-required': return 'Back up this wallet and verify the backup first.';
    case 'address-mismatch': return 'That is not the wallet bound to this character.';
    case 'name-not-an-address': return 'A character name is not a wallet address.';
    case 'unverified-wallet': return 'That character has no verified wallet to pay.';
    case 'bad-name': return describeCharacterNameProblem('') || 'Choose another name.';
    default: return 'That change could not be applied.';
  }
}
