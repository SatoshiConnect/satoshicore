export const metadata = {
  title: 'Status — SatoshiCore'
};

export default function StatusPage() {
  return (
    <div>
      <h1>Service Status</h1>
      <p>
        The web platform is fully static. The components below are separate
        backend services; when a service URL is configured and reachable, its
        status updates live in the browser.
      </p>
      <ul className="status-list">
        <li>
          <strong>Static site (GitHub Pages):</strong> operational
        </li>
        <li>
          <strong>Web Wallet API Gateway:</strong> separate service — not yet
          connected
        </li>
        <li>
          <strong>Blockchain Indexer:</strong> separate service — not yet
          connected
        </li>
        <li>
          <strong>Administrative APIs:</strong> never publicly exposed through
          this site
        </li>
      </ul>
    </div>
  );
}
