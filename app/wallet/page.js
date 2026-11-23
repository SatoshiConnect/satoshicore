import WalletPanel from '../../components/WalletPanel';
import './wallet.css';

export const metadata = {
  title: 'NSAT Wallet — SatoshiCore',
  description:
    'A non-custodial NSAT wallet that runs in your browser. Keys are generated and encrypted on this device; the gateway only relays signed transactions.',
};

export default function WalletPage() {
  return <WalletPanel />;
}
