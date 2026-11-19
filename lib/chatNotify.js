// Browser notifications are opt-in and intentionally generic: they never carry
// message text, a sender name or a profile handle. They are a foreground-tab
// convenience, not OS push while the browser is closed.
export const NOTIFY_KEY = 'scw-chat-notify-v1';

function storeOf(storage) {
  if (storage) return storage;
  return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
}

export function readNotifyPref(address, storage = undefined) {
  const owner = String(address || '').toUpperCase();
  if (!owner) return false;
  try {
    const parsed = JSON.parse(storeOf(storage)?.getItem(NOTIFY_KEY) || '{}');
    return parsed?.[owner] === true;
  } catch {
    return false;
  }
}

export function writeNotifyPref(address, enabled, storage = undefined) {
  const owner = String(address || '').toUpperCase();
  const store = storeOf(storage);
  if (!owner || !store) return false;
  try {
    const parsed = JSON.parse(store.getItem(NOTIFY_KEY) || '{}');
    const next = parsed && typeof parsed === 'object' ? { ...parsed } : {};
    if (enabled) next[owner] = true;
    else delete next[owner];
    store.setItem(NOTIFY_KEY, JSON.stringify(next));
    return enabled === true;
  } catch {
    return false;
  }
}

export function notificationSupported() {
  return typeof globalThis.Notification !== 'undefined';
}

export async function requestNotificationPermission() {
  if (!notificationSupported()) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try {
    return await Notification.requestPermission() === 'granted';
  } catch {
    return false;
  }
}

export function showEncryptedNotification() {
  if (!notificationSupported() || Notification.permission !== 'granted') return false;
  try {
    new Notification('New encrypted message', {
      body: 'Open NSAT to decrypt it on this device.',
      tag: 'nsat-chat',
      renotify: false,
    });
    return true;
  } catch {
    return false;
  }
}
