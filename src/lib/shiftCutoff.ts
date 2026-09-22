// Southern Lanka (carecode.org) tenant only — time-based cut-offs that compare "now" against
// an employee's assigned shift start time (the `schedule_assignments` collection — see
// src/services/scheduleAssignmentService.ts). Two rules use this:
//
//   • Leave application      — a directly-applicable leave type must be filed at least 12h
//     before the first shift the leave would cover (LEAVE_APPLY_CUTOFF_HOURS).
//   • Leave-deletion request — must be filed at least 3h before the first shift the leave
//     being deleted covers (LEAVE_DELETION_CUTOFF_HOURS).
//
// Both rules apply to a leave type only when it is employee-applicable — its
// `allow_direct_apply` flag is not `false` (see `leaveTypeHasApplyCutoff` below). Restricted
// "assign only" types (`allow_direct_apply === false`) are exempt from both cut-offs. There is
// deliberately NO leave-type-name matching here — the flag is the single source of truth.
//
// All times are wall-clock local: shift `start_time` is "HH:MM" 24h and `date` is a local
// "yyyy-MM-dd", so they combine into a local-time Date. Both the leaves page (instant inline
// feedback) and apiCompat's write path (applyLeave / requestLeaveDeletion re-check) call
// through here so the rule and its wording can never drift between the two.
import type { ScheduleAssignment } from '@/lib/types';

export const LEAVE_APPLY_CUTOFF_HOURS = 12;
export const LEAVE_DELETION_CUTOFF_HOURS = 3;

export const LEAVE_APPLY_SHIFT_CUTOFF_MSG =
  'Leave must be applied at least 12 hours before your scheduled shift.';
export const LEAVE_DELETION_SHIFT_CUTOFF_MSG =
  'Leave deletion requests must be submitted at least 3 hours before the shift start time.';

// Whether the shift cut-offs (12h apply / 3h deletion) apply to a given leave type. They apply
// to every employee-applicable type and are waived only for restricted assign-only types
// (`allow_direct_apply === false`). A missing flag counts as applicable — legacy types predate
// it, matching every other read of `allow_direct_apply` in the app (leaveService, getLeaveTypes)
// — and an unresolved type (null/undefined) also counts as applicable so a lookup miss fails
// safe (rule enforced) rather than silently skipping the cut-off.
export const leaveTypeHasApplyCutoff = (
  lt: { allow_direct_apply?: boolean } | null | undefined,
): boolean => !lt || lt.allow_direct_apply !== false;

const HOUR_MS = 3_600_000;

type ShiftLike = Pick<ScheduleAssignment, 'date' | 'start_time'> & { is_deleted?: boolean };

// A schedule assignment's local calendar date + start time as a local-time Date, or null when
// either part is missing / unparseable.
export function shiftStartDateTime(a: ShiftLike | null | undefined): Date | null {
  if (!a) return null;
  const [y, m, d] = String(a.date ?? '').slice(0, 10).split('-').map(Number);
  const [hh, mm] = String(a.start_time ?? '').split(':').map(Number);
  if ([y, m, d, hh, mm].some(n => n == null || Number.isNaN(n))) return null;
  return new Date(y, m - 1, d, hh, mm, 0, 0);
}

// The earliest still-upcoming shift start on a day within [from, to] (inclusive, "yyyy-MM-dd").
// null when the employee has no upcoming shift on any covered day (nothing to be early for),
// or when the range is empty/invalid.
export function nextCoveredShiftStart(
  assignments: ShiftLike[] | null | undefined,
  from: string,
  to: string,
  now: Date = new Date(),
): Date | null {
  if (!from) return null;
  const end = to && to >= from ? to : from;
  const nowMs = now.getTime();
  let best: Date | null = null;
  for (const a of assignments ?? []) {
    if (a?.is_deleted) continue;
    const ds = String(a?.date ?? '').slice(0, 10);
    if (!ds || ds < from || ds > end) continue;
    const start = shiftStartDateTime(a);
    if (!start || start.getTime() < nowMs) continue;
    if (!best || start.getTime() < best.getTime()) best = start;
  }
  return best;
}

// The relevant shift start when a cut-off is violated, else null. `hours` is the required lead
// time; a violation is `now` being closer to the shift start than that (a shift already in
// progress counts as violated).
export function shiftCutoffViolation(
  assignments: ShiftLike[] | null | undefined,
  from: string,
  to: string,
  hours: number,
  now: Date = new Date(),
): Date | null {
  const start = nextCoveredShiftStart(assignments, from, to, now);
  if (!start) return null;
  return start.getTime() - now.getTime() < hours * HOUR_MS ? start : null;
}
