import type { StateStorage } from 'zustand/middleware';

const noop: StateStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

/**
 * A localStorage-backed StateStorage for zustand `persist` that NEVER throws.
 *
 * Browser localStorage is capped (~5 MB per origin). At our scale a cached list
 * (working places, roles) can exceed that, and an uncaught QuotaExceededError
 * from setItem propagates out of the store action that triggered the persist —
 * crashing the app. (This is exactly what broke `working-places-cache`: the
 * setItem inside `load()`'s `set(...)` threw.) Persisted caches are a best-effort
 * speed optimization: a dropped write just means a cold-boot refetch, never a
 * crash. SSR-safe (returns a noop store on the server).
 */
export const safeLocalStorage = (): StateStorage => {
  if (typeof window === 'undefined') return noop;
  return {
    getItem: (name) => {
      try { return window.localStorage.getItem(name); } catch { return null; }
    },
    setItem: (name, value) => {
      try {
        window.localStorage.setItem(name, value);
      } catch {
        // Quota exceeded or storage blocked. Clear any stale value for this key
        // and retry once (the new value may be smaller); if it still won't fit,
        // skip silently — the in-memory store stays correct and a background
        // load repopulates next boot.
        try {
          window.localStorage.removeItem(name);
          window.localStorage.setItem(name, value);
        } catch { /* best-effort: give up caching this value */ }
      }
    },
    removeItem: (name) => {
      try { window.localStorage.removeItem(name); } catch { /* ignore */ }
    },
  };
};
