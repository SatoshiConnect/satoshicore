// chrome.storage.local-backed wallet storage for the extension popup.
//
// lib/nsatWallet.js persists the keystore + history through a synchronous
// getItem/setItem surface. A popup lives for exactly as long as it is open,
// so this adapter hydrates an in-memory map ONCE at popup open (before React
// mounts) and mirrors every subsequent write to chrome.storage.local —
// the extension's isolated, per-extension storage area (no page origin can
// read it, and it survives browser restarts).
//
// SECURITY: only AES-GCM ciphertext (the keystore blob) and public history
// entries ever cross this layer — plaintext seeds exist only in React state
// while unlocked, exactly like the web wallet. Closing the popup destroys
// that state entirely.

const PREFIX = 'scw-web-';

// A `chrome.storage.StorageArea`-shaped object: async get(null) / set(obj).
export function createWalletStorage(area) {
  const mem = new Map();
  return {
    async hydrate() {
      mem.clear();
      const all = await area.get(null);
      for (const [k, v] of Object.entries(all || {})) {
        if (typeof v === 'string' && k.startsWith(PREFIX)) mem.set(k, v);
      }
    },
    getItem(k) {
      return mem.has(k) ? mem.get(k) : null;
    },
    setItem(k, v) {
      mem.set(k, v);
      // Durability: persist immediately. A persist failure must not corrupt
      // the in-memory view the popup is using; it is surfaced on the console
      // and the next popup open re-hydrates from whatever was last written.
      area.set({ [k]: v }).catch((err) => {
        console.error('wallet storage persist failed:', err);
      });
    },
  };
}
