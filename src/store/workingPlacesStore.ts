'use client';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { useEffect, useMemo } from 'react';
import { getWorkingPlaces, DEFAULT_WORKING_PLACES, type ChamaryWithPlace } from '@/services/workingPlaceService';
import { canonPlaceName } from '@/lib/placeName';
import { safeLocalStorage } from '@/lib/persistStorage';
import type { WorkingPlaceLocation, WorkingPlaceTag } from '@/lib/types';

interface WorkingPlacesState {
  items:   WorkingPlaceLocation[];
  loaded:  boolean;
  loading: boolean;
  load:    (force?: boolean) => Promise<void>;
}

// Working places change rarely but are needed for check-in/out site selection.
// Persisting them avoids the "default places flash → real places" swap on cold
// boot; a background revalidate confirms the cached list.
export const useWorkingPlacesStore = create<WorkingPlacesState>()(
  persist(
    (set, get) => ({
      items: [], loaded: false, loading: false,
      load: async (force = false) => {
        if (get().loading) return;
        if (get().loaded && !force) return;
        set({ loading: true });
        try { set({ items: await getWorkingPlaces(true), loaded: true, loading: false }); }
        catch (e) { console.error('[workingPlaces] load failed', e); set({ loading: false }); }
      },
    }),
    {
      name: 'working-places-cache',
      version: 1,
      // Quota-safe: a cache write can never crash the app (localStorage is ~5MB/origin).
      storage: createJSONStorage(safeLocalStorage),
      // Cache only the fields the selection UI reads (see `useWorkingPlaces`). Dropping
      // created_at (a verbose serialized Timestamp), is_active, etc. keeps the cache
      // small so it fits localStorage even with many places; the full objects are
      // re-fetched on rehydrate (onRehydrateStorage → load(true)) moments later.
      partialize: (s) => ({
        items: s.items.map((p) => ({
          id: p.id, name: p.name, address: p.address ?? '',
          latitude: p.latitude ?? null, longitude: p.longitude ?? null,
          radius_m: p.radius_m ?? null, requires_site: !!p.requires_site,
          tags: p.tags ?? [], sort_order: p.sort_order ?? 0,
        })) as WorkingPlaceLocation[],
        loaded: s.loaded,
      }),
      onRehydrateStorage: () => (state) => {
        if (typeof window !== 'undefined') state?.load(true);
      },
    },
  ),
);

export interface WorkingPlaceOption {
  id: string; name: string; requires_site: boolean; tags: WorkingPlaceTag[];
  latitude: number | null; longitude: number | null; radius_m: number | null; address: string;
}

// Chamaries this EPF is responsible for (Chamary.responsible_epf, set in Working Places).
// Derived from the places already in this store rather than a fresh Firestore read, so the
// sidebar can ask "does this person run a canteen?" on every render for free.
//
// The persisted cache deliberately drops `chamaries` (see partialize), so this is empty until
// the first real load lands — a nav row that appears a moment late, never a wrong one.
export function useMyChamaries(epf: string | null | undefined): ChamaryWithPlace[] {
  const items = useWorkingPlacesStore(s => s.items);
  const load  = useWorkingPlacesStore(s => s.load);
  useEffect(() => { load(); }, [load]);

  return useMemo(() => {
    if (!epf) return [];
    return items
      .filter(p => p.is_active !== false)
      .flatMap(p => (p.chamaries ?? [])
        .filter(c => c.is_active && c.responsible_epf === epf)
        .map(c => ({ ...c, working_place_id: p.id, working_place_name: p.name })));
  }, [items, epf]);
}

// Active working places for selection. Falls back to the built-in defaults when the
// collection is empty, so check-out never breaks before an admin configures it.
export function useWorkingPlaces() {
  const items  = useWorkingPlacesStore(s => s.items);
  const loaded = useWorkingPlacesStore(s => s.loaded);
  const load   = useWorkingPlacesStore(s => s.load);
  useEffect(() => { load(); }, [load]);

  const options: WorkingPlaceOption[] = (loaded && items.length)
    ? items.map(p => ({
        id: p.id, name: p.name, requires_site: !!p.requires_site, tags: p.tags ?? [],
        latitude: p.latitude ?? null, longitude: p.longitude ?? null,
        radius_m: p.radius_m ?? null, address: p.address ?? '',
      }))
    : DEFAULT_WORKING_PLACES.map(p => ({
        id: '', name: p.name, requires_site: p.requires_site, tags: [],
        latitude: null, longitude: null, radius_m: null, address: '',
      }));

  const requiresSite = (name: string | null | undefined) =>
    !!name && options.some(o => o.name === name && o.requires_site);

  // Does a working place (by name) carry a given tag? Used by check-in shift detection.
  // Canonical match: a Solar-app "<name> (#site-no)" pick equals the tagged admin place.
  const placeHasTag = (name: string | null | undefined, tag: WorkingPlaceTag) => {
    const key = canonPlaceName(name);
    return !!key && options.some(o => canonPlaceName(o.name) === key && (o.tags ?? []).includes(tag));
  };

  return { options, requiresSite, placeHasTag, loaded, reload: () => load(true) };
}
