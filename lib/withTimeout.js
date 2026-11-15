// A deadline for database calls.
//
// Firestore does not fail fast when the backend cannot serve a request: a
// disabled API, a blocked network or an unconfirmed rules deploy makes the SDK
// queue the write and retry it in the background, so the promise never settles.
// A UI that awaits it stays disabled forever, which reads as "frozen" rather
// than "failed" — exactly what happened on the deployed site while the Cloud
// Firestore API was still disabled for the project.
//
// The message is deliberately about confirmation, not deletion: a timed-out
// write may still land after the deadline, so callers must not claim nothing
// was saved. Reads of the stored value on next load are the authority.
export const DB_TIMEOUT_MS = 12_000;

export function withTimeout(promise, message = 'the site database did not answer', ms = DB_TIMEOUT_MS) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
