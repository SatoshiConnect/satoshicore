// A profile link is deliberately just a URL: the sender hands it to any channel
// (Messages, email, a QR scan) and the recipient can open it hours later. No
// socket, session, or running app is required at share time.
//
// The query parameter is the same `?add=` value the chat's add field accepts:
// an `@handle` or a `G…` address. Prefer the handle only when the profile is
// readable by any signed-in account; a contacts-only/private handle would be
// denied for most recipients, so share the address instead when one exists.
import { normalizeAddress, normalizeProfileId, profileDisplayLabel } from './profile.js';

export const PROFILE_SHARE_PARAM = 'add';

export function profileShareTarget(profile) {
  const id = normalizeProfileId(profile?.profileId);
  const address = normalizeAddress(profile?.primaryAddress);
  const visibility = profile?.visibility === undefined ? 'signed-in' : profile.visibility;
  if (visibility === 'signed-in' && id) return id;
  if (address) return address;
  return id || '';
}

export function buildProfileShareUrl(href, profile) {
  const target = profileShareTarget(profile);
  if (!target || typeof href !== 'string' || !href) return '';
  let url;
  try {
    url = new URL(href);
  } catch {
    return '';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
  url.search = '';
  url.hash = '';
  url.searchParams.set(PROFILE_SHARE_PARAM, target);
  return url.toString();
}

export function profileShareText(profile) {
  const label = profileDisplayLabel(profile, 'My NSAT profile');
  return `Chat with ${label} on NSAT`;
}

/** True when the link only works for people the owner already allowed. */
export function isLimitedShare(profile) {
  if (!profile) return false;
  const visibility = profile.visibility === undefined ? 'signed-in' : profile.visibility;
  return visibility !== 'signed-in' && !normalizeAddress(profile.primaryAddress);
}

/** The warning shown beside the link, or an empty string when none applies. */
export function profileShareWarning(profile) {
  if (!profile || normalizeAddress(profile.primaryAddress)) return '';
  if (isLimitedShare(profile)) {
    return 'This profile is limited and has no primary wallet. The link only works for people already allowed to view it; choose a primary wallet to share an address that anyone can use.';
  }
  return 'This profile has no primary wallet. The link opens your profile, but the other person cannot start a chat until you choose one.';
}
