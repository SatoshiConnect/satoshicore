// Movement is clamped and speed-budgeted, not simulated. These cases pin the
// three ways a client could otherwise lie: outside the map, farther than a walk
// in the elapsed time, and a nonsense payload.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DISTANCE_TOLERANCE, FACINGS, MAX_SPEED, MAX_STEP_MS, applyMove, clampPosition, normalizeFacing, spawnPoint,
} from '../lib/movement.mjs';

const city = { id: 'bangkok', width: 1280, height: 960 };
const at = (ms) => 1_700_000_000_000 + ms;

test('spawn points are stable, in bounds and spread out', () => {
  const a = spawnPoint('ch_' + 'ab'.repeat(16), city);
  const b = spawnPoint('ch_' + 'ab'.repeat(16), city);
  assert.deepEqual(a, b);
  assert.ok(a.x >= 0 && a.x < city.width);
  assert.ok(a.y >= 0 && a.y < city.height);
  const other = spawnPoint('ch_' + 'cd'.repeat(16), city);
  assert.notDeepEqual(a, other);
});

test('positions are clamped to the playable rectangle', () => {
  assert.deepEqual(clampPosition({ x: -40, y: 5000 }, city), { x: 0, y: city.height - 1 });
  assert.deepEqual(clampPosition({ x: Number.NaN, y: 10 }, city), { x: 0, y: 10 });
});

test('facing is one of four values', () => {
  assert.deepEqual([...FACINGS], ['down', 'left', 'right', 'up']);
  assert.equal(normalizeFacing('up'), 'up');
  assert.equal(normalizeFacing('sideways'), 'down');
  assert.equal(normalizeFacing(undefined), 'down');
});

test('the first packet after a join is clamped and accepted', () => {
  const result = applyMove({ x: 9999, y: -5, facing: 'left', now: at(0), reference: null, city });
  assert.equal(result.ok, true);
  assert.equal(result.x, city.width - 1);
  assert.equal(result.y, 0);
  assert.equal(result.facing, 'left');
});

test('a step within the walking budget is accepted', () => {
  const reference = { at: at(0), x: 100, y: 100 };
  const result = applyMove({
    x: 100 + MAX_SPEED * 0.5, y: 100, facing: 'right', now: at(500), reference, city,
  });
  assert.equal(result.ok, true);
  assert.equal(result.distance, MAX_SPEED * 0.5);
});

test('a teleport is refused, including a replayed old packet', () => {
  const reference = { at: at(0), x: 100, y: 100 };
  const jump = applyMove({ x: 900, y: 100, facing: 'right', now: at(16), reference, city });
  assert.equal(jump.ok, false);
  assert.equal(jump.reason, 'too-far');
  // The same distance is fine when the elapsed time actually allows it.
  const walk = applyMove({ x: 900, y: 100, facing: 'right', now: at(6000), reference, city });
  assert.equal(walk.ok, true);
});

test('elapsed time is measured by the server and capped for arithmetic', () => {
  const reference = { at: at(0), x: 100, y: 100 };
  // A very long gap is still bounded, so the budget cannot overflow.
  const result = applyMove({ x: 1200, y: 100, facing: 'right', now: at(600_000), reference, city });
  assert.equal(result.ok, true);
  assert.ok(result.distance <= (MAX_SPEED * MAX_STEP_MS) / 1000 + DISTANCE_TOLERANCE);
});

test('non-numeric payloads are refused', () => {
  assert.equal(applyMove({ x: 'a', y: 0, now: at(0), reference: null, city }).ok, false);
  assert.equal(applyMove({ x: Infinity, y: 0, now: at(0), reference: null, city }).ok, false);
});
