// The cities that currently have a world room.
//
// This is the first slice of the real-world hierarchy (Earth → country → city):
// a small, explicit catalog rather than an open room namespace. A room name is
// derived from a catalog id, so a client cannot create an arbitrary room by
// asking for one, and memory use stays bounded by the catalog size.
//
// Width and height are the playable area in world pixels, not a claim about the
// real city. Country and region are labels for the UI; no geometry from
// OpenStreetMap or GeoNames is bundled yet.
export const CITIES = Object.freeze([
  Object.freeze({
    id: 'bangkok', name: 'Bangkok', country: 'TH', region: 'Krung Thep Maha Nakhon',
    width: 1280, height: 960, maxPlayers: 40,
  }),
  Object.freeze({
    id: 'chiang-mai', name: 'Chiang Mai', country: 'TH', region: 'Chiang Mai',
    width: 1024, height: 768, maxPlayers: 30,
  }),
  Object.freeze({
    id: 'phuket', name: 'Phuket', country: 'TH', region: 'Phuket',
    width: 1024, height: 768, maxPlayers: 30,
  }),
  Object.freeze({
    id: 'singapore', name: 'Singapore', country: 'SG', region: 'Central Region',
    width: 1152, height: 864, maxPlayers: 40,
  }),
]);

const BY_ID = new Map(CITIES.map((city) => [city.id, city]));

export function findCity(id) {
  return typeof id === 'string' ? BY_ID.get(id) || null : null;
}

/** Colyseus room name for a city. One room per city id. */
export function cityRoomName(id) {
  return `city:${id}`;
}

/** Public catalog for the world picker; contains no player data. */
export function cityCatalog() {
  return CITIES.map(({ id, name, country, region, maxPlayers }) => ({
    id, name, country, region, maxPlayers,
  }));
}
