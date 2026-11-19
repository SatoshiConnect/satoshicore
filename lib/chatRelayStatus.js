// Chat failures need a plain explanation, not a raw fetch error. This module
// only classifies and words the message; it does not retry or queue anything.
import { retryAfterMsOf } from './chatRetry.js';

export function describeChatFailure(error, { action = 'read' } = {}) {
  const raw = String(error?.message || error || '').trim();
  // A transport limit is a "wait", not a broken conversation: the client backs
  // off and reconnects, and no message is lost. Saying so stops people from
  // pressing the same button into the same window.
  if (Number(error?.status) === 429) {
    const wait = retryAfterMsOf(error);
    const seconds = wait > 0 ? Math.max(1, Math.round(wait / 1000)) : 0;
    const after = seconds > 0 ? `about ${seconds} s` : 'a moment';
    return {
      kind: 'rate-limited',
      title: 'Chat is busy right now',
      // Only the stream and the outbox retry by themselves. A room the person
      // opened is retried by the person, so the wording says exactly that
      // instead of promising an automatic reopen that does not happen.
      message: action === 'read'
        ? `The chat server asked this device to slow down. Nothing was lost — wait ${after}, then open the chat again.`
        : `The chat server asked this device to slow down. Nothing was lost; it retries automatically in ${after}.`,
      retry: true,
      retryAfterMs: wait,
    };
  }
  const offline = /failed to fetch|networkerror|network error|offline|load failed|econnrefused|unreachable|timed? ?out|timeout/i
    .test(raw);

  if (offline) {
    return {
      kind: 'offline',
      title: 'Chat server unreachable',
      message: action === 'send'
        ? 'Your message was not sent and nothing was queued. Your draft is still here; check your connection and press Send again.'
        : 'Your last messages stay visible and nothing was removed. Check your connection, then try again.',
      retry: action !== 'send',
    };
  }

  return {
    kind: 'error',
    title: action === 'send' ? 'Message not sent' : 'Chat could not be opened',
    message: raw || 'The chat service returned an error. Nothing was queued.',
    retry: action !== 'send',
  };
}

