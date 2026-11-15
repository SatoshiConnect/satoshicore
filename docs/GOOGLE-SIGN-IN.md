# Google sign-in for the website (optional)

Google sign-in identifies a SatoshiCore **website session only**. It does not unlock, back up, sync, or recover an NSAT wallet. Wallet seed and password remain
in the local encrypted keystore. The app requests basic Google sign-in only; it
does not request Gmail mailbox scopes and has no analytics integration. The one
optional exception is theme sync — a single `light`/`dark` value described below.

## Configure the no-cost Firebase project

1. Create or choose a Firebase project on the Spark (no-cost) plan. Google/social
   authentication is subject to Firebase's current free-plan quota (currently
   3,000 daily active users for most providers); sign-in can stop if limits or
   provider policy change. Do not enable paid services or attach billing for
   this feature.
2. Register a Firebase Web app and copy its `apiKey`, `authDomain`,
   `projectId`, and `appId`.
3. In **Authentication → Sign-in method**, enable **Google**.
4. In **Authentication → Settings → Authorized domains**, add `satoshicore.org`
   and `localhost` for local development.
5. Configure a Google OAuth consent screen/client as prompted by Firebase. Use
   the default Firebase auth handler at
   `https://<authDomain>/__/auth/handler`; no extra Google API scopes are needed.
6. Set the public build variables below in the environment used for `next build`.
   These Firebase web config values identify the project; they are not server
   secrets. Keep the API key restricted to Firebase-related APIs in Google
   Cloud. Do not add Google client secrets to this static site.

```sh
NEXT_PUBLIC_FIREBASE_API_KEY=...
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=your-project
NEXT_PUBLIC_FIREBASE_APP_ID=...
```

The app uses Firebase Authentication for the optional website identity only.
The sign-in UI remains disabled when these variables are missing; the
non-custodial wallet stays usable. Session persistence defaults to session-only;
Remember this device is a separate opt-in and affects Firebase sign-in only.
Firebase config is compiled into static assets at build time, so configure the
production build environment before deploying.

## Data and session behavior

Google sign-in is session-only by default: closing the browser session ends the website login. The optional **Remember this device** checkbox selects Firebase
`browserLocalPersistence`, which keeps the Firebase website sign-in session on
this browser until the user signs out or clears site data. This preference is
stored locally as a single boolean; Firebase stores its authentication session
using its normal browser persistence. It is specific to this browser/origin;
it does not transfer sign-in to a different device. Do not enable it on a shared
or public computer. Signing out removes the Firebase session and resets the
choice to off.

This persists only the website identity session. It does not unlock the wallet,
remember its password, sync a signing key, or grant permission to sign. Even on
a remembered device, signing still requires the local encrypted keystore to be
unlocked. A watched wallet address remains public/read-only as described below.

Firebase/Google process the Google account ID and basic profile data needed for
sign-in. SatoshiCore does not read Gmail, request mailbox permission, or send
the wallet name, balances, history, seed or password to Firebase. A public wallet
address is stored only if the user explicitly links one (below). The site never
uses the Firebase user identity to authorize signing: a signature still
requires the local encrypted keystore and its password.

Signing in writes nothing by itself. No wallet key material is ever written to
Firestore, Realtime Database, Cloud Storage, or a SatoshiCore backend. The only
client-writable documents are the two opt-in entries below: the theme, and
optionally one public address. This login is not a security boundary for private
wallet data and must not be described as wallet recovery.

## Optional theme sync

Wallet → Settings → Website account has a **Theme sync** control that is off by
default. Turning it on writes exactly one Firestore document:

```
websitePreferences/{googleAuthUid} = { theme: "light" | "dark" }
```

Turning it on adopts the theme already stored for the account (applying it to this
device) or, if there is none, saves this device's theme. After that, changing the
theme toggle on any signed-in device updates that document, and the next sign-in
applies it. Turning it off deletes the document and clears the local flag.

Prerequisites in the Firebase project (once):

1. **Build → Firestore Database → Create database.** Choose production mode. The
   Spark plan includes a free daily quota of document reads/writes, which is far
   above what one theme document uses; do not attach billing for this feature.
2. **Firestore Database → Rules**, paste `satoshicore-web/firestore.rules` and
   publish. It allows a user to read/delete only their own document, allows writes
   only for the owner with the single `theme` field and one of the two values, and
   denies every other path. Read the file before publishing; it is the enforcement
   point for "no wallet data in the database".
3. Keep the same authorized domains; Firestore needs no extra OAuth scope.

Rules are enforced by the database, not the page, so a modified client still
cannot read another account's document or add fields. If the database or rules
are missing, the toggle reports that sync could not be changed and the wallet is
unaffected — the theme keeps working locally.

## Optional watch-only address link

Settings → Website account has a **Linked wallets** control, separate from theme
sync and off by default. One account can link several wallets (up to ten),
because one person usually holds more than one. Each linked wallet is its own
document:

```
walletLinks/{googleAuthUid}/addresses/{address} = { address: "G…" }
```

The document id must equal the address it holds, which is what lets the rules
prove the shape without looping over a list. A single-address document from
before this supported more than one wallet (`walletLinks/{uid} = { address }`)
is still read as one more entry and is deleted when that address is unlinked.

What it is for: after signing in with Google on another device, that device can
show the address's balance and receive screen without holding a key. What it is
not: an address is public, it proves nothing about ownership, it confers no
spending power, and it is not a backup. Every send path still requires the
keystore and password on the device doing the signing; a watched address is
rendered read-only, with the Send action absent rather than failing later.

An address must be a canonical 56-character account id. `firestore.rules` enforces
the owner check plus `keys().hasOnly(['address'])`, `address == address` (the
document id) and `address.matches('^G[A-Z2-7]{55}$')`, so no balance, history,
name, seed or password can be added to that document. On read, anything that is
not one of those addresses is dropped (`lib/walletLinks.js`). Removing one entry
deletes only that document; removing all of them also clears the local
per-account flag. The ten-wallet cap is enforced by the client, because a rules
file cannot count a collection.

Deploy uses the same Firestore database and the same `firestore.rules` file; the
`walletLinks` block must be published together with the preferences block or the
link control reports that it could not be changed (the wallet is unaffected).

## Local verification

After configuration, build locally and test sign-in/sign-out using a test
Google account on `http://localhost:3000`. Then verify the deployed production
origin is listed as an authorized domain. Never use a wallet holding funds to
test account or signing flows.
