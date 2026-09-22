import { initializeApp, getApps } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import {
  getFirestore, initializeFirestore, type Firestore,
  persistentLocalCache, persistentMultipleTabManager, persistentSingleTabManager,
  memoryLocalCache,
} from 'firebase/firestore';
import { getStorage } from 'firebase/storage';
import { getMessaging, isSupported } from 'firebase/messaging';
import { GoogleAuthProvider } from 'firebase/auth';
import { normalizeDbId, primaryDomain, type Tenant } from '@/lib/tenants';
import { clientTenant } from '@/lib/tenantClient';

export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

const firebaseConfig = {
  apiKey:            process.env.NEXT_PUBLIC_FIREBASE_API_KEY!,
  authDomain:        process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN!,
  projectId:         process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID!,
  storageBucket:     process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET!,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID!,
  appId:             process.env.NEXT_PUBLIC_FIREBASE_APP_ID!,
};

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);

// ─── Which database? ───────────────────────────────────────────────────────────
// One build serves every registered domain, so a build-time env var cannot decide this. The
// browser can no longer work it out from the hostname either — the domain→database map lives
// in the `tenants` Firestore database, which you would need this answer to open.
//
// So the SERVER resolves it and injects the result (src/app/layout.tsx), and clientTenant()
// reads it back. The injection is an inline script at the top of <body>, which runs before
// this module is evaluated — that ordering is what keeps `tenant` a plain synchronous const.
//
// NEXT_PUBLIC_FIRESTORE_DB_ID remains the fallback for SSR and for any evaluation with no
// injected value, honoured literally so "test" selects the test database rather than silently
// falling back to production.
export const tenant: Tenant = clientTenant();
const FIRESTORE_DB_ID = normalizeDbId(tenant.dbId);

// ─── Offline cache ─────────────────────────────────────────────────────────────
// BOTH tenants get the persistent (IndexedDB) cache — named databases included — so reads
// are reused across pages, tabs and revisits, and the app works offline.
//
// Multi-tab is the default: the cache is shared between every open tab instead of one tab
// seizing ownership and cutting the others off.
//
// PREREQUISITE for a named database: deploy the composite indexes to it
// (`firebase deploy --only firestore:indexes`). A database missing an index fails an indexed
// listen, and under the persistent cache that trips the firebase-js-sdk "INTERNAL ASSERTION
// FAILED: Unexpected state" bug, which poisons the whole client — every later read and
// check-in throws. See firebase.json for the per-database index config.
//
// NEXT_PUBLIC_FIRESTORE_CACHE is the escape hatch if that bug ever resurfaces:
//   multi (default) | single | memory
type CacheMode = 'multi' | 'single' | 'memory';
const REQUESTED_CACHE = ((process.env.NEXT_PUBLIC_FIRESTORE_CACHE || 'multi').trim().toLowerCase()) as CacheMode;

const CACHE_LABEL: Record<CacheMode, string> = {
  multi:  'multi-tab',
  single: 'single-tab',
  memory: 'memory (no offline persistence)',
};

function localCacheFor(mode: CacheMode) {
  if (mode === 'memory') return memoryLocalCache();
  return persistentLocalCache({
    tabManager: mode === 'single'
      ? persistentSingleTabManager({ forceOwnership: true })
      : persistentMultipleTabManager(),
  });
}

// The instance is cached on globalThis so Next.js HMR module re-evaluations don't call
// initializeFirestore() twice on the same app — that itself throws "Unexpected state".
// SSR (no window) always falls back to plain getFirestore().
declare global {
  // eslint-disable-next-line no-var
  var __firestoreDb: Firestore | undefined;
}

const plainDb = () => (FIRESTORE_DB_ID ? getFirestore(app, FIRESTORE_DB_ID) : getFirestore(app));

function makeDb(): Firestore {
  if (typeof window === 'undefined') return plainDb();
  if (globalThis.__firestoreDb) return globalThis.__firestoreDb;

  let effective: CacheMode | 'reused' = REQUESTED_CACHE;
  try {
    globalThis.__firestoreDb = initializeFirestore(
      app,
      { localCache: localCacheFor(REQUESTED_CACHE) },
      FIRESTORE_DB_ID || undefined,
    );
  } catch {
    // initializeFirestore already called (duplicate module eval) — grab the existing instance.
    globalThis.__firestoreDb = plainDb();
    effective = 'reused';
  }

  const dbLabel = FIRESTORE_DB_ID || '(default)';
  const cacheLabel = effective === 'reused' ? 'existing instance' : CACHE_LABEL[REQUESTED_CACHE];
  const domain = window.location.hostname || primaryDomain(tenant);
  const style = 'color:#f59e0b;font-weight:600';
  console.log(`%c🔥 Domain: ${domain} | Firestore database: ${dbLabel}`, style);
  console.log(`%c🔥 Firestore offline cache: ${cacheLabel}`, style);

  return globalThis.__firestoreDb;
}

export const auth    = getAuth(app);
export const db      = makeDb();
export const storage = getStorage(app);

export const getMessagingInstance = async () => {
  if (typeof window === 'undefined') return null;
  const supported = await isSupported();
  if (!supported) return null;
  return getMessaging(app);
};

export default app;
