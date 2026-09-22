'use client';
import { Fragment, useState, useEffect, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  CalendarRange, ChevronLeft, ChevronRight, Loader2, Users, X, Clock, Building2, ArrowRight, Plus, Search, CalendarOff, AlertTriangle, Coffee, Repeat,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { tenant } from '@/lib/firebase';
import { localDateString } from '@/lib/utils';
import { useAuthStore } from '@/store/authStore';
import { useUserCapabilities, useRoles } from '@/store/rolesStore';
import { useCompanyContext } from '@/store/companyContextStore';
import { resolveCapabilitiesByName } from '@/lib/permissions';
import { useT } from '@/store/appStore';
import { getDepartments } from '@/services/departmentService';
import { getShiftDefinitions, subscribeShiftDefinitions } from '@/services/shiftDefinitionService';
import { getAllUsers } from '@/services/userService';
import {
  getScheduleAssignmentsForDepartment,
  subscribeScheduleAssignmentsForDepartment,
  getScheduleAssignmentsForRange,
  subscribeScheduleAssignmentsForRange,
  createScheduleAssignment,
  removeScheduleAssignment,
} from '@/services/scheduleAssignmentService';
import { getHolidayTypesForRange, type HolidayType } from '@/services/holidayService';
import { getEmployeeLeavesForMonth, getCompanyLeavesForReport } from '@/services/leaveService';
import { getDayOffsForRange, createDayOff, removeDayOff } from '@/services/dayOffService';
import {
  createSchedulePattern,
  deleteSchedulePattern,
  subscribeSchedulePatternsForDepartment,
  subscribeSchedulePatternsForDepartments,
  reconcilePatternsForDepartment,
} from '@/services/schedulePatternService';
import { MON_FRI, describeWeekdays } from '@/lib/schedulePattern';
import ImportDayOffsDialog from '@/components/ImportDayOffsDialog';
import ImportShiftsDialog from '@/components/ImportShiftsDialog';
import PatternOccurrenceModal from '@/components/PatternOccurrenceModal';
import WeekdayPicker from '@/components/WeekdayPicker';
import type { Department, Shift, AppUser, ScheduleAssignment, LeaveRecord, DayOff, SchedulePattern } from '@/lib/types';
import { shiftDepartmentIds } from '@/lib/types';
import { canUserAccessShift, shiftIsGlobal, isRecurringDayOffEligible } from '@/lib/shiftAccess';
import Select from '@/components/Select';
import { PageHeader } from '@/components/ui/page-header';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeaderSkeleton, ListSkeleton } from '@/components/ui/Skeleton';
import { PageTransition, Reveal } from '@/components/ui/motion';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';

// Gated by its own per-tenant module flag (TenantFeatures in src/lib/tenants.ts) — `tenant`
// is resolved from the hostname (or the NEXT_PUBLIC_FIRESTORE_DB_ID fallback for
// localhost/preview) by src/lib/firebase.ts, so a tenant with the flag off gets this page
// dead on every one of its domains without a separate host check. The sidebar link
// (useSidebarNav.ts) and the app shell's route gate ((pages)/layout.tsx) read the same flag.

// Right-edge divider for the frozen Employee column — a box-shadow rather than a border so it
// stays crisp and visible at every scroll position (see the comment above the table below).
const FROZEN_COL_DIVIDER = 'shadow-[2px_0_0_0_hsl(var(--border))]';

// The department picker's "everyone" entry. Not a department id — a sentinel the page reads
// as "every department I can see on one grid" (see scopeDepartments / isAll below). A full
// admin always gets it, even on a tenant with no departments set up at all, so staff who were
// never put in a department can still be scheduled; a HOD gets it only once they manage more
// than one department, since with one there is nothing to merge.
const ALL_DEPARTMENTS = '__all__';
// Group label for employees whose `department` matches no department record.
const NO_DEPARTMENT_LABEL = 'No department';
// Above this many rows the per-employee leave fan-out is replaced by one org-wide read.
const LEAVE_FANOUT_LIMIT = 25;

// Org-accepted holiday classification (see services/holidayService.ts, curated on the
// Reports page's "Manage Holidays" dialog) — shown on the date header so it's obvious which
// columns are holidays, and captured onto a ScheduleAssignment when a shift is assigned on
// one (see handleAssign below).
const HOLIDAY_LABELS: Record<HolidayType, string> = {
  poya: 'Poya Day', public: 'Public Holiday', mercantile: 'Mercantile Holiday',
};

function timeRange(start: string, end: string): string {
  if (!start && !end) return '—';
  return `${start || '—'} – ${end || '—'}`;
}

// True if two "HH:MM" time windows overlap on the same day — the check behind the shift-clash
// warning below. A shift whose end is at/before its start (e.g. Night 19:00–07:00) is treated
// as running past midnight, matching how these times are actually entered on the Shifts page —
// both windows are normalized onto the same 24h+ timeline (anchored at that date's midnight)
// before comparing, so e.g. Evening 13:00–19:00 and Night 19:00–07:00 are correctly seen as
// back-to-back (no overlap), while Evening 13:00–19:00 and "Evening Night" 13:00–07:00 are
// correctly seen as overlapping (both start at 13:00).
function timeRangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  if (!aStart || !aEnd || !bStart || !bEnd) return false;
  const toMin = (t: string) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + (m || 0);
  };
  const a1 = toMin(aStart);
  let a2 = toMin(aEnd);
  if (a2 <= a1) a2 += 24 * 60;
  const b1 = toMin(bStart);
  let b2 = toMin(bEnd);
  if (b2 <= b1) b2 += 24 * 60;
  return a1 < b2 && b1 < a2;
}

// Length of a "HH:MM"–"HH:MM" shift window, in hours — used to total up assigned work hours
// per employee below. Mirrors timeRangesOverlap's midnight-wrap handling: an end time at/before
// its start (e.g. Night 19:00–07:00) is treated as running into the next day rather than as a
// negative/zero-length shift.
function shiftDurationHours(start: string, end: string): number {
  if (!start || !end) return 0;
  const toMin = (t: string) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + (m || 0);
  };
  const startMin = toMin(start);
  let endMin = toMin(end);
  if (endMin <= startMin) endMin += 24 * 60;
  return (endMin - startMin) / 60;
}

// Every calendar day in `month`'s month, 1st through last — the horizontal date columns.
function monthDates(month: Date): Date[] {
  const year = month.getFullYear();
  const m = month.getMonth();
  const lastDay = new Date(year, m + 1, 0).getDate();
  return Array.from({ length: lastDay }, (_, i) => new Date(year, m, i + 1));
}

// Same 'yyyy-MM' shape the native <input type="month"> reads/writes — kept in sync with the
// identical helper on the Attendance View page so both pages' month controls look and behave
// the same way.
function monthInputValue(month: Date): string {
  return `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}`;
}

interface SelectedCell {
  epf_number: string;
  employee_name: string;
  date: string;
  holiday_type: HolidayType | null;
  // Any APPROVED leave of this employee's that covers `date` — see the `leaves`/`leavesByKey`
  // state below. Almost always 0 or 1 entries; kept as an array since nothing in this data
  // model actually prevents an employee having overlapping leave records.
  leaves: LeaveRecord[];
}

