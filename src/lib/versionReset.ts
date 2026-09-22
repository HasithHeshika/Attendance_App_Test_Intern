// Version-gated cache reset.
//
// Symptom this solves: right after a new version is deployed, some users can't check in
// until they log out and back in. Cause: caches written by the OLD build survive the update
// and no longer match what the NEW code expects —
//   • the persisted user profile (`user-profile`) only gets a partial refresh on a returning
//     session, so any field the new build newly relies on (employee_type, company_id, …) stays
//     stale until a full re-login rebuilds it (see AuthProvider), and
//   • persisted data caches / the service-worker precache can hold an old shape or old assets.
//
// This module clears the re-fetchable caches once per new version and lets AuthProvider rebuild
// the user profile in place. Auth session and user prefs (theme/language) are deliberately kept,
// so a deploy never logs anyone out.
import { APP_VERSION } from '@/lib/version';

// Two independent keys so each concern records "done for this build" on its own — the cache
// wipe and the profile rebuild can't leave each other half-applied.
const CACHE_VERSION_KEY = 'app_cache_version';
const USER_VERSION_KEY  = 'app_user_version';

// Persisted zustand stores that hold RE-FETCHABLE cache data (each revalidates from Firestore
// on rehydrate). Safe to drop on an update so an old data shape can't reach the new code before
// it revalidates. Deliberately excludes `user-profile` (rebuilt in place, never dropped) and any
// pref stores (theme/language).
const VOLATILE_LS_KEYS = ['working-places-cache', 'roles-cache', 'solar_sites_cache_v1'];

let cacheResetRan = false;

// Clear caches that can carry a stale shape/asset across an app update. Best-effort and
// idempotent (runs at most once per load, and does nothing once the current build is recorded).
// Never throws. Does NOT reload — the current page keeps its already-loaded code; the wipe makes
// the NEXT load fresh, while AuthProvider fixes the live session's user profile.
export async function clearStaleCachesForNewVersion(): Promise<void> {
  if (typeof window === 'undefined' || cacheResetRan) return;
  cacheResetRan = true;

  let prev: string | null = null;
  try { prev = localStorage.getItem(CACHE_VERSION_KEY); } catch { return; }
  if (prev === APP_VERSION) return;   // already cleared for this build

  // 1. Volatile persisted data caches (localStorage). Keep auth + prefs.
  for (const key of VOLATILE_LS_KEYS) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  }

  // 2. Service-worker Cache Storage — the old build's precached JS/HTML/assets.
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
  } catch { /* ignore */ }

  // Record the build LAST, so an interrupted wipe (tab closed mid-clear) retries next load.
  try { localStorage.setItem(CACHE_VERSION_KEY, APP_VERSION); } catch { /* ignore */ }
}

// Has a new build shipped since this device last rebuilt its persisted user profile? AuthProvider
// uses this to decide whether to do a full rebuild from Firestore (vs. the partial returning-session
// patch), then calls markUserProfileRebuilt() once it succeeds. Read-only here; the first run after
// this feature ships also returns true (no key yet) so existing broken sessions self-heal once.
export function userProfileNeedsRebuild(): boolean {
  if (typeof window === 'undefined') return false;
  try { return localStorage.getItem(USER_VERSION_KEY) !== APP_VERSION; }
  catch { return false; }
}

// Record that the persisted user profile was rebuilt for the current build. Call ONLY after a
// successful full rebuild — on failure we leave the key stale so it retries on the next load.
export function markUserProfileRebuilt(): void {
  if (typeof window === 'undefined') return;
  try { localStorage.setItem(USER_VERSION_KEY, APP_VERSION); } catch { /* ignore */ }
}
