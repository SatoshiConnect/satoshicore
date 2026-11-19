// E2EE control messages: edit and reaction instructions travel inside the same
// encrypted envelope as a normal message. The relay never sees the target text
// or the emoji; it only stores one more ciphertext row. A control row is hidden
// from the transcript and acknowledged after it has been applied.
export const CONTROL_PREFIX = '\u0001nsat-control-v1:';
const MAX_EMOJI = 8;
const MAX_EDIT = 4000;

export function encodeControl(control) {
  const kind = control?.kind;
  const id = Number(control?.id);
  if (!['edit', 'reaction'].includes(kind)) throw new Error('Unknown chat control.');
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('A control needs a message id.');
  const payload = { kind, id };
  if (kind === 'edit') {
    const text = String(control?.text ?? '').trim();
    if (!text) throw new Error('An edit needs text.');
    if (text.length > MAX_EDIT) throw new Error('Edited text is too long.');
    payload.text = text;
  } else {
    const emoji = String(control?.emoji ?? '').trim();
    if (emoji.length > MAX_EMOJI) throw new Error('Reaction is too long.');
    payload.emoji = emoji;
  }
  return CONTROL_PREFIX + JSON.stringify(payload);
}

export function decodeControl(text) {
  const raw = String(text ?? '');
  if (!raw.startsWith(CONTROL_PREFIX)) return null;
  let parsed;
  try { parsed = JSON.parse(raw.slice(CONTROL_PREFIX.length)); } catch { return null; }
  if (!parsed || !['edit', 'reaction'].includes(parsed.kind)) return null;
  const id = Number(parsed.id);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  if (parsed.kind === 'edit') {
    const body = String(parsed.text ?? '').trim();
    if (!body || body.length > MAX_EDIT) return null;
    return { kind: 'edit', id, text: body };
  }
  const emoji = String(parsed.emoji ?? '').trim();
  if (emoji.length > MAX_EMOJI) return null;
  return { kind: 'reaction', id, emoji };
}
