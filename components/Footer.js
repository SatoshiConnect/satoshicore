import Link from 'next/link';
import { NSAT } from '../lib/nsatToken';

export default function Footer() {
  return (
    <footer className="site-footer">
      <div className="container">
        <p>
          Non-custodial · {NSAT.baseFee} NSAT per operation · not a sale or
          investment offer.
        </p>
        <p className="footer-links">
          <Link href="/dashboard">Explorer</Link> · <Link href="/explorer">Search</Link> ·{' '}
          <Link href="/wallet">Wallet</Link> · <Link href="/docs">Docs</Link> ·{' '}
          <Link href="/status">Status</Link> · <Link href="/security">Security</Link> ·{' '}
          <Link href="/terms">Terms</Link> · <Link href="/privacy">Privacy</Link>
        </p>

      </div>
    </footer>
  );
}
