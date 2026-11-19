// Reading a character document with the caller's own credential.
//
// The world server has no service account and no admin bypass. It reads
// `characters/{uid}/list/{characterId}` from the Firestore REST API using the
// same ID token the browser presented, so firestore.rules decides what is
// visible — exactly as it would for the page. A document the rules hide is
// indistinguishable from one that does not exist, which is the behaviour we want
// for a game server: it cannot enumerate what a player may not see.
//
// Only the fields the world needs are decoded, and nothing is written back.
export const FIRESTORE_BASE = 'https://firestore.googleapis.com/v1';

function decodeValue(value) {
  if (!value || typeof value !== 'object') return null;
  if ('nullValue' in value) return null;
  if ('stringValue' in value) return value.stringValue;
  if ('booleanValue' in value) return value.booleanValue === true;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('timestampValue' in value) return value.timestampValue;
  if ('mapValue' in value) return decodeFields(value.mapValue?.fields || {});
  if ('arrayValue' in value) return (value.arrayValue?.values || []).map(decodeValue);
  return null;
}

export function decodeFields(fields = {}) {
  const out = {};
  for (const [key, value] of Object.entries(fields)) out[key] = decodeValue(value);
  return out;
}

export function characterDocumentPath(uid, characterId) {
  return `/documents/characters/${encodeURIComponent(uid)}/list/${encodeURIComponent(characterId)}`;
}

export function createFirestoreReader({
  projectId, fetchImpl = globalThis.fetch, base = FIRESTORE_BASE,
} = {}) {
  if (typeof projectId !== 'string' || !projectId) {
    throw new Error('A Firebase project id is required to read characters.');
  }
  const root = `${base}/projects/${encodeURIComponent(projectId)}/databases/(default)`;

  return async function readCharacter({ idToken, uid, characterId } = {}) {
    if (typeof idToken !== 'string' || !idToken) throw new Error('no-id-token');
    if (typeof uid !== 'string' || !uid) throw new Error('no-uid');
    if (typeof characterId !== 'string' || !characterId) throw new Error('no-character-id');
    const response = await fetchImpl(`${root}${characterDocumentPath(uid, characterId)}`, {
      headers: { authorization: `Bearer ${idToken}`, accept: 'application/json' },
    });
    // 403 means the rules denied the read; to this service that is the same as
    // "not yours", never an error the caller can distinguish.
    if (response.status === 404 || response.status === 403) return null;
    if (!response.ok) {
      const error = new Error(`firestore read failed with ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const body = await response.json();
    const fields = decodeFields(body?.fields || {});
    if (!fields.characterId) return null;
    return fields;
  };
}
