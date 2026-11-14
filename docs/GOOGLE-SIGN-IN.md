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

The app uses Firebase Authentication only. The sign-in UI remains disabled
when these variables are missing; the non-custodial wallet stays usable.
Firebase config is compiled into static assets at build time, so configure the
production build environment before deploying.

## Data and session behavior

The Firebase SDK uses browser-session auth persistence; signing out or closing
the browser session ends the website login. Firebase/Google process the Google
account ID and basic profile data needed for sign-in. SatoshiCore does not read
Gmail, request mailbox permission, or send wallet addresses, balances, history,
seed, or password to Firebase. The site does not use the Firebase user identity
to authorize wallet signing or wallet access.

Signing in writes nothing by itself. No wallet data is ever written to Firestore,
Realtime Database, Cloud Storage, or a SatoshiCore backend: the only client-writable
document is the opt-in theme entry below. This login is not a security boundary for
private wallet data and must not be described as wallet recovery.

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

## Local verification

After configuration, build locally and test sign-in/sign-out using a test
Google account on `http://localhost:3000`. Then verify the deployed production
origin is listed as an authorized domain. Never use a wallet holding funds to
test account or signing flows.
