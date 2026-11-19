// The city maps the Pixel World renders and the server collides against.
//
// These are authored layouts, generated deterministically from a city's id and
// bounds: a river or shoreline, a road grid, building blocks, parks and a plaza.
// They are *inspired* by the real cities only in shape (Bangkok has a river,
// Phuket has a shore) and are explicitly fictional game scenes — no building,
// road or coordinate here comes from OpenStreetMap or any other real dataset.
//
// One module, two consumers: the browser draws these tiles, and the world server
// uses the same bytes to decide whether a reported position is legal. Collision
// therefore cannot be bypassed by a modified page — the server refuses a step
// into a building or the water even when the client says it happened.
//
// Coordinates: world pixels, origin at the top-left of the city rectangle, one
// tile = TILE px. A character's position is the point at its feet, and its foot
// box is what collides — not the whole sprite — so walking behind a building
// still feels right.
export const TILE = 32;
export const MAP_VERSION = 1;

export const T_GRASS = 0;
export const T_PATH = 1;
export const T_ROAD = 2;
export const T_WATER = 3;
export const T_BUILDING = 4;
export const T_TREE = 5;
export const T_PLAZA = 6;
export const T_SAND = 7;
export const T_BRIDGE = 8;
export const T_FOUNTAIN = 9;

// Indexed by tile kind. Water, buildings, trees and the fountain block movement.
const WALKABLE = Object.freeze([
  true, // grass
  true, // path
  true, // road
  false, // water
  false, // building
  false, // tree
  true, // plaza
  true, // sand
  true, // bridge
  false, // fountain
]);

/** The collision footprint at a character's feet, in world pixels. */
export const FOOT = Object.freeze({ halfWidth: 9, height: 10 });

const LAYOUTS = Object.freeze({
  bangkok: Object.freeze({
    roadEvery: 6,
    river: Object.freeze({ axis: 'v', start: 0.5, width: 3 }),
    plaza: Object.freeze({ x: 0.34, y: 0.42, w: 4, h: 4 }),
    parkChance: 0.18,
  }),
  'chiang-mai': Object.freeze({
    roadEvery: 6,
    river: Object.freeze({ axis: 'h', start: 0.66, width: 2 }),
    plaza: Object.freeze({ x: 0.4, y: 0.3, w: 4, h: 3 }),
    parkChance: 0.3,
  }),
  phuket: Object.freeze({
    roadEvery: 5,
    sea: 'left',
    plaza: Object.freeze({ x: 0.5, y: 0.4, w: 3, h: 3 }),
    parkChance: 0.22,
  }),
  singapore: Object.freeze({
    roadEvery: 6,
    bay: Object.freeze({ x: 0.68, y: 0.66, w: 9, h: 7 }),
    plaza: Object.freeze({ x: 0.34, y: 0.36, w: 4, h: 4 }),
    parkChance: 0.2,
  }),
});

const DEFAULT_LAYOUT = Object.freeze({
  roadEvery: 6,
  plaza: Object.freeze({ x: 0.4, y: 0.4, w: 3, h: 3 }),
  parkChance: 0.2,
});

