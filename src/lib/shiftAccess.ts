// Who may be scheduled onto a Shift — the single interpreter of
// Shift.eligible_roles / Shift.eligible_user_epfs. Dependency-free (types only)
// so it stays unit-testable alongside the other src/lib/*.ts helpers.
//
// This is the eligibility gate that sits ON TOP OF department scoping. Callers
// are already dealing with a user who belongs to one of the shift's departments
// (the Schedule grid only lists a department's own people as rows); this answers
// the extra question "…but is the shift restricted, and if so is this person on
// the allow-list?". It does NOT re-check department membership.

import type { AppUser, Shift } from '@/lib/types';

// Token used inside Shift.eligible_roles to mean "any effective Head of
// Department". Matches the RoleCapabilities key of the same name in
// @/lib/permissions so the two never drift.
export const HOD_ELIGIBLE_ROLE = 'is_department_head';

type ShiftEligibility = Pick<Shift, 'eligible_roles' | 'eligible_user_epfs'>;
type ShiftUser = Pick<
  AppUser,
  'epf_number' | 'role' | 'hod_department_ids' | 'is_head_of_department'
>;

// Whether a shift restricts who can be scheduled onto it. `false` → open to
// everyone in its departments (the default; every shift created before this
// feature, whose docs carry neither field).
export function shiftIsRestricted(shift: ShiftEligibility): boolean {
  return (shift.eligible_roles?.length ?? 0) > 0
      || (shift.eligible_user_epfs?.length ?? 0) > 0;
}

// A restricted shift (eligible_roles / eligible_user_epfs) saved with NO departments
// applies across EVERY department — "HOD shifts are global". An unrestricted shift always
// requires at least one department, so this is only ever true for restricted ones. The
// Schedule grid and the roster import use it to decide which per-department views a shift
// shows up in; the eligibility gate above still keeps ineligible people off it.
export function shiftIsGlobal(shift: {
  department_ids?: string[];
  department_id?: string | null;
  eligible_roles?: string[];
  eligible_user_epfs?: string[];
}): boolean {
  const hasDepartments = (shift.department_ids?.length ?? 0) > 0 || !!shift.department_id;
  return !hasDepartments && shiftIsRestricted(shift);
}

// A user counts as a Head of Department for shift eligibility if they actually
// manage at least one department (the current model) or still carry the legacy
// per-user flag. Deliberately reads only fields present on AppUser — it does not
// resolve role capabilities, so an HOD-capable role with zero departments
// assigned is NOT treated as an HOD here (same stance the Shifts/Schedule pages
// take: a real assignment is required to manage a roster).
export function isEffectiveHod(
  user: Pick<AppUser, 'hod_department_ids' | 'is_head_of_department'>,
): boolean {
  return (user.hod_department_ids?.length ?? 0) > 0
      || user.is_head_of_department === true;
}

// Can this user be scheduled onto this shift?
//
//   shift not restricted                              → true  (open shift)
//   no user                                           → false
//   user.epf_number in eligible_user_epfs             → true
//   eligible_roles has the HOD token & effective HOD  → true
//   user.role listed verbatim in eligible_roles       → true  (plain role match)
//   otherwise                                         → false
export function canUserAccessShift(
  user: ShiftUser | null | undefined,
  shift: ShiftEligibility,
): boolean {
  if (!shiftIsRestricted(shift)) return true;
  if (!user) return false;

  const epfs  = shift.eligible_user_epfs ?? [];
  const roles = shift.eligible_roles ?? [];

  if (user.epf_number && epfs.includes(user.epf_number)) return true;
  if (roles.includes(HOD_ELIGIBLE_ROLE) && isEffectiveHod(user)) return true;
  if (user.role && roles.includes(user.role)) return true;

  return false;
}

// Who may be given a RECURRING day-off pattern: an effective Head of Department, or a
// "designated exec" — someone whose EPF is on the allow-list of a restricted shift
// (Shift.eligible_user_epfs). Same population that can hold HOD shifts without the role.
// A plain employee gets one-off day-offs only.
export function isRecurringDayOffEligible(
  user: (ShiftUser & Pick<AppUser, 'epf_number'>) | null | undefined,
  restrictedShifts: Array<Pick<Shift, 'eligible_user_epfs'>>,
): boolean {
  if (!user) return false;
  if (isEffectiveHod(user)) return true;
  return !!user.epf_number && restrictedShifts.some(
    (s) => (s.eligible_user_epfs ?? []).includes(user.epf_number),
  );
}

// Convenience for list rendering — the subset of `shifts` a user may be given.
// Department filtering is the caller's job (see note at the top of this file).
export function accessibleShifts<T extends ShiftEligibility>(
  user: ShiftUser | null | undefined,
  shifts: T[],
): T[] {
  return shifts.filter((s) => canUserAccessShift(user, s));
}
