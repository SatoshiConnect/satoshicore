// The browser side of character records.
//
// `lib/characters.js` is the pure document/crypto layer and knows nothing about
// Firestore. This module is the thin I/O around it: read the signed-in account's
// own characters and create a new one. It deliberately has no delete, no wallet
// binding and no payment lookup — those stay behind the flows that already exist
// for them.
import { loadFirestore } from './firebaseAuth.js';
import { withTimeout } from './withTimeout.js';
import {
  CHARACTER_LIST_SUBCOLLECTION,
  CHARACTERS_COLLECTION,
  canCreateCharacter,
  characterDocument,
  characterPath,
  newCharacterId,
  normalizeAppearance,
  normalizeCharacterName,
} from './characters.js';

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

/** The parts of a stored character a picker or nameplate may show. */
export function summarizeCharacter(raw, id = '') {
  if (!raw || typeof raw !== 'object') return null;
  const appearance = normalizeAppearance(raw.appearance);
  const name = typeof raw.name === 'string' ? raw.name : '';
  if (raw.deletedAt) return null;
  return {
    characterId: typeof raw.characterId === 'string' ? raw.characterId : id,
    owner: typeof raw.owner === 'string' ? raw.owner : '',
    name,
    appearance: appearance || null,
    hasWallet: Boolean(raw.walletBinding && raw.walletBinding.address),
  };
}

/** Every live character of the signed-in account, newest last. */
export async function listMyCharacters(uid) {
  if (!uid) throw fail('no-account', 'Sign in to load your characters.');
  const { sdk, db } = await loadFirestore();
  const snapshot = await withTimeout(
    sdk.getDocs(sdk.collection(db, CHARACTERS_COLLECTION, uid, CHARACTER_LIST_SUBCOLLECTION)),
    'loading your characters did not complete',
  );
  return snapshot.docs
    .map((entry) => summarizeCharacter(entry.data(), entry.id))
    .filter(Boolean)
    .sort((a, b) => String(a.characterId).localeCompare(String(b.characterId)));
}

/**
 * Create a character for the signed-in account.
 *
 * The document is built by `characterDocument`, so the shape, the appearance
 * bounds and the opaque `ch_` id are the same ones the rules and the world
 * server expect. No wallet is bound here: a binding needs the wallet unlocked,
 * and that is a separate, explicit step.
 */
export async function createMyCharacter({ uid, name, appearance }) {
  if (!uid) throw fail('no-account', 'Sign in to create a character.');
  const cleanName = normalizeCharacterName(name);
  if (!cleanName) throw fail('bad-name', 'Choose a character name of 2–24 characters.');
  const cleanAppearance = normalizeAppearance(appearance);
  if (!cleanAppearance) throw fail('bad-appearance', 'That appearance is not valid.');

  const existing = await listMyCharacters(uid);
  const gate = canCreateCharacter(existing);
  if (!gate.allowed) {
    throw fail('character-limit', `This account already has ${gate.limit} characters.`);
  }

  const characterId = newCharacterId();
  const document = characterDocument({
    characterId, owner: uid, name: cleanName, appearance: cleanAppearance,
  });
  const { sdk, db } = await loadFirestore();
  await withTimeout(
    sdk.setDoc(sdk.doc(db, ...characterPath(uid, characterId)), document),
    'creating the character did not complete',
  );
  return summarizeCharacter(document, characterId);
}
