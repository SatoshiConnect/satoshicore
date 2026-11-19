import { MAX_REQUEST_AMOUNT } from './chatPaymentRequest.js';

const ADDRESS_RE = /^G[A-Z2-7]{55}$/;
const UINT_RE = /^(0|[1-9]\d*)$/;

const failure = (reason) => ({ ok: false, reason });

/** Validate the visible coin draft; the wallet rechecks all fields before signing. */
export function prepareChatCoinApproval({
  from,
  to,
  amount,
  balance,
  fee,
  network,
  expectedNetwork,
}) {
  const sender = String(from || '').toUpperCase();
  const recipient = String(to || '').toUpperCase();
  if (!ADDRESS_RE.test(sender) || !ADDRESS_RE.test(recipient) || sender === recipient) {
    return failure('Choose a valid destination address other than this wallet.');
  }
  if (typeof network !== 'string' || !network || network !== expectedNetwork) {
    return failure('The verified network identity is unavailable or does not match.');
  }

  const amountText = String(amount ?? '').replace(/[,_ ]/g, '');
  if (!UINT_RE.test(amountText)) return failure('Enter an exact whole-number amount greater than zero.');
  const amountValue = BigInt(amountText);
  if (amountValue <= 0n || amountValue > MAX_REQUEST_AMOUNT) {
    return failure('Amount is outside the supported exact integer range.');
  }

  const balanceText = String(balance ?? '').replace(/[,_ ]/g, '');
  if (!UINT_RE.test(balanceText)) return failure('Current exact wallet balance is unavailable.');
  if (!Number.isSafeInteger(fee) || fee <= 0) return failure('Current verified network fee is unavailable.');

  const feeValue = BigInt(fee);
  const total = amountValue + feeValue;
  const balanceValue = BigInt(balanceText);
  if (total > balanceValue) return failure('Amount plus network fee exceeds the exact available balance.');

  return {
    ok: true,
    from: sender,
    to: recipient,
    amount: amountValue.toString(),
    fee: feeValue.toString(),
    total: total.toString(),
    network,
  };
}
