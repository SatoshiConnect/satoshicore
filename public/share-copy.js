'use strict';

// Decode the bounded share payload and render only as text. URLs become links
// only for http(s); no content is interpreted as HTML or JavaScript.
function decodePayload(encoded) {
  const text = String(encoded || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = text + '='.repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function renderShare() {
  const content = document.getElementById('share-content');
  if (!content) return;
  try {
    const shared = decodePayload(content.dataset.share);
    for (const value of [shared.title, shared.text]) {
      if (!value) continue;
      const p = document.createElement(shared.title === value ? 'strong' : 'p');
      p.textContent = value;
      content.append(p);
    }
    if (shared.url) {
      const p = document.createElement('p');
      try {
        const url = new URL(shared.url);
        if (url.protocol === 'https:' || url.protocol === 'http:') {
          const a = document.createElement('a');
          a.href = url.href;
          a.target = '_blank';
          a.rel = 'noreferrer';
          a.textContent = shared.url;
          p.append(a);
        } else p.textContent = shared.url;
      } catch { p.textContent = shared.url; }
      content.append(p);
    }
  } catch {
    content.textContent = 'Could not read the shared content.';
  }
}

renderShare();
document.addEventListener('click', async (event) => {
  const button = event.target?.closest?.('#copy[data-share]');
  if (!button) return;
  const status = document.getElementById('status');
  try {
    const shared = decodePayload(button.dataset.share);
    const value = [shared.title, shared.text, shared.url].map((part) => String(part || '').trim()).filter(Boolean).join('\n\n');
    await navigator.clipboard.writeText(value);
    if (status) status.textContent = 'Copied to clipboard.';
    button.textContent = 'Copied';
  } catch {
    if (status) status.textContent = 'Could not copy. Select the shared text and copy it manually.';
  }
});
