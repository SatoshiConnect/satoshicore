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
      const auth = authSdk.initializeAuth(app, {
        persistence: authSdk.browserSessionPersistence,
        popupRedirectResolver: authSdk.browserPopupRedirectResolver,
      });
      // Session-only persistence is initialized before auth can restore any
      // previous local-persistence session. This identifies the site user only;
      // it is not wallet key backup or sync.
      return { auth, authSdk };
    }).catch((error) => {
      authClientPromise = null;
      throw error;
    });
  }
  return authClientPromise;
}
