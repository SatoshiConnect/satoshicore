// One label per wallet, derived only from things we actually observed.
//
// `chain` is what the network answered for this address right now:
//   exact       the ledger has the account (balance is known)
//   missing     the network answered and has no such account
//   unavailable the network could not be asked (offline, gateway error)
// `backup` and `registration` are this device's own records, never a claim
// about the ledger. "Active On-chain" therefore requires `exact`; a local
// flag can never produce it.
export const WALLET_STATUS = {
  ACTIVE: 'active',
  PENDING: 'pending',
  FAILED: 'failed',
  BACKUP_REQUIRED: 'backup-required',
  CREATED: 'created',
  OFFLINE: 'offline',
};

const LABELS = {
  [WALLET_STATUS.ACTIVE]: 'Active On-chain',
  [WALLET_STATUS.PENDING]: 'Pending Registration',
  [WALLET_STATUS.FAILED]: 'Registration Failed',
  [WALLET_STATUS.BACKUP_REQUIRED]: 'Backup Required',
  [WALLET_STATUS.CREATED]: 'Created Locally',
  [WALLET_STATUS.OFFLINE]: 'Network Unavailable',
};

export function walletStatus({ chain, backup, registration } = {}) {
  const kind = chain?.kind;
  if (kind === 'exact') {
    return { id: WALLET_STATUS.ACTIVE, label: LABELS[WALLET_STATUS.ACTIVE], tone: 'ok' };
  }
  if (kind === 'unavailable' || kind == null) {
    // The backup question is answered on this device, so it is still worth
    // asking when the network is silent — otherwise an offline network hides
    // the one warning the user can act on right now.
    if (kind == null || !backup?.verified) {
      return { id: WALLET_STATUS.BACKUP_REQUIRED, label: LABELS[WALLET_STATUS.BACKUP_REQUIRED], tone: 'warn' };
    }
    return { id: WALLET_STATUS.OFFLINE, label: LABELS[WALLET_STATUS.OFFLINE], tone: 'info' };
  }
  // The ledger answered "no account". Only local records may refine this, and
  // none of them may upgrade it to an on-chain claim.
  const state = String(registration?.state || '');
  if (state === 'pending') {
    return { id: WALLET_STATUS.PENDING, label: LABELS[WALLET_STATUS.PENDING], tone: 'info' };
  }
  if (state === 'failed') {
    return { id: WALLET_STATUS.FAILED, label: LABELS[WALLET_STATUS.FAILED], tone: 'warn' };
  }
  if (!backup?.verified) {
    return { id: WALLET_STATUS.BACKUP_REQUIRED, label: LABELS[WALLET_STATUS.BACKUP_REQUIRED], tone: 'warn' };
  }
  return { id: WALLET_STATUS.CREATED, label: LABELS[WALLET_STATUS.CREATED], tone: 'info' };
}
