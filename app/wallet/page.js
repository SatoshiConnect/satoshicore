import WalletPanel from '../../components/WalletPanel';

export const metadata = {
  title: 'Web Wallet — SatoshiCore'
};

export default function WalletPage() {
  return (
    <div>
      <h1>Web Wallet</h1>
      <p>
        The Web Wallet runs entirely in your browser. Transaction signing is
        performed client-side; the API Gateway never receives key material —
        only already-signed transactions.
      </p>
      <WalletPanel />
    </div>
  );
}
