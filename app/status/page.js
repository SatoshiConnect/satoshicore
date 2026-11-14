import Link from 'next/link';
import ChainStatus from '../../components/ChainStatus';
import PageHeader from '../../components/PageHeader';

export const metadata = {
  title: 'Status — SatoshiCore'
};

const SERVICES = [
  { name: 'Static site', detail: 'HTML served by Caddy', ok: true },
  { name: 'API Gateway', detail: 'probe above', ok: null },
  { name: 'Indexer', detail: 'read-only history', ok: null },
  { name: 'Admin APIs', detail: 'never public', ok: null }
];

export default function StatusPage() {
  return (
    <div className="stack">
      <PageHeader
        eyebrow="NSAT · operations"
        title="Service status"
        lead="Live chain reading, plus what sits behind this site."
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
