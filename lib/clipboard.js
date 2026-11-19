// Clipboard access is a browser capability, not a guarantee: it is missing on
// insecure origins, denied by permission, and unavailable in some embedded
// browsers. Keep the check and the error in one place so the UI can report a
// failure instead of pretending the copy succeeded.
export async function copyTextToClipboard(value, { clipboard } = {}) {
  const target = clipboard
    || (typeof navigator !== 'undefined' ? navigator.clipboard : null);
  if (!target || typeof target.writeText !== 'function') {
    throw Object.assign(
      new Error('Clipboard is not available in this browser.'),
      { code: 'CLIPBOARD_UNAVAILABLE' },
    );
  }
  await target.writeText(String(value ?? ''));
}