// Sidebar "Schedule" page (see useSidebarNav.ts) — a Google-Calendar-style grid: pick a
// department, its active employees become rows (Name + EPF Number), the picked month's dates
// become columns, and clicking a cell assigns one of the department's shifts to that employee
// on that date (src/services/scheduleAssignmentService.ts). An employee can hold more than one
// shift on the same date — each assignment is its own doc, added/removed independently — so a
// cell can show several. Deliberately flat and live: no roster/weekday-recurrence layer, no
// publish/override snapshot — every assignment here is exactly what's stored, the moment it's
// made.
export default function SchedulePage() {
  const router = useRouter();
  const me = useAuthStore((s) => s.user);
  const caps = useUserCapabilities();
  const { roles } = useRoles();
  const t = useT();
  const allowed = tenant.features.schedule;
  // A Head-of-Department-capable role (caps.is_department_head) never gets blanket org-wide
  // access from can_manage_schedules alone, even when a role has both set (several users can
  // share an HOD-capable role — CNO, Assistant Manager, ... — each scoped to their own
  // hod_department_ids) — that would silently undo the per-user department scoping below.
  // A non-HOD role's can_manage_schedules still grants full access as normal. A Super
  // Admin/System Admin override (see AppUser.is_super_admin / resolveUserCapabilities in
  // @/lib/permissions) always bypasses the HOD exclusion — true org-wide access regardless
  // of what their assigned role otherwise carries.
  const canManageAll = !!caps.can_manage_schedules && (!!caps.is_system_admin || !caps.is_department_head);
  // Head-of-Department-capable ROLE (see AppUser.hod_department_ids, set on the Users page).
  // This is about the ROLE, not whether departments are actually assigned yet — an HOD with
  // zero departments assigned still gets locked scope (see hasHodDepartments below), which
  // resolves to an EMPTY department list rather than falling through to org-wide access.
  const isHODRole = !!caps.is_department_head;
  const hasHodDepartments = !!me?.hod_department_ids?.length;
  const deptLocked = !canManageAll && isHODRole;
  // Full assign/remove rights: an org-wide schedule manager, or a HOD with at least one
  // department actually assigned. An HOD role with ZERO departments assigned gets neither
  // manage NOR the read-only fallback below (see canViewOnly) — just the "no departments
  // assigned yet" empty state further down — until departments are added to their profile.
  const canManage = canManageAll || (isHODRole && hasHodDepartments);
  const canViewOnly = !canManage && !isHODRole && !!caps.can_view_schedules;
  // Day Off declare/manage authorization — its own dynamic guard, independent of shift-manage
  // rights: a role with can_declare_day_offs on it, OR a System Admin, OR any HOD-capable role
  // that actually has departments assigned to this user (me.hod_department_ids non-empty — the
  // "Departments managed" multi-select on the Users edit form).
  const canDeclareDayOffs =
    !!caps.is_system_admin ||
    !!caps.can_declare_day_offs ||
    (isHODRole && hasHodDepartments);

  const [departments, setDepartments] = useState<Department[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [loading, setLoading] = useState(true);
  // Global Company Selector (Top Navbar, southernlanka only — see companyContextStore.ts).
  // Narrows the Department picker below to that company's departments (a Department belongs
  // to exactly one company, see the type). Use `inScope` (not a raw companyId comparison) for
  // the filter below — it's what actually enforces the fail-closed rule: companyId === ''
  // means "browse every company" for a switching admin but "nothing" for a locked user with
  // no company assigned (companyContextBlocked) — see companyContextStore.ts.
  const { companyId, inScope: companyInScope, blocked: companyContextBlocked } = useCompanyContext();
  const [deptId, setDeptId] = useState('');
  const [employees, setEmployees] = useState<AppUser[]>([]);
  const [employeesLoading, setEmployeesLoading] = useState(false);
  // Search by employee name OR EPF number — one box, either matches (client-side over
  // `employees`, which is already scoped to the picked department).
  const [employeeSearch, setEmployeeSearch] = useState('');
  // Bubble anyone with a shift assigned today to the top of the grid — same "who's already
  // covered today" glance the Attendance View page's own "Marked Today First" toggle gives.
  const [shiftTodayFirst, setShiftTodayFirst] = useState(false);
  const [assignments, setAssignments] = useState<ScheduleAssignment[]>([]);
  const [assignmentsLoading, setAssignmentsLoading] = useState(false);
  const [month, setMonth] = useState(() => new Date());
  const [selectedCell, setSelectedCell] = useState<SelectedCell | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  // Org-accepted Poya/Public/Mercantile holidays within the visible month — keyed by
  // 'yyyy-MM-dd'. Department-independent (holidays apply org-wide), so this only depends on
  // which month is showing, not which department is picked.
  const [holidayTypes, setHolidayTypes] = useState<Map<string, HolidayType>>(new Map());
  // Leave records for the department's employees that overlap the visible month — so the cell
  // dialog can flag "this employee is on leave that day" instead of silently letting an admin
  // double-book a shift on top of it. Fetched with any status (leavesByKey below narrows to
  // approved only) so there's no extra round trip if that ever needs to change.
  const [leaves, setLeaves] = useState<LeaveRecord[]>([]);
  const [leavesLoading, setLeavesLoading] = useState(false);
  // Declared Day Offs overlapping the visible month — keyed by 'yyyy-MM-dd' per employee via
  // dayOffsByKey below. Employee-specific (unlike holidayTypes), so it's rendered in the grid
  // cells, not the date header. Reloaded after an import / declare / remove.
  const [dayOffs, setDayOffs] = useState<DayOff[]>([]);
  // Which day-off row is mid-write ('add' for the cell dialog's "Mark as Day Off", else a doc id).
  const [dayOffBusy, setDayOffBusy] = useState<string | null>(null);
  // Recurring shift patterns for the picked department — powers the ↻ badge on the grid and
  // the "Delete this occurrence / End series" prompt. Live-subscribed, same as assignments.
  const [patterns, setPatterns] = useState<SchedulePattern[]>([]);
  // Cell-dialog "Repeat weekly" controls — reset every time a cell opens.
  const [repeatOn, setRepeatOn] = useState(false);
  const [repeatWeekdays, setRepeatWeekdays] = useState<number[]>(MON_FRI);
  const [repeatUntil, setRepeatUntil] = useState('');  // '' = open-ended
  // The pattern-backed row whose × was clicked (a shift assignment OR a day-off) — drives
  // PatternOccurrenceModal.
  const [patternTarget, setPatternTarget] = useState<{
    pattern: SchedulePattern | null;
    date: string;
    label: string;                    // shift name, or "Day Off"
    assignment?: ScheduleAssignment;  // set for a shift occurrence
    dayOffId?: string;                // set for a day-off occurrence
  } | null>(null);
  const [patternBusy, setPatternBusy] = useState<'occurrence' | 'series' | null>(null);

  useEffect(() => {
    if (!allowed) router.replace('/dashboard');
  }, [allowed, router]);

  useEffect(() => {
    if (!allowed) return;
    (async () => {
      setLoading(true);
      const results = await Promise.allSettled([getDepartments(), getShiftDefinitions()]);
      if (results[0].status === 'fulfilled') setDepartments(results[0].value);
      else { console.error(results[0].reason); toast.error('Failed to load departments'); }
      if (results[1].status === 'fulfilled') setShifts(results[1].value);
      else { console.error(results[1].reason); toast.error('Failed to load shifts'); }
      setLoading(false);
    })();
  }, [allowed]);

  // Real-time shift definitions — a new/edited/deleted shift (Shift Creation page) shows up in
  // this page's shift picker/grid instantly. Fires once immediately with current data — a
  // harmless redundant overlap with the initial load above — then again on every write.
  useEffect(() => {
    if (!allowed) return;
    const unsub = subscribeShiftDefinitions(setShifts);
    return () => unsub();
  }, [allowed]);

  // A HOD (not also a full admin) only ever sees the department(s) they're assigned to
  // (AppUser.hod_department_ids, ids already — no name lookup needed, unlike the old
  // single-department flag). A full admin sees every active department, scoped further by
  // companyInScope (the Global Company Selector's fail-closed rule — see
  // companyContextStore.ts: a switching admin's unset pick shows every company, but a locked
  // user with no company assigned gets nothing, never every company).
  const scopeDepartments = useMemo(
    () =>
      departments
        .filter((d) => d.is_active)
        .filter((d) => !deptLocked || (me?.hod_department_ids ?? []).includes(d.id))
        .filter((d) => companyInScope(d.company_id)),
    [departments, deptLocked, me?.hod_department_ids, companyInScope],
  );
  const departmentOptions = useMemo(() => {
    const single = scopeDepartments.map((d) => ({ value: d.id, label: d.name }));
    // See ALL_DEPARTMENTS: always for an org-wide manager, only once a HOD has 2+ departments.
    const offerAll = !deptLocked || single.length > 1;
    return offerAll
      ? [{ value: ALL_DEPARTMENTS, label: deptLocked ? 'All my departments' : 'All departments' }, ...single]
      : single;
  }, [scopeDepartments, deptLocked]);
  const department = useMemo(() => departments.find((d) => d.id === deptId) ?? null, [departments, deptId]);
  // Picking (or clearing) the company invalidates whatever department was selected under the
  // previous scope — same "clear what no longer applies" pattern as employeeSearch below.
  useEffect(() => { setDeptId(''); }, [companyId]);
  const isAll = deptId === ALL_DEPARTMENTS;
  // Something is picked that the grid can show: one department, or all of them.
  const scopeReady = isAll || !!department;
  // Name → department, for turning an employee's free-text `department` back into a record
  // (there is no id on the user). Inactive departments are included so an employee still
  // filed under a closed one resolves rather than reading as department-less.
  const deptByName = useMemo(() => new Map(departments.map((d) => [d.name, d])), [departments]);
  // In the single-department view every row belongs to `department`; in the merged view each
  // row carries its own — or none, when the person was never put in one.
  const rowDepartment = useCallback(
    (emp: Pick<AppUser, 'department'>): Department | null =>
      (isAll ? (deptByName.get(emp.department ?? '') ?? null) : department),
    [isAll, deptByName, department],
  );

  // Convenience auto-select when a HOD manages exactly one department — same UX as the old
  // hard lock; with more than one they pick from the filtered list above instead.
  useEffect(() => {
    if (!deptLocked || deptId || departmentOptions.length !== 1) return;
    setDeptId(departmentOptions[0].value);
  }, [deptLocked, deptId, departmentOptions]);

  // Employees of the picked department, from the existing User collection (getAllUsers —
  // active only, same helper used across this app's other people-pickers), scoped to the
  // department's OWN company when exactly one department is picked (a Department belongs to
  // exactly one company — see the type) and then filtered client-side by department name,
  // since there's no per-department query on users. Company-scoping matters here specifically:
  // department names are not unique across companies, so matching on name alone could pull in
  // another company's same-named department. Also drops anyone whose role no longer carries an
  // employee profile (is_employee) — a role can be repurposed to a non-employee one without the
  // old department assignment being cleared.
  //
  // "All departments" widens that to everyone in scope (necessarily an unscoped query — the
  // picked departments can span more than one company): an org-wide manager sees every active
  // user (including people filed under no department at all — on a tenant that never set
  // departments up, that is everyone); a HOD sees the union of their departments' staff. Rows
  // are ordered department by department so the grid can print a heading between groups.
  useEffect(() => {
    if (!scopeReady) { setEmployees([]); return; }
    let cancelled = false;
    setEmployeesLoading(true);
    const scopeNames = new Set(scopeDepartments.map((d) => d.name));
    const groupOf = (u: AppUser) => (deptByName.has(u.department ?? '') ? u.department : NO_DEPARTMENT_LABEL);
    getAllUsers(isAll ? undefined : department?.company_id)
      .then((users) => {
        if (cancelled) return;
        const rows = (isAll
          ? users.filter((u) => !deptLocked || scopeNames.has(u.department ?? ''))
          : users.filter((u) => u.department === department!.name))
          .filter((u) => resolveCapabilitiesByName(u.role, roles).is_employee);
        setEmployees(
          rows.sort((a, b) => {
            if (isAll) {
              const ga = groupOf(a), gb = groupOf(b);
              // Department-less people go last, so the named groups read first.
              if (ga !== gb) {
                if (ga === NO_DEPARTMENT_LABEL) return 1;
                if (gb === NO_DEPARTMENT_LABEL) return -1;
                return ga.localeCompare(gb);
              }
            }
            return a.display_name.localeCompare(b.display_name);
          }),
        );
      })
      .catch((e) => { console.error(e); if (!cancelled) toast.error('Failed to load employees'); })
      .finally(() => { if (!cancelled) setEmployeesLoading(false); });
    return () => { cancelled = true; };
  }, [scopeReady, isAll, department, deptLocked, scopeDepartments, deptByName, roles]);
  // A search from one department rarely means anything for another — clear it on switch.
  useEffect(() => { setEmployeeSearch(''); }, [deptId]);

  // The selected department's active employees, shaped for the Day Off and Shift Roster import
  // templates (pre-filled EPF + Name, one row each). Search filter deliberately NOT applied —
  // the template covers the whole department.
  const deptTemplateEmployees = useMemo(
    () => employees.map((e) => ({ epf_number: e.epf_number, employee_name: e.display_name })),
    [employees],
  );

  // The visible month's first and last day — the window the "All departments" reads use.
  const monthRange = useMemo(() => {
    const days = monthDates(month);
    return { from: localDateString(days[0]), to: localDateString(days[days.length - 1]) };
  }, [month]);

  // Force-refresh the grid after one of this page's own writes. Per department that is the
  // cached department read; for "All departments" it is the month-range read, since no single
  // department covers what is on screen.
  const reloadAssignments = useCallback(async () => {
    if (!scopeReady) return;
    setAssignmentsLoading(true);
    try {
      setAssignments(isAll
        ? await getScheduleAssignmentsForRange(monthRange.from, monthRange.to)
        : await getScheduleAssignmentsForDepartment(department!.id, true));
    } catch (e) {
      console.error(e);
      toast.error('Failed to load schedule');
    } finally {
      setAssignmentsLoading(false);
    }
  }, [scopeReady, isAll, department, monthRange]);
  // Real-time roster grid — an Admin/HOD's own create/remove (elsewhere in this file) and any
  // OTHER admin/HOD acting on this same department both land here instantly, with no manual
  // refresh (see subscribeScheduleAssignmentsForDepartment in scheduleAssignmentService.ts).
  // Re-subscribes whenever the picked department changes; cleaned up on unmount/department
  // change either way. "All departments" listens on the visible month instead (every
  // department, one query), so it also re-subscribes when the month moves.
  useEffect(() => {
    if (!deptId) { setAssignments([]); return; }
    setAssignmentsLoading(true);
    const onRows = (rows: ScheduleAssignment[]) => {
      setAssignments(rows);
      setAssignmentsLoading(false);
    };
    const unsub = isAll
      ? subscribeScheduleAssignmentsForRange(monthRange.from, monthRange.to, onRows)
      : subscribeScheduleAssignmentsForDepartment(deptId, onRows);
    return () => unsub();
  }, [deptId, isAll, monthRange]);

  // Recurring patterns for the picked department — used only to resolve which pattern a
  // ↻-flagged assignment belongs to (for the occurrence/series prompt). The materialised
  // schedule_assignments rows are what actually render. "All departments" listens on every
  // department in scope plus '' — the id a pattern gets for a department-less employee.
  const scopeIdsKey = scopeDepartments.map((d) => d.id).join(',');
  useEffect(() => {
    if (!deptId) { setPatterns([]); return; }
    const unsub = isAll
      ? subscribeSchedulePatternsForDepartments([...(scopeIdsKey ? scopeIdsKey.split(',') : []), ''], setPatterns)
      : subscribeSchedulePatternsForDepartment(deptId, setPatterns);
    return () => unsub();
  }, [deptId, isAll, scopeIdsKey]);

  // Self-heal: when a department loads, deactivate + clear-forward any recurring pattern
  // whose owner has since been offboarded / deactivated, or lost HOD status without being a
  // designated exec (see reconcilePatternsForEmployee / patternIsVoid). The weekly cron is
  // the backstop for departments nobody opens — same "inline guard + scheduled sweep" shape
  // as the shift auto check-out. Fire-and-forget; refreshes the views only if it changed
  // something. Writes happen only when an owner is genuinely no longer entitled.
  useEffect(() => {
    if (!deptId) return;
    let cancelled = false;
    const ids = isAll ? (scopeIdsKey ? scopeIdsKey.split(',') : []) : [deptId];
    Promise.all(ids.map((id) => reconcilePatternsForDepartment(id)))
      .then((results) => {
        if (cancelled || !results.some((r) => r.deactivated)) return;
        reloadAssignments();
        loadDayOffs();
      })
      .catch((e) => console.warn('pattern reconcile skipped:', e));
    return () => { cancelled = true; };
    // reloadAssignments/loadDayOffs are stable enough for a fire-and-forget self-heal that
    // should run once per scope, not on every render that redefines them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deptId, isAll, scopeIdsKey]);

  // A shift belongs to this department view if it names the department, OR it's a global
  // restricted shift (HOD/exec-only, saved with no departments — see shiftIsGlobal). Global
  // shifts surface under every department so an eligible HOD/exec row can be given one from
  // any department; canUserAccessShift still filters the picker per employee below.
  //
  // A department-less employee (only reachable through "All departments") is offered the
  // shifts that belong to no department at all plus the global ones — on a tenant that never
  // set departments up, that is every shift there is.
  const shiftsForDepartment = useCallback(
    (dept: Department | null): Shift[] =>
      shifts.filter((s) => s.is_active && (
        dept ? (shiftDepartmentIds(s).includes(dept.id) || shiftIsGlobal(s))
             : (shiftDepartmentIds(s).length === 0))),
    [shifts],
  );
  // What the imports and the "no shifts yet" notice look at: one department's shifts, or —
  // for "All departments" — everything any row on the grid could be given.
  const departmentShifts = useMemo(() => {
    if (!scopeReady) return [];
    if (!isAll) return shiftsForDepartment(department);
    const seen = new Set<string>();
    const out: Shift[] = [];
    for (const dept of [...scopeDepartments, null]) {
      for (const sh of shiftsForDepartment(dept)) if (!seen.has(sh.id)) { seen.add(sh.id); out.push(sh); }
    }
    return out;
  }, [scopeReady, isAll, department, scopeDepartments, shiftsForDepartment]);

  const dates = useMemo(() => monthDates(month), [month]);
  const todayStr = localDateString();

  useEffect(() => {
    if (!allowed || !dates.length) return;
    let cancelled = false;
    getHolidayTypesForRange(localDateString(dates[0]), localDateString(dates[dates.length - 1]))
      .then((map) => { if (!cancelled) setHolidayTypes(map); })
      .catch((e) => console.error(e)); // non-fatal — the grid still works without holiday markers
    return () => { cancelled = true; };
  }, [allowed, dates]);

  // Declared Day Offs overlapping the visible month (single-field date range query), clipped to
  // the visible employees by dayOffsByKey below. Re-run on month change and after any
  // import/declare/remove from this page. Non-fatal on failure — the grid still renders.
  const loadDayOffs = useCallback(async () => {
    if (!allowed || !dates.length) return;
    try {
      const rows = await getDayOffsForRange(
        localDateString(dates[0]), localDateString(dates[dates.length - 1]),
      );
      setDayOffs(rows);
    } catch (e) { console.error(e); }
  }, [allowed, dates]);
  useEffect(() => { loadDayOffs(); }, [loadDayOffs]);

  // One getEmployeeLeavesForMonth call per employee currently in view (that helper is a
  // single-field equality query — cheap, no composite index — same one My Schedule and the
  // Excel report already use), refetched whenever the department's roster or the visible
  // month changes. A department's employee count is small, so fanning out per-employee here
  // is fine — there's no per-department leave query to use instead.
  //
  // "All departments" can put a few hundred rows on the grid, and a query per row is then
  // the wrong shape — past LEAVE_FANOUT_LIMIT rows it switches to one org-wide overlap read
  // (getCompanyLeavesForReport with no company: every status, straddlers included, exactly
  // what the per-employee path returns) and keeps only the people on screen.
  useEffect(() => {
    if (!employees.length) { setLeaves([]); return; }
    let cancelled = false;
    setLeavesLoading(true);
    const year = month.getFullYear();
    const mo = month.getMonth() + 1;
    const load = employees.length > LEAVE_FANOUT_LIMIT
      ? getCompanyLeavesForReport('', year, mo).then((rows) => {
          const onGrid = new Set(employees.map((e) => e.epf_number));
          return rows.filter((l) => onGrid.has(l.epf_number));
        })
      : Promise.all(employees.map((e) => getEmployeeLeavesForMonth(e.epf_number, year, mo))).then((r) => r.flat());
    load
      .then((rows) => { if (!cancelled) setLeaves(rows); })
      .catch((e) => { console.error(e); }) // non-fatal — the grid still works without leave flags
      .finally(() => { if (!cancelled) setLeavesLoading(false); });
    return () => { cancelled = true; };
  }, [employees, month]);

  // Expanded from date ranges to individual visible dates so a cell can be looked up directly
  // by (employee, date) — mirrors assignmentsByKey below. Pending AND approved leaves both show
  // here (only rejected/deleted are excluded) — the grid cells and the assign dialog's banner
  // both label which status a leave is in, so an admin sees a likely absence even before it's
  // decided rather than being surprised after the fact. The trailing Leaves count column is the
  // one place that's stricter — see employeeLeaveDayCounts below, which only counts approved.
  const leavesByKey = useMemo(() => {
    const m = new Map<string, LeaveRecord[]>();
    for (const l of leaves) {
      if (l.is_deleted || l.status === 'rejected') continue;
      for (const d of dates) {
        const dateStr = localDateString(d);
        if (dateStr >= l.from_date && dateStr <= l.to_date) {
          const list = m.get(`${l.epf_number}|${dateStr}`) ?? [];
          list.push(l);
          m.set(`${l.epf_number}|${dateStr}`, list);
        }
      }
    }
    return m;
  }, [leaves, dates]);

  // An employee can hold several shifts on the same date — grouped by (employee, date), not a
  // single value per key.
  const assignmentsByKey = useMemo(() => {
    const m = new Map<string, ScheduleAssignment[]>();
    for (const a of assignments) {
      const key = `${a.epf_number}|${a.date}`;
      const list = m.get(key) ?? [];
      list.push(a);
      m.set(key, list);
    }
    return m;
  }, [assignments]);

  // Only meaningful when today actually has a column in the visible grid — a past/future
  // month has no "today" to bubble anyone against. Same guard the Attendance View page uses
  // for its own "Marked Today First" toggle.
  const hasTodayColumn = dates.some((d) => localDateString(d) === todayStr);

  const filteredEmployees = useMemo(() => {
    const q = employeeSearch.trim().toLowerCase();
    const list = !q
      ? employees
      : employees.filter(
          (e) => e.display_name.toLowerCase().includes(q) || e.epf_number.toLowerCase().includes(q),
        );
    if (!shiftTodayFirst || !hasTodayColumn) return list;
    // "All Departments" view groups rows into contiguous per-department blocks below
    // (groupName/prevGroup/groupSize) — that grouping depends on rows staying sorted by
    // department first, so it's preserved here as the PRIMARY key; shift-today only reorders
    // WITHIN each department's block, never across the whole list. Single-department view has
    // no such grouping, so shift-today is simply the primary key there.
    const groupOf = (u: AppUser) => (deptByName.has(u.department ?? '') ? u.department! : NO_DEPARTMENT_LABEL);
    const hasShiftToday = (u: AppUser) => (assignmentsByKey.get(`${u.epf_number}|${todayStr}`)?.length ?? 0) > 0;
    return [...list].sort((a, b) => {
      if (isAll) {
        const ga = groupOf(a), gb = groupOf(b);
        if (ga !== gb) {
          if (ga === NO_DEPARTMENT_LABEL) return 1;
          if (gb === NO_DEPARTMENT_LABEL) return -1;
          return ga.localeCompare(gb);
        }
      }
      const aHas = hasShiftToday(a), bHas = hasShiftToday(b);
      if (aHas !== bHas) return aHas ? -1 : 1;
      return a.display_name.localeCompare(b.display_name);
    });
  }, [employees, employeeSearch, shiftTodayFirst, hasTodayColumn, isAll, deptByName, assignmentsByKey, todayStr]);

  // Declared Day Offs by (employee, date) — the overlay lookup for the grid cells + the cell
  // dialog (which reads this live, mirroring selectedAssignments, so a declare/remove reflects
  // without reopening).
  const dayOffsByKey = useMemo(() => {
    const m = new Map<string, DayOff[]>();
    for (const d of dayOffs) {
      const key = `${d.epf_number}|${d.date}`;
      const list = m.get(key) ?? [];
      list.push(d);
      m.set(key, list);
    }
    return m;
  }, [dayOffs]);

  // Per-employee totals for the two trailing summary columns at the end of the table — scoped
  // to the visible month only (`assignments`/`leaves` are loaded per-department/per-employee
  // regardless of month, so both are clipped to `dates` here rather than counted raw).
  const employeeShiftCounts = useMemo(() => {
    const dateStrSet = new Set(dates.map((d) => localDateString(d)));
    const m = new Map<string, number>();
    for (const a of assignments) {
      if (!dateStrSet.has(a.date)) continue;
      m.set(a.epf_number, (m.get(a.epf_number) ?? 0) + 1);
    }
    return m;
  }, [assignments, dates]);
  // Total assigned work hours this month, from each assignment's shift start/end time
  // (shiftDurationHours above) — same date-clipping as employeeShiftCounts, so it only totals
  // shifts falling within the visible month.
  const employeeWorkHours = useMemo(() => {
    const dateStrSet = new Set(dates.map((d) => localDateString(d)));
    const m = new Map<string, number>();
    for (const a of assignments) {
      if (!dateStrSet.has(a.date)) continue;
      m.set(a.epf_number, (m.get(a.epf_number) ?? 0) + shiftDurationHours(a.start_time, a.end_time));
    }
    return m;
  }, [assignments, dates]);
  // Counts DAYS on approved leave this month, not leave records — leavesByKey includes pending
  // too (for the grid/dialog display above), but a still-pending request isn't confirmed time
  // off, so it's excluded here to keep this column meaning "days actually on leave," not "days
  // someone might be on leave."
  const employeeLeaveDayCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const [key, list] of leavesByKey) {
      if (!list.some((l) => l.status === 'approved')) continue;
      const epf = key.slice(0, key.indexOf('|'));
      m.set(epf, (m.get(epf) ?? 0) + 1);
    }
    return m;
  }, [leavesByKey]);

  const openCell = (emp: AppUser, date: string) => {
    // No department-has-shifts gate here anymore — the dialog itself handles an empty
    // departmentShifts list (see the "Available Shifts" section below), offering a way to
    // create one on the spot instead of bouncing the admin off to a toast.
    setSelectedCell({
      epf_number: emp.epf_number,
      employee_name: emp.display_name,
      date,
      holiday_type: holidayTypes.get(date) ?? null,
      leaves: leavesByKey.get(`${emp.epf_number}|${date}`) ?? [],
    });
    // Every cell opens with recurrence OFF — a repeat is a deliberate extra choice.
    setRepeatOn(false);
    setRepeatWeekdays(MON_FRI);
    setRepeatUntil('');
  };

  const selectedAssignments = selectedCell
    ? assignmentsByKey.get(`${selectedCell.epf_number}|${selectedCell.date}`) ?? []
    : [];
  // Read live from dayOffsByKey (not stored on selectedCell) so a declare/remove from the
  // dialog reflects immediately after loadDayOffs — same pattern as selectedAssignments.
  const selectedDayOffs = selectedCell
    ? dayOffsByKey.get(`${selectedCell.epf_number}|${selectedCell.date}`) ?? []
    : [];
  // The open cell's employee, resolved to the full AppUser (selectedCell only carries the
  // EPF) — needed for the restricted-shift eligibility check below. Always present while the
  // dialog is open: openCell() is only ever called with a row from `employees`.
  const selectedEmployee = useMemo(
    () => (selectedCell ? employees.find((e) => e.epf_number === selectedCell.epf_number) ?? null : null),
    [selectedCell, employees],
  );

  // Shifts not yet assigned to this cell — the same shift can never be added twice to one
  // employee/date.
  // The open cell's department — the row's own, which in the single-department view is
  // simply the picked one — and the shifts that department can hand out.
  const cellDepartment = useMemo(
    () => (selectedEmployee ? rowDepartment(selectedEmployee) : department),
    [selectedEmployee, rowDepartment, department],
  );
  const cellDepartmentName = cellDepartment?.name ?? selectedEmployee?.department ?? '';
  const dialogShifts = useMemo(
    () => (isAll ? shiftsForDepartment(cellDepartment) : departmentShifts),
    [isAll, shiftsForDepartment, cellDepartment, departmentShifts],
  );
  const unassignedShifts = useMemo(
    () => dialogShifts.filter((s) => !selectedAssignments.some((a) => a.shift_id === s.id)),
    [dialogShifts, selectedAssignments],
  );
  // …then narrowed to the ones THIS employee is allowed on. A restricted shift
  // (Shift.eligible_roles / eligible_user_epfs — see src/lib/shiftAccess.ts) only shows for
  // an effective Head of Department or an explicitly listed EPF; an unrestricted shift shows
  // for everyone in the department, exactly as before.
  const availableShifts = useMemo(
    () => unassignedShifts.filter((s) => canUserAccessShift(selectedEmployee, s)),
    [unassignedShifts, selectedEmployee],
  );
  // Unassigned shifts hidden purely because this employee isn't eligible — drives a clearer
  // empty-state message than "everything's already assigned".
  const restrictedHiddenCount = unassignedShifts.length - availableShifts.length;

  // The already-assigned shift (if any) whose time window clashes with `shift` — e.g. picking
  // "Evening Night" (13:00–07:00) when "Evening" (13:00–19:00) is already on this cell. Used
  // both to disable/warn inline in the Available Shifts list and to hard-block assignment below
  // — overlapping shifts are never allowed on the same employee/date, no override.
  const findOverlap = (shift: Shift): ScheduleAssignment | null =>
    selectedAssignments.find((a) => timeRangesOverlap(shift.start_time, shift.end_time, a.start_time, a.end_time)) ?? null;

  const handleAssign = async (shift: Shift) => {
    if (!selectedCell || !scopeReady) return;
    // "Repeat weekly" on → create a pattern instead of a one-off. No overlap prompt: a
    // pattern spans many dates, and the materialise engine skips dates that already carry a
    // (different) pattern's row anyway.
    if (repeatOn) {
      if (repeatWeekdays.length === 0) {
        toast.error('Pick at least one weekday to repeat on');
        return;
      }
      await doCreatePattern(shift);
      return;
    }
    // Hard block — the Available Shifts button is already disabled for an overlapping shift,
    // this is the belt-and-braces guard against it firing anyway. No "assign anyway" path.
    const overlap = findOverlap(shift);
    if (overlap) {
      toast.error(`Shift overlaps with ${overlap.shift_name} (${overlap.start_time} - ${overlap.end_time}). Overlapping shifts cannot be assigned.`);
      return;
    }
    await doAssign(shift);
  };

  const doCreatePattern = async (shift: Shift) => {
    if (!selectedCell || !scopeReady) return;
    if (selectedEmployee && !canUserAccessShift(selectedEmployee, shift)) {
      toast.error(`${selectedCell.employee_name} isn't eligible for the ${shift.name} shift`);
      return;
    }
    setAssigning(true);
    try {
      await createSchedulePattern(
        {
          epf_number: selectedCell.epf_number,
          employee_name: selectedCell.employee_name,
          department_id: cellDepartment?.id ?? '',
          department_name: cellDepartmentName,
          shift_id: shift.id,
          shift_name: shift.name,
          start_time: shift.start_time,
          end_time: shift.end_time,
          weekdays: repeatWeekdays,
          effective_from: selectedCell.date,
          effective_to: repeatUntil || null,
        },
        { epf_number: me?.epf_number ?? '', name: me?.name ?? '' },
      );
      toast.success(`${shift.name} set to repeat ${describeWeekdays(repeatWeekdays)} for ${selectedCell.employee_name}`);
      setSelectedCell(null);
      await reloadAssignments();
    } catch (e) {
      console.error(e);
      toast.error('Failed to create the repeating pattern');
    } finally {
      setAssigning(false);
    }
  };

  const doAssign = async (shift: Shift) => {
    if (!selectedCell || !scopeReady) return;
    // Defensive — availableShifts already excludes shifts this employee can't be given, but
    // re-assert here in case that state ever falls out of sync (same stance as the shift form).
    if (selectedEmployee && !canUserAccessShift(selectedEmployee, shift)) {
      toast.error(`${selectedCell.employee_name} isn't eligible for the ${shift.name} shift`);
      return;
    }
    setAssigning(true);
    try {
      await createScheduleAssignment({
        department_id: cellDepartment?.id ?? '',
        department_name: cellDepartmentName,
        epf_number: selectedCell.epf_number,
        employee_name: selectedCell.employee_name,
        date: selectedCell.date,
        shift_id: shift.id,
        shift_name: shift.name,
        start_time: shift.start_time,
        end_time: shift.end_time,
        holiday_type: selectedCell.holiday_type,
        assigned_by: me?.epf_number ?? '',
        assigned_by_name: me?.name ?? '',
      });
      toast.success(`${shift.name} assigned to ${selectedCell.employee_name}`);
      // Dialog stays open — an employee can be given more than one shift for the same cell in
      // one go; Available Shifts re-narrows below as each is picked.
      await reloadAssignments();
    } catch (e) {
      console.error(e);
      toast.error('Failed to assign shift');
    } finally {
      setAssigning(false);
    }
  };

  const handleRemove = async (assignment: ScheduleAssignment) => {
    if (!scopeReady) return;
    // Placed by a recurring pattern → ask "this day only" vs "end the series" rather than
    // silently doing one of them.
    if (assignment.pattern_id) {
      setPatternTarget({
        assignment,
        pattern: patterns.find((p) => p.id === assignment.pattern_id) ?? null,
        date: assignment.date,
        label: assignment.shift_name,
      });
      return;
    }
    setRemovingId(assignment.id);
    try {
      await removeScheduleAssignment(assignment, { epf_number: me?.epf_number ?? '', name: me?.name ?? '' });
      toast.success(`${assignment.shift_name} removed`);
      await reloadAssignments();
    } catch (e) {
      console.error(e);
      toast.error('Failed to remove assignment');
    } finally {
      setRemovingId(null);
    }
  };

  // "Delete this occurrence only" — soft-delete just this one materialised row (a shift
  // assignment or a day-off). Its tombstone stays, so the engine / weekly job won't re-add
  // this date.
  const handleDeletePatternOccurrence = async () => {
    if (!patternTarget || !scopeReady) return;
    setPatternBusy('occurrence');
    try {
      if (patternTarget.assignment) {
        await removeScheduleAssignment(patternTarget.assignment, { epf_number: me?.epf_number ?? '', name: me?.name ?? '' });
        await reloadAssignments();
      } else if (patternTarget.dayOffId) {
        await removeDayOff(patternTarget.dayOffId);
        await loadDayOffs();
      }
      toast.success(`${patternTarget.label} removed for this date`);
      setPatternTarget(null);
    } catch (e) {
      console.error(e);
      toast.error('Failed to remove this occurrence');
    } finally {
      setPatternBusy(null);
    }
  };

  // "End repeating series" — soft-delete the pattern; its engine clears every future row it
  // owns (>= today), shifts or day-offs. Past dates are left as history.
  const handleEndPatternSeries = async () => {
    if (!scopeReady) return;
    if (!patternTarget?.pattern) {
      toast.error("Couldn't find the pattern for this entry — try again in a moment");
      return;
    }
    setPatternBusy('series');
    try {
      const { removed } = await deleteSchedulePattern(patternTarget.pattern.id);
      toast.success(`Repeating ${patternTarget.label} ended — ${removed} future date${removed === 1 ? '' : 's'} cleared`);
      setPatternTarget(null);
      await Promise.all([reloadAssignments(), loadDayOffs()]);
    } catch (e) {
      console.error(e);
      toast.error('Failed to end the series');
    } finally {
      setPatternBusy(null);
    }
  };

  // Whether the open cell's employee may be given a RECURRING day off (effective HOD, or a
  // designated exec on a restricted shift's allow-list). Plain staff get one-offs only.
  const dayOffEligible = useMemo(
    () => isRecurringDayOffEligible(selectedEmployee, dialogShifts),
    [selectedEmployee, dialogShifts],
  );

  // "Mark as Day Off" from the open cell. With Repeat weekly ON (and the employee eligible)
  // it creates a recurring is_day_off SchedulePattern instead of a single day_offs doc.
  const handleMarkDayOff = async () => {
    if (!selectedCell || !scopeReady) return;
    setDayOffBusy('add');
    try {
      if (repeatOn && dayOffEligible) {
        if (repeatWeekdays.length === 0) {
          toast.error('Pick at least one weekday to repeat on');
          return;
        }
        await createSchedulePattern(
          {
            epf_number: selectedCell.epf_number,
            employee_name: selectedCell.employee_name,
            department_id: cellDepartment?.id ?? '',
            department_name: cellDepartmentName,
            is_day_off: true,
            shift_id: '',
            shift_name: 'Day Off',
            start_time: '',
            end_time: '',
            weekdays: repeatWeekdays,
            effective_from: selectedCell.date,
            effective_to: repeatUntil || null,
          },
          { epf_number: me?.epf_number ?? '', name: me?.name ?? '' },
        );
        toast.success(`Recurring day off set (${describeWeekdays(repeatWeekdays)}) for ${selectedCell.employee_name}`);
        setSelectedCell(null);
        await loadDayOffs();
        return;
      }
      const id = await createDayOff(
        {
          epf_number: selectedCell.epf_number,
          employee_name: selectedCell.employee_name,
          date: selectedCell.date,
          source: 'manual',
        },
        me?.epf_number ?? '',
      );
      toast.success(id ? 'Day off declared' : 'Already declared for this date');
      await loadDayOffs();
    } catch (e) {
      console.error(e);
      toast.error('Failed to declare day off');
    } finally {
      setDayOffBusy(null);
    }
  };

  const handleRemoveDayOff = async (dayOff: DayOff) => {
    // From a recurring pattern → the occurrence/series prompt, same as a shift.
    if (dayOff.pattern_id) {
      setPatternTarget({
        dayOffId: dayOff.id,
        pattern: patterns.find((p) => p.id === dayOff.pattern_id) ?? null,
        date: dayOff.date,
        label: 'Day Off',
      });
      return;
    }
    setDayOffBusy(dayOff.id);
    try {
      await removeDayOff(dayOff.id);
      toast.success('Day off removed');
      await loadDayOffs();
    } catch (e) {
      console.error(e);
      toast.error('Failed to remove day off');
    } finally {
      setDayOffBusy(null);
    }
  };

  if (!allowed) return null;
  // Fail-closed: this user isn't allowed to switch companies (companyContext.canSwitch false)
  // AND their own AppUser.company_id is missing/empty — bad data, a not-yet-assigned account,
  // or an admin-type role with no company. There is no company to scope departments/employees
  // by, so show nothing rather than let companyId === '' be silently read as "every company"
  // (see companyContextStore.ts's inScope/blocked — that's exactly the bug this guard closes).
  if (companyContextBlocked) {
    return (
      <div className="p-10 text-center text-muted-foreground">
        <Building2 className="w-8 h-8 mx-auto mb-3 opacity-40" />
        <p className="font-medium text-foreground">No assigned company</p>
        <p className="text-sm mt-1">Your account has no company assigned — contact an admin.</p>
      </div>
    );
  }
  // Blocks only someone with NONE of: org-wide manage, an HOD-capable role (even with zero
  // departments assigned yet — they still get past this to the friendlier "no departments
  // assigned to you" empty state below instead of this generic message), plain read-only view
  // access, or Day Off declare/manage authorization.
  if (caps && !canManageAll && !isHODRole && !caps.can_view_schedules && !canDeclareDayOffs) {
    return (
      <div className="text-muted-foreground p-10 text-center">
        {t.noAccessSection}
      </div>
    );
  }
  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeaderSkeleton />
        <ListSkeleton rows={6} />
      </div>
    );
  }

  return (
    <PageTransition className="space-y-6">
      <PageHeader
        title="Schedule"
        description={
          deptLocked
            ? "Assign shifts to your assigned departments' employees on specific dates."
            : 'Assign shifts to employees on specific dates.'
        }
        icon={CalendarRange}
        actions={
          (canDeclareDayOffs || canManage) && (
          <>
            {/* Bulk-declare employee Day Offs from an Excel/CSV — its own authorization guard
                (see canDeclareDayOffs above), separate from shift-manage rights. */}
            {canDeclareDayOffs && (
              <ImportDayOffsDialog
                createdByEpf={me?.epf_number ?? ''}
                disabled={!department}
                departmentName={department?.name}
                employees={deptTemplateEmployees}
                onImported={() => loadDayOffs()}
              />
            )}
            {/* Bulk shift-roster import — same shift-assignment rights as the grid itself. */}
            {canManage && (
              <ImportShiftsDialog
                departmentId={department?.id}
                departmentName={department?.name}
                departmentShifts={departmentShifts}
                employees={deptTemplateEmployees}
                month={month}
                holidayTypes={holidayTypes}
                actor={{ epf_number: me?.epf_number ?? '', name: me?.name ?? '' }}
                disabled={!department}
                onImported={() => reloadAssignments()}
              />
            )}
            {/* A HOD can also manage their own department's shift definitions (SouthernlankaShifts
                locks the department picker there the same way this page does). */}
            {canManage && (
              <Button variant="outline" onClick={() => router.push('/shifts')}>
                Manage Shifts
                <ArrowRight className="w-4 h-4" />
              </Button>
            )}
          </>
          )
        }
      />

      <Reveal>
        <Card className="p-5">
          <div className="max-w-xs space-y-1.5">
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Department
            </label>
            {/* departmentOptions is already filtered to the HOD's assigned department(s) above
                (or every active department for a full admin), and to the Global Company
                Selector's companyId (Top Navbar — see companyContextStore.ts) — a single
                Select covers all of it, no more hard-locked static display for a HOD. */}
            <Select
              value={deptId}
              onChange={setDeptId}
              options={departmentOptions}
              placeholder={departmentOptions.length ? 'Select a department…' : 'No departments yet'}
              searchable
              disabled={departmentOptions.length === 0}
            />
            {/* The imports validate a sheet against ONE department's roster, so they stay off
                in the merged view — said here rather than left as two mysteriously disabled
                buttons in the header. */}
            {isAll && (canDeclareDayOffs || canManage) && (
              <p className="text-[11px] text-muted-foreground">
                Showing every department on one grid. Pick a single department to use the imports.
              </p>
            )}
          </div>
        </Card>
      </Reveal>

      {!scopeReady ? (
        <Reveal delay={0.05}>
          <Card>
            <EmptyState
              icon={Building2}
              title={deptLocked && departmentOptions.length === 0 ? 'No departments assigned to you' : 'Pick a department'}
              description={
                deptLocked && departmentOptions.length === 0
                  ? 'Contact an admin to assign you as Head of Department for one or more departments.'
                  : 'Select a department above to see its employees and schedule shifts for them.'
              }
            />
          </Card>
        </Reveal>
      ) : (
        <Reveal delay={0.05}>
          <Card className="overflow-hidden">
            {/* flex-wrap — the left group (prev/month-picker/next/Today) already fills most of
                a narrow mobile width on its own; without wrap the employee counter on the right
                had nowhere to go but clip past the card's edge (justify-between pushes it fully
                right, but the row itself was nowrap so it just overflowed instead of dropping
                to its own line). */}
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-border">
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setMonth((mo) => new Date(mo.getFullYear(), mo.getMonth() - 1, 1))}
                  aria-label="Previous month"
                >
                  <ChevronLeft className="w-4 h-4" />
                </Button>
                <Input type="month" className="w-36 h-8 text-xs" value={monthInputValue(month)}
                  onChange={(e) => {
                    const v = e.target.value;
                    // The native month picker's "Clear" fires onChange with an empty value —
                    // reset to the current month (same as the This Month button) instead of
                    // no-op'ing. Same convention as the Attendance View page's month input.
                    if (!v) { setMonth(new Date()); return; }
                    const [y, m] = v.split('-').map(Number);
                    if (y && m) setMonth(new Date(y, m - 1, 1));
                  }} />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setMonth((mo) => new Date(mo.getFullYear(), mo.getMonth() + 1, 1))}
                  aria-label="Next month"
                >
                  <ChevronRight className="w-4 h-4" />
                </Button>
                <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => setMonth(new Date())}>
                  This Month
                </Button>
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground whitespace-nowrap">
                {(employeesLoading || assignmentsLoading || leavesLoading) && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                <Users className="w-3.5 h-3.5" />
                {employeeSearch.trim()
                  ? `${filteredEmployees.length} of ${employees.length} employees`
                  : `${employees.length} employee${employees.length === 1 ? '' : 's'}`}
              </div>
            </div>

            {employees.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-border">
                <div className="relative max-w-xs flex-1 min-w-[200px]">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                  <Input
                    value={employeeSearch}
                    onChange={(e) => setEmployeeSearch(e.target.value)}
                    placeholder="Search by name or EPF number…"
                    className="pl-8 h-9 text-xs w-full"
                  />
                </div>
                {hasTodayColumn && (
                  <Button
                    variant={shiftTodayFirst ? 'default' : 'outline'}
                    size="sm"
                    className="h-9 text-xs"
                    onClick={() => setShiftTodayFirst((v) => !v)}
                    aria-pressed={shiftTodayFirst}
                  >
                    <CalendarRange className="w-3.5 h-3.5" />Scheduled Today First
                  </Button>
                )}
              </div>
            )}

            {!departmentShifts.length && (
              <div className="px-4 py-2.5 text-[11px] text-warning border-b border-warning/30 bg-warning/5">
                {department ? `${department.name} has` : 'These departments have'} no shifts yet — add one under Shifts before scheduling.
              </div>
            )}

            {employees.length === 0 ? (
              <EmptyState
                icon={Users}
                title={department ? 'No employees in this department' : 'No active employees'}
                description={department
                  ? `No active employees are assigned to ${department.name}.`
                  : 'Nobody in these departments is active right now.'}
              />
            ) : filteredEmployees.length === 0 ? (
              <EmptyState
                icon={Search}
                title="No matches"
                description="Try a different name or EPF number."
                action={
                  <Button variant="outline" size="sm" onClick={() => setEmployeeSearch('')}>
                    Clear search
                  </Button>
                }
              />
            ) : (
              // max-h + overflow-auto (both axes) turns this into its own scroll region, so the
              // header row and the employee column can each stay pinned with position:sticky
              // relative to IT — not the page viewport, which would have to account for
              // whatever the app's top bar takes up. Frozen header + frozen first column is the
              // standard spreadsheet/calendar pattern: once there are more employees than fit on
              // screen, the date header would otherwise scroll away with them, and there'd be no
              // way to tell which column is which date.
              <div className="overflow-auto max-h-[70vh]">
                {/* border-separate (not the default border-collapse) — a table's border-collapse
                    algorithm can hand ownership of a shared border to either neighboring cell,
                    which made the frozen column's right-edge divider flicker/vanish under a
                    sticky cell as rows scrolled underneath it. A box-shadow (FROZEN_COL_DIVIDER
                    below) sidesteps that entirely: it paints as part of the sticky cell's own
                    box, so it travels with it and stays visible at every scroll position. */}
                {/* table-fixed below lg — without it (automatic table layout), a long employee
                    name's UNCLIPPED text width still influences column sizing even though
                    `truncate` visually clips it, so the frozen Employee column could size
                    itself far past its w-48 (192px) hint — on a narrow mobile viewport it grew
                    to ~320px, swallowing nearly the whole screen and leaving only a sliver of
                    the date columns. table-fixed makes the browser take column widths ONLY
                    from this header row's explicit w-* classes, ignoring cell content
                    entirely. Reverted back to table-auto at lg — desktop has enough room that
                    it was never actually broken there, and table-auto's current-row behavior
                    is the one already in use/expected on desktop. */}
                <table className="w-full table-fixed lg:table-auto border-separate border-spacing-0 text-sm">
                  <thead>
                    <tr>
                      <th className={`sticky left-0 top-0 z-30 bg-card border-b border-border px-3 py-2 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider w-48 min-w-[12rem] ${FROZEN_COL_DIVIDER}`}>
                        Employee
                      </th>
                      {dates.map((d) => {
                        const dateStr = localDateString(d);
                        const isToday = dateStr === todayStr;
                        const isSunday = d.getDay() === 0;
                        // Org-accepted Poya/Public/Mercantile holiday (see holidayTypes above)
                        // — same purple accent My Schedule's calendar already uses for this
                        // (rgba(167,139,250,…) / #a78bfa), so a holiday reads the same way
                        // everywhere in the app. Today wins the background when a date is both.
                        const holiday = holidayTypes.get(dateStr) ?? null;
                        return (
                          <th
                            key={dateStr}
                            title={holiday ? HOLIDAY_LABELS[holiday] : undefined}
                            className={`sticky top-0 z-20 border-b border-border px-1.5 py-2 text-center w-[84px] min-w-[84px] ${
                              // Opaque (not the body cells' translucent /10 tint) — this header
                              // is sticky and sits directly over scrolling rows, so a
                              // see-through background would let row content (job titles, the
                              // "+" add button) bleed through underneath it.
                              isToday ? 'bg-[color-mix(in_srgb,hsl(var(--primary))_10%,hsl(var(--card)))]'
                                : holiday ? 'bg-[color-mix(in_srgb,#a78bfa_10%,hsl(var(--card)))]'
                                : 'bg-card'
                            }`}
                          >
                            <div
                              className={`text-xs font-semibold ${isToday ? 'text-primary' : !holiday ? 'text-foreground' : ''}`}
                              style={!isToday && holiday ? { color: '#a78bfa' } : undefined}
                            >
                              {d.getDate()}
                            </div>
                            <div className={`text-[10px] uppercase ${isSunday && !holiday ? 'text-destructive' : 'text-muted-foreground'}`}>
                              {d.toLocaleDateString('en-US', { weekday: 'short' })}
                            </div>
                            {holiday && (
                              <div className="text-[8px] font-semibold uppercase truncate" style={{ color: '#a78bfa' }}>
                                {holiday === 'public' ? 'Holiday' : holiday === 'poya' ? 'Poya' : 'Mercantile'}
                              </div>
                            )}
                          </th>
                        );
                      })}
                      {/* Trailing summary columns — totals for the visible month only (see
                          employeeShiftCounts/employeeLeaveDayCounts above). Not sticky:
                          unlike the frozen Employee column, there's no per-row need to keep
                          these on screen while scrolling through the dates. */}
                      <th className="sticky top-0 z-20 border-b border-l-2 border-border bg-card px-2 py-2 text-center w-16 min-w-[64px]">
                        <div className="text-[10px] font-semibold text-foreground uppercase tracking-wider">Shifts</div>
                      </th>
                      <th className="sticky top-0 z-20 border-b border-border bg-card px-2 py-2 text-center w-16 min-w-[64px]">
                        <div className="text-[10px] font-semibold text-foreground uppercase tracking-wider">Leaves</div>
                      </th>
                      <th className="sticky top-0 z-20 border-b border-border bg-card px-2 py-2 text-center w-20 min-w-[80px]">
                        <div className="text-[10px] font-semibold text-foreground uppercase tracking-wider">Work Hrs</div>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredEmployees.map((emp, idx) => {
                      // "All departments": a heading row wherever the department changes.
                      // Rows arrive already ordered by department (see the employees effect),
                      // so comparing with the previous row is enough.
                      const groupName = isAll ? (rowDepartment(emp)?.name ?? NO_DEPARTMENT_LABEL) : null;
                      const prevGroup = isAll && idx > 0 ? (rowDepartment(filteredEmployees[idx - 1])?.name ?? NO_DEPARTMENT_LABEL) : null;
                      const startsGroup = isAll && (idx === 0 || groupName !== prevGroup);
                      const groupSize = startsGroup
                        ? filteredEmployees.filter((e) => (rowDepartment(e)?.name ?? NO_DEPARTMENT_LABEL) === groupName).length
                        : 0;
                      return (
                    <Fragment key={emp.epf_number}>
                    {startsGroup && (
                      <tr>
                        <td
                          colSpan={dates.length + 4}
                          className="border-b border-border bg-muted/40 px-3 py-1.5"
                        >
                          {/* Sticky inside the scroll region, like the Employee column, so the
                              heading stays readable while the dates scroll past. */}
                          <div className="sticky left-3 flex w-fit items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                            <Building2 className="h-3 w-3" />
                            {groupName}
                            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold normal-case tracking-normal text-foreground tabular-nums">{groupSize}</span>
                          </div>
                        </td>
                      </tr>
                    )}
                    <tr className="hover:bg-accent/20">
                        <td className={`sticky left-0 z-10 bg-card border-b border-border px-3 py-2 align-top ${FROZEN_COL_DIVIDER}`}>
                          <div className="text-xs font-semibold text-foreground truncate">{emp.display_name}</div>
                          <div className="text-[11px] text-muted-foreground truncate">{emp.epf_number}</div>
                          <div className="text-[10px] text-muted-foreground/80 truncate">{emp.designation || emp.role}</div>
                        </td>
                        {dates.map((d) => {
                          const dateStr = localDateString(d);
                          const cellAssignments = assignmentsByKey.get(`${emp.epf_number}|${dateStr}`) ?? [];
                          const isToday = dateStr === todayStr;
                          const holiday = holidayTypes.get(dateStr) ?? null;
                          // Approved/pending leave covering this date — shown even when a
                          // shift is also assigned (an admin may still need to reassign
                          // coverage), so it doesn't gate on cellAssignments being empty.
                          const cellLeaves = leavesByKey.get(`${emp.epf_number}|${dateStr}`) ?? [];
                          const onLeave = cellLeaves.length > 0;
                          const leaveNote = onLeave
                            ? cellLeaves.map((l) => `On leave: ${l.leave_type_name}${l.status === 'pending' ? ' (pending)' : ''}`).join('\n')
                            : '';
                          // Declared Day Off(s) for this employee/date — a distinct overlay,
                          // shown alongside a shift badge too (an admin may still need to
                          // reassign coverage), same as the leave flag.
                          const cellDayOffs = dayOffsByKey.get(`${emp.epf_number}|${dateStr}`) ?? [];
                          const isDayOff = cellDayOffs.length > 0;
                          const dayOffNote = isDayOff
                            ? `Day Off${cellDayOffs[0].reason ? `: ${cellDayOffs[0].reason}` : ''}`
                            : '';
                          // A shift or day-off here came from a recurring pattern → ↻ corner mark.
                          const isPatternCell = cellAssignments.some((a) => a.pattern_id) || cellDayOffs.some((d) => d.pattern_id);
                          const cellTitle = cellAssignments.length
                            ? [cellAssignments.map((a) => `${a.shift_name} · ${timeRange(a.start_time, a.end_time)}${a.pattern_id ? ' · repeats weekly' : ''}`).join('\n'), leaveNote, dayOffNote].filter(Boolean).join('\n')
                            : isDayOff ? `${dayOffNote}\nClick to assign a shift anyway`
                            : onLeave ? `${leaveNote}\nClick to assign a shift anyway`
                            : holiday ? `${HOLIDAY_LABELS[holiday]} — click to assign a shift` : 'Click to assign a shift';
                          return (
                            <td
                              key={dateStr}
                              className={`relative border-b border-border px-1 py-1.5 text-center align-middle cursor-pointer ${
                                isToday ? 'bg-primary/5' : onLeave ? 'bg-amber-500/10' : isDayOff ? 'bg-sky-500/10' : holiday ? 'bg-[#a78bfa]/5' : ''
                              }`}
                              onClick={() => openCell(emp, dateStr)}
                              title={cellTitle}
                            >
                              {isPatternCell && (
                                <Repeat
                                  className="absolute top-0.5 right-0.5 w-2.5 h-2.5 text-primary/70"
                                  aria-label="Recurring shift"
                                />
                              )}
                              {/* Each item is a fixed h-6 pill, centered (both axes) within the
                                  cell so it lines up under the centered date/day headers above —
                                  the td's own align-middle centers this whole stack vertically
                                  when a row's height is driven by a taller neighboring cell. */}
                              <div className="flex flex-col gap-1">
                                {cellAssignments.length === 0 ? (
                                  onLeave ? (
                                    <div className="h-6 w-full flex items-center justify-center gap-1 rounded-md border border-dashed border-amber-500/50 text-[9px] font-medium text-amber-600 hover:border-amber-500 transition-colors">
                                      <CalendarOff className="w-2.5 h-2.5 flex-shrink-0" />
                                      On Leave
                                    </div>
                                  ) : isDayOff ? (
                                    <div className="h-6 w-full flex items-center justify-center gap-1 rounded-md border border-dashed border-sky-500/50 text-[9px] font-medium text-sky-600 hover:border-sky-500 transition-colors">
                                      <Coffee className="w-2.5 h-2.5 flex-shrink-0" />
                                      Day Off
                                    </div>
                                  ) : (
                                    <div className="h-6 w-full flex items-center justify-center rounded-md border border-dashed border-border/60 text-muted-foreground/70 hover:border-primary/50 hover:text-primary transition-colors">
                                      <Plus className="w-3.5 h-3.5" />
                                    </div>
                                  )
                                ) : cellAssignments.length === 1 ? (
                                  <Badge variant="brand" className="h-6 w-full items-center justify-center truncate px-1.5 py-0 text-[10px]">
                                    {cellAssignments[0].shift_name}
                                  </Badge>
                                ) : (
                                  <>
                                    {cellAssignments.slice(0, 2).map((a) => (
                                      <Badge key={a.id} variant="brand" className="h-6 w-full items-center justify-center truncate px-1 py-0 text-[9px] leading-none">
                                        {a.shift_name}
                                      </Badge>
                                    ))}
                                    {cellAssignments.length > 2 && (
                                      <span className="h-4 w-full flex items-center justify-center text-[9px] font-medium text-muted-foreground">
                                        +{cellAssignments.length - 2} more
                                      </span>
                                    )}
                                  </>
                                )}
                                {/* A shift assigned on top of a leave — worth flagging even
                                    though the cell already has a badge, since it usually
                                    means coverage needs to be re-checked. */}
                                {cellAssignments.length > 0 && onLeave && (
                                  <span className="h-4 w-full flex items-center justify-center gap-0.5 text-[8px] font-medium text-amber-600">
                                    <CalendarOff className="w-2 h-2 flex-shrink-0" />
                                    On Leave
                                  </span>
                                )}
                                {cellAssignments.length > 0 && isDayOff && (
                                  <span className="h-4 w-full flex items-center justify-center gap-0.5 text-[8px] font-medium text-sky-600">
                                    <Coffee className="w-2 h-2 flex-shrink-0" />
                                    Day Off
                                  </span>
                                )}
                              </div>
                            </td>
                          );
                        })}
                        {(() => {
                          const shiftCount = employeeShiftCounts.get(emp.epf_number) ?? 0;
                          const leaveCount = employeeLeaveDayCounts.get(emp.epf_number) ?? 0;
                          const workHours = employeeWorkHours.get(emp.epf_number) ?? 0;
                          // Whole hours print bare ("184"); a fractional shift length prints one
                          // decimal ("184.5") rather than a misleading long float.
                          const workHoursLabel = Number.isInteger(workHours) ? String(workHours) : workHours.toFixed(1);
                          return (
                            <>
                              <td className="border-b border-l-2 border-border bg-muted/10 px-1 py-1 text-center align-middle">
                                <span className="text-xs font-semibold text-foreground">{shiftCount}</span>
                              </td>
                              <td className="border-b border-border bg-muted/10 px-1 py-1 text-center align-middle">
                                <span className={`text-xs font-semibold ${leaveCount > 0 ? 'text-amber-600' : 'text-muted-foreground'}`}>
                                  {leaveCount}
                                </span>
                              </td>
                              <td className="border-b border-border bg-muted/10 px-1 py-1 text-center align-middle">
                                <span className="text-xs font-semibold text-foreground">{workHoursLabel}</span>
                              </td>
                            </>
                          );
                        })()}
                    </tr>
                    </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </Reveal>
      )}

      <Dialog open={!!selectedCell} onOpenChange={(open) => !open && setSelectedCell(null)}>
        <DialogContent className="max-w-sm max-h-[90vh] overflow-y-auto">
          {selectedCell && (
            <>
              {/* pr-8: the DialogContent's close (X) button is absolutely positioned at
                  top-right and overlaps the header's content area — without this, a long
                  employee name renders straight under it. min-w-0 + break-words lets the
                  name itself wrap (including a single very long token) instead of pushing
                  the badge off or colliding with the X. */}
              <DialogHeader className="pr-8">
                <DialogTitle className="flex items-center gap-2 flex-wrap">
                  <span className="min-w-0 break-words">{selectedCell.employee_name}</span>
                  {selectedCell.holiday_type && (
                    <Badge
                      variant="outline"
                      style={{ color: '#a78bfa', borderColor: 'rgba(167,139,250,0.4)', background: 'rgba(167,139,250,0.12)' }}
                    >
                      {HOLIDAY_LABELS[selectedCell.holiday_type]}
                    </Badge>
                  )}
                </DialogTitle>
                <DialogDescription>
                  {new Date(`${selectedCell.date}T00:00:00`).toLocaleDateString('en-US', {
                    weekday: 'long', month: 'short', day: 'numeric', year: 'numeric',
                  })}
                  {cellDepartmentName ? ` · ${cellDepartmentName}` : ''}
                </DialogDescription>
              </DialogHeader>

              {/* This employee has a leave covering this date — surfaced up front so an admin
                  doesn't blindly assign a shift on top of it without knowing. Shown for both
                  pending and approved (rejected/deleted are excluded upstream in leavesByKey);
                  the badge below tells them which — the trailing Leaves count on the grid only
                  counts approved days, so it can legitimately read 0 while this still shows a
                  pending one. */}
              {selectedCell.leaves.length > 0 && (
                <div className="space-y-1.5">
                  {selectedCell.leaves.map((l) => (
                    <div
                      key={l.id}
                      className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2"
                    >
                      <CalendarOff className="w-3.5 h-3.5 text-amber-600 flex-shrink-0 mt-0.5" />
                      <div className="min-w-0 text-xs">
                        <div className="flex items-center gap-1.5 flex-wrap font-medium text-foreground">
                          {l.leave_type_name}
                          <Badge variant={l.status === 'approved' ? 'success' : 'warning'} className="text-[9px] px-1.5 py-0 h-4 leading-none">
                            {l.status}
                          </Badge>
                          {l.is_half_day && (
                            <span className="text-muted-foreground font-normal">
                              (half day{l.half_day_period ? ` · ${l.half_day_period}` : ''})
                            </span>
                          )}
                        </div>
                        {l.reason && <div className="mt-0.5 text-muted-foreground truncate">{l.reason}</div>}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Declared Day Off(s) for this employee/date — the same distinct overlay as the
                  grid. Remove is gated by canDeclareDayOffs; "Mark as Day Off" shows only when
                  none is declared yet. */}
              {selectedDayOffs.length > 0 && (
                <div className="space-y-1.5">
                  {selectedDayOffs.map((d) => (
                    <div key={d.id} className="flex items-start gap-2 rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-2">
                      <Coffee className="w-3.5 h-3.5 text-sky-600 flex-shrink-0 mt-0.5" />
                      <div className="min-w-0 text-xs flex-1">
                        <div className="flex items-center gap-1.5 font-medium text-foreground">
                          Day Off
                          {d.pattern_id && <Repeat className="w-3 h-3 text-primary/70 flex-shrink-0" aria-label="Repeats weekly" />}
                        </div>
                        {d.reason && <div className="mt-0.5 text-muted-foreground truncate">{d.reason}</div>}
                        <div className="mt-0.5 text-[10px] text-muted-foreground/70">
                          {d.pattern_id
                            ? (() => { const p = patterns.find((pp) => pp.id === d.pattern_id); return p ? `Recurring · ${describeWeekdays(p.weekdays)}` : 'Recurring'; })()
                            : d.source === 'excel' ? 'Imported' : 'Declared manually'}
                        </div>
                      </div>
                      {canDeclareDayOffs && (
                        <button
                          type="button"
                          onClick={() => handleRemoveDayOff(d)}
                          disabled={dayOffBusy === d.id}
                          aria-label="Remove day off"
                          title={d.pattern_id ? 'Remove — this day or the whole series' : 'Remove day off'}
                          className="rounded-full p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50 flex-shrink-0"
                        >
                          {dayOffBusy === d.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {/* Repeat weekly — one toggle for the whole dialog. When ON: picking a shift
                  below creates a recurring shift pattern; "Mark as Day Off" creates a
                  recurring day-off pattern (HOD / designated exec only). */}
              {(canManage || canDeclareDayOffs) && (
                <div className="rounded-lg border border-border bg-muted/30 p-2.5 space-y-2.5">
                  <label className="flex items-center justify-between gap-3 cursor-pointer">
                    <span className="flex items-center gap-2 text-xs font-semibold text-foreground">
                      <Repeat className="w-3.5 h-3.5 text-primary" />
                      Repeat weekly
                    </span>
                    <Checkbox checked={repeatOn} onCheckedChange={(v) => setRepeatOn(v === true)} />
                  </label>
                  {repeatOn && (
                    <div className="space-y-2.5 pt-0.5">
                      <WeekdayPicker value={repeatWeekdays} onChange={setRepeatWeekdays} />
                      <label className="block space-y-1">
                        <span className="text-[11px] font-medium text-muted-foreground">
                          Repeat until <span className="font-normal">— leave blank to repeat indefinitely</span>
                        </span>
                        <Input
                          type="date"
                          value={repeatUntil}
                          min={selectedCell.date}
                          onChange={(e) => setRepeatUntil(e.target.value)}
                          className="h-8 text-xs"
                        />
                      </label>
                      <p className="text-[10px] text-muted-foreground">
                        Starts {new Date(`${selectedCell.date}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}.
                        Applies to the shift you pick below, or to Mark as Day Off. With no end date it rolls forward forever
                        (~8 weeks materialised ahead, extended weekly) until someone ends the series. Past dates and
                        manually-placed entries are never touched.
                      </p>
                      {!dayOffEligible && (
                        <p className="text-[10px] text-warning">
                          Recurring day off is only for Heads of Department or designated execs — Mark as Day Off will add a single day only.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}

              {canDeclareDayOffs && selectedDayOffs.length === 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={handleMarkDayOff}
                  disabled={dayOffBusy === 'add'}
                >
                  {dayOffBusy === 'add' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Coffee className="w-3.5 h-3.5" />}
                  {repeatOn && dayOffEligible ? `Repeat Day Off · ${describeWeekdays(repeatWeekdays)}` : 'Mark as Day Off'}
                </Button>
              )}

              {selectedAssignments.length > 0 && (
                <div className="space-y-2">
                  <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Assigned
                  </div>
                  <div className="space-y-1.5">
                    {selectedAssignments.map((a) => (
                      <div
                        key={a.id}
                        className="flex items-center justify-between gap-2 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2"
                      >
                        <span className="flex items-center gap-2 min-w-0">
                          <Clock className="w-3.5 h-3.5 text-primary flex-shrink-0" />
                          <span className="min-w-0">
                            <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                              <span className="truncate">{a.shift_name}</span>
                              {a.pattern_id && (
                                <Repeat className="w-3 h-3 text-primary/70 flex-shrink-0" aria-label="Repeats weekly" />
                              )}
                            </span>
                            <span className="block text-[11px] text-muted-foreground">
                              {timeRange(a.start_time, a.end_time)}
                              {a.pattern_id && (() => {
                                const p = patterns.find((pp) => pp.id === a.pattern_id);
                                return p ? ` · repeats ${describeWeekdays(p.weekdays)}` : ' · repeats weekly';
                              })()}
                            </span>
                          </span>
                        </span>
                        {canManage && (
                          <button
                            type="button"
                            onClick={() => handleRemove(a)}
                            disabled={removingId === a.id}
                            aria-label={`Remove ${a.shift_name}`}
                            title={a.pattern_id ? 'Remove — this day or the whole series' : 'Remove'}
                            className="rounded-full p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50 flex-shrink-0"
                          >
                            {removingId === a.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {canManage ? (
              <div className="space-y-2">
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  Available Shifts
                </div>
                {repeatOn && availableShifts.length > 0 && (
                  <p className="text-[10px] text-primary">Repeat weekly is on — the shift you pick starts a recurring pattern.</p>
                )}

                {!dialogShifts.length ? (
                  // Nothing to pick from at all — send them to create one instead of just
                  // saying so and leaving them to find their own way there (the previous
                  // behavior: a toast + no dialog at all).
                  <div className="rounded-lg border border-dashed border-border/60 bg-muted/20 px-3 py-4 text-center space-y-2.5">
                    <p className="text-[11px] text-muted-foreground">
                      {cellDepartment ? `${cellDepartment.name} has no shifts yet.` : 'No shifts are set up for someone without a department.'}
                    </p>
                    <Button size="sm" onClick={() => router.push('/shifts')}>
                      <Plus className="w-3.5 h-3.5" />
                      Create Shift
                    </Button>
                  </div>
                ) : availableShifts.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground">
                    {restrictedHiddenCount > 0
                      ? `The remaining shift${restrictedHiddenCount === 1 ? ' is' : 's are'} restricted — ${selectedCell.employee_name} isn't a Head of Department or on the shift's access list.`
                      : 'Every shift in this department is already assigned here.'}
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    {restrictedHiddenCount > 0 && (
                      <p className="text-[10px] text-muted-foreground pb-1">
                        {restrictedHiddenCount} restricted shift{restrictedHiddenCount === 1 ? '' : 's'} hidden — {selectedCell.employee_name} isn't eligible.
                      </p>
                    )}
                    {availableShifts.map((s) => {
                      // Flagged inline, before it's even clicked — an overlapping shift's
                      // button is disabled outright (no "assign anyway"); handleAssign's own
                      // overlap check is just the belt-and-braces backstop. A two-row layout
                      // (name+time on top, full-width wrapped warning underneath) rather than
                      // cramming everything into one flex row — the warning text is often
                      // longer than the row is wide, and squeezed alongside the right-aligned
                      // time it either got truncated mid-word or visually collided with it.
                      const overlap = findOverlap(s);
                      return (
                        <button
                          key={s.id}
                          type="button"
                          disabled={assigning || !!overlap}
                          onClick={() => handleAssign(s)}
                          title={overlap ? `Overlaps ${overlap.shift_name} (${timeRange(overlap.start_time, overlap.end_time)}) — overlapping shifts cannot be assigned` : undefined}
                          className={`w-full flex flex-col gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                            overlap
                              ? 'border-destructive/40 bg-destructive/10'
                              : 'border-border bg-muted/30 hover:border-primary/40 hover:bg-accent/30'
                          }`}
                        >
                          <span className="flex items-center justify-between gap-2 w-full">
                            <span className="flex items-center gap-2 min-w-0">
                              {overlap ? (
                                <AlertTriangle className="w-3.5 h-3.5 text-destructive flex-shrink-0" />
                              ) : (
                                <Plus className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                              )}
                              <span className="text-sm font-medium text-foreground truncate">{s.name}</span>
                            </span>
                            <span className="text-[11px] text-muted-foreground flex-shrink-0">
                              {timeRange(s.start_time, s.end_time)}
                            </span>
                          </span>
                          {overlap && (
                            <span className="block text-[10px] text-destructive leading-snug whitespace-normal break-words pl-[22px]">
                              Overlaps {overlap.shift_name} ({timeRange(overlap.start_time, overlap.end_time)}) — overlapping shifts cannot be assigned
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              ) : selectedAssignments.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">
                  No shifts assigned to {selectedCell.employee_name} on this date.
                </p>
              ) : null}

              <DialogFooter>
                <Button variant="outline" className="flex-1" onClick={() => setSelectedCell(null)}>
                  Close
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <PatternOccurrenceModal
        open={!!patternTarget}
        onOpenChange={() => setPatternTarget(null)}
        shiftName={patternTarget?.label ?? ''}
        dateLabel={patternTarget
          ? new Date(`${patternTarget.date}T00:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
          : ''}
        weekdaysLabel={patternTarget?.pattern ? describeWeekdays(patternTarget.pattern.weekdays) : 'weekly'}
        busy={patternBusy}
        onDeleteOccurrence={handleDeletePatternOccurrence}
        onEndSeries={handleEndPatternSeries}
      />
    </PageTransition>
  );
}
