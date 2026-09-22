import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { RoleCapabilities } from '@/lib/permissions';
import type { AttendanceMethod } from '@/lib/types';

// Role is the role's display name (data-driven). Capabilities are resolved from the
// roles registry at login and denormalized here so gating stays synchronous.
export type UserRole = string;

export interface User {
  name:          string;
  email:         string;
  role:          UserRole;
  capabilities?: RoleCapabilities;
  epf_number?:   string;
  designation?:  string;
  department?:   string;
  phone?:        string;
  avatar?:       string;
  company?:      string;
  company_id?:   string;
  employee_type?: string;
  is_shift_worker?: boolean;
  // Southernlanka only — see AppUser.hod_department_ids. Department ids this Head of
  // Department manages leave approvals and shift rosters for. Grants Schedule/Shifts page
  // access (filtered to these departments) without the broader can_manage_users/
  // can_manage_schedules capability.
  hod_department_ids?: string[];
  // Denormalized name mirror of hod_department_ids (same order/length) — see
  // AppUser.hod_department_names. Compared against another user's `department` (a name), so
  // read THIS when scoping employees by department name.
  hod_department_names?: string[];
  // Southernlanka only — see AppUser.is_super_admin. A per-user override (set from the
  // Users Add/Edit form) that grants full System Admin capabilities regardless of Role.
  is_super_admin?: boolean;
  date_of_birth?: string | null;   // YYYY-MM-DD — used for the birthday wish
  // Southernlanka only — see AppUser.attendance_methods. Undefined/empty on every other
  // tenant, where mobile check-in/out is never restricted.
  attendance_methods?: AttendanceMethod[];
}

interface AuthState {
  user:            User | null;
  isAuthenticated: boolean;
  _hasHydrated:    boolean;
  setHasHydrated:  (v: boolean) => void;
  setAuth:         (user: User) => void;
  logout:          () => void;
  updateUser:      (data: Partial<User>) => void;
}

// Safe localStorage wrapper. No-ops during SSR (no `localStorage` on the server) and
// degrades gracefully when access is blocked (e.g. iOS Private Browsing).
const safeLocalStorage = {
  getItem: (name: string) => {
    if (typeof window === 'undefined') return null;
    try { return localStorage.getItem(name); }
    catch { console.warn('[authStore] localStorage access blocked (likely iOS Private Browsing)'); return null; }
  },
  setItem: (name: string, value: string) => {
    if (typeof window === 'undefined') return;
    try { localStorage.setItem(name, value); } catch { }
  },
  removeItem: (name: string) => {
    if (typeof window === 'undefined') return;
    try { localStorage.removeItem(name); } catch { }
  },
};

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user:            null,
      isAuthenticated: false,
      _hasHydrated:    false,

      setHasHydrated: (v) => set({ _hasHydrated: v }),
      setAuth:   (user) => set({ user, isAuthenticated: true }),
      logout:    () => set({ user: null, isAuthenticated: false }),
      updateUser: (data) =>
        set((state) => ({ user: state.user ? { ...state.user, ...data } : null })),
    }),
    {
      name:    'user-profile',
      storage: createJSONStorage(() => safeLocalStorage),
      partialize: (state) => ({
        user:            state.user,
        isAuthenticated: state.isAuthenticated,
      }),
      onRehydrateStorage: () => (state, error) => {
        if (error) console.error('[authStore] rehydration error:', error);
        if (state) state.setHasHydrated(true);
        else useAuthStore.getState().setHasHydrated(true);
      },
    }
  )
);
