// Structured request-to-pay messages for the encrypted chat.
//
// Requests are ordinary E2E message text at the relay. The marker only becomes
// actionable after the recipient decrypts it and verifies that its claimed
// address is the authenticated sender (`message.from`). It never triggers a
// transaction: the recipient opens the Send form and reviews/confirms through
// the wallet's normal local signing path.
import { normalizeAddress } from './profile.js';

const PREFIX = 'NSAT-PAY-REQUEST/1\n';
// The wallet codec serializes NativeAmount128 as signed i64 hi + uint64 lo.
export const MAX_REQUEST_AMOUNT = (1n << 127n) - 1n;

function normalizeAmount(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  try {
    const amount = BigInt(value);
    return amount <= MAX_REQUEST_AMOUNT ? amount.toString() : null;
  } catch {
    return null;
  }
}

/** Create the plaintext payload; chat encrypts it before the relay sees it. */
export function createPaymentRequestText({ amount, address } = {}) {
  const normalizedAmount = normalizeAmount(amount);
  const normalizedAddress = normalizeAddress(address);
  if (!normalizedAmount) throw new Error('Enter a whole-number NSAT amount greater than zero.');
  if (!normalizedAddress) throw new Error('A payment request needs a valid wallet address.');
  return `${PREFIX}${JSON.stringify({ amount: normalizedAmount, address: normalizedAddress })}`;
}

/**
 * Parse only a well-formed request from the authenticated sender.
 * `null` means normal chat text; malformed markers are visible but inert.
 */
export function parsePaymentRequestText(text, authenticatedFrom) {
  if (typeof text !== 'string' || !text.startsWith(PREFIX)) return null;
  let data;
  try {
    data = JSON.parse(text.slice(PREFIX.length));
  } catch {
    return { kind: 'invalid', reason: 'This payment request is malformed and cannot be used.' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)
      || Object.keys(data).sort().join(',') !== 'address,amount') {
    return { kind: 'invalid', reason: 'This payment request is malformed and cannot be used.' };
  }
  const amount = normalizeAmount(data.amount);
  const address = normalizeAddress(data.address);
  const sender = normalizeAddress(authenticatedFrom);
  if (!amount || !address) {
    return { kind: 'invalid', reason: 'This payment request has invalid details and cannot be used.' };
  }
  if (!sender || sender !== address) {
    return { kind: 'invalid', reason: 'This request address does not match the verified sender.' };
  }
  return { kind: 'payment-request', amount, address };
}
