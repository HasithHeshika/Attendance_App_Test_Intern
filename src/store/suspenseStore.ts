import { create } from 'zustand';
import { useEffect } from 'react';
import type { SuspenseAccount } from '@/lib/types';
import { getUserAccounts } from '@/services/suspenseService';
import { useAuthStore } from '@/store/authStore';
import { tenant } from '@/lib/firebase';

// Whether the signed-in user HAS any suspense account is per-user Firestore state, not a
// role capability — so it can't be resolved synchronously from the roles registry like
// other nav gating. This tiny store loads the user's per-company accounts once per session
// so the sidebar can show the Suspense tab to account holders.
interface SuspenseState {
  epf:        string | null;   // the epf the cached accounts belong to
  loadingEpf: string | null;   // the epf currently being fetched (last request wins)
  accounts:   SuspenseAccount[];
  loaded:     boolean;
  loading:    boolean;
  loadAccounts: (epf: string, force?: boolean) => Promise<void>;
}

export const useSuspenseStore = create<SuspenseState>((set, get) => ({
  epf:        null,
  loadingEpf: null,
  accounts:   [],
  loaded:     false,
  loading:    false,
  loadAccounts: async (epf, force = false) => {
    if (!epf) return;
    const s = get();
    if (s.loaded && s.epf === epf && !force) return; // fresh cache for this epf
    if (s.loadingEpf === epf) return;                // a fetch for this epf is already in flight
    // Note: a fetch for a DIFFERENT epf may be in flight — let this one proceed; the stale-guard
    // below discards whichever response is no longer the most recently requested epf.
    set({ loading: true, loadingEpf: epf });
    try {
      const accounts = await getUserAccounts(epf);
      if (get().loadingEpf !== epf) return;          // a newer epf was requested — drop this result
      set({ accounts, epf, loaded: true, loading: false, loadingEpf: null });
    } catch (e) {
      console.error('[suspenseStore] failed to load accounts:', e);
      if (get().loadingEpf === epf) set({ loading: false, loadingEpf: null });
    }
  },
}));

// Hook: the signed-in user's suspense accounts (loading them on first use). `hasAccount`
// drives the Suspense nav item; the accounts feed the holder's per-company balance view.
export function useSuspenseAccess(): {
  accounts: SuspenseAccount[]; hasAccount: boolean; loaded: boolean; reload: () => Promise<void>;
} {
  const epf      = useAuthStore(s => s.user?.epf_number) ?? '';
  const accounts = useSuspenseStore(s => s.accounts);
  const loaded   = useSuspenseStore(s => s.loaded);
  const storeEpf = useSuspenseStore(s => s.epf);
  const load     = useSuspenseStore(s => s.loadAccounts);
  // Suspense is a per-tenant feature — never query it (or show the nav) on tenants without it.
  useEffect(() => { if (epf && tenant.features.suspense) load(epf); }, [epf, load]);
  if (!tenant.features.suspense) return { accounts: [], hasAccount: false, loaded: true, reload: () => Promise.resolve() };
  // Only trust the cache when it belongs to the currently signed-in user (guards logout /
  // account switch, where stale accounts must not leak to the next user).
  const matches = loaded && storeEpf === epf && !!epf;
  return {
    accounts:   matches ? accounts : [],
    hasAccount: matches ? accounts.length > 0 : false,
    loaded:     matches,
    reload:     () => (epf ? load(epf, true) : Promise.resolve()),
  };
}
