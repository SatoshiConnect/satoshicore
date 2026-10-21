'use client';

import { useEffect, useState } from 'react';

// Central backend-availability probe. The static site has no server of its
// own; any functionality that needs the Web Wallet API Gateway or the
// Blockchain Indexer checks here first and degrades to an explicit
// offline/experimental state instead of failing silently.
export const BACKENDS = [
  {
    id: 'api-gateway',
    name: 'Web Wallet API Gateway',
    envKey: 'NEXT_PUBLIC_API_GATEWAY_URL',
    description:
      'Account lookup, transaction construction and broadcast relay. Deployed as a separate service; never bundled into this static site.'
  },
  {
    id: 'indexer',
    name: 'Blockchain Indexer',
    envKey: 'NEXT_PUBLIC_INDEXER_URL',
    description:
      'Chain data queries for balances, history and explorer views. Deployed as a separate service.'
  }
];

export function useBackendStatus() {
  const [status, setStatus] = useState(() =>
    Object.fromEntries(BACKENDS.map((b) => [b.id, 'checking']))
  );

  useEffect(() => {
    let cancelled = false;

    async function probe() {
      const next = {};
      for (const backend of BACKENDS) {
        const url = process.env.NEXT_PUBLIC_INDEXER_URL && backend.envKey
          ? process.env[backend.envKey]
          : process.env[backend.envKey];
        if (!url) {
          next[backend.id] = 'offline';
          continue;
        }
        try {
          const res = await fetch(`${url.replace(/\/$/, '')}/health`, {
            method: 'GET',
            signal: AbortSignal.timeout(5000)
          });
          next[backend.id] = res.ok ? 'online' : 'degraded';
        } catch {
          next[backend.id] = 'offline';
        }
      }
      if (!cancelled) setStatus(next);
    }

    probe();
    return () => {
      cancelled = true;
    };
  }, []);

  return status;
}

export default function BackendStatus({ backendId, children }) {
  const status = useBackendStatus();
  const state = status[backendId] || 'offline';

  if (state === 'online') return children;

  const label =
    state === 'checking'
      ? 'Checking service availability…'
      : 'Offline / experimental mode: the backend service for this feature is not currently available.';

  return (
    <div className="offline-banner" role="status">
      <strong>{label}</strong>
      <p>
        This feature requires a backend service that runs separately from the
        static site. It will activate automatically once the service URL is
        configured and reachable.
      </p>
    </div>
  );
}
