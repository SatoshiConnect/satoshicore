// Live model for the NSAT explorer dashboard.
//
// Everything here is derived from the node itself, through the same-origin
// gateway endpoint /api/v1/explorer/snapshot (read-only /info, /peers,
// /quorum, /metrics). Nothing is invented: when a source is missing the field
// stays null and the UI shows a dash plus the reason. Series are built only
// from readings this tab actually observed, and the UI says so.

export const MAX_OBSERVATIONS = 60;
export const MAX_SAMPLES = 60;
export const MAX_EVENTS = 40;

export function emptyFeed() {
  return {
    status: 'loading', // loading | live | stale | offline
    lastAt: null,
    lastError: null,
    staleFor: 0,
    snapshot: null,
    observations: [], // one per closed ledger we witnessed
    samples: [], // one per poll
    events: []
  };
}

const round = (v, p = 2) => Math.round(v * 10 ** p) / 10 ** p;

function event(feed, at, category, text, tone = 'blue') {
  const last = feed.events[0];
  if (last && last.text === text && at - last.at < 15_000) return feed.events;
  const next = [{ id: `${at}-${category}-${feed.events.length}`, at, category, text, tone }, ...feed.events];
  return next.slice(0, MAX_EVENTS);
}

// Fold one gateway snapshot (or a failure) into the live feed.
// `snapshot` is null when the fetch itself failed.
export function ingest(feed, snapshot, { at = Date.now(), error = null } = {}) {
  const prev = feed;

  if (!snapshot || snapshot.ok === false) {
    const events = prev.status === 'offline'
      ? prev.events
      : event(prev, at, 'system', 'Gateway could not read the node — showing last known values, not new ones', 'red');
    return {
      ...prev,
      status: 'offline',
      lastError: error || (snapshot && snapshot.error) || 'no response',
      events
    };
  }

  const stale = Boolean(snapshot.stale);
  const ledger = snapshot.ledger || {};
  const closeTime = typeof ledger.closeTime === 'number' ? ledger.closeTime : null;
  const num = typeof ledger.num === 'number' ? ledger.num : null;
  const age = typeof ledger.age === 'number' ? ledger.age : null;
  // Timestamp (in this browser's clock) of the last close, derived from the
  // node's own age field so a clock skew between node and browser cannot make
  // the age display lie.
  const closedAt = age !== null ? at - age * 1000 : null;

  const txCum = snapshot.metrics && typeof snapshot.metrics.txAppliedTotal === 'number'
    ? snapshot.metrics.txAppliedTotal
    : null;

  let observations = prev.observations.slice();
  let samples = prev.samples.slice();

  // First successful reading: adopt the closes the gateway itself witnessed,
  // so the charts start from real history instead of an empty box.
  const hist = snapshot.history;
  if (!observations.length && hist && Array.isArray(hist.closes) && hist.closes.length) {
    observations = hist.closes
      .slice()
      .reverse()
      .map((c) => ({
        num: c.num,
        closeTime: c.closeTime,
        at: c.at,
        closedAt: c.at,
        openedLedgers: c.opened,
        closeSeconds: typeof c.seconds === 'number' ? c.seconds : null,
        txsSince: typeof c.txs === 'number' ? c.txs : null,
        tps: typeof c.tps === 'number' ? c.tps : null,
        txCum: typeof c.tx === 'number' ? c.tx : null,
        hash: null,
        source: 'gateway'
      }));
  }
  if (!samples.length && hist && Array.isArray(hist.samples) && hist.samples.length) {
    samples = hist.samples
      .slice()
      .reverse()
      .map((s) => ({
        at: s.at,
        latencyMs: s.latencyMs,
        txPerLedger: s.txPerLedger,
        closeMs: s.closeMs,
        lagMs: s.lagMs,
        num: s.num,
        age: s.age,
        baseFee: s.baseFee,
        agree: s.agree,
        peers: s.peers
      }));
  }

  const last = observations[0];

  let openedLedgers = 0;
  let closeSeconds = null;
  let txsSince = null;
  let tps = null;

  if (num !== null && closeTime !== null && (!last || num > last.num)) {
    if (last) {
      openedLedgers = num - last.num;
      const seconds = closeTime - last.closeTime;
      if (seconds > 0 && seconds < 900) {
        closeSeconds = round(seconds / openedLedgers, 1);
        if (txCum !== null && last.txCum !== null && txCum >= last.txCum) {
          txsSince = txCum - last.txCum;
          tps = round(txsSince / seconds, 2);
        }
      }
    }
    const obs = {
      num,
      closeTime,
      at,
      closedAt,
      openedLedgers,
      closeSeconds,
      txsSince,
      tps,
      // Kept so the next close can diff the node's cumulative tx counter.
      txCum,
      hash: ledger.hash || null
    };
    // Only record a real close: the first reading has no interval yet and is
    // stored so the next one can compute one.
    observations.unshift(obs);
  } else if (observations.length) {
    observations[0] = { ...observations[0], closedAt };
  }

  samples.unshift({
    at,
    latencyMs: snapshot.metrics && snapshot.metrics.connLatencyMs ? snapshot.metrics.connLatencyMs.mean : null,
    txPerLedger: snapshot.metrics && snapshot.metrics.txPerLedger ? snapshot.metrics.txPerLedger.mean : null,
    closeMs: snapshot.metrics && snapshot.metrics.closeMs ? snapshot.metrics.closeMs.mean : null,
    lagMs: snapshot.quorum ? snapshot.quorum.lagMs : null,
    num,
    age,
    baseFee: typeof ledger.baseFee === 'number' ? ledger.baseFee : null,
    agree: snapshot.quorum ? snapshot.quorum.agreeCount : null,
    peers: snapshot.peers ? snapshot.peers.authenticated : null
  });

  let events = prev.events;
  if (!prev.events.length && hist && observations.length > 1) {
    // Seed the feed with the closes the gateway already witnessed, so the
    // panel is not blank for the first minute of a visit.
    const seeded = observations.slice(0, 5).map((o) => {
      const parts = [`#${o.num.toLocaleString('en-US')} closed`];
      if (o.closeSeconds !== null) parts.push(`in ${o.closeSeconds.toFixed(1)} s`);
      if (o.txsSince !== null) parts.push(`${o.txsSince} tx applied`);
      return { id: `seed-${o.num}`, at: o.at, category: 'ledger', text: parts.join(' · '), tone: 'blue' };
    });
    events = [
      {
        id: `seed-adopt-${at}`,
        at,
        category: 'system',
        text: `Adopted ${observations.length} ledger closes the gateway observed since ${new Date(hist.since).toLocaleTimeString()}`,
        tone: 'green'
      },
      ...seeded
    ].slice(0, MAX_EVENTS);
  }
  if (closeSeconds !== null) {
    const detail = [`#${num.toLocaleString('en-US')} closed`];
    if (closeSeconds !== null) detail.push(`in ${closeSeconds.toFixed(1)} s`);
    if (txsSince !== null) detail.push(`${txsSince} tx applied`);
    events = event({ ...prev, events }, at, 'ledger', detail.join(' · '), 'blue');
  }
  if (prev.status === 'offline') {
    events = event({ ...prev, events }, at, 'system', 'Node reachable again — live readings resumed', 'green');
  }
  if (snapshot.quorum && snapshot.quorum.validated === false) {
    events = event({ ...prev, events }, at, 'network', 'Quorum has not validated the latest slot', 'red');
  }
  if (snapshot.partial && snapshot.partial.length) {
    events = event({ ...prev, events }, at, 'system', `Partial reading — ${snapshot.partial.join(', ')} unavailable`, 'amber');
  }

  return {
    ...prev,
    status: stale ? 'stale' : 'live',
    lastAt: snapshot.observedAt || at,
    lastError: null,
    staleFor: stale ? at - (snapshot.observedAt || at) : 0,
    snapshot,
    observations: observations.slice(0, MAX_OBSERVATIONS),
    samples: samples.slice(0, MAX_SAMPLES),
    events
  };
}

