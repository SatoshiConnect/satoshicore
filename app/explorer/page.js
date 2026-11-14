import Link from 'next/link';
import ExplorerPanel from '../../components/ExplorerPanel';
import PageHeader from '../../components/PageHeader';

export const metadata = {
  title: 'Search — SatoshiCore'
};

export default function ExplorerPage() {
  return (
    <div className="stack">
      <PageHeader
        eyebrow="NSAT · read-only lookup"
        title="Search the chain"
        lead="One account ID or transaction hash. Read-only."
        actions={
          <>
            <Link href="/dashboard" className="button">Open the live explorer</Link>
            <Link href="/wallet" className="button secondary">Open the wallet</Link>
          </>
        }
      />
      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Account / transaction lookup</h2>
          <span className="panel-meta">
            G… account · 64-hex hash
          </span>
        </div>
        <div className="panel-body">
          <ExplorerPanel />
        </div>
      </section>
    </div>
  );
}
