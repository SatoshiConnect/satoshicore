import WalletPanel from '../../components/WalletPanel';
import './wallet.css';

export const metadata = {
  title: 'NSAT Wallet — SatoshiCore',
  description:
    'The NSAT Web Wallet, the same wallet as the SatoshiCore iPhone app. Keys are generated and encrypted in your browser; the gateway only relays signed transactions.',
};

export default function WalletPage() {
  return <WalletPanel />;
}
