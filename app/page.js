import Link from 'next/link';
import InstallApp from '../components/InstallApp';
import WalletPanel from '../components/WalletPanel';
// The homepage IS the wallet (UNIVERSAL WALLET DIRECTIVE §4): there is no
// landing page in front of it, and no visit to /wallet is required first.
// /wallet/ stays as an alias so existing links and the installed PWA keep
// working. Same component, same core, same storage as that route.
import './wallet/wallet.css';

export const metadata = {
  title: 'NSAT Wallet — SatoshiCore',
  description:
    'The NSAT wallet: create or import a wallet, see the exact balance, send and '
    + 'receive NSAT. Non-custodial — the seed is generated and encrypted on this '
    + 'device and every transaction is signed locally.',
};

export default function HomePage() {
  return (
    <>
      <WalletPanel />
      {/* Secondary: after the wallet actions, not in front of them. */}
      <div className="nw-extras">
        <InstallApp />
        <Link className="button secondary" href="/download/">How to install</Link>
      </div>
    </>
  );
}
