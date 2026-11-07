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
        lead="Look up one NSAT account ID or transaction hash. Live balances come from a node through the Web Wallet API Gateway; transaction history and transaction details come from the indexer built from the node's own history archive. Nothing here can sign or submit a transaction."
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
