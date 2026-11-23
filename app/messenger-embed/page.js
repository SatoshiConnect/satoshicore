import WalletPanel from '../../components/WalletPanel';
import '../wallet/wallet.css';

export const metadata = {
  title: 'SatoshiCore Wallet · Messenger',
  description: 'The full SatoshiCore Wallet embedded in Messenger. Signing remains on this Wallet origin.',
};

// This route is framed only by chat.satoshicore.org in Caddy. The Wallet
// remains hosted on its own origin so its local encrypted keystore and
// transaction signing never cross into Messenger.
export default function MessengerWalletPage() {
  return <WalletPanel />;
}
