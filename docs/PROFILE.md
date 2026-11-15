# Profile (basic)

A profile is three things and nothing more: a **self-chosen public ID**, a
**verified email** behind the account, and **one wallet chosen as primary**.

It is not an authentication factor. A profile proves nothing about a wallet and
cannot sign; every send path still needs the local encrypted keystore and its
password. A profile ID is a handle, never a key.

## Documents

```
profiles/{uid}                    = { profileId: "@somchai", primaryAddress: "G…" | "" }
profileIds/{profileId}            = { uid: "…" }      // e.g. profileIds/@somchai
```

The `@` is part of the stored ID, not decoration added while rendering: the
label, the profile field and the claim document id are the same string. A bare
name without `@` is rejected rather than silently rewritten, so what is stored
is exactly what is shown and claimed.

- Both fields always exist on the profile, so the rules can check the shape
  without looping, and there is nowhere to add a name, balance, history, seed,
  password or email.
- The claim document is what makes an ID unique. It is **create-only**
  (`allow update: if false`), so an ID cannot be re-pointed or taken over.
- `get` on `profileIds` is allowed for signed-in accounts (so a free ID can be
  checked) and `list` is denied, so IDs cannot be enumerated.
- `walletLinks` is unchanged: a primary wallet must be an address the same
  account already linked, which the rules prove with `exists()`/`get()`.

## Email verification

No verification email is sent by this site, because it is a static build with no
server of its own. Verification is the identity provider's claim —
`request.auth.token.email_verified` — and it is part of the signed-in token, so a
page cannot set it.

`firestore.rules` requires `request.auth.token.email_verified == true` for every
profile and claim write. An account whose email is not verified therefore cannot
create a profile even by calling the Firestore API directly, and the card says
why instead of failing silently. The email address itself is never written to
Firestore; only the claim is checked. Google accounts arrive verified, so this
requirement is normally satisfied by signing in.

## Creating, changing, deleting

- **Create**: claim the ID, then write the profile. The claim is what the rules
  require the profile's ID to be, so the two cannot disagree. If the profile
  write fails after the claim, the claim is released again — a failed attempt
  must not burn an ID.
- **Taken ID**: reported as taken, before and after the race. A concurrent claim
  loses at the rules (`create` only), and that refusal is reported as "taken",
  not as a generic error.
- **Edit**: the ID and the primary wallet are edited together in one form with
  **Save changes** / **Cancel**, and both are written in a single profile write.
  The new ID's claim is taken first, the profile is written, and only then is the
  old claim released — so a failure in between leaves the account holding its
  existing ID and frees the new one again. Cancel restores both fields from the
  saved profile; nothing is sent.
- **What is editable, and what is not**: the ID and the primary wallet are the
  only two stored fields, and both are editable. The email is not: it is the
  provider's identity for the account, shown with its verified badge, and
  `firestore.rules` reads `email_verified` from the signed-in token — a change
  here would have to happen at the provider and is deliberately not offered, so
  the card says so instead of showing a dead control.
- **Change primary wallet**: allowed only to one of the linked addresses; the
  select lists those, and the rules re-check the link.
- **Delete**: removes `profiles/{uid}` and the claim it holds, freeing the ID.
  No wallet, key or balance is touched.

The wallet screen opens on the account's primary wallet when it is still linked,
so the choice has a visible effect rather than being a label nobody reads. It
only chooses which linked address opens first; it grants nothing.

When a profile exists, the wallet home also shows the `@id` next to the address
(a copy button with the tooltip “a handle, not a payment address”), so the name
the person chose is visible where they use the wallet rather than buried in
Settings. It is display only and is not resolvable to an address yet.

## Provisioning (one-time, Firebase console)

1. Firestore Database → Rules → paste `satoshicore-web/firestore.rules` and
   publish. The `profiles` and `profileIds` blocks must go out with the existing
   `websitePreferences` and `walletLinks` blocks; publishing only part of the file
   makes the profile card report a rules refusal (the wallet itself is
   unaffected).
2. Keep the same authorized domains; no extra OAuth scope is needed.
3. Sign-in method: Google (already required for the account features). Email
   verification comes from the provider and needs no extra setting for Google
   accounts.

## What is verified, and what is not

- `npm test` includes `tests/profile.test.mjs` (13 checks): ID validation and
  wording (including that `@` is required and stored), the exact two-field
  document, claim/race handling, the round trip (create → primary → delete →
  release), editing (one save writes ID + primary together, new claim first, old
  released after, failed save gives the new ID back, an unlinked primary wallet is
  refused before any write), the Firestore store writing one profile and one
  claim document, refusal wording, and assertions on the rules file
  (verified-email requirement, `hasOnly` shapes, claim/`walletLinks` linkage,
  no `list`, no `update`, deny-all fallback, no `if true`).
- The card was rendered in a local build and shows, for a signed-out visitor,
  "Sign in above to create a profile." — wiring only.
- **Not verified**: the actual write path against a live database, because that
  needs a signed-in Google account and the rules published in the project. The
  401s in a local dev console come from pointing the dev build at a chat relay
  that is not the gateway, and are unrelated to the profile.
