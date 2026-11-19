// Conversation search is local: it filters the chat list this device already
// knows and never queries the relay or another account. Matching is
// case-insensitive over the display name, the @handle and the wallet address.
export function normalizeConversationQuery(value) {
  return typeof value === 'string'
    ? value.trim().replace(/^@/, '').toLowerCase()
    : '';
}

export function conversationMatches({ address = '', handle = '', name = '' } = {}, query) {
  const needle = normalizeConversationQuery(query);
  if (!needle) return true;
  return [name, handle, address]
    .map((value) => String(value || '').trim().replace(/^@/, '').toLowerCase())
    .some((value) => value.includes(needle));
}

/** Filter in the caller's order, so pinned-first ordering is preserved. */
export function filterConversations(entries, query, describe = (entry) => entry) {
  const needle = normalizeConversationQuery(query);
  if (!needle) return [...(entries || [])];
  return (entries || []).filter((entry) => conversationMatches(describe(entry), query));
}