// Series for the charts. Each returns oldest→newest, and may be short while
// the tab is still collecting its first readings.
export function series(feed) {
  const obs = feed.observations.slice(0, 32).reverse();
  const samples = feed.samples.slice(0, 32).reverse();
  const closes = obs.filter((o) => typeof o.closeSeconds === 'number').map((o) => o.closeSeconds);
  const tps = obs.filter((o) => typeof o.tps === 'number').map((o) => o.tps);
  const nums = (key) => samples.map((s) => s[key]).filter((v) => typeof v === 'number');
  return {
    close: closes,
    tps,
    txPerLedger: nums('txPerLedger'),
    latency: nums('latencyMs'),
    lag: nums('lagMs'),
    // One series per KPI, so a sparkline always plots the metric it sits under.
    ledger: nums('num'),
    age: nums('age'),
    fee: nums('baseFee'),
    agree: nums('agree'),
    peers: nums('peers')
  };
}

export function mean(list) {
  if (!list.length) return null;
  return list.reduce((a, b) => a + b, 0) / list.length;
}

// Seconds since the node closed its last ledger, measured on the browser
// clock but anchored to the node's own age reading.
export function ledgerAgeSeconds(feed, now = Date.now()) {
  const obs = feed.observations[0];
  if (obs && typeof obs.closedAt === 'number') {
    return Math.max(0, (now - obs.closedAt) / 1000);
  }
  const snap = feed.snapshot;
  if (snap && snap.ledger && typeof snap.ledger.age === 'number' && feed.lastAt) {
    return Math.max(0, (now - feed.lastAt) / 1000 + snap.ledger.age);
  }
  return null;
}

export function agoSeconds(at, now = Date.now()) {
  return Math.max(0, Math.round((now - at) / 1000));
}

export function formatAgo(seconds) {
  if (seconds === null || seconds === undefined) return '—';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}
