// Replies are ordinary encrypted message text: the relay sees the same
// envelope it already accepts. The quote is sender-provided context, not a
// verified copy of another message; it is rendered as a quotation, never as
// trusted wallet or transaction data.
import { MAX_TEXT_LENGTH } from './e2eChat.js';

const PREFIX = 'NSAT-REPLY/1\n';
export const MAX_REPLY_QUOTE = 200;
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

const invalid = (reason) => ({ kind: 'invalid', reason });

export function createReplyText({ to, quote, text } = {}) {
  const id = typeof to === 'string' ? to.trim() : '';
  const quoted = typeof quote === 'string' ? quote.trim() : '';
  const body = typeof text === 'string' ? text.trim() : '';
  if (!ID_RE.test(id)) throw new Error('A reply needs the message it answers.');
  if (!quoted) throw new Error('A reply needs a quote.');
  if (quoted.length > MAX_REPLY_QUOTE) {
    throw new Error(`A reply quote is limited to ${MAX_REPLY_QUOTE} characters.`);
  }
  if (!body) throw new Error('A reply cannot be empty.');
  const payload = `${PREFIX}${JSON.stringify({ to: id, quote: quoted, text: body })}`;
  if (payload.length > MAX_TEXT_LENGTH) {
    throw new Error(`A reply is limited to ${MAX_TEXT_LENGTH} characters, including the quote.`);
  }
  return payload;
}

/** `null` means ordinary chat text; malformed markers stay visible but inert. */
export function parseReplyText(text) {
  if (typeof text !== 'string' || !text.startsWith(PREFIX)) return null;
  let data;
  try {
    data = JSON.parse(text.slice(PREFIX.length));
  } catch {
    return invalid('This reply is malformed and cannot be shown as a quote.');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)
      || Object.keys(data).sort().join(',') !== 'quote,text,to') {
    return invalid('This reply has an unexpected shape.');
  }
  const id = typeof data.to === 'string' ? data.to.trim() : '';
  const quote = typeof data.quote === 'string' ? data.quote.trim() : '';
  const body = typeof data.text === 'string' ? data.text.trim() : '';
  if (!ID_RE.test(id) || !quote || quote.length > MAX_REPLY_QUOTE || !body) {
    return invalid('This reply has invalid fields.');
  }
  if (text.length > MAX_TEXT_LENGTH) return invalid('This reply is too long.');
  return { kind: 'reply', to: id, quote, text: body };
}

/**
 * The human-readable body for copy, forward, previews and nested quotes. A
 * malformed marker is left as-is so it is not silently reinterpreted.
 */
export function displayMessageText(text) {
  const parsed = parseReplyText(text);
  return parsed?.kind === 'reply' ? parsed.text : text;
}
