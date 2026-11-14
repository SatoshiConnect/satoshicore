'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { getExplorerSnapshot, EXPECTED_NETWORK_ID } from '../lib/nsatClient';
import {
  emptyFeed,
  ingest,
  series,
  mean,
  ledgerAgeSeconds,
  agoSeconds,
  formatAgo
} from '../lib/nsatLive';
import { NSAT } from '../lib/nsatToken';
import PageHeader from './PageHeader';

const MENU = [
  { id: 'overview', label: 'Overview' },
  { id: 'ledgers', label: 'Ledgers' },
  { id: 'validators', label: 'Validators' },
  { id: 'network', label: 'Network' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'tools', label: 'Tools' }
];

const EVENT_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'ledger', label: 'Ledger' },
  { id: 'network', label: 'Network' },
  { id: 'system', label: 'System' }
];

// The gateway caches its own reading for ~2.5 s and the node answers /info in
// bursts, so 4 s is the shortest poll that stays useful without hammering it.
const POLL_MS = 4000;

const n = (value) => (typeof value === 'number' ? Math.round(value).toLocaleString('en-US') : '—');
const fixed = (value, places = 2) => (typeof value === 'number' ? value.toFixed(places) : '—');
const orDash = (value) => (value === null || value === undefined || value === '' ? '—' : value);

function gateClock(ms) {
  const total = Math.max(0, ms) / 1000;
  const minutes = Math.floor(total / 60);
  const seconds = total - minutes * 60;
  const whole = String(Math.floor(seconds)).padStart(2, '0');
  const fraction = seconds.toFixed(1).split('.')[1];
  return `${String(minutes).padStart(2, '0')}:${whole}.${fraction}`;
}

/* ------------------------------- Charts -------------------------------- */

