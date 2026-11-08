export async function waitForConfirmation(getVerdict, hash, {
  submittedAt, timeoutMs = 90_000, onUpdate,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let delay = 250;
  let attempts = 0;
  let last = null;
  while (Date.now() < deadline) {
    attempts += 1;
    try {
      const verdict = await getVerdict(hash, submittedAt);
      last = verdict;
      onUpdate?.(verdict);
      if (verdict.status === 'confirmed' || verdict.status === 'failed' || verdict.status === 'not_found') return verdict;
      if (verdict.status === 'unknown' && attempts >= 3) return verdict;
      delay = Math.min(1000, Math.round(delay * 1.4));
    } catch (error) {
      delay = error?.status === 429 ? Math.min(5000, delay * 3) : Math.min(3000, delay + 500);
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  return last ?? { hash, status: 'pending', reason: 'client_timeout' };
}
