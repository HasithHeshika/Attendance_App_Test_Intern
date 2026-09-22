import { initializeApp, getApps, cert, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import {
  normalizeDbId, tenantByHost, tenantById, tenantForDbId, type Tenant,
} from '@/lib/tenants';
import { tenantsSync } from '@/lib/tenantRegistry';

// Normalise FIREBASE_ADMIN_PRIVATE_KEY across the ways hosts (Netlify/Vercel/etc.) mangle
// it. Handles, in order: surrounding quotes kept literally, a base64-encoded key, and
// escaped "\n" sequences that must become real newlines. Without this, a valid key pasted
// with quotes or as base64 makes cert() throw → verifyIdToken fails → "bad_token".
function normalizePrivateKey(raw?: string): string | undefined {
  if (!raw) return undefined;
  let k = raw.trim();

  // 1. Strip a single pair of accidental surrounding quotes.
  if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) {
    k = k.slice(1, -1).trim();
  }

  // 2. If there's no PEM header, it may be base64-encoded — decode and use if it yields one.
  if (!k.includes('BEGIN PRIVATE KEY')) {
    try {
      const decoded = Buffer.from(k, 'base64').toString('utf8');
      if (decoded.includes('BEGIN PRIVATE KEY')) k = decoded.trim();
    } catch { /* not base64 — fall through */ }
  }

  // 3. Restore escaped newlines (and any literal CRLF escapes) to real newlines.
  k = k.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n');
  return k;
}

// Reads the service account from env vars:
//   FIREBASE_ADMIN_PROJECT_ID
//   FIREBASE_ADMIN_CLIENT_EMAIL
//   FIREBASE_ADMIN_PRIVATE_KEY   (raw PEM, escaped \n, base64, or quote-wrapped — all OK)
function getAdminApp(): App {
  const existing = getApps();
  if (existing.length) return existing[0];

  const projectId   = process.env.FIREBASE_ADMIN_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_ADMIN_CLIENT_EMAIL;
  const privateKey  = normalizePrivateKey(process.env.FIREBASE_ADMIN_PRIVATE_KEY);

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error('Firebase Admin credentials are not configured (FIREBASE_ADMIN_* env vars).');
  }
  if (!privateKey.includes('BEGIN PRIVATE KEY')) {
    throw new Error('FIREBASE_ADMIN_PRIVATE_KEY is malformed (no PEM header after normalisation).');
  }

  return initializeApp({
    credential: cert({ projectId, clientEmail, privateKey }),
  });
}

// ─── Which database? ───────────────────────────────────────────────────────────
// ONE deployment serves altavision.lk AND carecode.org, so the database is resolved PER
// REQUEST, never from a build-time env var. Always use adminDbFor(req) in a route handler —
// a bare adminDb() falls back to the env default and would silently read/write the WRONG
// tenant's data. See src/lib/tenants.ts for the domain → database map.
//
// FIRESTORE_DB_ID remains the fallback for local dev and for any caller with no request
// context (scripts). It is normalised exactly like the client (see src/lib/firebase.ts).
const ENV_DB_ID = normalizeDbId(process.env.FIRESTORE_DB_ID);

type ReqLike = { headers: Headers; url?: string; nextUrl?: { searchParams: URLSearchParams } };

function searchParamsOf(req: ReqLike): URLSearchParams | null {
  if (req.nextUrl?.searchParams) return req.nextUrl.searchParams;
  if (req.url) { try { return new URL(req.url).searchParams; } catch { /* relative url */ } }
  return null;
}

/**
 * Resolve the tenant for an incoming request.
 *   1. `?tenant=<id>` — for cron jobs and server-to-server callers that reach the app on a
 *      host that doesn't identify the tenant.
 *   2. Host header (`x-forwarded-host` first — that's the one Netlify sets to the real domain).
 *   3. FIRESTORE_DB_ID env fallback, then the default tenant.
 */
export function tenantForRequest(req: ReqLike): Tenant {
  // tenantsSync() never blocks — memory cache, else the snapshot that shipped with this
  // deploy. See src/lib/tenantRegistry.ts for why resolution here must stay synchronous.
  const tenants = tenantsSync();

  const byParam = tenantById(searchParamsOf(req)?.get('tenant'), tenants);
  if (byParam) return byParam;

  const host = req.headers.get('x-forwarded-host') || req.headers.get('host');
  const byHost = tenantByHost(host, tenants);
  if (byHost) return byHost;

  // No matching host (local dev, scripts): honour FIRESTORE_DB_ID literally, so a value
  // like "test" selects the test database instead of falling back to production.
  return tenantForDbId(ENV_DB_ID, tenants);
}

export const adminAuth = () => getAuth(getAdminApp());

/**
 * Firestore for an explicit database id. `undefined` uses the FIRESTORE_DB_ID env fallback.
 * Prefer adminDbFor(req) inside route handlers.
 */
export const adminDb = (dbId?: string): Firestore => {
  const id = normalizeDbId(dbId ?? ENV_DB_ID);
  return id ? getFirestore(getAdminApp(), id) : getFirestore(getAdminApp());
};

/** Firestore for the tenant that owns this request. Use this in every API route. */
export const adminDbFor = (req: ReqLike): Firestore => adminDb(tenantForRequest(req).dbId);

/**
 * Every tenant database a request should act on — for cron jobs, which are hit by a
 * scheduler on ONE url but must process ALL tenants. Pass `?tenant=all` to fan out;
 * anything else resolves to the single tenant that owns the request.
 */
export function adminDbsForRequest(req: ReqLike): Array<{ tenant: Tenant; db: Firestore }> {
  const param = (searchParamsOf(req)?.get('tenant') || '').trim().toLowerCase();
  const targets = param === 'all' ? tenantsSync() : [tenantForRequest(req)];
  return targets.map(tenant => ({ tenant, db: adminDb(tenant.dbId) }));
}
