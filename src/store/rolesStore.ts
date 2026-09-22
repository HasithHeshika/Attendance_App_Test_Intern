import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { safeLocalStorage } from '@/lib/persistStorage';
import { getRoles } from '@/services/roleService';
import type { Role, RoleCapabilities } from '@/lib/permissions';
import { resolveCapabilitiesByName, resolveUserCapabilities, FALLBACK_CAPS } from '@/lib/permissions';
import { useAuthStore } from '@/store/authStore';
import { useEffect } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { auth } from '@/lib/firebase';

// Resolves once Firebase has settled sign-in state, with the user or null.
// `auth.currentUser` alone is not enough — it is null while the session is still restoring,
// which is exactly the window the rehydrate and useRoles() callers run in. Deliberately NOT
// memoised: caching the first settle would freeze a signed-out `null` in place, and the
// post-sign-in loadRoles() that AuthProvider fires would then skip for the rest of the session.
function authSettled(): Promise<User | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);
  if (auth.currentUser) return Promise.resolve(auth.currentUser);
  return new Promise<User | null>((resolve) => {
    const unsub = onAuthStateChanged(auth, (u) => { unsub(); resolve(u); });
  });
}

interface RolesState {
  roles:    Role[];
  loaded:   boolean;
  loading:  boolean;
  loadRoles: (force?: boolean) => Promise<void>;
}

// Roles change rarely but gate the whole UI. Persisting the last-known registry
// makes capability resolution synchronous on a cold boot (no Firestore round-trip
// before anything can render); a background revalidate then confirms it.
export const useRolesStore = create<RolesState>()(
  persist(
    (set, get) => ({
      roles:   [],
      loaded:  false,
      loading: false,
      loadRoles: async (force = false) => {
        if (get().loading) return;
        if (get().loaded && !force) return;
        set({ loading: true });
        try {
          // `roles` is `allow read: if isAuth()`, and this runs from triggers that fire BEFORE
          // Firebase has restored the session — the rehydrate revalidation below and useRoles()
          // on mount both do. Reading then returns permission-denied on a perfectly valid
          // account. Wait for auth to settle, and skip entirely when nobody is signed in:
          // AuthProvider and the login page both load roles once auth is real.
          const user = await authSettled();
          if (!user) { set({ loading: false }); return; }
          const roles = await getRoles(force);
          set({ roles, loaded: true, loading: false });
        } catch (e) {
          console.error('[rolesStore] failed to load roles:', e);
          set({ loading: false });
        }
      },
    }),
    {
      name: 'roles-cache',
      version: 1,
      // Quota-safe: a cache write can never crash the app (localStorage is ~5MB/origin).
      storage: createJSONStorage(safeLocalStorage),
      // Persist the data (+ loaded, so gating is correct on the first frame).
      // `loading` is transient and must never be restored.
      partialize: (s) => ({ roles: s.roles, loaded: s.loaded }),
      // After restoring, revalidate once in the background — instant, never stale
      // for long. Client-only so it can't fire during SSR/prerender.
      onRehydrateStorage: () => (state) => {
        if (typeof window !== 'undefined') state?.loadRoles(true);
      },
    },
  ),
);

// Hook: returns the cached roles, loading them on first use.
export function useRoles(): { roles: Role[]; loaded: boolean; reload: () => Promise<void> } {
  const roles  = useRolesStore(s => s.roles);
  const loaded = useRolesStore(s => s.loaded);
  const load   = useRolesStore(s => s.loadRoles);
  useEffect(() => { load(); }, [load]);
  return { roles, loaded, reload: () => load(true) };
}

// Hook: capabilities resolved for a given role name against the cached registry.
export function useCapabilitiesFor(roleName: string | undefined): RoleCapabilities {
  const { roles } = useRoles();
  return resolveCapabilitiesByName(roleName, roles);
}

// Hook: capabilities for the signed-in user, always resolved live from the role
// registry. `resolveCapabilitiesByName` falls back to the built-in DEFAULT_ROLES
// (and understands legacy role names) when the registry isn't loaded/seeded yet,
// so this is correct immediately and never serves a stale denormalized value.
export function useUserCapabilities(): RoleCapabilities {
  const user = useAuthStore(s => s.user);
  const { roles } = useRoles();
  if (!user) return { ...FALLBACK_CAPS };
  // Trainees of a role get that role's configured trainee access set. resolveUserCapabilities
  // also honours the per-user is_super_admin override (Southern Lanka only) — see
  // AppUser.is_super_admin.
  return resolveUserCapabilities(user, roles);
}
