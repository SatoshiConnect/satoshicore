// NSAT Wallet — browser extension popup entry.
//
// This is the SAME wallet the satoshicore.org web page serves: the verbatim
// WalletPanel component over the audited lib/* engine (local Ed25519
// signing, exact network-identity gate, live baseFee). The only differences
// from the web deployment are injected at build time:
//   - storage backend: chrome.storage.local instead of page localStorage
//   - configuration: build-time gateway/indexer/network constants
import { createRoot } from 'react-dom/client';
import WalletPanel from '../../components/WalletPanel';
import { setWalletStorage } from '../../lib/nsatWallet';
import { createWalletStorage } from './storage';

async function boot() {
  const storage = createWalletStorage(chrome.storage.local);
  // Hydrate BEFORE installing the adapter / mounting React: nsatWallet's
  // reads are synchronous, so the ciphertext must already be in memory.
  await storage.hydrate();
  setWalletStorage(storage);
  createRoot(document.getElementById('root')).render(<WalletPanel />);
}

boot();
