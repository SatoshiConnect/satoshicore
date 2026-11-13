import HomeWallet from '../components/HomeWallet';

export const metadata = {
  title: 'NSAT Wallet — SatoshiCore',
  description:
    'Open the NSAT wallet or install the browser extension. Non-custodial: keys are generated and encrypted on your device, transactions are signed locally.',
};

export default function HomePage() {
  return <HomeWallet />;
}
