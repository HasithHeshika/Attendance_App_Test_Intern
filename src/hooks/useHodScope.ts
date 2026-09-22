'use client';
import { useMemo } from 'react';
import { useUserCapabilities } from '@/store/rolesStore';
import { useAuthStore } from '@/store/authStore';

// Resolves "which departments may this user see?" for the Attendance View grid, which scopes
// its data to a Head of Department's assigned department(s). Kept as a hook (rather than
// inline in the page) so the page body isn't sprinkled with hod_department_names juggling and
// stable-key bookkeeping — and so the Schedule / Shifts pages, which roll their own copy of
// this today, have one thing to converge on later.
//
// STRICT by design:
//  • A blanket viewer — System Admin, or an explicit can_view_attendance capability — is
//    never scoped: `isHodScoped` is false and the arrays are empty.
//  • An is_department_head ROLE only counts as a scoped HOD once it has department(s) ACTUALLY
//    assigned (AppUser.hod_department_ids / hod_department_names). An empty assignment list
//    resolves to `isHodScoped === false` with empty arrays — the caller treats that as "no
//    access", never as "sees everything".
//  • NEVER falls back to AppUser.department — that's just where the person sits, not a
//    department they manage.
//
// hod_department_names is the denormalized name mirror of hod_department_ids (written
// together on the Users page). Names are what employee.department / Department.name compare
// against, so they're the primary key here; the ids are a last-ditch fallback for a
// pre-migration doc that only ever got the ids written.

export interface HodScope {
  /** Auth store hasn't produced a user yet — hold access decisions / rendering until false. */
  authPending: boolean;
  /** Blanket viewer (System Admin or can_view_attendance) — every department, no scoping. */
  canViewAll: boolean;
  /** The role carries is_department_head, regardless of whether departments are assigned. */
  isDepartmentHeadRole: boolean;
  /** !canViewAll AND is_department_head AND at least one department actually assigned. */
  isHodScoped: boolean;
  /** Department NAME(s) this HOD may see — [] unless isHodScoped. */
  departmentNames: string[];
  /** Department id(s) this HOD manages (hod_department_ids) — [] unless isHodScoped. */
  departmentIds: string[];
  /** Set(departmentNames) for O(1) membership tests. */
  departmentNameSet: Set<string>;
  /** Set(departmentIds) for O(1) membership tests. */
  departmentIdSet: Set<string>;
  /** The one managed department name when EXACTLY one is assigned, else ''. */
  singleDepartmentName: string;
  /** Stable primitive key over departmentNames — safe to use directly in effect/memo deps. */
  key: string;
  /** Stable primitive key over departmentIds. */
  idKey: string;
}

export function useHodScope(): HodScope {
  const caps = useUserCapabilities();
  const me = useAuthStore((s) => s.user);

  const canViewAll = !!caps.is_system_admin || !!caps.can_view_attendance;
  const isDepartmentHeadRole = !!caps.is_department_head;
  const scoped = !canViewAll && isDepartmentHeadRole;

  const departmentNames = useMemo<string[]>(() => {
    if (!scoped || !me) return [];
    return me.hod_department_names?.length ? me.hod_department_names : (me.hod_department_ids ?? []);
  }, [scoped, me]);

  const departmentIds = useMemo<string[]>(
    () => (!scoped || !me ? [] : (me.hod_department_ids ?? [])),
    [scoped, me],
  );

  const key = departmentNames.join('|');
  const idKey = departmentIds.join('|');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const departmentNameSet = useMemo(() => new Set(departmentNames), [key]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const departmentIdSet = useMemo(() => new Set(departmentIds), [idKey]);

  const isHodScoped = scoped && departmentNames.length > 0;
  const singleDepartmentName = isHodScoped && departmentNames.length === 1 ? departmentNames[0] : '';

  return {
    authPending: !canViewAll && !me,
    canViewAll,
    isDepartmentHeadRole,
    isHodScoped,
    departmentNames,
    departmentIds,
    departmentNameSet,
    departmentIdSet,
    singleDepartmentName,
    key,
    idKey,
  };
}
