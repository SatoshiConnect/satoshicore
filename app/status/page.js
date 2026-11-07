import Link from 'next/link';
import ChainStatus from '../../components/ChainStatus';
import PageHeader from '../../components/PageHeader';

export const metadata = {
  title: 'Status — SatoshiCore'
};

const SERVICES = [
  {
    name: 'Static site (satoshicore.org)',
    detail: 'exported HTML served by Caddy from this machine',
    ok: true
  },
  {
    name: 'Web Wallet API Gateway',
    detail: 'separate service — probe live above',
    ok: null
  },
  {
    name: 'Blockchain Indexer',
    detail: 'separate read-only service over the node history archive',
    ok: null
  },
  {
    name: 'Administrative APIs',
    detail: 'never publicly exposed through this site or the gateway',
    ok: null
  }
];

export default function StatusPage() {
  return (
    <div className="stack">
      <PageHeader
        eyebrow="NSAT · operations"
        title="Service status"
        lead="The web platform is fully static. Chain data is read through the Web Wallet API Gateway from the nsat-core node; when the gateway is configured and reachable, the live reading appears below. Anything a service does not answer is shown as unknown, never guessed."
        actions={
          <>
            <Link href="/dashboard" className="button">Live explorer</Link>
            <Link href="/docs" className="button secondary">How it is served</Link>
          </>
        }
      />

      <ChainStatus />

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Services behind this site</h2>
          <span className="panel-meta">read-only · no admin surface</span>
        </div>
        <div className="panel-body">
          <ul className="status-list">
            {SERVICES.map((s) => (
              <li key={s.name}>
                <strong>{s.name}:</strong> {s.detail}
                {s.ok === true ? ' — operational' : null}
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}
