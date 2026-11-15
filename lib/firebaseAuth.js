// Direct public env reads are required: Next.js substitutes these values into
// client bundles at build time for static export.
const BUILD_CONFIG = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY || '',
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || '',
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || '',
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID || '',
};

export function getFirebaseWebConfig(overrides = {}) {
  return {
    apiKey: overrides.apiKey ?? BUILD_CONFIG.apiKey,
    authDomain: overrides.authDomain ?? BUILD_CONFIG.authDomain,
    projectId: overrides.projectId ?? BUILD_CONFIG.projectId,
    appId: overrides.appId ?? BUILD_CONFIG.appId,
  };
}

export function isFirebaseWebConfigured(config = BUILD_CONFIG) {
  return Object.values(config).every((value) =>
    typeof value === 'string' && value.trim().length > 0,
  );
}

let authClientPromise;

const REMEMBER_GOOGLE_SESSION_KEY = 'nsat-google-remember-device';

// This preference contains no account token or wallet data; it only selects
// Firebase's browser-local vs browser-session persistence mode on next load.
export function shouldRememberGoogleSession(storage = globalThis.localStorage) {
  if (!storage) return false;
  try {
    return storage.getItem(REMEMBER_GOOGLE_SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

export function setRememberGoogleSession(enabled, storage = globalThis.localStorage) {
  if (!storage) return false;
  try {
    if (enabled) storage.setItem(REMEMBER_GOOGLE_SESSION_KEY, '1');
    else storage.removeItem(REMEMBER_GOOGLE_SESSION_KEY);
    return true;
  } catch {
    // The caller still has its current session; next sign-in will default to
    // session-only. Callers must not claim the choice was stored.
    return false;
  }
}

/** Switch the Google website session persistence after explicit user choice. */
export async function setGoogleSessionPersistence(remember) {
  const { auth, authSdk } = await loadGoogleAuth();
  const persistence = remember
    ? authSdk.browserLocalPersistence
    : authSdk.browserSessionPersistence;
  await authSdk.setPersistence(auth, persistence);
  const saved = setRememberGoogleSession(remember);
  if (remember && !saved) {
    // Don't leave a LOCAL Firebase session when we cannot persist that the user
    // opted in to it. Fall back to session-only and make the UI report failure.
    await authSdk.setPersistence(auth, authSdk.browserSessionPersistence);
    throw new Error('could not store the remember-device choice');
  }
  // For false, absent storage already means off by default; Firebase has still
  // been switched to session-only, so the safer behavior is preserved.
  return remember;
}

function firebaseApp(appSdk) {
  return appSdk.getApps().length ? appSdk.getApp() : appSdk.initializeApp(getFirebaseWebConfig());
}

// Firestore is loaded only when the user opts into theme sync, so the wallet
// page does not pay for the database SDK unless that feature is used.
let firestorePromise;

export function loadFirestore() {
  if (!isFirebaseWebConfigured()) {
    return Promise.reject(new Error('Firebase is not configured for this build.'));
  }
  if (!firestorePromise) {
    firestorePromise = Promise.all([
      import('firebase/app'),
      import('firebase/firestore'),
    ]).then(([appSdk, sdk]) => {
      const app = firebaseApp(appSdk);
      return { sdk, db: sdk.getFirestore(app) };
    }).catch((error) => {
      firestorePromise = null;
      throw error;
    });
  }
  return firestorePromise;
}

export function loadGoogleAuth() {
  if (!isFirebaseWebConfigured()) {
    return Promise.reject(new Error('Google sign-in is not configured for this build.'));
  }
  if (!authClientPromise) {
    authClientPromise = Promise.all([
      import('firebase/app'),
      import('firebase/auth'),
    ]).then(async ([appSdk, authSdk]) => {
      const app = firebaseApp(appSdk);
      const remember = shouldRememberGoogleSession();
      const auth = authSdk.initializeAuth(app, {
        persistence: remember
          ? authSdk.browserLocalPersistence
          : authSdk.browserSessionPersistence,
        popupRedirectResolver: authSdk.browserPopupRedirectResolver,
      });
      // The default is session-only. browserLocalPersistence is selected only
      // after an explicit "Remember this device" choice. This persists the
      // website identity session, never wallet unlock state or signing keys.
      return { auth, authSdk };
    }).catch((error) => {
      authClientPromise = null;
      throw error;
    });
  }
  return authClientPromise;
}
