// Movement validation, kept pure so it can be tested without a socket.
//
// The client sends a position, not an intent stream, so the server does not
// simulate walking. It does three things instead:
//
//   1. clamps the position into the city's playable rectangle;
//   2. refuses a step farther than a walking character could have travelled in
//      the elapsed time (a teleport, a speed hack, or a replayed old packet);
//   3. normalises facing to one of four values.
//
// That is enough for a social room where nothing is contested. If gameplay ever
// depends on position (doors, payments at a location), the server must own the
// simulation instead of trusting a reported point — see
// docs/SUPERAPP-INTEGRATION-AUDIT.md.
export const FACINGS = Object.freeze(['down', 'left', 'right', 'up']);
// World pixels per second. A little above the walk animation so ordinary
// latency does not trip the budget.
export const MAX_SPEED = 150;
// Slack for one late packet, in world pixels.
export const DISTANCE_TOLERANCE = 24;
// Upper bound for one packet's elapsed time. `now` is the server's clock, so
// this only keeps the arithmetic finite (a hot loop after a machine suspend).
export const MAX_STEP_MS = 60_000;
export const MIN_STEP_MS = 16;

const ABSENT = Object.freeze({ ok: false, reason: 'absent' });

function hash32(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** A stable spawn point for a character, so rejoining feels like coming back. */
export function spawnPoint(characterId, city) {
  const h = hash32(String(characterId || ''));
  const pad = 64;
  const width = Math.max(city.width - pad * 2, 1);
  const height = Math.max(city.height - pad * 2, 1);
  return {
    x: pad + (h % width),
    y: pad + ((h >>> 11) % height),
  };
}

export function clampPosition({ x, y }, city) {
  const maxX = Math.max(city.width - 1, 0);
  const maxY = Math.max(city.height - 1, 0);
  return {
    x: Math.min(Math.max(Number.isFinite(x) ? x : 0, 0), maxX),
    y: Math.min(Math.max(Number.isFinite(y) ? y : 0, 0), maxY),
  };
}

export function normalizeFacing(value) {
  if (value === 'up' || value === 'left' || value === 'right') return value;
  return 'down';
}

/**
 * Validate one movement packet.
 *
 * `reference` is the last accepted position and the time it was accepted. The
 * first packet after a join has no meaningful reference, so it is clamped and
 * accepted; later packets must fit the walking budget.
 */
export function applyMove({ x, y, facing, now, reference, city }) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { ...ABSENT, reason: 'not-a-number' };
  if (!reference) {
    const at = clampPosition({ x, y }, city);
    return { ok: true, x: at.x, y: at.y, facing: normalizeFacing(facing), distance: 0 };
  }
  const elapsed = Math.min(
    Math.max(now - reference.at, MIN_STEP_MS),
    MAX_STEP_MS,
  );
  const allowed = (MAX_SPEED * elapsed) / 1000 + DISTANCE_TOLERANCE;
  const target = clampPosition({ x, y }, city);
  const distance = Math.hypot(target.x - reference.x, target.y - reference.y);
  if (distance > allowed) {
    return { ok: false, reason: 'too-far', distance, allowed };
  }
  return {
    ok: true,
    x: target.x,
    y: target.y,
    facing: normalizeFacing(facing),
    distance,
  };
}
