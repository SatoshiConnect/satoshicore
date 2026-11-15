import ExplorerDashboard from '../../components/ExplorerDashboard';
import './dashboard.css';

export const metadata = {
  title: 'NSAT Explorer — live dashboard',
  description:
    'Live NSAT chain readings: ledger head, close times, throughput, quorum agreement, peers and node metrics, read from the running nsat-core node through the same-origin gateway.',
};

export default function DashboardPage() {
  return <ExplorerDashboard />;
}
