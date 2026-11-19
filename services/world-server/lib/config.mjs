// Configuration comes from the environment, and a missing security value stops
// the service instead of silently running without it.
//
// There is no default ticket secret and no "skip auth" switch: a world server
// that starts without them would accept joins from anyone, so a misconfiguration
// is a startup failure with a readable reason.
export const DEFAULT_PORT = 8790;
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_TICKET_TTL_MS = 60_000;

export function loadConfig(env = process.env) {
  const port = Number(env.WORLD_PORT || env.PORT || DEFAULT_PORT);
  const host = String(env.WORLD_HOST || DEFAULT_HOST);
  const projectId = String(env.FIREBASE_PROJECT_ID || '').trim();
  const ticketSecret = String(env.WORLD_TICKET_SECRET || '');
  const ttl = Number(env.WORLD_TICKET_TTL_MS || DEFAULT_TICKET_TTL_MS);
  // Development-only read-only view. Off unless an operator turns it on, and the
  // route also refuses anything that is not loopback.
  const devSpectator = String(env.WORLD_DEV_SPECTATOR || '') === '1';
  const allowedOrigins = String(env.WORLD_ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  const problems = [];
  if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(projectId)) {
    problems.push('FIREBASE_PROJECT_ID must be the Firebase project id (for example satoshicore).');
  }
  if (ticketSecret.length < 32) {
    problems.push('WORLD_TICKET_SECRET must be at least 32 characters (generate one with `openssl rand -hex 32`).');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push('WORLD_PORT must be a TCP port between 1 and 65535.');
  }
  if (!Number.isInteger(ttl) || ttl < 5_000 || ttl > 600_000) {
    problems.push('WORLD_TICKET_TTL_MS must be between 5000 and 600000.');
  }

  return {
    port, host, projectId, ticketSecret, allowedOrigins, ticketTtlMs: ttl,
    devSpectator, problems,
    // Bind on loopback unless an operator deliberately exposes the service.
    exposed: host !== '127.0.0.1' && host !== 'localhost',
  };
}
