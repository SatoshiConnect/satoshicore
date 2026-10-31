import Link from 'next/link';

export default function Footer() {
  return (
    <footer className="site-footer">
      <div className="container">
        <p>
          SatoshiCore Web Platform v24.0 — static build. Web Wallet and explorer
          data services run as separate backend components; features requiring
          them are shown in offline/experimental mode until they are available.
        </p>
      </div>
    </footer>
  );
}
