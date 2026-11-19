// Generate the Web Push (VAPID) keypair used by the chat relay.
//
//   node scripts/generate-vapid-keys.mjs
//
// The PUBLIC key is safe to ship in the web build (it is how a browser verifies
// that a push really came from this deployment). The PRIVATE key must stay on
// the gateway host and never enter the repository, a build artifact or a chat
// message. Rotating the pair invalidates every existing subscription: devices
// re-subscribe the next time somebody opens the chat and turns alerts on.
import { generateVAPIDKeys } from 'web-push';

const { publicKey, privateKey } = generateVAPIDKeys();

console.log('# Public: build-time value for the web app (safe to publish).');
console.log(`NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY=${publicKey}`);
console.log('');
console.log('# Private: gateway only. Keep it out of the repo and out of build output.');
console.log(`NSAT_VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`NSAT_VAPID_PRIVATE_KEY=${privateKey}`);
console.log('NSAT_VAPID_SUBJECT=mailto:noreply@satoshicore.org');
