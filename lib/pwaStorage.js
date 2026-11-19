// Device-local storage status for the PWA. Values come only from the browser;
// they are not sent to the gateway and never include the contents of storage.

export function formatStorageBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unknown';
  if (bytes < 1024) return `${Math.floor(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = bytes / 1024;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount < 10 ? amount.toFixed(1) : Math.round(amount)} ${units[index]}`;
}

export async function readPwaStorage(storage = globalThis.navigator?.storage) {
  if (!storage || typeof storage.estimate !== 'function') {
    return { supported: false, usage: null, quota: null, persisted: null };
  }
  const [estimate, persisted] = await Promise.all([
    storage.estimate().catch(() => ({})),
    typeof storage.persisted === 'function'
      ? storage.persisted().catch(() => null)
      : Promise.resolve(null),
  ]);
  const usage = Number.isFinite(estimate?.usage) ? estimate.usage : null;
  const quota = Number.isFinite(estimate?.quota) ? estimate.quota : null;
  return { supported: true, usage, quota, persisted };
}

/** Call only from the user's explicit button gesture; persistence is a request. */
export async function requestPwaPersistence(storage = globalThis.navigator?.storage) {
  if (!storage || typeof storage.persist !== 'function') return false;
  try {
    return (await storage.persist()) === true;
  } catch {
    return false;
  }
}

export function storageUsagePercent({ usage, quota }) {
  const used = Number(usage);
  const total = Number(quota);
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null;
  return Math.max(0, Math.min(100, (used / total) * 100));
}
