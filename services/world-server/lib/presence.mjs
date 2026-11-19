// A registry of live rooms, used only by the read-only development spectator.
//
// It holds the room objects, not a copy of their state: a snapshot is read from
// the live room when it is asked for, so the view can never drift from what
// players actually see. Nothing is persisted, and when a room is disposed its
// entry disappears with it.
export function createPresenceRegistry() {
  const rooms = new Map();

  return {
    attach(cityId, room) {
      rooms.set(cityId, room);
    },

    detach(cityId, room) {
      if (rooms.get(cityId) === room) rooms.delete(cityId);
    },

    snapshot(cityId) {
      const room = rooms.get(cityId);
      if (!room || !room.state || !room.state.players) return [];
      const players = [];
      room.state.players.forEach((player) => {
        players.push({
          characterId: player.characterId,
          name: player.name,
          x: Math.round(player.x),
          y: Math.round(player.y),
          facing: player.facing,
        });
      });
      return players.sort((a, b) => a.name.localeCompare(b.name));
    },

    cities() {
      return [...rooms.keys()];
    },
  };
}
