// Retry timing for the chat event stream.
//
// The stream is a wake-up signal, not the message transport: every message still
// goes through the signed fetch and local decrypt path. That means a reconnect
// can be slow and conservative — what it must never be is a fixed 3-second loop,
// which turns one rate-limited handshake into twenty more requests a minute and
// keeps the client inside the limit that caused the first refusal.
//
// Delays grow exponentially from a base, carry jitter so many tabs do not retry
// in lockstep, and never undercut a `Retry-After` the server sent.
export const SSE_BASE_DELAY_MS = 1000;
export const SSE_MAX_DELAY_MS = 30_000;
// Several frames can describe one change (a message plus its read receipt).
// Coalescing them keeps a chatty peer from turning each frame into a mailbox read.
export const POLL_COALESCE_MS = 1500;

/** Milliseconds the server asked us to wait, from any field we may have set. */
export function retryAfterMsOf(error) {
  const direct = Number(error?.retryAfterMs);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const seconds = Number(error?.retryAfter);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const header = Number(error?.headers?.['retry-after']);
  if (Number.isFinite(header) && header > 0) return header * 1000;
  return 0;
}

/**
 * Delay before retry number `attempt` (0 = first retry after a failure).
 *
 * `random` is injectable so the growth and the jitter bounds can be asserted
 * deterministically. A `Retry-After` from the server wins over our schedule.
 */
export function nextReconnectDelay(attempt, {
  retryAfterMs = 0,
  random = Math.random,
  base = SSE_BASE_DELAY_MS,
  max = SSE_MAX_DELAY_MS,
} = {}) {
  const step = Math.min(max, base * 2 ** Math.max(0, Number(attempt) || 0));
  const draw = Math.min(1, Math.max(0, Number(random()) || 0));
  // 50–100% of the step: a wide enough spread that a room full of tabs does not
  // reconnect together, without waiting longer than the step itself.
  const jittered = step * (0.5 + draw * 0.5);
  return Math.max(jittered, Number(retryAfterMs) || 0);
}
