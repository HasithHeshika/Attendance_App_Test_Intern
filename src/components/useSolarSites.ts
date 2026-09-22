'use client';
import { useEffect, useState } from 'react';
import { auth, tenant } from '@/lib/firebase';

export interface SolarSite {
  siteNo: string;
  projectNo?: string;
  name: string;
  lat: number;
  lng: number;
  address?: string | null;
}

// Session cache — sites rarely change while the app is open, so fetch once.
let cache: SolarSite[] | null = null;
let inflight: Promise<SolarSite[]> | null = null;

// Cross-reload cache (localStorage). The server already serves these from an hourly cache, so
// a matching 1-hour client TTL means a reload reuses the last copy instead of calling again.
const LS_KEY = 'solar_sites_cache_v1';
const LS_TTL_MS = 60 * 60 * 1000;

function readLocal(): SolarSite[] | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { sites?: SolarSite[]; fetchedAt?: number };
    if (!Array.isArray(parsed?.sites) || typeof parsed?.fetchedAt !== 'number') return null;
    if (Date.now() - parsed.fetchedAt > LS_TTL_MS) return null;   // expired → refetch
    return parsed.sites;
  } catch { return null; }
}
function writeLocal(sites: SolarSite[]) {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ sites, fetchedAt: Date.now() })); } catch { /* ignore */ }
}

async function fetchSites(): Promise<SolarSite[]> {
  if (cache) return cache;
  if (inflight) return inflight;
  // Reuse a fresh localStorage copy before going to the network at all.
  const local = readLocal();
  if (local) { cache = local; return local; }
  inflight = (async () => {
    try {
      const idToken = await auth.currentUser?.getIdToken();
      const res = await fetch('/api/solar/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      });
      const data = await res.json().catch(() => ({}));
      // Surface the server's reason so a prod-only outage is visible in the console
      // (the route returns `reason` on failure; GET /api/solar/projects is a config probe).
      if (!res.ok || data?.success === false) {
        console.warn('[solar sites] empty —', data?.reason ?? `HTTP ${res.status}`,
          '· open /api/solar/projects (GET) to probe config');
        return [];
      }
      const result: SolarSite[] = Array.isArray(data?.sites) ? data.sites : [];
      cache = result;
      if (result.length) writeLocal(result);
      return result;
    } catch {
      return [];
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

// The Solar installed sites (with GPS) for the working-place picker. Loads once when enabled.
// Hard-gated on the tenant's `solarApp` feature: Solar is an Alta Vision integration only, so
// for every other tenant (e.g. Southern Lanka) this always returns [] and never calls the API —
// no solar project sites can leak into their working-place pills / site search.
export function useSolarSites(enabled: boolean): SolarSite[] {
  const solarEnabled = enabled && tenant.features.solarApp;
  const [sites, setSites] = useState<SolarSite[]>(solarEnabled ? (cache ?? []) : []);
  useEffect(() => {
    if (!solarEnabled) { setSites([]); return; }
    if (cache) { setSites(cache); return; }
    let stopped = false;
    fetchSites().then(s => { if (!stopped) setSites(s); });
    return () => { stopped = true; };
  }, [solarEnabled]);
  return solarEnabled ? sites : [];
}
