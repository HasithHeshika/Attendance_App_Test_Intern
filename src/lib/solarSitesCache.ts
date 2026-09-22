/**
 * Server-side hourly cache for the Solar app's installed sites (with GPS).
 *
 * Every client that opens the working-place picker calls our own /api/solar/projects route.
 * Without caching, each of those calls fanned out to the upstream Solar API. This module makes
 * the upstream API get hit AT MOST ONCE PER HOUR for the whole deployment, regardless of how
 * many clients, tabs or reloads there are:
 *
 *   1. Process memory (fast path)  — avoids any I/O on a warm server instance.
 *   2. Firestore `app_cache/solar_sites` (shared store) — covers cold starts and multiple
 *      serverless instances, so a freshly-spun instance reads the cached copy instead of
 *      calling Solar. Admin SDK writes here, bypassing security rules (clients never touch it).
 *   3. Upstream Solar API — only when both caches are older than the 1-hour TTL.
 *
 * On an upstream failure we serve the last good (stale) copy instead of an empty list, so the
 * picker keeps working through a transient Solar outage.
 */
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { getSolarProjects } from '@/lib/solarApi';

export interface CachedSolarSite {
  siteNo: string;
  projectNo?: string;
  name: string;
  lat: number;
  lng: number;
  address?: string | null;
}

const TTL_MS    = 60 * 60 * 1000; // refresh upstream at most once per hour
const CACHE_COL = 'app_cache';
const CACHE_DOC = 'solar_sites';

// Process-local copy (per warm instance). Shared Firestore copy is the cross-instance source.
let mem: { sites: CachedSolarSite[]; fetchedAt: number } | null = null;
let inflight: Promise<CachedSolarSite[]> | null = null;

function adminConfigured(): boolean {
  return !!(
    process.env.FIREBASE_ADMIN_PROJECT_ID &&
    process.env.FIREBASE_ADMIN_CLIENT_EMAIL &&
    process.env.FIREBASE_ADMIN_PRIVATE_KEY
  );
}

// A live server-to-server fetch of Solar sites (with GPS), trimmed to what the picker needs.
// Exported for the GET config probe, which must always test upstream connectivity directly.
export async function fetchSolarSitesFresh(): Promise<CachedSolarSite[]> {
  const data = await getSolarProjects({ withGps: true });
  return (data?.data ?? [])
    .filter(s => s.gpsLat != null && s.gpsLng != null)
    .map(s => ({
      siteNo:    s.siteNo,
      projectNo: s.projectNo,
      name:      s.customerName || s.siteNo,
      lat:       s.gpsLat as number,
      lng:       s.gpsLng as number,
      address:   s.address ?? null,
    }));
}

async function readFirestoreCache(db: Firestore): Promise<{ sites: CachedSolarSite[]; fetchedAt: number } | null> {
  if (!adminConfigured()) return null;
  try {
    const snap = await db.collection(CACHE_COL).doc(CACHE_DOC).get();
    if (!snap.exists) return null;
    const d = snap.data() as { sites?: CachedSolarSite[]; fetched_at?: Timestamp } | undefined;
    const fetchedAt = d?.fetched_at?.toMillis?.() ?? 0;
    const sites = Array.isArray(d?.sites) ? d!.sites! : [];
    return { sites, fetchedAt };
  } catch (e) {
    console.warn('[solar cache] Firestore read failed:', e);
    return null;
  }
}

async function writeFirestoreCache(db: Firestore, sites: CachedSolarSite[], fetchedAt: number): Promise<void> {
  if (!adminConfigured()) return;
  try {
    await db.collection(CACHE_COL).doc(CACHE_DOC).set({
      sites,
      count: sites.length,
      fetched_at: Timestamp.fromMillis(fetchedAt),
    });
  } catch (e) {
    console.warn('[solar cache] Firestore write failed:', e);
  }
}

// Refresh from upstream, persist to both caches. Deduped per instance via `inflight` so a
// burst of requests at expiry triggers a single upstream call.
function refresh(db: Firestore): Promise<CachedSolarSite[]> {
  if (inflight) return inflight;
  inflight = (async () => {
    const sites = await fetchSolarSitesFresh();
    const fetchedAt = Date.now();
    mem = { sites, fetchedAt };
    await writeFirestoreCache(db, sites, fetchedAt);
    return sites;
  })().finally(() => { inflight = null; });
  return inflight;
}

/**
 * The cached Solar sites. Upstream Solar is called at most once per hour across the whole
 * server. `stale` is true only when upstream is down and we're serving an expired copy.
 */
export async function getCachedSolarSites(db: Firestore): Promise<{
  sites: CachedSolarSite[]; fetchedAt: number; stale: boolean;
}> {
  const now = Date.now();

  // 1. Warm process memory.
  if (mem && now - mem.fetchedAt < TTL_MS) return { ...mem, stale: false };

  // 2. Shared Firestore copy (cold starts / other instances).
  const fs = await readFirestoreCache(db);
  if (fs && now - fs.fetchedAt < TTL_MS) { mem = fs; return { ...fs, stale: false }; }

  // 3. Both expired → refresh from upstream; on failure serve the newest stale copy we have.
  try {
    const sites = await refresh(db);
    return { sites, fetchedAt: Date.now(), stale: false };
  } catch (e) {
    const fallback = (mem && fs) ? (mem.fetchedAt >= fs.fetchedAt ? mem : fs) : (mem ?? fs);
    if (fallback) {
      console.warn('[solar cache] upstream refresh failed — serving stale cache:', e);
      return { ...fallback, stale: true };
    }
    throw e;
  }
}