function hash32(text) {
  let h = 2166136261;
  for (let i = 0; i < String(text).length; i += 1) {
    h ^= String(text).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** A stable pseudo-random value in [0,1) from a seed and a coordinate. */
function noise(seed, c, r, salt = 0) {
  return (hash32(`${seed}:${c}:${r}:${salt}`) >>> 8) / 0x1000000;
}

function layoutFor(cityId) {
  return LAYOUTS[cityId] || DEFAULT_LAYOUT;
}

/**
 * Build one city's tile grid.
 *
 * The order is deliberate: water first (so roads over it become bridges), then
 * the road grid, then the plaza, then buildings only where the ground is still
 * plain grass. That keeps a building from ever being placed on a road or in the
 * river, which would cut the city in half.
 */
function buildCity(city, layout) {
  const cols = Math.max(1, Math.round(city.width / TILE));
  const rows = Math.max(1, Math.round(city.height / TILE));
  const tiles = new Uint8Array(cols * rows);
  const seed = String(city.id || 'city');
  const at = (c, r) => (c >= 0 && c < cols && r >= 0 && r < rows ? tiles[r * cols + c] : T_WATER);
  const set = (c, r, kind) => {
    if (c >= 0 && c < cols && r >= 0 && r < rows) tiles[r * cols + c] = kind;
  };
  const fillRect = (c0, r0, w, h, kind) => {
    for (let r = r0; r < r0 + h; r += 1) {
      for (let c = c0; c < c0 + w; c += 1) set(c, r, kind);
    }
  };

  // 1. Water. A river with banks, a sea edge, or a bay.
  if (layout.river) {
    const width = Math.max(2, layout.river.width);
    if (layout.river.axis === 'h') {
      const r0 = Math.round(rows * layout.river.start);
      fillRect(0, r0, cols, width, T_WATER);
    } else {
      const c0 = Math.round(cols * layout.river.start);
      fillRect(c0, 0, width, rows, T_WATER);
    }
  }
  if (layout.sea === 'left') {
    const shore = Math.max(3, Math.round(cols * 0.16));
    fillRect(0, 0, shore, rows, T_WATER);
    fillRect(shore, 0, 2, rows, T_SAND);
  }
  if (layout.bay) {
    const c0 = Math.round(cols * layout.bay.x);
    const r0 = Math.round(rows * layout.bay.y);
    fillRect(c0, r0, layout.bay.w, layout.bay.h, T_WATER);
    fillRect(c0 - 1, r0 - 1, layout.bay.w + 2, 1, T_SAND);
    fillRect(c0 - 1, r0 - 1, 1, layout.bay.h + 2, T_SAND);
  }

  // 2. Roads. A road that crosses water becomes a bridge, so every district
  //    stays reachable on foot.
  const roadEvery = Math.max(4, layout.roadEvery || 6);
  const roadCols = [];
  const roadRows = [];
  for (let c = 1; c < cols; c += roadEvery) roadCols.push(c);
  for (let r = 1; r < rows; r += roadEvery) roadRows.push(r);
  for (const c of roadCols) {
    for (let r = 0; r < rows; r += 1) {
      set(c, r, at(c, r) === T_WATER ? T_BRIDGE : T_ROAD);
    }
  }
  for (const r of roadRows) {
    for (let c = 0; c < cols; c += 1) {
      set(c, r, at(c, r) === T_WATER ? T_BRIDGE : T_ROAD);
    }
  }

  // 3. The plaza: a paved square with a fountain at its centre, always walkable
  //    around the water, and the fixed spawn area every character can reach.
  const plaza = layout.plaza || DEFAULT_LAYOUT.plaza;
  const plazaC = Math.min(Math.max(Math.round(cols * plaza.x), 1), Math.max(cols - plaza.w - 1, 1));
  const plazaR = Math.min(Math.max(Math.round(rows * plaza.y), 1), Math.max(rows - plaza.h - 1, 1));
  fillRect(plazaC, plazaR, plaza.w, plaza.h, T_PLAZA);
  const fountainC = plazaC + Math.floor(plaza.w / 2);
  const fountainR = plazaR + Math.floor(plaza.h / 2);
  set(fountainC, fountainR, T_FOUNTAIN);

  // 4. Blocks between roads: a building block, a park, or a small square.
  //    Everything here is procedurally placed and fictional.
  // Road lines sit at 1, 1+roadEvery, …; the interior between two of them is
  // exactly roadEvery-2 tiles wide, and that interior is what a block fills.
  for (let cellR = 2; cellR + 2 < rows; cellR += roadEvery) {
    for (let cellC = 2; cellC + 2 < cols; cellC += roadEvery) {
      const c0 = cellC;
      const r0 = cellR;
      const w = Math.min(roadEvery - 2, cols - c0);
      const h = Math.min(roadEvery - 2, rows - r0);
      if (w < 2 || h < 2) continue;

      const roll = noise(seed, cellC, cellR, 'block');
      let clean = true;
      for (let r = r0; r < r0 + h && clean; r += 1) {
        for (let c = c0; c < c0 + w && clean; c += 1) {
          if (at(c, r) !== T_GRASS) clean = false;
        }
      }
      if (!clean) continue;

      if (roll < (layout.parkChance || 0)) {
        // Park: grass with a ring of trees, a clearing in the middle.
        for (let r = r0; r < r0 + h; r += 1) {
          for (let c = c0; c < c0 + w; c += 1) {
            const edge = c === c0 || c === c0 + w - 1 || r === r0 || r === r0 + h - 1;
            set(c, r, edge && noise(seed, c, r, 'tree') < 0.72 ? T_TREE : T_GRASS);
          }
        }
        continue;
      }

      // Building block. The footprint is inset by one tile so a sidewalk of
      // grass visually separates it from the road; the door is a path tile at
      // the middle of the street-facing edge.
      fillRect(c0, r0, w, h, T_BUILDING);
      // A two-tile doorway on the street-facing edge: visually a shopfront, and
      // a legal standing tile so the sidewalk is not one long wall.
      const doorC = c0 + Math.floor(w / 2);
      set(doorC, r0 + h - 1, T_PATH);
      set(doorC - 1, r0 + h - 1, T_PATH);
    }
  }

  // 5. A few street trees on grass beside the roads, never on a road or plaza.
  for (let r = 1; r < rows - 1; r += 1) {
    for (let c = 1; c < cols - 1; c += 1) {
      if (at(c, r) !== T_GRASS) continue;
      if (noise(seed, c, r, 'street-tree') > 0.015) continue;
      const touchesRoad = at(c + 1, r) === T_ROAD || at(c - 1, r) === T_ROAD
        || at(c, r + 1) === T_ROAD || at(c, r - 1) === T_ROAD;
      if (touchesRoad) set(c, r, T_TREE);
    }
  }

  return {
    v: MAP_VERSION,
    city: String(city.id || ''),
    width: cols * TILE,
    height: rows * TILE,
    cols,
    rows,
    tile: TILE,
    tiles,
  };
}

const cache = new Map();

/**
 * The map for a city. `city` needs `{ id, width, height }`; the result is cached
 * per id so the browser and the tests do not rebuild it per frame.
 */
export function mapForCity(city) {
  const id = String(city && city.id ? city.id : '');
  if (!id) throw new Error('A city id is required for a map.');
  const cached = cache.get(id);
  if (cached) return cached;
  const map = buildCity(city, layoutFor(id));
  cache.set(id, map);
  return map;
}

/** Clear the cache. Tests use this; nothing in the app needs it. */
export function resetMapCache() {
  cache.clear();
}

export function tileAt(map, col, row) {
  if (!map || col < 0 || row < 0 || col >= map.cols || row >= map.rows) return T_WATER;
  return map.tiles[row * map.cols + col];
}

export function isWalkableTile(kind) {
  return Boolean(WALKABLE[kind]);
}

export function tileAtPixel(map, x, y) {
  return tileAt(map, Math.floor(x / TILE), Math.floor(y / TILE));
}

/**
 * Whether a foot box at `x,y` (x centre, y feet) stands entirely on walkable
 * tiles. Four corners are enough because every tile is uniformly solid.
 */
export function isWalkablePixel(map, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const half = FOOT.halfWidth;
  const top = y - FOOT.height;
  const points = [
    [x - half, top], [x + half, top],
    [x - half, y], [x + half, y],
    [x, top], [x, y],
  ];
  return points.every(([px, py]) => isWalkableTile(tileAtPixel(map, px, py)));
}

/**
 * Move a foot box by `dx,dy`, sliding along an obstacle instead of sticking to
 * it. Each axis is tested separately, which is what makes walking against a wall
 * while also pressing along it feel normal.
 */
export function moveWithCollision(map, x, y, dx, dy) {
  let nextX = x;
  let nextY = y;
  if (dx && isWalkablePixel(map, nextX + dx, nextY)) nextX += dx;
  if (dy && isWalkablePixel(map, nextX, nextY + dy)) nextY += dy;
  return { x: nextX, y: nextY };
}

/** The nearest legal foot position, searched outward in tile rings. */
export function nearestWalkable(map, x, y, maxTiles = 12) {
  if (isWalkablePixel(map, x, y)) return { x, y };
  const startC = Math.floor(x / TILE);
  const startR = Math.floor(y / TILE);
  for (let ring = 1; ring <= maxTiles; ring += 1) {
    for (let dr = -ring; dr <= ring; dr += 1) {
      for (let dc = -ring; dc <= ring; dc += 1) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== ring) continue;
        const c = startC + dc;
        const r = startR + dr;
        if (!isWalkableTile(tileAt(map, c, r))) continue;
        // Aim at the middle of the tile, which is always inside it.
        const candidate = { x: c * TILE + TILE / 2, y: r * TILE + TILE / 2 };
        if (isWalkablePixel(map, candidate.x, candidate.y)) return candidate;
      }
    }
  }
  return { x, y };
}

