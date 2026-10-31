import WalletPanel from '../../components/WalletPanel';
import './wallet.css';

export const metadata = {
  title: 'NSAT Wallet — SatoshiCore',
  description:
    'The NSAT Web Wallet in the original SatoshiCore Desktop design. Keys are generated and encrypted in your browser; the gateway only relays signed transactions.',
};

export default function WalletPage() {
  return <WalletPanel />;
}
