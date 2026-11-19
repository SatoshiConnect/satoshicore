'use client';

import { migrateArchiveData } from './chatArchive.js';
import { migratePaymentRequests } from './chatPaymentInbox.js';
import { chatMigrationDone, markChatMigrationDone } from './chatIdentity.js';

/**
 * Move old seed-encrypted local chat data under the separate chat identity.
 * The wallet has to be unlocked once for this one-time migration; after it, the
 * chat, inbox and archive work while the wallet is locked.
 */
export async function migrateChatData({
  walletSeed32, chatIdentity, address, storage = undefined,
} = {}) {
  const owner = String(address || '').toUpperCase();
  if (!owner || !chatIdentity?.seed32) return { done: false, migrated: 0 };
  if (chatMigrationDone(owner, storage)) return { done: true, migrated: 0 };
  if (!(walletSeed32 instanceof Uint8Array) || walletSeed32.length !== 32) {
    return { done: false, migrated: 0 };
  }
  const archive = await migrateArchiveData({
    fromSeed32: walletSeed32, toSeed32: chatIdentity.seed32, address: owner,
  });
  const requests = await migratePaymentRequests({
    fromSeed32: walletSeed32, toSeed32: chatIdentity.seed32, address: owner,
  });
  markChatMigrationDone(owner, storage);
  return {
    done: true,
    migrated: (archive.migrated || 0) + (requests.migrated || 0),
    archive,
    requests,
  };
}