const pathOf = (data, height = 34, pad = 2) => {
  const max = Math.max(...data);
  const min = Math.min(...data);
  const flat = max === min;
  const span = max - min || 1;
  return data
    .map((value, i) => {
      const x = (i / Math.max(data.length - 1, 1)) * 100;
      const ratio = flat ? 0.5 : (value - min) / span;
      const y = 38 - pad - ratio * height;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
};

function Spark({ data, color }) {
  if (!data || data.length < 2) return null;
  return (
    <svg className="nsx-spark" viewBox="0 0 100 38" preserveAspectRatio="none" aria-hidden="true">
      <polyline
        points={pathOf(data.slice(-24), 30, 4)}
        fill="none"
        stroke={color}
        strokeWidth="1.6"
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function BarChart({ data, rainbow = false, tone = '#38bdf8' }) {
  if (!data || data.length < 2) return null;
  const shown = data.slice(-40);
  const max = Math.max(...shown, 0.0001);
  const width = 100 / shown.length;
  return (
    <svg className="nsx-chart" viewBox="0 0 100 38" preserveAspectRatio="none" aria-hidden="true">
      {shown.map((value, i) => {
        const height = Math.max(1.5, (value / max) * 32);
        const fill = rainbow ? `hsl(${(i / shown.length) * 320} 92% 62%)` : tone;
        return (
          <rect
            key={i}
            x={i * width + width * 0.18}
            y={36 - height}
            width={width * 0.64}
            height={height}
            rx="0.4"
            fill={fill}
            opacity={rainbow ? 0.95 : 0.85}
          />
        );
      })}
    </svg>
  );
}

function LineChart({ data, color, id }) {
  if (!data || data.length < 2) return null;
  const shown = data.slice(-40);
  const points = pathOf(shown, 30, 3);
  return (
    <svg className="nsx-chart" viewBox="0 0 100 38" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={`nsx-g-${id}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.5" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,38 ${points} 100,38`} fill={`url(#nsx-g-${id})`} />
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.7"
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Chart({ data, kind, color, id, rainbow, tone, emptyLabel = 'collecting readings…' }) {
  const flatZero = data && data.length > 1 && data.every((v) => v === 0);
  if (!data || data.length < 2 || flatZero) {
    return (
      <div className="nsx-chart-empty" role="status">
        {flatZero ? emptyLabel : 'collecting readings…'}
        {!flatZero && <span>{data && data.length ? '1 of 2' : '0 of 2'}</span>}
      </div>
    );
  }
  if (kind === 'bar') return <BarChart data={data} rainbow={rainbow} tone={tone || color} />;
  return <LineChart data={data} color={color} id={id} />;
}

/* ------------------------------ Building ------------------------------- */

function Kpi({ label, value, unit, spark, color, note, tone }) {
  return (
    <div className="nsx-kpi" style={{ '--tone': color }}>
      <div className="nsx-kpi-label">{label}</div>
      <div className={`nsx-kpi-value${tone === 'muted' ? ' is-muted' : ''}`}>
        {value}
        {unit ? <span className="nsx-kpi-unit">{unit}</span> : null}
      </div>
      <div className="nsx-kpi-spark">
        <Spark data={spark} color={color} />
      </div>
      <div className="nsx-kpi-note">{note}</div>
    </div>
  );
}

function Chip({ index, side, tone, value, meta, badge }) {
  return (
    <div className={`nsx-chip nsx-chip--${side} tone-${tone}`} style={{ '--i': index }}>
      <div className="nsx-chip-top">
        <b>{value}</b>
        <span className="nsx-chip-time">{meta}</span>
      </div>
      <div className="nsx-chip-badge">{badge}</div>
    </div>
  );
}

/* ------------------------------- Dashboard ----------------------------- */

export default function ExplorerDashboard() {
  const [feed, setFeed] = useState(emptyFeed);
  const [active, setActive] = useState('overview');
  const [query, setQuery] = useState('');
  const [eventFilter, setEventFilter] = useState('all');
  const [now, setNow] = useState(() => Date.now());
  const sections = useRef({});
  const feedRef = useRef(feed);
  feedRef.current = feed;

  // Poll the gateway. A failed poll is folded in as `null`, which moves the
  // feed to `offline` — it never keeps a stale value looking current.
  useEffect(() => {
    let alive = true;
    let running = false;

    const poll = async () => {
      if (running) return;
      running = true;
      try {
        const snapshot = await getExplorerSnapshot();
        if (alive) setFeed((prev) => ingest(prev, snapshot, { at: Date.now() }));
      } catch (err) {
        if (alive) setFeed((prev) => ingest(prev, null, { at: Date.now(), error: err.message }));
      } finally {
        running = false;
      }
    };

    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  // One shared ticker for the "age of last close" clock and relative times.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const jump = (id) => {
    setActive(id);
    sections.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const snap = feed.snapshot;
  const ledger = (snap && snap.ledger) || {};
  const quorum = (snap && snap.quorum) || {};
  const peers = (snap && snap.peers) || {};
  const metrics = (snap && snap.metrics) || {};
  const networkOk = snap && snap.network === EXPECTED_NETWORK_ID;
  const s = useMemo(() => series(feed), [feed]);
  const age = ledgerAgeSeconds(feed, now);
  const observedClose = useMemo(() => mean(s.close.slice(-12)), [s.close]);
  const observedTps = feed.observations[0] ? feed.observations[0].tps : null;
  const ticks = age !== null && observedClose ? Math.min(1, age / observedClose) : 0;

  const ledgers = feed.observations.slice(0, 8);
  const validators = (snap && snap.validators) || [];
  const stats = validators.filter((v) => v.agree !== null);
  const agreeCount = stats.filter((v) => v.agree).length;

  const q = query.trim().toLowerCase();
  const match = (...parts) => !q || parts.join(' ').toLowerCase().includes(q);

  const filteredLedgers = ledgers.filter((o) => match(`#${o.num}`, o.hash || '', String(o.num)));
  const filteredValidators = validators.filter((v) => match(v.id, v.direction, v.version || ''));
  const filteredEvents = feed.events
    .filter((e) => eventFilter === 'all' || e.category === eventFilter)
    .filter((e) => match(e.text, e.category));

  // Five rows keep this card level with the other three tables; the rest of
  // the raw metrics are one `curl /metrics` away for anyone who wants them.
  const metricRows = [
    ['Close time · mean', metrics.closeMs ? `${fixed(metrics.closeMs.mean, 2)} ms` : '—'],
    ['Close time · 95th', metrics.closeMs ? `${fixed(metrics.closeMs['95%'], 2)} ms` : '—'],
    ['Tx per ledger · mean', metrics.txPerLedger ? fixed(metrics.txPerLedger.mean, 2) : '—'],
    ['Ledger applies · ok / fail', `${n(metrics.applySuccess)} / ${n(metrics.applyFailure)}`],
    ['SCP cost · mean', metrics.scpCost ? n(metrics.scpCost.mean) : '—']
  ].filter(([label]) => match(label));

  const statusPill =
    feed.status === 'live'
      ? { cls: 'is-live', label: `Live · ${agoSeconds(feed.lastAt || now, now)}s`, dot: 'is-green' }
      : feed.status === 'stale'
        ? { cls: 'is-stale', label: `Stale · ${Math.round(feed.staleFor / 1000)}s`, dot: 'is-amber' }
        : feed.status === 'offline'
          ? { cls: 'is-offline', label: 'Offline', dot: 'is-red' }
          : { cls: 'is-dim', label: 'Connecting', dot: 'is-amber' };

  return (
    <div className="nsx">
      {/* Same header block as Search / Docs / Status, so the explorer opens
       * exactly like the rest of the site. */}
      <PageHeader
        eyebrow="NSAT · live network"
        title="Live explorer"
        lead="Live readings from the running node. Nothing is simulated."
        actions={
          <>
            <Link href="/explorer" className="button secondary">Search an account</Link>
            <Link href="/wallet" className="button secondary">Open the wallet</Link>
          </>
        }
        meta={snap && snap.network ? snap.network : undefined}
      />

      {/* ------------------------------ Tool bar --------------------------- */}
      <div className="nsx-bar">
        <nav className="nsx-menu" aria-label="Explorer sections">
          {MENU.map((item) => (
            <button
              key={item.id}
              type="button"
              className={active === item.id ? 'is-active' : undefined}
              onClick={() => jump(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <label className="nsx-search">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <path d="m15.5 15.5 4.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter ledgers, validators, metrics, events…"
            aria-label="Filter the live tables"
          />
        </label>

        <div className="nsx-status">
          <span
            className={`nsx-pill ${networkOk ? 'is-green' : 'is-dim'}`}
            title={snap && snap.network ? snap.network : 'network identity not read yet'}
          >
            <i className={networkOk ? undefined : 'is-amber'} /> {networkOk ? 'Mainnet' : 'Unverified'}
          </span>
          <span className="nsx-pill" title="Consensus lag reported by the node">
            <i className="is-amber" /> {quorum.lagMs === null || quorum.lagMs === undefined ? '—' : `${quorum.lagMs} ms`}
          </span>
          <span className={`nsx-pill ${statusPill.cls}`} title="Reading the running NSAT node through the same-origin gateway">
            <i className={statusPill.dot} /> {statusPill.label}
          </span>
        </div>
      </div>

      {(feed.status === 'offline' || feed.status === 'stale' || (snap && snap.partial && snap.partial.length > 0)) && (
        <div className={`nsx-banner ${feed.status === 'offline' ? 'is-red' : 'is-amber'}`} role="status">
          {feed.status === 'offline'
            ? `Node unreachable${feed.lastError ? ` (${feed.lastError})` : ''} — values below are the last reading, not live numbers.`
            : feed.status === 'stale'
              ? `The node answered from a cached reading ${Math.round(feed.staleFor / 1000)} s old.`
              : `Partial reading: ${snap.partial.join(', ')} unavailable right now.`}
        </div>
      )}

      <div className="nsx-body">
        {/* ------------------------------ KPIs ----------------------------- */}
        <div className="nsx-kpis" ref={(el) => (sections.current.overview = el)}>
          <Kpi
            label="Latest Ledger"
            value={`#${n(ledger.num)}`}
            color="#38bdf8"
            spark={s.ledger}
            note={age === null ? 'not read yet' : `closed ${fixed(age, 1)} s ago`}
          />
          <Kpi
            label="Close Time"
            value={fixed(observedClose, 2)}
            unit="s"
            color="#4ade80"
            spark={s.close}
            note={`observed · ${s.close.length} close${s.close.length === 1 ? '' : 's'}`}
            tone={observedClose === null ? 'muted' : undefined}
          />
          <Kpi
            label="Tx / Ledger"
            value={fixed(metrics.txPerLedger ? metrics.txPerLedger.mean : null, 2)}
            color="#a855f7"
            spark={s.txPerLedger}
            note="node metric · applied"
            tone={metrics.txPerLedger ? undefined : 'muted'}
          />
          <Kpi
            label="Throughput"
            value={fixed(observedTps, 2)}
            unit=" tx/s"
            color="#22d3ee"
            spark={s.tps}
            note="observed between closes"
            tone={observedTps === null ? 'muted' : undefined}
          />
          <Kpi
            label="Base Fee"
            value={n(ledger.baseFee)}
            unit=" NSAT"
            color="#fbbf24"
            spark={s.fee}
            note="per operation · unchanged"
            tone={ledger.baseFee === undefined || ledger.baseFee === null ? 'muted' : undefined}
          />
          <Kpi
            label="Validators"
            value={
              quorum.agreeCount === null || quorum.agreeCount === undefined
                ? '—'
                : `${quorum.agreeCount}/${orDash(quorum.nodeCount)}`
            }
            color="#2dd4bf"
            spark={s.agree}
            note="agree in quorum set"
          />
          <Kpi
            label="Quorum Lag"
            value={orDash(quorum.lagMs)}
            unit=" ms"
            color="#4ade80"
            spark={s.lag}
            note={quorum.phase ? quorum.phase.toLowerCase() : 'phase not read'}
          />
          <Kpi
            label="Peers"
            value={orDash(peers.authenticated)}
            color="#f472b6"
            spark={s.peers}
            note={`${orDash(peers.pending)} pending · overlay`}
          />
        </div>

        {/* --------------------------- Ledger tunnel ----------------------- */}
        <section className="nsx-hall" ref={(el) => (sections.current.ledgers = el)}>
          <div className="nsx-hall-glow" aria-hidden="true" />

          <div className="nsx-hall-col nsx-hall-col--left">
            <div className="nsx-hall-head">
              <span className="nsx-hall-title">◀ Confirmed ledgers</span>
              <span className="nsx-hall-sub">Done · closed · irreversible</span>
            </div>
            <div className="nsx-cascade">
              {ledgers.length === 0 ? (
                <div className="nsx-chip is-placeholder">
                  <div className="nsx-chip-top">
                    <b>Waiting for the first close…</b>
                  </div>
                  <div className="nsx-chip-badge">reading node</div>
                </div>
              ) : (
                ledgers.slice(0, 5).map((obs, i) => (
                  <Chip
                    key={obs.num}
                    index={i}
                    side="left"
                    tone="blue"
                    value={`#${n(obs.num)}`}
                    meta={obs.closeSeconds === null ? '—' : `${fixed(obs.closeSeconds, 1)}s`}
                    badge={obs.txsSince ? `${obs.txsSince} tx` : 'finalized'}
                  />
                ))
              )}
            </div>
          </div>

          <div className="nsx-gate">
            <div className="nsx-gate-rail" aria-hidden="true" />
            <div className="nsx-gate-inner">
              <div className="nsx-gate-title">Ledger gate</div>
              <div className="nsx-gate-label">Age of last close</div>
              <div className="nsx-gate-clock">{age === null ? '--:--.-' : gateClock(age * 1000)}</div>
              <div className="nsx-gate-bar">
                <span style={{ width: `${ticks * 100}%` }} />
              </div>
              <div className="nsx-gate-ledger">#{n(ledger.num)}</div>
              <div className="nsx-gate-tx">
                {observedClose === null ? 'typical close —' : `typical ${fixed(observedClose, 1)} s`}
              </div>
              <div className="nsx-gate-verify">
                {feed.status === 'offline'
                  ? 'Offline'
                  : quorum.validated === false
                    ? 'Awaiting'
                    : quorum.validated
                      ? 'Validated'
                      : 'Reading…'}
              </div>
            </div>
            <div className="nsx-gate-rail" aria-hidden="true" />
          </div>

          {/* Right side = the work in progress: consensus phase, how much of
           * the quorum has agreed, how far behind the head the qset is, and
           * peers still handshaking. The validator roster itself lives in the
           * table below, so it is not repeated here. */}
          <div className="nsx-hall-col nsx-hall-col--right">
            <div className="nsx-hall-head is-right">
              <span className="nsx-hall-title">In progress ▶</span>
              <span className="nsx-hall-sub">Agreeing · validating · not yet closed</span>
            </div>
            <div className="nsx-cascade is-right">
              {quorum.phase === null || quorum.phase === undefined ? (
                <div className="nsx-chip nsx-chip--right is-placeholder">
                  <div className="nsx-chip-top">
                    <b>Quorum not read…</b>
                  </div>
                  <div className="nsx-chip-badge">reading node</div>
                </div>
              ) : (
                <>
                  <Chip
                    index={0}
                    side="right"
                    tone={quorum.validated === false ? 'red' : 'green'}
                    value={quorum.phase}
                    meta={quorum.validated === false ? 'unvalidated' : 'validated'}
                    badge="scp phase"
                  />
                  <Chip
                    index={1}
                    side="right"
                    tone={quorum.missing ? 'red' : 'green'}
                    value={`${orDash(quorum.agreeCount)}/${orDash(quorum.nodeCount)}`}
                    meta="agree"
                    badge={quorum.missing ? `${quorum.missing} missing` : 'no missing'}
                  />
                  <Chip
                    index={2}
                    side="right"
                    tone={quorum.lagMs !== null && quorum.lagMs > 1000 ? 'amber' : 'blue'}
                    value={`${orDash(quorum.lagMs)} ms`}
                    meta="lag"
                    badge="behind head"
                  />
                  <Chip
                    index={3}
                    side="right"
                    tone={peers.pending ? 'amber' : 'slate'}
                    value={orDash(peers.pending)}
                    meta="handshaking"
                    badge={`${orDash(peers.authenticated)} peers up`}
                  />
                </>
              )}
            </div>
          </div>

          <div className="nsx-lifecycle">
            <span className="nsx-lifecycle-tag">Current ledger lifecycle</span>
            <div className="nsx-lifecycle-bar">
              <span className="nsx-lifecycle-seg is-green" style={{ flex: Math.max(2, ticks * 100) }} />
              <span className="nsx-lifecycle-seg is-dim" style={{ flex: Math.max(2, 100 - ticks * 100) }} />
            </div>
            <div className="nsx-lifecycle-legend">
              <span>
                <i className="is-blue" /> Finalized #{n(ledger.num)}
                {observedClose === null ? '' : ` · ${fixed(observedClose, 1)} s mean`}
              </span>
              <span>
                <i className="is-green" /> Gate · {age === null ? '—' : `${fixed(age, 1)} s`} since close
              </span>
              <span>
                <i className="is-amber" /> Next slot #{n((ledger.num || 0) + 1)} · {orDash(quorum.nodeCount)} node
                quorum
              </span>
            </div>
          </div>
        </section>

        {/* ------------------------------ Charts --------------------------- */}
        <div className="nsx-charts" ref={(el) => (sections.current.analytics = el)}>
          <section className="nsx-card">
            <header className="nsx-card-head">
              <h2>Ledger Close Time (observed)</h2>
              <span className="nsx-card-hint">
                {s.close.length ? `mean ${fixed(mean(s.close), 2)} s` : 'waiting'}
              </span>
            </header>
            <Chart data={s.close} kind="line" color="#4ade80" id="close" />
            <footer className="nsx-chart-foot">
              <span className="is-green">min {s.close.length ? fixed(Math.min(...s.close), 2) : '—'} s</span>
              <span className="is-green">max {s.close.length ? fixed(Math.max(...s.close), 2) : '—'} s</span>
            </footer>
          </section>

          <section className="nsx-card">
            <header className="nsx-card-head">
              <h2>Throughput (observed)</h2>
              <span className="nsx-card-hint">
                {!s.tps.length
                  ? 'waiting'
                  : Math.max(...s.tps) === 0
                    ? 'idle · no tx applied'
                    : `peak ${fixed(Math.max(...s.tps), 2)} tx/s`}
              </span>
            </header>
            <Chart data={s.tps} kind="bar" rainbow emptyLabel="idle · no transactions applied" />
            <footer className="nsx-chart-foot">
              <span>now {fixed(observedTps, 2)} tx/s</span>
              <span className="is-dim">{s.tps.length} closes</span>
            </footer>
          </section>

          <section className="nsx-card">
            <header className="nsx-card-head">
              <h2>Consensus Lag (observed)</h2>
              <span className="nsx-card-hint">
                {s.lag.length ? `${orDash(quorum.phase || '')} · now ${orDash(quorum.lagMs)} ms` : 'waiting'}
              </span>
            </header>
            <Chart data={s.lag} kind="line" color="#a855f7" id="lag" />
            <footer className="nsx-chart-foot">
              <span className="is-violet">mean {s.lag.length ? `${n(mean(s.lag))} ms` : '—'}</span>
              <span className="is-violet">max {s.lag.length ? `${n(Math.max(...s.lag))} ms` : '—'}</span>
            </footer>
          </section>

          <section className="nsx-card" ref={(el) => (sections.current.network = el)}>
            <header className="nsx-card-head">
              <h2>Overlay Latency (node metric)</h2>
              <span className="nsx-card-hint">
                {metrics.connLatencyMs ? `median ${fixed(metrics.connLatencyMs.median, 1)} ms` : 'not read'}
              </span>
            </header>
            <Chart data={s.latency} kind="line" color="#38bdf8" id="lat" />
            <footer className="nsx-chart-foot">
              <span className="is-blue">
                mean {metrics.connLatencyMs ? fixed(metrics.connLatencyMs.mean, 1) : '—'} ms
              </span>
              <span className="is-blue">
                95th {metrics.connLatencyMs ? fixed(metrics.connLatencyMs['95%'], 0) : '—'} ms
              </span>
            </footer>
          </section>
        </div>

        {/* ------------------------------ Tables --------------------------- */}
        <div className="nsx-tables" ref={(el) => (sections.current.validators = el)}>
          <section className="nsx-card nsx-table">
            <header className="nsx-card-head">
              <h2>Observed Ledgers</h2>
              <span className="nsx-card-hint">{feed.observations.length} closes seen</span>
            </header>
            <div className="nsx-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Height</th>
                    <th>Close</th>
                    <th>Tx applied</th>
                    <th>Seen</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredLedgers.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="nsx-empty">
                        {ledgers.length === 0
                          ? 'No ledger close observed yet — the next one appears here.'
                          : `Nothing matches “${query}”.`}
                      </td>
                    </tr>
                  ) : (
                    filteredLedgers.slice(0, 5).map((obs) => (
                      <tr key={obs.num}>
                        <td className="is-num">#{n(obs.num)}</td>
                        <td>{obs.closeSeconds === null ? '—' : `${fixed(obs.closeSeconds, 1)}s`}</td>
                        <td>{obs.txsSince === null ? '—' : n(obs.txsSince)}</td>
                        <td className="is-dim">{formatAgo(agoSeconds(obs.at, now))}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="nsx-card nsx-table">
            <header className="nsx-card-head">
              <h2>Validators ({agreeCount}/{validators.length || '—'})</h2>
              <span className="nsx-card-hint">
                <i className="nsx-live-dot" /> from /peers + /quorum
              </span>
            </header>
            <div className="nsx-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Node</th>
                    <th>Role</th>
                    <th>Latency</th>
                    <th>Agree</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredValidators.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="nsx-empty">
                        {validators.length === 0 ? 'Peer list not read yet.' : `Nothing matches “${query}”.`}
                      </td>
                    </tr>
                  ) : (
                    filteredValidators.slice(0, 5).map((v) => (
                      <tr key={`${v.id}-${v.direction}`}>
                        <td>
                          <span className="nsx-node">
                            <i className={v.agree === false ? 'is-red' : v.self ? 'is-green' : 'is-amber'} />
                            {v.id}
                          </span>
                        </td>
                        <td className="is-dim">{v.direction}</td>
                        <td>{v.latencyMs === null || v.latencyMs === undefined ? '—' : `${v.latencyMs} ms`}</td>
                        <td>
                          <span className={`nsx-badge ${v.agree === false ? 'is-red' : v.agree === null ? 'is-amber' : 'is-teal'}`}>
                            {v.agree === false ? 'missing' : v.agree === null ? 'unknown' : 'agree'}
                          </span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="nsx-card nsx-table">
            <header className="nsx-card-head">
              <h2>Node Metrics</h2>
              <span className="nsx-card-hint">/metrics · since node start</span>
            </header>
            <div className="nsx-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Metric</th>
                    <th>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {metricRows.length === 0 ? (
                    <tr>
                      <td colSpan={2} className="nsx-empty">
                    {snap ? `Nothing matches “${query}”.` : 'Metrics not read yet.'}
                      </td>
                    </tr>
                  ) : (
                    metricRows.map(([label, value]) => (
                      <tr key={label}>
                        <td className="is-dim">{label}</td>
                        <td className="is-num">{value}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="nsx-card nsx-table">
            <header className="nsx-card-head">
              <h2>Events</h2>
              <div className="nsx-tabs" role="tablist" aria-label="Event category">
                {EVENT_FILTERS.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={eventFilter === tab.id}
                    className={eventFilter === tab.id ? 'is-active' : undefined}
                    onClick={() => setEventFilter(tab.id)}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </header>
            <div className="nsx-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Event</th>
                    <th>Age</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredEvents.length === 0 ? (
                    <tr>
                      <td colSpan={2} className="nsx-empty">
                        {feed.events.length === 0
                          ? 'Watching the node — events appear as ledgers close.'
                          : 'No event in this category yet.'}
                      </td>
                    </tr>
                  ) : (
                    filteredEvents.slice(0, 5).map((e) => (
                      <tr key={e.id}>
                        <td>
                          <span className="nsx-alert">
                            <i className={`is-${e.tone}`} />
                            {e.text}
                          </span>
                        </td>
                        <td className="is-dim">{formatAgo(agoSeconds(e.at, now))}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        {/* ------------------------------ Tools ---------------------------- */}
        <section className="nsx-card" ref={(el) => (sections.current.tools = el)}>
          <header className="nsx-card-head">
            <h2>Tools</h2>
            <span className="nsx-card-hint">
              fee {NSAT.baseFee} NSAT · {snap && snap.protocolVersion ? `protocol ${snap.protocolVersion}` : 'protocol —'}
            </span>
          </header>
          <div className="nsx-tools">
            <Link href="/wallet">
              <b>Web wallet</b>
              <span>create, unlock, send with a real NSAT account</span>
            </Link>
            <Link href="/explorer">
              <b>Live explorer</b>
              <span>account balance and transaction lookup</span>
            </Link>
            <Link href="/status">
              <b>Status</b>
              <span>node, gateway and indexer checks</span>
            </Link>
            <Link href="/docs">
              <b>Docs</b>
              <span>fee {NSAT.baseFee} NSAT · 0 decimals</span>
            </Link>
          </div>
        </section>

        <footer className="nsx-foot">
          <span className="nsx-foot-brand">
            NSAT Explorer <em>·</em> live <em>·</em> transparent <em>·</em> secure
          </span>
          <span className="nsx-foot-note">
            read from nsat-core (/info · /peers · /quorum · /metrics) via /api/v1/explorer/snapshot · every{' '}
            {POLL_MS / 1000} s · series combine gateway readings with this tab&apos;s observations
          </span>
        </footer>
      </div>
    </div>
  );
}
