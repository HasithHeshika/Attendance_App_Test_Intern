import { normalizeTenant, type Tenant } from '@/lib/tenants';
import { snapshotTenants } from '@/lib/tenantSnapshot';

/**
 * The tenant registry — SERVER ONLY.
 *
 * Tenants live in their own Firestore database (`tenants`) so that adding a domain, rebranding
 * or turning a module off is a form submission rather than a deploy. This module is the only
 * thing that reads it.
 *
 * Never import this from a client component. It pulls in firebase-admin (lazily, but the
 * bundler still follows it) and the browser has no business holding the tenant list anyway —
 * it receives its OWN tenant, already resolved, through window.__TENANT__.
 *
 * ─── Why there are two entry points ───────────────────────────────────────────
 *
 * 41 files call adminDbFor(req) / tenantForRequest(req) on the request path. Making tenant
 * resolution async would mean touching every one of them and turning every route handler into
 * a place where you can forget an await and silently read the wrong organisation's data. So:
 *
 *   tenantsSync()    never blocks. Memory cache, else the shipped snapshot. Used by
 *                    adminDbFor and middleware — the hot path.
 *   awaitTenants()   blocks on Firestore and fills the cache. Used by the root layout (which
 *                    injects the resolved tenant into the page) and by the /platform UI.
 *
 * The cost of the sync path is staleness, never wrongness: a cold instance serves the snapshot
 * until its first refresh resolves, so a tenant added seconds ago may be briefly unknown to it.
 * The root layout awaits, so what a BROWSER is told is always current.
 */

/** The Firestore database holding the tenant registry. Not a tenant database — the registry. */
export const TENANTS_DB_ID = 'tenants';
export const TENANTS_COLLECTION = 'tenants';

/** How long a loaded list is trusted before a refresh is kicked off behind the next read. */
const TTL_MS = 60_000;

/** The list that shipped with this deploy — see src/lib/tenantSnapshot.ts. */
const SNAPSHOT: Tenant[] = snapshotTenants();

interface CacheState {
  tenants: Tenant[];
  /** When this list was loaded from Firestore. 0 means "this is only the snapshot". */
  loadedAt: number;
  /** An in-flight refresh, so concurrent requests share one Firestore read. */
  inflight: Promise<Tenant[]> | null;
}

// Parked on globalThis so Next.js HMR and multiple module instances share one cache instead of
// each holding a stale copy and refreshing independently.
declare global {
  // eslint-disable-next-line no-var
  var __tenantRegistry: CacheState | undefined;
}

function state(): CacheState {
  if (!globalThis.__tenantRegistry) {
    globalThis.__tenantRegistry = { tenants: SNAPSHOT, loadedAt: 0, inflight: null };
  }
  return globalThis.__tenantRegistry;
}

/** Read every tenant document. Kept separate so the cache logic below stays readable. */
/**
 * How long a registry read may hold a page render open.
 *
 * The root layout is `force-dynamic` and AWAITS this, so an unbounded read is an unbounded
 * time-to-first-byte on every domain: nothing downstream can start until the tenant list
 * resolves. Firestore's own client will retry a cold or unreachable connection for far longer
 * than any person will wait for a page.
 *
 * Three seconds is chosen against what the module already does on failure — serve the shipped
 * snapshot. A slightly stale tenant list rendered now beats a correct one rendered in thirty
 * seconds, and the next request retries anyway.
 */
const FETCH_TIMEOUT_MS = 3_000;

async function fetchTenants(): Promise<Tenant[]> {
  // Imported lazily: firebaseAdmin imports THIS module for tenantsSync(), so a static import
  // here would be a cycle. By the time a refresh actually runs, both modules are initialised.
  const { adminDb } = await import('@/lib/firebaseAdmin');
  const read = adminDb(TENANTS_DB_ID).collection(TENANTS_COLLECTION).get();
  // Races rather than aborts: the Firestore SDK has no cancellation here, so the read is left
  // to finish in the background and its result simply arrives too late to be used. It costs
  // one wasted query on a slow instance and saves every visitor the wait.
  const snap = await Promise.race([
    read,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`tenants read exceeded ${FETCH_TIMEOUT_MS}ms`)), FETCH_TIMEOUT_MS)
        // Do not hold the process open for a timer nobody is waiting on any more.
        .unref?.();
    }),
  ]);
  return snap.docs.map(d => normalizeTenant(d.id, d.data() as Record<string, unknown>));
}

/**
 * Load from Firestore and cache. An empty collection is treated as a FAILURE, not as "there
 * are no tenants" — an unseeded or misconfigured database must fall back to the snapshot
 * rather than resolve every domain to nothing.
 */
export async function awaitTenants(force = false): Promise<Tenant[]> {
  const s = state();
  const fresh = s.loadedAt > 0 && Date.now() - s.loadedAt < TTL_MS;
  if (fresh && !force) return s.tenants;
  if (s.inflight) return s.inflight;

  s.inflight = (async () => {
    try {
      const list = await fetchTenants();
      if (list.length === 0) throw new Error('tenants collection is empty');
      s.tenants = list;
      s.loadedAt = Date.now();
      return list;
    } catch (e) {
      // Keep serving the last good list (or the snapshot). Deliberately never rethrows: a
      // registry read failure must not take down page rendering on every domain.
      console.error('[tenantRegistry] load failed, serving last good list:', e);
      return s.tenants;
    } finally {
      s.inflight = null;
    }
  })();

  return s.inflight;
}

/**
 * The tenant list, right now, without blocking. Memory cache if warm, otherwise the snapshot
 * that shipped with this deploy. Kicks off a background refresh when the cache has gone stale
 * so a warm instance converges within one request.
 */
export function tenantsSync(): Tenant[] {
  const s = state();
  const stale = s.loadedAt === 0 || Date.now() - s.loadedAt >= TTL_MS;
  if (stale && !s.inflight) void awaitTenants().catch(() => { /* already logged */ });
  return s.tenants;
}

/** Force the next read to hit Firestore — call after any write from the /platform UI. */
export function invalidateTenants(): void {
  state().loadedAt = 0;
}

/** True when the list being served is the shipped snapshot rather than a live read. */
export function isServingSnapshot(): boolean {
  return state().loadedAt === 0;
}