/** A stable spawn on the plaza, so rejoining feels like coming back. */
export function spawnForCharacter(map, characterId) {
  // Walk out from the centre along a hash-chosen ring until legal ground is
  // found. Two characters with different ids start at different angles.
  const h = hash32(String(characterId || ''));
  const angle = (h % 360) * (Math.PI / 180);
  for (let step = 0; step < 48; step += 1) {
    const radius = step * TILE;
    const candidate = {
      x: map.width / 2 + Math.cos(angle) * radius,
      y: map.height / 2 + Math.sin(angle) * radius,
    };
    if (isWalkablePixel(map, candidate.x, candidate.y)) {
      return { x: Math.round(candidate.x), y: Math.round(candidate.y) };
    }
  }
  return nearestWalkable(map, map.width / 2, map.height / 2);
}

/** Count of tiles by kind, for a quick sanity check and a labelled map legend. */
export function tileCensus(map) {
  const counts = {};
  for (let i = 0; i < map.tiles.length; i += 1) {
    const kind = map.tiles[i];
    counts[kind] = (counts[kind] || 0) + 1;
  }
  return counts;
}

/** Stable per-tile variation the renderer uses; not used by collision. */
export function tileVariation(map, col, row, salt = 0) {
  return noise(map.city, col, row, salt);
}
