// One polling tab per wallet.
//
// Every tab that has the same wallet open would otherwise poll the same mailbox
// and acknowledge the same deliveries. Web Locks give one tab the wallet's poll
// lock; the others stay followers and receive the leader's unread snapshot over
// BroadcastChannel. The snapshot is only `{ at, counts }`: public addresses and
// integers, never message text.
//
// The lock is held for as long as the tab is mounted and unlocked. Closing or
// locking that tab resolves the lock request, and the next queued tab becomes the
// leader. Browsers without Web Locks keep the old behaviour (each tab polls), but
// snapshots are still broadcast so their badges do not diverge.
'use client';

export const CHAT_TAB_CHANNEL_PREFIX = 'scw-chat-tab-v1:';
export const CHAT_POLL_LOCK_PREFIX = 'scw-chat-poll-v1:';

const ADDRESS_RE = /^G[A-Z2-7]{55}$/;

const browserLocks = () => {
  try {
    return typeof navigator === 'undefined' ? null : (navigator.locks || null);
  } catch {
    return null;
  }
};

const browserChannel = () => {
  try {
    return typeof BroadcastChannel === 'undefined' ? null : BroadcastChannel;
  } catch {
    return null;
  }
};

const noop = () => {};

/**
 * Start tab coordination for one wallet.
 *
 * `onLeaderChange(true)` means this tab owns the poll lock and should run the
 * interval; `onSnapshot(snapshot)` is called for snapshots sent by another tab.
 * `publish(snapshot)` announces a snapshot this tab just wrote (a follower may
 * announce a room clear too); `prime(snapshot)` only seeds the reply used for a
 * new tab's snapshot request.
 */
export function createChatTabSync({
  wallet,
  canLead = true,
  locks = browserLocks(),
  Channel = browserChannel(),
  onSnapshot = noop,
  onLeaderChange = noop,
} = {}) {
  const owner = String(wallet || '').toUpperCase();
  if (!ADDRESS_RE.test(owner)) {
    return { start: noop, close: noop, publish: noop, prime: noop, isLeader: () => false };
  }

  let channel = null;
  let began = false;
  let closed = false;
  let leader = false;
  let release = null;
  let lastSnapshot = null;

  const setLeader = (next) => {
    if (leader === next) return;
    leader = next;
    try { onLeaderChange(next); } catch { /* a listener must not break the lock */ }
  };

  const send = (message) => {
    if (!channel) return;
    try {
      channel.postMessage({ v: 1, wallet: owner, ...message });
    } catch {
      // A closed or suspended channel is not a reason to stop polling.
    }
  };

  const handle = (event) => {
    const data = event?.data;
    if (!data || data.v !== 1 || data.wallet !== owner) return;
    if (data.type === 'snapshot') {
      if (!data.snapshot || typeof data.snapshot !== 'object') return;
      lastSnapshot = data.snapshot;
      try { onSnapshot(data.snapshot); } catch { /* a listener must not break the channel */ }
    } else if (data.type === 'snapshot-request' && leader && lastSnapshot) {
      send({ type: 'snapshot', snapshot: lastSnapshot });
    }
  };

  const publish = (snapshot) => {
    if (!snapshot || typeof snapshot !== 'object') return;
    lastSnapshot = snapshot;
    send({ type: 'snapshot', snapshot });
  };

  const prime = (snapshot) => {
    if (snapshot && typeof snapshot === 'object') lastSnapshot = snapshot;
  };

  const start = () => {
    if (began) return;
    began = true;

    if (Channel) {
      try {
        channel = new Channel(`${CHAT_TAB_CHANNEL_PREFIX}${owner}`);
        channel.onmessage = handle;
      } catch {
        channel = null;
      }
    }

    // Without a channel a follower could never receive a snapshot, so keep the
    // old one-poll-per-tab behaviour rather than leaving its badge stale.
    if (!channel) {
      if (canLead) setLeader(true);
      return;
    }

    // Ask the current leader for its last snapshot; this avoids waiting up to a
    // full poll interval when a second tab opens.
    send({ type: 'snapshot-request' });

    if (!canLead) return;
    if (!locks || typeof locks.request !== 'function') {
      // Preserve polling on browsers without Web Locks. The snapshot channel is
      // still useful, even though it cannot elect a single reader there.
      setLeader(true);
      return;
    }

    try {
      locks.request(`${CHAT_POLL_LOCK_PREFIX}${owner}`, async () => {
        if (closed) return;
        setLeader(true);
        await new Promise((resolve) => { release = resolve; });
        release = null;
        if (!closed) setLeader(false);
      }).catch(() => {
        // A failed lock must not leave an unlocked wallet without badges.
        if (!closed) setLeader(true);
      });
    } catch {
      setLeader(true);
    }
  };

  const close = () => {
    if (closed) return;
    closed = true;
    setLeader(false);
    const resolve = release;
    release = null;
    if (resolve) resolve();
    if (channel) {
      try {
        channel.onmessage = null;
        channel.close();
      } catch { /* already closed */ }
      channel = null;
    }
  };

  return { start, close, publish, prime, isLeader: () => leader };
}
