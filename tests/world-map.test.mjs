import test from 'node:test';
import assert from 'node:assert/strict';
import {
  T_BUILDING, T_WATER, TILE,
  isWalkablePixel, isWalkableTile, mapForCity, moveWithCollision,
  nearestWalkable, resetMapCache, spawnForCharacter, tileAt, tileCensus,
} from '../lib/worldMap.js';

const CITIES = [
  { id: 'bangkok', width: 1280, height: 960 },
  { id: 'chiang-mai', width: 1024, height: 768 },
  { id: 'phuket', width: 1024, height: 768 },
  { id: 'singapore', width: 1152, height: 864 },
];

test('each city map matches its declared pixel bounds', () => {
  for (const city of CITIES) {
    const map = mapForCity(city);
    assert.equal(map.width, city.width, `${city.id} width`);
    assert.equal(map.height, city.height, `${city.id} height`);
    assert.equal(map.cols * TILE, city.width);
    assert.equal(map.rows * TILE, city.height);
    assert.equal(map.tiles.length, map.cols * map.rows);
  }
});

test('a map is deterministic for the same city', () => {
  resetMapCache();
  const first = mapForCity(CITIES[0]);
  resetMapCache();
  const second = mapForCity(CITIES[0]);
  assert.deepEqual(Array.from(first.tiles), Array.from(second.tiles));
});

test('every city has real variety, not one repeated tile', () => {
  for (const city of CITIES) {
    const map = mapForCity(city);
    const census = tileCensus(map);
    const walkableCount = Object.entries(census)
      .filter(([kind]) => isWalkableTile(Number(kind)))
      .reduce((sum, [, count]) => sum + count, 0);
    assert.ok(Object.keys(census).length >= 5, `${city.id} has ${Object.keys(census).length} tile kinds`);
    assert.ok(walkableCount / map.tiles.length > 0.5, `${city.id} is mostly walkable`);
    assert.ok((census[T_BUILDING] || 0) > 0, `${city.id} has buildings`);
    assert.ok((census[T_WATER] || 0) > 0, `${city.id} has water`);
  }
});

test('outside the map is never walkable', () => {
  const map = mapForCity(CITIES[0]);
  assert.equal(tileAt(map, -1, 0), T_WATER);
  assert.equal(tileAt(map, 0, -1), T_WATER);
  assert.equal(tileAt(map, map.cols, 0), T_WATER);
  assert.equal(isWalkablePixel(map, -20, 20), false);
});

test('water and buildings block a foot box', () => {
  const map = mapForCity(CITIES[0]);
  let water = null;
  let building = null;
  for (let r = 0; r < map.rows && (!water || !building); r += 1) {
    for (let c = 0; c < map.cols && (!water || !building); c += 1) {
      const kind = tileAt(map, c, r);
      const point = { x: c * TILE + TILE / 2, y: r * TILE + TILE / 2 };
      if (kind === T_WATER && !water && isWalkablePixel(map, point.x, point.y) === false) water = point;
      if (kind === T_BUILDING && !building) building = point;
    }
  }
  assert.ok(water, 'a water tile exists');
  assert.ok(building, 'a building tile exists');
  assert.equal(isWalkablePixel(map, water.x, water.y), false);
  assert.equal(isWalkablePixel(map, building.x, building.y), false);
});

test('walking into a wall stops that axis but slides along it', () => {
  const map = {
    v: 1, city: 'test', cols: 10, rows: 10, width: 320, height: 320, tile: TILE,
    tiles: new Uint8Array(100),
  };
  map.tiles[5 * 10 + 5] = T_BUILDING;
  // Standing left of the building, on grass.
  assert.equal(isWalkablePixel(map, 150, 176), true);
  const blocked = moveWithCollision(map, 150, 176, 20, 0);
  assert.equal(blocked.x, 150, 'the x step into the wall is refused');
  const slid = moveWithCollision(map, 150, 176, 20, 4);
  assert.equal(slid.x, 150, 'x is still refused');
  assert.equal(slid.y, 180, 'y still moves, so the player slides');
  // A clear step is accepted.
  const free = moveWithCollision(map, 60, 60, 8, 0);
  assert.equal(free.x, 68);
});

test('spawn is always inside the city and on legal ground', () => {
  for (const city of CITIES) {
    const map = mapForCity(city);
    const ids = ['ch_' + '0'.repeat(32), 'ch_' + 'a'.repeat(32), 'ch_0123456789abcdef0123456789abcdef'];
    for (const id of ids) {
      const spawn = spawnForCharacter(map, id);
      assert.ok(spawn.x > 0 && spawn.x < map.width, `${city.id} x in bounds`);
      assert.ok(spawn.y > 0 && spawn.y < map.height, `${city.id} y in bounds`);
      assert.equal(isWalkablePixel(map, spawn.x, spawn.y), true,
        `${city.id} spawn ${spawn.x},${spawn.y} is walkable`);
    }
  }
});

test('nearestWalkable rescues a position inside a building', () => {
  const map = mapForCity(CITIES[3]);
  let inside = null;
  for (let r = 0; r < map.rows && !inside; r += 1) {
    for (let c = 0; c < map.cols && !inside; c += 1) {
      if (tileAt(map, c, r) === T_BUILDING && isWalkablePixel(map, c * TILE + 16, r * TILE + 16) === false) {
        inside = { x: c * TILE + 16, y: r * TILE + 16 };
      }
    }
  }
  assert.ok(inside, 'a solid building tile exists');
  const rescued = nearestWalkable(map, inside.x, inside.y);
  assert.equal(isWalkablePixel(map, rescued.x, rescued.y), true);
});
