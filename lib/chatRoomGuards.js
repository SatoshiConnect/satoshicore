// Guards for async chat reads. Kept out of ChatPanel so races can be exercised
// deterministically without a browser: a poll must not apply after the room has
// changed, a room read must not apply after another room read has started, and
// acks are serialized so an older read cannot overtake a newer one.

/**
 * Two independent epochs:
 * - pollEpoch invalidates in-flight mailbox polls when a room opens/leaves or a
 *   newer poll starts.
 * - roomEpoch invalidates an in-flight room read when another room read starts
 *   or the room is left. A poll starting later must not cancel a room read.
 */
export function createRoomGuard() {
  let pollEpoch = 0;
  let roomEpoch = 0;
  return {
    beginPoll() {
      pollEpoch += 1;
      return pollEpoch;
    },
    beginRoomRead() {
      roomEpoch += 1;
      pollEpoch += 1;
      return roomEpoch;
    },
    leaveRoom() {
      roomEpoch += 1;
      pollEpoch += 1;
    },
    isCurrentPoll(token) {
      return token === pollEpoch;
    },
    isCurrentRoomRead(token) {
      return token === roomEpoch;
    },
  };
}

/**
 * One ack pipeline per chat screen. Tasks run in call order; a rejected task
 * does not stall the next one. Callers still guard stale work inside the task,
 * because the queue cannot know whether a room changed while it was waiting.
 */
export function createAckQueue() {
  let tail = Promise.resolve();
  return {
    run(task) {
      if (typeof task !== 'function') return Promise.resolve(undefined);
      const next = tail.then(task, task);
      tail = next.then(() => undefined, () => undefined);
      return next;
    },
    idle() {
      return tail;
    },
  };
}