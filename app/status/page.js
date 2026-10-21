import ChainStatus from '../../components/ChainStatus';

export const metadata = {
  title: 'Status — SatoshiCore'
};

export default function StatusPage() {
  return (
    <div>
      <h1>Service Status</h1>
      <p>
        The web platform is fully static. Chain data is read through the Web
        Wallet API Gateway from the nsat-core node; when the gateway is
        configured and reachable, live status appears below.
      </p>
      <ChainStatus />
      <ul className="status-list">
        <li>
          <strong>Static site (GitHub Pages):</strong> operational
        </li>
        <li>
          <strong>Web Wallet API Gateway:</strong> separate service — probes
          live above
        </li>
        <li>
          <strong>Blockchain Indexer:</strong> separate service — planned
          phase
        </li>
        <li>
          <strong>Administrative APIs:</strong> never publicly exposed through
          this site or the gateway
        </li>
      </ul>
    </div>
  );
}
