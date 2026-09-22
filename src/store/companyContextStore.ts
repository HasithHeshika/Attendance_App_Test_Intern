'use client';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { useCallback, useEffect, useState } from 'react';
import { safeLocalStorage } from '@/lib/persistStorage';
import { useAuthStore } from '@/store/authStore';
import { useUserCapabilities, useRoles } from '@/store/rolesStore';
import { getCompanies } from '@/services/companyService';
import type { Company } from '@/lib/types';

interface CompanyContextState {
  selectedCompanyId: string;
  setSelectedCompanyId: (id: string) => void;
}

// Southern Lanka only: the company a can_manage_all_companies-capable user has picked from the
// Global Company Selector in the Top Navbar. Persisted so the pick survives navigation and
// reloads. Nothing should read this store directly — use useCompanyContext() below, which
// also enforces the permission gate (a user without the capability never sees this pick at
// all, regardless of what's sitting in their browser's localStorage).
const useCompanyContextStore = create<CompanyContextState>()(
  persist(
    (set) => ({
      selectedCompanyId: '',
      setSelectedCompanyId: (id) => set({ selectedCompanyId: id }),
    }),
    {
      name: 'southernlanka-company-context',
      version: 1,
      storage: createJSONStorage(safeLocalStorage),
    },
  ),
);

// The single source of truth for "which company's data am I working with" — consumed by the
// Schedule, Shifts, Departments, Users and Attendance View pages instead of each keeping its
// own local dropdown/state.
//
// A user with can_manage_all_companies (or System Admin, which implies it — see
// withSystemAdminOverrides in @/lib/permissions) gets the persisted global pick, a Company
// list to switch between, and a setter (canSwitch: true). Everyone else is hard-locked to
// their own AppUser.company_id: canSwitch is false, setCompanyId is a no-op, and companies
// stays empty (never fetched — no reason to read every company for someone who can't pick
// one). Callers should HIDE any switcher UI when canSwitch is false, not just disable it.
//
// `ready` guards the hydration window: caps are resolved LIVE off useUserCapabilities(), which
// is itself live off useAuthStore().user + useRoles() — both start out empty/default on a cold
// boot before Firebase Auth and the roles registry have settled (AuthProvider already blocks
// this hook's usual callers, the app shell and its pages, from mounting before that point — see
// AuthProvider.tsx — but this hook has no way to know it's only ever used there, and a future
// caller outside that gate would otherwise see a misleadingly-confident canSwitch/companyId on
// the very first render). While `!ready`, canSwitch is forced false and companyId is forced ''
// regardless of what caps/me would otherwise resolve to — a locked/hidden state, never a guess.
export function useCompanyContext(): {
  companyId: string;
  canSwitch: boolean;
  ready: boolean;
  // Fail-closed signal: true once resolved (ready) for a LOCKED user (canSwitch false) whose
  // own AppUser.company_id is missing/empty — bad data, a not-yet-assigned account, or an
  // admin-type role with no company. companyId === '' is ambiguous on its own: for a
  // switching admin it means "browse every company" (intentional); for a locked user it must
  // NEVER be read that way — see inScope() below, which is the one place that distinction is
  // actually enforced. `blocked` exists so callers can also surface an explicit "No assigned
  // company" message instead of a silently-empty list that looks like a loading glitch.
  blocked: boolean;
  // The one place the fail-closed rule lives — every company-boundary filter across the app
  // should call this instead of hand-rolling `!companyId || doc.company_id === companyId`
  // (that shortcut is exactly the fail-OPEN bug this closes: it reads an unset companyId as
  // "no filter" unconditionally, which is correct for a switching admin but was silently
  // showing every company's data to a locked user with no company assigned). Returns false
  // outright while `!ready` — nothing is "in scope" before capabilities have resolved.
  inScope: (docCompanyId: string | null | undefined) => boolean;
  setCompanyId: (id: string) => void;
  companies: Company[];
} {
  const me = useAuthStore((s) => s.user);
  const caps = useUserCapabilities();
  const { loaded: rolesLoaded } = useRoles();
  const selectedCompanyId = useCompanyContextStore((s) => s.selectedCompanyId);
  const setSelectedCompanyId = useCompanyContextStore((s) => s.setSelectedCompanyId);

  // Both must have actually settled — an absent user (still loading, or genuinely signed out)
  // AND an unloaded roles registry each independently mean "capabilities aren't trustworthy
  // yet" (useUserCapabilities silently returns FALLBACK_CAPS for either case, which is safe as
  // a capability default but must NOT be read as "confirmed no access" here — that's a
  // still-loading state, not a permission decision).
  const ready = !!me && rolesLoaded;
  // caps.is_system_admin / caps.can_manage_all_companies are resolved via
  // resolveUserCapabilities(me, roles) → resolveCapabilitiesByName(me.role, roles,
  // me.employee_type) inside useUserCapabilities() — the live registry, not a denormalized
  // snapshot, so a role edited on the Roles page (including a custom, non-built-in role name)
  // takes effect immediately without a re-login. See src/lib/permissions.ts.
  const canSwitch = ready && (!!caps.is_system_admin || !!caps.can_manage_all_companies);

  const [companies, setCompanies] = useState<Company[]>([]);
  useEffect(() => {
    if (!canSwitch) { setCompanies([]); return; }
    let cancelled = false;
    getCompanies()
      .then((list) => { if (!cancelled) setCompanies(list); })
      .catch((e) => console.error('[companyContext] failed to load companies', e));
    return () => { cancelled = true; };
  }, [canSwitch]);

  const companyId = !ready ? '' : canSwitch ? selectedCompanyId : (me?.company_id ?? '');
  // Fail-closed only for a LOCKED user (canSwitch false) — a switching admin's unset pick
  // ('' ) is a deliberate "browse every company" choice, never "blocked".
  const blocked = ready && !canSwitch && !companyId;
  // useCallback, not a plain closure — this hook is consumed by five pages' own useMemo/
  // useEffect dependency arrays (see the doc comment above), and a NEW function reference on
  // every render was retriggering them on every render in turn. In schedule/page.tsx that fed
  // scopeDepartments's useMemo -> the employees-loading useEffect -> setEmployeesLoading(true)
  // every firing -> re-render -> new inScope -> loop: exactly "Maximum update depth exceeded".
  const inScope = useCallback((docCompanyId: string | null | undefined): boolean => {
    if (!ready) return false;
    if (companyId) return docCompanyId === companyId;
    // companyId === '': a switching admin with nothing picked sees everything; a locked user
    // with no company assigned sees NOTHING — this ternary is the entire fail-closed rule.
    return canSwitch;
  }, [ready, companyId, canSwitch]);

  if (process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.debug('[companyContext]', {
      ready, canSwitch, blocked, role: me?.role, is_system_admin: caps.is_system_admin,
      can_manage_all_companies: caps.can_manage_all_companies, companyId,
    });
  }

  if (!ready) {
    // Still resolving — hidden/locked, never a guessed value either way.
    return { companyId: '', canSwitch: false, ready: false, blocked: false, inScope, setCompanyId: () => {}, companies: [] };
  }
  if (!canSwitch) {
    return { companyId, canSwitch: false, ready: true, blocked, inScope, setCompanyId: () => {}, companies: [] };
  }
  return { companyId, canSwitch: true, ready: true, blocked: false, inScope, setCompanyId: setSelectedCompanyId, companies };
}
