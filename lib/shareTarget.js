// Parse PWA Share Target parameters as untrusted plain text. The caller may
// display/copy these strings, but must not execute markup or auto-navigate to
// the supplied URL.
export const SHARE_LIMITS = Object.freeze({ title: 200, text: 5_000, url: 2_048 });

function bounded(value, max) {
  return String(value || '').trim().slice(0, max);
}

export function parseShareTarget(search = '') {
  const params = search instanceof URLSearchParams
    ? search
    : new URLSearchParams(String(search || '').replace(/^\?/, ''));
  const title = bounded(params.get('title'), SHARE_LIMITS.title);
  const text = bounded(params.get('text'), SHARE_LIMITS.text);
  const rawUrl = bounded(params.get('url'), SHARE_LIMITS.url);
  let safeUrl = '';
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') safeUrl = parsed.href;
  } catch {
    // URLs from other apps are data, not instructions; show them as plain text.
  }
  return { title, text, url: rawUrl, safeUrl };
}

export function sharePageForShortcut(value) {
  return ({ wallet: 'overview', chat: 'chat', receive: 'receive' })[String(value || '')] || null;
}

export function shareText({ title = '', text = '', url = '' } = {}) {
  return [title, text, url].map((part) => String(part || '').trim()).filter(Boolean).join('\n\n');
}
