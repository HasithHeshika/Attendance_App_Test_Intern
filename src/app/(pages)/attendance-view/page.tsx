'use client';
// Attendance View — admin-facing monthly attendance matrix across every employee, not just
// your own (that's the separate self-service /attendance page). Mirrors the Schedule page's
// grid layout (src/app/(pages)/schedule/page.tsx): a frozen Employee column, a horizontally
// scrolling day-by-day header, and one row per employee. Gated by BOTH tenant.features.payroll
// and the can_view_attendance capability (see permissions.ts) — Southern Lanka tenant only,
// same convention as the rest of the payroll module.
//
// Each cell's color comes from the Attendance Cutoff & Shift Engine
// (src/lib/attendanceShortfallEngine.ts): Late/Early is computed strictly against that day's
// SCHEDULED shift(s) (ScheduleAssignment), never a fixed clock-in cutoff. mergeShiftBlocks()
// splits a day into one block PER CONTIGUOUS RUN — two shifts with a 0-minute gap merge into
// one block (a missing mid-shift punch is never misread as late/early), but same-day shifts
// with a real gap (e.g. Morning 07:00-13:00 then Night 19:00-07:00) stay as separate blocks,
// each matched to its own attendance session in chronological order and scored independently
// — the gap between them is never counted as working time. Monthly totals are persisted
// (attendanceShortfallService.ts) so HR/Payroll has a stable number to act on manually — this
// page does not itself deduct pay or leave.
//
// Each punch's source badge (Fingerprint terminal vs Mobile app) is read straight off the
// attendances doc's own check_in_method/check_out_method for the WHOLE grid — a fingerprint
// punch is already written into that SAME collection (see src/lib/fingerprintApi.ts), so no
// per-cell query against fingerprint_attendance_events is needed just to color the matrix.
// The one place that DOES read fingerprint_attendance_events is the cell-detail modal's
// Device ID field, on demand when a cell is clicked — that collection is Admin-SDK-only
// (firestore.rules), reached through /api/payroll/attendance-source, never a direct client
// query.
//
// Also lets an admin/HOD retro-assign, add another, or remove a shift straight from the cell
// modal here — real-time attendance discrepancies (a walk-in with no shift on file, a wrong
// shift, a shift that shouldn't have been there) are far more often noticed while looking at
// THIS grid than the Schedule page's. Same writes the Schedule page itself makes
// (createScheduleAssignment / removeScheduleAssignment) and the SAME hard overlap block — no
// "assign anyway" here either, see findOverlap/handleAssignShift below.

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { CalendarCheck, ChevronLeft, ChevronRight, Search, Fingerprint, ScanFace, Smartphone, Link2, Layers, Building2, CalendarOff, Coffee, Plus, Loader2, AlertTriangle, X, CheckCircle2, CornerDownLeft } from 'lucide-react';
import toast from 'react-hot-toast';
import { useHodScope, type HodScope } from '@/hooks/useHodScope';
import { useAuthStore } from '@/store/authStore';
import { useCompanyContext } from '@/store/companyContextStore';
import { useT } from '@/store/appStore';
import { tenant } from '@/lib/firebase';
import { getCompanies } from '@/services/companyService';
import { getAllEmployees } from '@/services/userService';
import { getCompanyAttendanceForMonth, getCompanyAttendanceForDate } from '@/services/attendanceService';
import { getActiveRoles } from '@/services/roleService';
import { getDepartments } from '@/services/departmentService';
import { getScheduleAssignmentsForDepartment, createScheduleAssignment, removeScheduleAssignment } from '@/services/scheduleAssignmentService';
import { subscribeShiftDefinitions } from '@/services/shiftDefinitionService';
import { getHolidayTypesForRange, type HolidayType } from '@/services/holidayService';
import { getEmployeeLeavesForMonth } from '@/services/leaveService';
import { getDayOffsForRange } from '@/services/dayOffService';
import { upsertAttendanceShortfallSummaries, type AttendanceShortfallSummary } from '@/services/attendanceShortfallService';
import { getAttendanceFingerprintSource, type FingerprintEventInfo } from '@/services/attendanceSourceService';
import { mergeShiftBlocks, computeShortfallForDay, matchSessionsToBlocks, computeCheckOutOverrunMinutes, formatMinutes, formatScheduledClock, type ConstituentShift } from '@/lib/attendanceShortfallEngine';
import { canUserAccessShift, shiftIsGlobal } from '@/lib/shiftAccess';
import type { Company, Department, AppUser, AttendanceRecord, ScheduleAssignment, AttendanceMethod, Shift, LeaveRecord, DayOff } from '@/lib/types';
import { shiftDepartmentIds } from '@/lib/types';
import { localDateString } from '@/lib/utils';
import { PageHeader } from '@/components/ui/page-header';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/empty-state';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';

// Right-edge divider for the frozen Employee column — box-shadow (not a border) so it stays
// crisp at every scroll position. Exact same trick the Schedule page uses.
const FROZEN_COL_DIVIDER = 'shadow-[2px_0_0_0_hsl(var(--border))]';

const HOLIDAY_LABELS: Record<HolidayType, string> = {
  poya: 'Poya Day', public: 'Public Holiday', mercantile: 'Mercantile Holiday',
};

// True if two "HH:MM" time windows overlap on the same day — same helper the Schedule page
// defines locally (src/app/(pages)/schedule/page.tsx's timeRangesOverlap), used here to hard-
// block an overlapping shift from being assigned straight out of this page's cell modal too. A
// shift whose end is at/before its start (e.g. Night 19:00–07:00) is treated as running past
// midnight, matching how these times are actually entered on the Shifts page.
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

function monthDates(month: Date): Date[] {
  const year = month.getFullYear();
  const m = month.getMonth();
  const lastDay = new Date(year, m + 1, 0).getDate();
  return Array.from({ length: lastDay }, (_, i) => new Date(year, m, i + 1));
}

function periodOf(month: Date): string {
  return `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}`;
}

// Pure calendar-day arithmetic on a "YYYY-MM-DD" string — mirrors fingerprintApi.ts's own
// prevDateStr, kept as a separate copy here since that file is server-only (next/server,
// firebaseAdmin) and can't be imported into a client page.
function shiftDateStr(dateStr: string, deltaDays: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function monthInputValue(month: Date): string {
  return periodOf(month);
}

function clockLabel(ts: Date | null): string {
  if (!ts) return '';
  return ts.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Colombo' });
}

// How many calendar days (Asia/Colombo) `time` falls from `referenceDateStr` — 0 for the
// common same-day case. Shared by the plain-text grid-cell tooltip and the PunchLabel badge
// below, so the two can never disagree about which punches get flagged as "not today". A
// session that ran past midnight (correctly matched end-to-end since fingerprintApi.ts's 36h
// checkout lookback) can genuinely check out a day or more after it checked in — without this,
// a checkout time numerically earlier than the check-in time (e.g. check-in 15:04, check-out
// 07:38) reads as nonsensical rather than "next day".
function dayOffsetFrom(time: Date, referenceDateStr: string): number {
  return Math.round((Date.parse(localDateString(time)) - Date.parse(referenceDateStr)) / 86_400_000);
}

// "" for the common same-day case, else " (+1d)" / " (-1d)" etc. — the plain-text form of the
// PunchLabel badge above, for contexts (tooltips) that can't render JSX.
function dayOffsetLabel(time: Date, referenceDateStr: string): string {
  const offset = dayOffsetFrom(time, referenceDateStr);
  return offset === 0 ? '' : ` (${offset > 0 ? '+' : ''}${offset}d)`;
}

interface DayTimes {
  checkIn: Date | null;
  checkOut: Date | null;
  checkInMethod: AttendanceMethod;
  checkOutMethod: AttendanceMethod;
}

// `sessions` is the source of truth going forward; legacy single-session docs only carry the
// top-level check_in/check_out. Returns every punch cycle for the day, sorted chronologically
// by check-in — a split day (e.g. Morning then Night with a gap) has two entries here, one per
// shift, paired index-for-index against mergeShiftBlocks()'s own per-block output below.
//
// Source resolution (Fingerprint vs Mobile): a fingerprint-terminal punch is written directly
// into THIS SAME attendances/{epf}_{date}.sessions[] array (see src/lib/fingerprintApi.ts's
// module comment) with check_in_method/check_out_method set to 'fingerprint' — there's no
// separate join against fingerprint_attendance_events needed (or wanted: that collection is
// purely a raw per-scan idempotency ledger for the terminal API, not a reporting source — see
// its own comment). A missing method field means the punch came from the mobile app, which
// never sets it explicitly.
function sessionsOf(rec: AttendanceRecord | undefined): DayTimes[] {
  if (!rec) return [];
  if (rec.sessions && rec.sessions.length > 0) {
    return [...rec.sessions]
      .sort((a, b) => (a.check_in?.toMillis() ?? 0) - (b.check_in?.toMillis() ?? 0))
      .map(s => ({
        checkIn: s.check_in?.toDate() ?? null,
        checkOut: s.check_out?.toDate() ?? null,
        checkInMethod: s.check_in_method ?? 'mobile',
        checkOutMethod: s.check_out_method ?? 'mobile',
      }));
  }
  if (rec.check_in || rec.check_out) {
    return [{ checkIn: rec.check_in?.toDate() ?? null, checkOut: rec.check_out?.toDate() ?? null, checkInMethod: 'mobile', checkOutMethod: 'mobile' }];
  }
  return [];
}

// Priority order for resolving a day's status (mirrors src/app/(pages)/schedule/page.tsx's
// leave/day-off overlays): Leave beats Day Off beats actual attendance outcome. Within the
// attendance outcome itself, a real check-in always means Present (ontime/late/early), scored
// against that day's shift when one exists — 'unscheduled' vs 'absent' only distinguishes a
// past day with NO check-in: no shift assigned at all vs a shift that went unattended.
type CellStatus = 'future' | 'absent' | 'unscheduled' | 'leave' | 'dayoff' | 'ontime' | 'late' | 'early';

// One entry per distinct scheduled shift-cycle that day (see mergeShiftBlocks) — a split day
// (non-contiguous same-day shifts) has more than one, each scored independently against its
// own matched attendance session.
interface DayBlockDetail {
  scheduledStartMin: number;
  scheduledEndMin: number;
  shiftNames: string[]; // >1 only when this specific block is itself a true back-to-back merge
  shifts: ConstituentShift[]; // same length as shiftNames — each shift's OWN scheduled window
  checkIn: Date | null;
  checkOut: Date | null;
  checkInMethod: AttendanceMethod;
  checkOutMethod: AttendanceMethod;
  lateMinutes: number;
  earlyMinutes: number;
}

interface DayCell {
  checkIn: Date | null;  // earliest session check-in that day — compact grid-cell display only
  checkOut: Date | null; // latest session check-out that day — compact grid-cell display only
  checkInMethod: AttendanceMethod;
  checkOutMethod: AttendanceMethod;
  lateMinutes: number;  // SUM across every block that day
  earlyMinutes: number; // SUM across every block that day
  status: CellStatus;
  blocks: DayBlockDetail[];
  leaves: LeaveRecord[];  // approved/pending leave covering this date — empty when none
  dayOffs: DayOff[];      // declared/recurring Day Off(s) for this date — empty when none
  // Minutes the day's actual (latest) check-out falls past the LAST scheduled block's own
  // scheduledEndMin — 0 when nothing overruns. Most common cause: a shift retroactively
  // attached to a punch that already existed unscheduled, whose real check-out runs past
  // whatever window the newly-added shift offers. See computeCheckOutOverrunMinutes.
  checkOutOverrunMinutes: number;
  // A checkout that arrived within the 36h cross-day lookback (see CHECKOUT_LOOKBACK_HOURS in
  // shiftAutoClose.ts) is written back into the CHECK-IN day's own document, not this one's —
  // so a day with no check-in of its own can still be the day a PREVIOUS day's session actually
  // closed on. null when this date has no such spillover.
  spilloverCheckout: { time: Date; method: AttendanceMethod; fromDate: string } | null;
}

// 👆 Fingerprint terminal punch vs 📱 mobile app punch — see dayTimes()'s source-resolution
// comment above for exactly how this is derived (no separate query needed).
const METHOD_ICON: Record<AttendanceMethod, typeof Fingerprint> = { fingerprint: Fingerprint, face: ScanFace, mobile: Smartphone };
const METHOD_LABEL: Record<AttendanceMethod, string> = { fingerprint: 'Fingerprint', face: 'Face ID', mobile: 'Mobile App' };

const STATUS_DOT: Record<CellStatus, string> = {
  future: '', absent: 'bg-muted-foreground/30', unscheduled: '', leave: '', dayoff: '',
  ontime: 'bg-success', late: 'bg-destructive', early: 'bg-warning',
};
const STATUS_CELL: Record<CellStatus, string> = {
  future: '',
  absent: 'border border-dashed border-border/60 text-muted-foreground/60',
  unscheduled: 'text-muted-foreground/50',
  leave: 'bg-amber-500/10 border border-amber-500/30 text-amber-600',
  dayoff: 'bg-sky-500/10 border border-sky-500/30 text-sky-600',
  ontime: 'bg-success/10 border border-success/30 text-success',
  late: 'bg-destructive/10 border border-destructive/30 text-destructive',
  early: 'bg-warning/10 border border-warning/30 text-warning',
};
// Compact grid-cell label for a status that isn't a real clock time (Present statuses fall
// through to clockLabel(cell.checkIn) instead — see the cell render below).
const STATUS_LABEL: Partial<Record<CellStatus, string>> = {
  absent: 'Absent', unscheduled: 'Unscheduled', leave: 'Leave', dayoff: 'Day Off',
};

export default function AttendanceViewPage() {
  // Blanket view (System Admin / can_view_attendance) vs a strict Head-of-Department scope —
  // an is_department_head role is let in ONLY with department(s) actually assigned, and then
  // bounded to exactly those (same stance the Schedule page takes). All of that lives in the
  // hook so the page and its content component share one source of truth.
  const scope = useHodScope();

  if (!tenant.features.payroll) {
    return <div className="p-10 text-center text-muted-foreground">This section is not enabled for this organisation.</div>;
  }
  // Wait for the auth store to hydrate before an access decision, so a slow rehydrate doesn't
  // flash the access-denied message on a perfectly valid HOD session.
  if (scope.authPending) {
    return <div className="p-10 text-center text-muted-foreground">Loading…</div>;
  }
  // No blanket view, and not a HOD with department(s) assigned → nothing to show. (An
  // is_department_head role with an EMPTY assignment list lands here too — isHodScoped is
  // false for it.)
  if (!scope.canViewAll && !scope.isHodScoped) {
    return <div className="p-10 text-center text-muted-foreground">You don&apos;t have access to this section.</div>;
  }

  return (
    <Suspense fallback={<div className="p-10 text-center text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin mx-auto" /></div>}>
      <AttendanceViewContent scope={scope} />
    </Suspense>
  );
}

function AttendanceViewContent({ scope }: { scope: HodScope }) {
  // While isHodScoped is set, the employee list, the attendance records, the schedule
  // assignments, the persisted monthly summary rows AND the selectable company are ALL bounded
  // to the HOD's assigned department(s) — the dropdown only ever offers those departments
  // (plus an "All My Departments" option when there's more than one).
  const {
    isHodScoped,
    departmentNames: hodDepartmentNames,
    departmentIdSet: hodDeptIdSet,
    departmentNameSet: hodDeptSet,
    singleDepartmentName: singleHodDept,
    key: hodKey,
  } = scope;

  const searchParams = useSearchParams();
  const urlSearch = searchParams?.get('search') ?? searchParams?.get('epf') ?? '';

  const me = useAuthStore(s => s.user);
  const t = useT();
  const [companies, setCompanies] = useState<Company[]>([]);
  // Top Navbar's Global Company Selector (southernlanka only — see companyContextStore.ts).
  // A HOD-scoped viewer never follows this directly — their company is pinned below from
  // their OWN assigned department(s) (hodCompanyId), the exact same data-scoping guarantee
  // this page had before: switching companies in the navbar can never surface staff an HOD
  // doesn't manage. Everyone else (the effective `companyId` further down) follows it as-is.
  // `navbarBlocked` distinguishes a locked user with no company assigned (fail-closed — this
  // page already never fetches without a specific companyId, see the load effect below, so
  // the only gap left to close here is telling them WHY the grid is empty instead of showing
  // the same "pick a company" prompt a switching admin who simply hasn't chosen one yet gets).
  // NOTE: this superseded the page's own company-picker/"All companies" state
  // (usePayrollUiStore + ALL_COMPANIES) that main independently kept building on — see the
  // migration note on companyContextStore.ts (Schedule/Shifts/Departments/Users/Attendance
  // View all read the navbar selector now instead of keeping their own). Re-add an
  // "All companies" mode here only by extending that shared store, not a local one.
  const { companyId: navbarCompanyId, blocked: navbarBlocked } = useCompanyContext();
  const [employees, setEmployees] = useState<AppUser[]>([]);
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [assignments, setAssignments] = useState<ScheduleAssignment[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [holidayTypes, setHolidayTypes] = useState<Map<string, HolidayType>>(new Map());
  // Approved/pending leave and declared Day Offs for the visible employees/month — same two
  // sources the Schedule page overlays on its grid (getEmployeeLeavesForMonth per employee,
  // getDayOffsForRange org-wide by date). Drive the Leave/Day Off priority in cellsByEmployee
  // below; scoped to the right employees purely through the (epf, date) lookup key, same as
  // the Schedule page — dayOffs itself is fetched org-wide but only ever looked up for epfs
  // already in `employees` (which is already HOD-bounded).
  const [leaves, setLeaves] = useState<LeaveRecord[]>([]);
  const [dayOffs, setDayOffs] = useState<DayOff[]>([]);
  const [roleNames, setRoleNames] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [month, setMonth] = useState(() => new Date());
  const [search, setSearch] = useState(urlSearch);

  useEffect(() => {
    if (urlSearch) {
      setSearch(urlSearch);
    }
  }, [urlSearch]);
  // '' means "all in scope" — every company department for a full viewer, or "All My
  // Departments" for a multi-department HOD. A single-department HOD is pinned to that one
  // department (below) and its dropdown is disabled.
  const [departmentFilter, setDepartmentFilter] = useState(singleHodDept);
  const [roleFilter, setRoleFilter] = useState('');
  // Bubble anyone who's already punched in today to the top of the list — a quick "who's
  // marked attendance yet" glance without leaving this page. Reordering only, never hides
  // anyone (see the toggle's render guard below for why it only appears when the viewed
  // month actually includes today).
  const [markedTodayFirst, setMarkedTodayFirst] = useState(false);
  // A POINTER, not a snapshot — the modal derives its cell/holiday/record live from the memos
  // below, so a shift assigned/removed from inside the modal (or from the Schedule page, while
  // this page happens to be open) re-renders it immediately with no reopen and no stale copy.
  const [selectedRef, setSelectedRef] = useState<{ employee: AppUser; dateStr: string } | null>(null);

  // All departments (every company) — kept in state so it can drive both the per-company
  // department list below AND the HOD company resolution. getDepartments() is module-cached
  // with a 10-min TTL, so this is effectively free even though the load effect reads it too.
  // `departmentsLoaded` gates the load effect so it doesn't run once with an empty list.
  const [allDepartments, setAllDepartments] = useState<Department[]>([]);
  const [departmentsLoaded, setDepartmentsLoaded] = useState(false);

  useEffect(() => {
    getCompanies().then(setCompanies).catch(() => {});
    getActiveRoles().then(roles => setRoleNames(roles.map(r => r.name).sort())).catch(() => {});
    getDepartments().then(setAllDepartments).catch(() => {}).finally(() => setDepartmentsLoaded(true));
  }, []);

  // Live shift-template list — only used by the cell modal's assign/add picker, so a shift
  // created/edited under Shifts shows up without a reload. Same subscription the Schedule page
  // uses; cheap (one small unfiltered collection).
  useEffect(() => subscribeShiftDefinitions(setShifts), []);

  // Keep a single-department HOD pinned to their one department — its dropdown is disabled
  // (see below), but pin the value defensively so a late auth-store hydrate can't leave it
  // blank. A multi-department HOD is left free to switch between "All My Departments" ('') and
  // any one of their assigned departments.
  useEffect(() => {
    if (singleHodDept) setDepartmentFilter(singleHodDept);
  }, [singleHodDept]);

  // The company a scoped HOD's departments live in — resolved from the departments list by id
  // (name as fallback). null until departments load, or when not HOD-scoped, or if none of the
  // HOD's assigned departments can be found (a stale assignment — best-effort: don't pin).
  const hodCompanyId = useMemo(() => {
    if (!isHodScoped || allDepartments.length === 0) return null;
    const match = allDepartments.find(d => hodDeptIdSet.has(d.id) || hodDeptSet.has(d.name));
    return match?.company_id ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHodScoped, allDepartments, hodKey, scope.idKey]);

  // Effective company for everything below: a scoped HOD is pinned to their OWN department's
  // company (never the navbar's pick, however it's set — a fixed department set lives in
  // exactly one company, so letting an HOD switch companies would only ever surface staff
  // they don't manage; the Select is gone from this page's own header for exactly that
  // reason). Everyone else follows the navbar's Global Company Selector directly.
  const companyId = isHodScoped ? hodCompanyId : navbarCompanyId;

  const dates = useMemo(() => monthDates(month), [month]);
  const period = periodOf(month);
  const todayStr = localDateString();
  // Only meaningful when today actually has a column in the visible grid — a past/future
  // month has no "today" to bubble anyone against.
  const hasTodayColumn = dates.some(d => localDateString(d) === todayStr);

  useEffect(() => {
    if (!companyId || dates.length === 0 || !departmentsLoaded) return;
    // A scoped HOD's company is still resolving, or hasn't been pinned yet — don't fetch the
    // wrong company's month (and briefly flash another company's same-named department's staff).
    if (isHodScoped && hodCompanyId && companyId !== hodCompanyId) return;
    setLoading(true);
    const year = month.getFullYear();
    const monthNum = month.getMonth() + 1;
    const fromDate = localDateString(dates[0]);
    const toDate = localDateString(dates[dates.length - 1]);
    const companyDepts = allDepartments.filter(d => d.company_id === companyId);
    // The 2 calendar days immediately before the visible range — a checkout within the 36h
    // cross-day lookback (CHECKOUT_LOOKBACK_HOURS in shiftAutoClose.ts) is written back into the
    // CHECK-IN day's own document, so a session that began the day (or two) before this range
    // opened and closed inside it would otherwise be invisible: its owning doc lives outside the
    // month-range query below. These are always outside `fromDate..toDate` (fromDate is always
    // the 1st), so merging them into `records` can never duplicate an in-range doc.
    const spillDate1 = shiftDateStr(fromDate, -1);
    const spillDate2 = shiftDateStr(fromDate, -2);

    Promise.all([
      getAllEmployees(companyId),
      getCompanyAttendanceForMonth(companyId, year, monthNum),
      getHolidayTypesForRange(fromDate, toDate),
      getDayOffsForRange(fromDate, toDate),
      getCompanyAttendanceForDate(companyId, spillDate1),
      getCompanyAttendanceForDate(companyId, spillDate2),
    ]).then(async ([emps, recs, holidays, dayOffRows, spill1, spill2]) => {
      // HOD scope: never keep any other department's people in state, so every downstream
      // memo (the grid, the monthly totals, the persisted summary rows) is department-bounded
      // by construction — not merely hidden by the display filter. `AppUser.department`,
      // `Department.name` and `hod_department_names[]` are all the department NAME, so they
      // match directly. An HOD may manage several, hence the set membership tests.
      const scopedEmps = isHodScoped ? emps.filter(e => !!e.department && hodDeptSet.has(e.department)) : emps;
      const scopedDepts = isHodScoped
        ? companyDepts.filter(d => hodDeptIdSet.has(d.id) || hodDeptSet.has(d.name))
        : companyDepts;
      const scopedEpfs = new Set(scopedEmps.map(e => e.epf_number));
      const allRecs = [...recs, ...spill1, ...spill2];
      setEmployees(scopedEmps);
      setRecords(isHodScoped ? allRecs.filter(r => scopedEpfs.has(r.epf_number)) : allRecs);
      setHolidayTypes(holidays);
      // dayOffs is an org-wide range query (no department field to filter server-side, same as
      // the Schedule page's own use of it) — left unfiltered here since dayOffsByKey below is
      // only ever looked up by (epf, date) for employees already in `scopedEmps`.
      setDayOffs(dayOffRows);
      // Each in-scope department's assignments, merged, then bounded to the visible month —
      // same "read the whole small per-department collection, filter client-side" convention
      // the Schedule page itself uses (avoids a composite index). For an HOD this is only
      // their managed department(s). Leave is fetched per employee (single-field query, no
      // composite index — same helper the Schedule page uses), fanned out over scopedEmps.
      const [perDept, leaveRows] = await Promise.all([
        Promise.all(scopedDepts.map(d => getScheduleAssignmentsForDepartment(d.id))),
        Promise.all(scopedEmps.map(e => getEmployeeLeavesForMonth(e.epf_number, year, monthNum))),
      ]);
      setAssignments(perDept.flat().filter(a => a.date >= fromDate && a.date <= toDate));
      setLeaves(leaveRows.flat());
    }).catch(() => toast.error('Failed to load attendance.'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, month, isHodScoped, hodKey, hodCompanyId, allDepartments, departmentsLoaded]);

  // Department options for the filter dropdown. An HOD only ever sees the department(s)
  // assigned to them — resolved through the departments list so an empty-but-assigned
  // department still appears and an id-only fallback still renders a real name — never any
  // department outside their scope. A full viewer sees every department that actually has
  // employees, as before.
  const departments = useMemo(() => {
    if (!isHodScoped) {
      return Array.from(new Set(employees.map(e => e.department).filter(Boolean))).sort();
    }
    const resolved = allDepartments
      .filter(d => hodDeptIdSet.has(d.id) || hodDeptSet.has(d.name))
      .map(d => d.name);
    return [...new Set(resolved.length ? resolved : hodDepartmentNames)].sort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHodScoped, hodKey, scope.idKey, employees, allDepartments]);

  const recordsByKey = useMemo(() => {
    const m = new Map<string, AttendanceRecord>();
    records.forEach(r => m.set(`${r.epf_number}|${r.date}`, r));
    return m;
  }, [records]);

  const assignmentsByKey = useMemo(() => {
    const m = new Map<string, ScheduleAssignment[]>();
    assignments.forEach(a => {
      const key = `${a.epf_number}|${a.date}`;
      const list = m.get(key) ?? [];
      list.push(a);
      m.set(key, list);
    });
    return m;
  }, [assignments]);

  // Expanded from date ranges to individual visible dates, same as the Schedule page's own
  // leavesByKey — pending AND approved both count (only rejected/deleted are excluded), since
  // either one means this isn't a genuine Absent/Unscheduled day.
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

  // One computed cell per employee per visible day — the single source of truth for both the
  // grid's rendering and the monthly totals below, so they can never disagree with each other.
  const cellsByEmployee = useMemo(() => {
    const map = new Map<string, Map<string, DayCell>>();
    for (const emp of employees) {
      const dayMap = new Map<string, DayCell>();
      for (const d of dates) {
        const dateStr = localDateString(d);
        const record = recordsByKey.get(`${emp.epf_number}|${dateStr}`);
        const shiftBlocks = mergeShiftBlocks(assignmentsByKey.get(`${emp.epf_number}|${dateStr}`) ?? []);
        const sessions = sessionsOf(record);
        const cellLeaves = leavesByKey.get(`${emp.epf_number}|${dateStr}`) ?? [];
        const cellDayOffs = dayOffsByKey.get(`${emp.epf_number}|${dateStr}`) ?? [];

        // Pair each scheduled block with the session whose actual punch times best fit its
        // window (see matchSessionsToBlocks) — NOT sessions[i]. A blind index pairing breaks
        // the moment a shift is retroactively attached to a day whose punch already existed
        // unscheduled: the block/session counts no longer agree, and a block ends up scored
        // against the wrong punch (or none) while the punch that belongs to it is dropped.
        const matchedSessions = matchSessionsToBlocks(shiftBlocks, sessions);
        const blocks: DayBlockDetail[] = shiftBlocks.map((block, i) => {
          const session = matchedSessions[i];
          const checkIn = session?.checkIn ?? null;
          const checkOut = session?.checkOut ?? null;
          const { lateMinutes, earlyDepartureMinutes } = computeShortfallForDay(block, checkIn, checkOut);
          return {
            scheduledStartMin: block.scheduledStartMin, scheduledEndMin: block.scheduledEndMin, shiftNames: block.shiftNames, shifts: block.shifts,
            checkIn, checkOut,
            checkInMethod: session?.checkInMethod ?? 'mobile', checkOutMethod: session?.checkOutMethod ?? 'mobile',
            lateMinutes, earlyMinutes: earlyDepartureMinutes,
          };
        });

        const totalLate = blocks.reduce((s, b) => s + b.lateMinutes, 0);
        const totalEarly = blocks.reduce((s, b) => s + b.earlyMinutes, 0);
        const firstCheckIn = sessions[0]?.checkIn ?? null;
        const lastSession = sessions[sessions.length - 1];
        // Checked against the day's OVERALL latest check-out (not just whichever session got
        // matched to the last block) — a punch that overruns every scheduled block still needs
        // to surface, even if matchSessionsToBlocks matched it elsewhere for scoring purposes.
        const checkOutOverrunMinutes = computeCheckOutOverrunMinutes(shiftBlocks, lastSession?.checkOut ?? null);
        // A checkout within the 36h cross-day lookback (CHECKOUT_LOOKBACK_HOURS in
        // shiftAutoClose.ts) is written back into the CHECK-IN day's own document, not today's —
        // so today can be the day a PREVIOUS day's session actually closed on even though today
        // has no session of its own. Checked back up to 2 calendar days, matching the same
        // window the backend itself uses (a check-in just before midnight can close as late as
        // 2 calendar days later). recordsByKey covers these thanks to the extra spillover fetch
        // in the load effect above.
        let spilloverCheckout: DayCell['spilloverCheckout'] = null;
        for (const back of [1, 2]) {
          const backDateStr = shiftDateStr(dateStr, -back);
          const backSessions = sessionsOf(recordsByKey.get(`${emp.epf_number}|${backDateStr}`));
          const hit = backSessions.find(s => s.checkOut && localDateString(s.checkOut) === dateStr);
          if (hit) { spilloverCheckout = { time: hit.checkOut!, method: hit.checkOutMethod, fromDate: backDateStr }; break; }
        }
        // Priority order (mirrors the Schedule page's own leave/day-off overlay precedence):
        // Leave > Day Off > actual attendance outcome. A real check-in is ALWAYS Present
        // (ontime/late/early — scored against a shift when one exists, otherwise unscored),
        // regardless of whether a shift was scheduled; only with no check-in does it matter
        // whether a shift existed (Absent) or not (Unscheduled).
        let status: CellStatus;
        if (cellLeaves.length > 0) status = 'leave';
        else if (cellDayOffs.length > 0) status = 'dayoff';
        else if (firstCheckIn) status = totalLate > 0 ? 'late' : totalEarly > 0 ? 'early' : 'ontime';
        else if (dateStr > todayStr) status = 'future';
        else if (shiftBlocks.length === 0) status = 'unscheduled';
        else status = 'absent';
        dayMap.set(dateStr, {
          checkIn: firstCheckIn, checkOut: lastSession?.checkOut ?? null,
          checkInMethod: sessions[0]?.checkInMethod ?? 'mobile', checkOutMethod: lastSession?.checkOutMethod ?? 'mobile',
          lateMinutes: totalLate, earlyMinutes: totalEarly, status, blocks,
          leaves: cellLeaves, dayOffs: cellDayOffs,
          checkOutOverrunMinutes, spilloverCheckout,
        });
      }
      map.set(emp.epf_number, dayMap);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employees, dates, recordsByKey, assignmentsByKey, leavesByKey, dayOffsByKey]);

  const monthlyTotals = useMemo(() => {
    const map = new Map<string, { lateMinutes: number; earlyMinutes: number; lateDays: number; earlyDays: number }>();
    for (const [epf, dayMap] of cellsByEmployee) {
      let lateMinutes = 0, earlyMinutes = 0, lateDays = 0, earlyDays = 0;
      for (const cell of dayMap.values()) {
        lateMinutes += cell.lateMinutes; earlyMinutes += cell.earlyMinutes;
        if (cell.lateMinutes > 0) lateDays++;
        if (cell.earlyMinutes > 0) earlyDays++;
      }
      map.set(epf, { lateMinutes, earlyMinutes, lateDays, earlyDays });
    }
    return map;
  }, [cellsByEmployee]);

  // Persist this month's totals once the data has settled — a stable snapshot HR/Payroll can
  // read later (e.g. to manually apply a one-off No-Pay line or leave-balance adjustment).
  // Never applies any deduction itself.
  useEffect(() => {
    if (loading || !companyId || employees.length === 0) return;
    const rows: Omit<AttendanceShortfallSummary, 'id' | 'updated_at'>[] = employees.map(emp => {
      const t = monthlyTotals.get(emp.epf_number) ?? { lateMinutes: 0, earlyMinutes: 0, lateDays: 0, earlyDays: 0 };
      return {
        company_id: companyId, epf_number: emp.epf_number, employee_name: emp.display_name, period,
        total_late_minutes: t.lateMinutes, total_early_departure_minutes: t.earlyMinutes,
        late_days: t.lateDays, early_departure_days: t.earlyDays,
      };
    });
    upsertAttendanceShortfallSummaries(rows).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, companyId, period, monthlyTotals]);

  const filteredEmployees = useMemo(() => {
    const q = search.trim().toLowerCase();
    return employees
      .filter(u => {
        // Defense-in-depth only — `employees` is already narrowed to the HOD's departments on
        // load, and the dropdown can't emit an out-of-scope value, so this should never fire.
        if (isHodScoped && (!u.department || !hodDeptSet.has(u.department))) return false;
        if (departmentFilter && u.department !== departmentFilter) return false;
        if (roleFilter && u.role !== roleFilter) return false;
        if (!q) return true;
        return [u.display_name, u.first_name, u.last_name, u.epf_number, u.employee_number]
          .filter(Boolean).join(' ').toLowerCase().includes(q);
      })
      .sort((a, b) => {
        // Reordering only — never hides anyone. Marked employees sort by most-recent check-in
        // first (who just punched in, at a glance); the not-yet-marked group has no check-in
        // time to sort by, so it stays alphabetical, same as with the toggle off.
        if (markedTodayFirst && hasTodayColumn) {
          const aCheckIn = cellsByEmployee.get(a.epf_number)?.get(todayStr)?.checkIn ?? null;
          const bCheckIn = cellsByEmployee.get(b.epf_number)?.get(todayStr)?.checkIn ?? null;
          if (!!aCheckIn !== !!bCheckIn) return aCheckIn ? -1 : 1;
          if (aCheckIn && bCheckIn) return bCheckIn.getTime() - aCheckIn.getTime();
        }
        return a.display_name.localeCompare(b.display_name);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employees, search, departmentFilter, roleFilter, isHodScoped, hodKey, markedTodayFirst, hasTodayColumn, cellsByEmployee, todayStr]);

  const company = companies.find(c => c.id === companyId) ?? null;
  const scopeReady = !!company;

  // The open cell, resolved LIVE from the grid memos (not stored on the ref) — so an assign
  // from inside the modal reflects immediately. `cell` goes null only if the month changed
  // out from under an open modal, which the render guard below treats as "close".
  const selected = useMemo(() => {
    if (!selectedRef) return null;
    const { employee, dateStr } = selectedRef;
    return {
      employee, dateStr,
      cell: cellsByEmployee.get(employee.epf_number)?.get(dateStr) ?? null,
      holiday: holidayTypes.get(dateStr) ?? null,
      record: recordsByKey.get(`${employee.epf_number}|${dateStr}`) ?? null,
    };
  }, [selectedRef, cellsByEmployee, holidayTypes, recordsByKey]);

  // Re-point the open modal at another date for the SAME employee — used by the spillover
  // banner's "View <date>" link so an admin reading a checkout that closed on this day can jump
  // straight to the day that actually owns the record. Only ever a day (or two) earlier than
  // the currently open date, so the target can fall in the previous month — switch `month` too
  // when it does, same as the header's own prev/next month navigation.
  const jumpToDate = (employee: AppUser, dateStr: string) => {
    const [y, m] = dateStr.split('-').map(Number);
    const targetMonth = new Date(y, m - 1, 1);
    if (targetMonth.getFullYear() !== month.getFullYear() || targetMonth.getMonth() !== month.getMonth()) {
      setMonth(targetMonth);
    }
    setSelectedRef({ employee, dateStr });
  };

  // Every raw ScheduleAssignment on the open cell (not the merged blocks selected.cell.blocks
  // carries — those can combine 2+ rows into one back-to-back block) — what the overlap check
  // and the assign/remove writes below actually operate on, same shape the Schedule page's own
  // selectedAssignments uses.
  const selectedAssignments = useMemo(() => {
    if (!selected) return [];
    return assignmentsByKey.get(`${selected.employee.epf_number}|${selected.dateStr}`) ?? [];
  }, [selected, assignmentsByKey]);

  // Shift templates the open cell's employee may be given on that date — department scope
  // (shiftDepartmentIds / shiftIsGlobal) + per-employee eligibility (canUserAccessShift),
  // minus anything already on the cell. `dept` is null when the employee's department name
  // can't be resolved to a Department doc, or (defensively) falls outside an HOD's scope.
  const assignCtx = useMemo(() => {
    if (!selected) return null;
    // Scope the lookup to the employee's company — a department name could collide with a
    // same-named department in another company.
    const dept = allDepartments.find(d => d.company_id === companyId && d.name === selected.employee.department) ?? null;
    if (!dept || (isHodScoped && !hodDeptIdSet.has(dept.id))) return { dept: null as Department | null, shifts: [] as Shift[] };
    const assignedIds = new Set(selectedAssignments.map(a => a.shift_id));
    const list = shifts
      .filter(s => s.is_active
        && (shiftDepartmentIds(s).includes(dept.id) || shiftIsGlobal(s))
        && canUserAccessShift(selected.employee, s)
        && !assignedIds.has(s.id))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { dept, shifts: list };
  }, [selected, allDepartments, companyId, shifts, selectedAssignments, isHodScoped, hodDeptIdSet]);

  // The already-assigned shift (if any) whose time window clashes with `shift` — used both to
  // disable/warn inline in the picker and to hard-block the write in handleAssignShift below.
  // Same rule the Schedule page enforces (src/app/(pages)/schedule/page.tsx's own findOverlap):
  // overlapping shifts are never allowed on the same employee/date, no override.
  const findOverlap = (shift: Shift): ScheduleAssignment | null =>
    selectedAssignments.find(a => timeRangesOverlap(shift.start_time, shift.end_time, a.start_time, a.end_time)) ?? null;

  // Retro-assign one shift to the open cell's employee/date, then re-pull JUST that
  // department's assignments (bounded to the visible month) and swap them into state. Every
  // downstream memo — the grid cell colour/status, the Late/Early columns, the persisted
  // attendance_shortfall_summary upsert — recomputes off `assignments`, so nothing else needs
  // wiring. The modal keeps itself open so a split day can get its second shift.
  const handleAssignShift = async (shift: Shift) => {
    if (!selected || !assignCtx?.dept) return;
    const { dept } = assignCtx;
    const { employee, dateStr } = selected;
    // Hard block — the picker button is already disabled for an overlapping shift, this is the
    // belt-and-braces guard against it firing anyway. No "assign anyway" path.
    const overlap = findOverlap(shift);
    if (overlap) {
      toast.error(`Shift overlaps with ${overlap.shift_name} (${overlap.start_time} - ${overlap.end_time}). Overlapping shifts cannot be assigned.`);
      return;
    }
    try {
      await createScheduleAssignment({
        department_id: dept.id, department_name: dept.name,
        epf_number: employee.epf_number, employee_name: employee.display_name,
        date: dateStr,
        shift_id: shift.id, shift_name: shift.name,
        start_time: shift.start_time, end_time: shift.end_time,
        holiday_type: selected.holiday ?? null,
        assigned_by: me?.epf_number ?? '', assigned_by_name: me?.name ?? '',
      });
      const from = localDateString(dates[0]);
      const to = localDateString(dates[dates.length - 1]);
      const fresh = (await getScheduleAssignmentsForDepartment(dept.id, true))
        .filter(a => a.date >= from && a.date <= to);
      setAssignments(prev => [...prev.filter(a => a.department_id !== dept.id), ...fresh]);
      toast.success(`${shift.name} assigned to ${employee.display_name}`);
      // The retro-assign case this is really for: a punch already existed unscheduled (or
      // under a shift that ended earlier), and the newly-attached shift still doesn't cover
      // the actual check-out. The grid cell carries a persistent indicator for this already —
      // this toast is the immediate feedback at the moment it's introduced.
      const dayAssignments = fresh.filter(a => a.epf_number === employee.epf_number && a.date === dateStr);
      const record = recordsByKey.get(`${employee.epf_number}|${dateStr}`);
      const daySessions = sessionsOf(record);
      const lastCheckOut = daySessions[daySessions.length - 1]?.checkOut ?? null;
      const overrun = computeCheckOutOverrunMinutes(mergeShiftBlocks(dayAssignments), lastCheckOut);
      if (overrun > 0) {
        toast(`Heads up: ${employee.display_name}'s check-out is still ${formatMinutes(overrun)} after ${shift.name}'s scheduled end.`, { icon: '⚠️' });
      }
    } catch (e) {
      console.error(e);
      toast.error('Failed to assign shift.');
    }
  };

  // Remove one shift from the open cell — the same soft-delete write the Schedule page's own X
  // button makes. Uses the assignment's OWN department_id (not assignCtx.dept) so removal never
  // depends on the employee's department name still resolving to a live Department doc.
  const handleRemoveAssignment = async (assignment: ScheduleAssignment) => {
    try {
      await removeScheduleAssignment(assignment, { epf_number: me?.epf_number ?? '', name: me?.name ?? '' });
      const from = localDateString(dates[0]);
      const to = localDateString(dates[dates.length - 1]);
      const fresh = (await getScheduleAssignmentsForDepartment(assignment.department_id, true))
        .filter(a => a.date >= from && a.date <= to);
      setAssignments(prev => [...prev.filter(a => a.department_id !== assignment.department_id), ...fresh]);
      toast.success(`${assignment.shift_name} removed`);
    } catch (e) {
      console.error(e);
      toast.error('Failed to remove shift.');
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Attendance View"
        description={isHodScoped
          ? (hodDepartmentNames.length === 1
              ? `${hodDepartmentNames[0]} attendance for a chosen month — Late/Early is checked against each employee's scheduled shift(s), not a fixed cutoff.`
              : `Attendance across your ${hodDepartmentNames.length} managed departments for a chosen month — Late/Early is checked against each employee's scheduled shift(s), not a fixed cutoff.`)
          : "Every employee's attendance for a chosen month — Late/Early is checked against their scheduled shift(s), not a fixed cutoff."}
        icon={CalendarCheck}
        actions={isHodScoped && (
          // Company is chosen from the Top Navbar's Global Company Selector now (southernlanka
          // only — see companyContextStore.ts), not a picker on this page. An HOD never sees
          // one anyway — their company is pinned from their own department(s), see companyId
          // above — but this badge still surfaces their scope at a glance.
          <Badge variant="outline" className="gap-1.5 py-1">
            <Building2 className="w-3 h-3" />
            {hodDepartmentNames.length === 1
              ? `Head of Dept · ${hodDepartmentNames[0]}`
              : `Head of Dept · ${hodDepartmentNames.length} Departments`}
          </Badge>
        )}
      />

      {!scopeReady ? (
        <Card className="p-10">
          <EmptyState
            icon={CalendarCheck}
            title={isHodScoped ? 'Loading…' : navbarBlocked ? 'No assigned company' : 'No company selected'}
            description={
              isHodScoped
                ? 'Resolving your department’s company…'
                : navbarBlocked
                  // Fail-closed: this account has no company on its own profile and can't
                  // switch companies from the navbar either — there's nothing to show, and
                  // no picker to point them at (unlike a switching admin below).
                  ? 'Your account has no company assigned — contact an admin.'
                  : 'Pick a company from the navbar above.'
            }
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-border">
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="icon-sm" onClick={() => setMonth(mo => new Date(mo.getFullYear(), mo.getMonth() - 1, 1))} aria-label="Previous month">
                <ChevronLeft className="w-4 h-4" />
              </Button>
              <Input type="month" className="w-36 h-8 text-xs" value={monthInputValue(month)}
                onChange={e => {
                  const v = e.target.value;
                  // The native month picker's "Clear" fires onChange with an empty value —
                  // reset to the current month (same as the Today button) instead of no-op'ing.
                  if (!v) { setMonth(new Date()); return; }
                  const [y, m] = v.split('-').map(Number);
                  if (y && m) setMonth(new Date(y, m - 1, 1));
                }} />
              <Button variant="ghost" size="icon-sm" onClick={() => setMonth(mo => new Date(mo.getFullYear(), mo.getMonth() + 1, 1))} aria-label="Next month">
                <ChevronRight className="w-4 h-4" />
              </Button>
              <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => setMonth(new Date())}>This Month</Button>
            </div>
            <div className="text-xs text-muted-foreground">
              {search.trim() || roleFilter || (departmentFilter && !singleHodDept)
                ? `${filteredEmployees.length} of ${employees.length} employees`
                : `${employees.length} employee${employees.length === 1 ? '' : 's'}`}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-border">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
              <Input className="pl-8 h-9 text-xs" placeholder="Search name, employee no. or EPF…" value={search} onChange={e => setSearch(e.target.value)} />
            </div>
            {!isHodScoped ? (
              // Full viewer — every company department, plus "All Departments".
              <Select value={departmentFilter || '__all'} onValueChange={v => setDepartmentFilter(v === '__all' ? '' : v)}>
                <SelectTrigger className="w-44 h-9 text-xs"><SelectValue placeholder="Filter by Department" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all">All Departments</SelectItem>
                  {departments.map(d => <SelectItem key={d} value={d}>{d}</SelectItem>)}
                </SelectContent>
              </Select>
            ) : singleHodDept ? (
              // HOD of exactly one department — pre-selected and locked. The dropdown is
              // rendered (so the scope is visible) but disabled so it can't be changed.
              <Select value={singleHodDept} disabled>
                <SelectTrigger className="w-44 h-9 text-xs" title="You manage a single department"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={singleHodDept}>{singleHodDept}</SelectItem>
                </SelectContent>
              </Select>
            ) : (
              // HOD of several departments — "All My Departments" plus each assigned
              // department. Departments outside their scope are never listed.
              <Select value={departmentFilter || '__allmine'} onValueChange={v => setDepartmentFilter(v === '__allmine' ? '' : v)}>
                <SelectTrigger className="w-44 h-9 text-xs"><SelectValue placeholder="My Departments" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__allmine">All My Departments</SelectItem>
                  {departments.map(d => <SelectItem key={d} value={d}>{d}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
            <Select value={roleFilter || '__all'} onValueChange={v => setRoleFilter(v === '__all' ? '' : v)}>
              <SelectTrigger className="w-44 h-9 text-xs"><SelectValue placeholder="Filter by Designation / Role" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all">All Roles</SelectItem>
                {roleNames.map(r => <SelectItem key={r} value={r}>{r}</SelectItem>)}
              </SelectContent>
            </Select>
            {hasTodayColumn && (
              <Button
                variant={markedTodayFirst ? 'default' : 'outline'}
                size="sm"
                className="h-9 text-xs"
                onClick={() => setMarkedTodayFirst(v => !v)}
                aria-pressed={markedTodayFirst}
              >
                <CheckCircle2 className="w-3.5 h-3.5" />Marked Today First
              </Button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3 px-4 py-2 border-b border-border text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-success" />On-time</span>
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-destructive" />Late arrival</span>
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-warning" />Early departure</span>
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-muted-foreground/30" />Absent</span>
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full border border-dashed border-muted-foreground/50" />Unscheduled</span>
            <span className="flex items-center gap-1.5"><AlertTriangle className="w-3 h-3 text-warning" />Punched in, no shift assigned</span>
            <span className="flex items-center gap-1.5"><AlertTriangle className="w-3 h-3 text-warning" />Checked out after last shift ended</span>
            <span className="flex items-center gap-1.5"><CalendarOff className="w-3 h-3 text-amber-600" />Leave</span>
            <span className="flex items-center gap-1.5"><Coffee className="w-3 h-3 text-sky-600" />Day Off</span>
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full" style={{ background: '#a78bfa' }} />Holiday</span>
            <span className="w-px h-3 bg-border" />
            <span className="flex items-center gap-1.5"><Fingerprint className="w-3 h-3" />Fingerprint terminal</span>
            <span className="flex items-center gap-1.5"><Smartphone className="w-3 h-3" />Mobile app</span>
            <span className="flex items-center gap-1.5"><Link2 className="w-3 h-3" />Merged duty (continuous shifts)</span>
            <span className="flex items-center gap-1.5"><Layers className="w-3 h-3" />Split shifts (separate cycles, same day)</span>
            <span className="text-muted-foreground/70">· click any cell for details</span>
          </div>

          {loading ? (
            <p className="text-center text-sm text-muted-foreground py-10">Loading…</p>
          ) : employees.length === 0 ? (
            <EmptyState icon={CalendarCheck} title="No employees"
              description={isHodScoped
                ? `No active employees are assigned to ${hodDepartmentNames.length === 1 ? hodDepartmentNames[0] : 'your managed departments'}.`
                : 'This company has no active employees.'} />
          ) : filteredEmployees.length === 0 ? (
            <EmptyState icon={Search} title="No matches" description="Try a different name, EPF number, department or role."
              action={<Button variant="outline" size="sm" onClick={() => { setSearch(''); if (!singleHodDept) setDepartmentFilter(''); setRoleFilter(''); }}>Clear filters</Button>} />
          ) : (
            // Same frozen-header + frozen-first-column spreadsheet pattern as the Schedule page
            // — see the extensive comment there for why border-separate/table-fixed/sticky are
            // used together this way.
            <div className="overflow-auto max-h-[70vh]">
              <table className="w-full table-fixed lg:table-auto border-separate border-spacing-0 text-sm">
                <thead>
                  <tr>
                    <th className={`sticky left-0 top-0 z-30 bg-card border-b border-border px-3 py-2 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider w-48 min-w-[12rem] ${FROZEN_COL_DIVIDER}`}>
                      Employee
                    </th>
                    {dates.map(d => {
                      const dateStr = localDateString(d);
                      const isToday = dateStr === todayStr;
                      const isSunday = d.getDay() === 0;
                      const holiday = holidayTypes.get(dateStr) ?? null;
                      return (
                        <th key={dateStr} title={holiday ? HOLIDAY_LABELS[holiday] : undefined}
                          className={`sticky top-0 z-20 border-b border-border px-1.5 py-2 text-center w-[84px] min-w-[84px] ${
                            // Opaque (not the body cells' translucent /10 tint) — this header is
                            // sticky and sits directly over scrolling rows, so a see-through
                            // background lets row content bleed through underneath it.
                            isToday ? 'bg-[color-mix(in_srgb,hsl(var(--primary))_10%,hsl(var(--card)))]'
                              : holiday ? 'bg-[color-mix(in_srgb,#a78bfa_10%,hsl(var(--card)))]'
                              : 'bg-card'
                          }`}>
                          <div className={`text-xs font-semibold ${isToday ? 'text-primary' : !holiday ? 'text-foreground' : ''}`}
                            style={!isToday && holiday ? { color: '#a78bfa' } : undefined}>
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
                    <th className="sticky top-0 z-20 border-b border-l-2 border-border bg-card px-2 py-2 text-center w-20 min-w-[76px]">
                      <div className="text-[10px] font-semibold text-foreground uppercase tracking-wider">Late</div>
                    </th>
                    <th className="sticky top-0 z-20 border-b border-border bg-card px-2 py-2 text-center w-20 min-w-[76px]">
                      <div className="text-[10px] font-semibold text-foreground uppercase tracking-wider">Early</div>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filteredEmployees.map(emp => {
                    const dayMap = cellsByEmployee.get(emp.epf_number);
                    const totals = monthlyTotals.get(emp.epf_number);
                    return (
                      <tr key={emp.epf_number} className="hover:bg-accent/20">
                        <td className={`sticky left-0 z-10 bg-card border-b border-border px-3 py-2 align-top ${FROZEN_COL_DIVIDER}`}>
                          <div className="text-xs font-semibold text-foreground truncate">{emp.display_name}</div>
                          <div className="text-[11px] text-muted-foreground truncate">{emp.epf_number}</div>
                          <div className="text-[10px] text-muted-foreground/80 truncate">{emp.designation || emp.role}</div>
                        </td>
                        {dates.map(d => {
                          const dateStr = localDateString(d);
                          const cell = dayMap?.get(dateStr);
                          const isToday = dateStr === todayStr;
                          const holiday = holidayTypes.get(dateStr) ?? null;
                          if (!cell || cell.status === 'future') {
                            return (
                              <td key={dateStr} className={`border-b border-border px-1 py-1 text-center align-middle ${isToday ? 'bg-primary/5' : holiday ? 'bg-[#a78bfa]/5' : ''}`} />
                            );
                          }
                          const isSplitDay = cell.blocks.length > 1;
                          const isMergedDuty = cell.blocks.some(b => b.shiftNames.length > 1);
                          const isPresent = cell.status === 'ontime' || cell.status === 'late' || cell.status === 'early';
                          // A real punch with no shift to score it against — status is still
                          // 'ontime' (a check-in is always Present, see the cellsByEmployee
                          // comment above), but nothing here has actually been assigned yet, so
                          // the grid needs its own signal distinct from a normal on-time day.
                          const needsShift = isPresent && cell.blocks.length === 0;
                          const exceedsLastShift = cell.checkOutOverrunMinutes > 0;
                          const statusNote = cell.status === 'leave'
                            ? cell.leaves.map(l => `On leave: ${l.leave_type_name}${l.status === 'pending' ? ' (pending)' : ''}`).join('\n')
                            : cell.status === 'dayoff'
                              ? `Day Off${cell.dayOffs[0]?.reason ? `: ${cell.dayOffs[0].reason}` : ''}`
                              : cell.status === 'unscheduled'
                                ? 'Unscheduled — no shift assigned'
                                : cell.status === 'absent'
                                  ? 'Absent — shift scheduled, no check-in'
                                  : needsShift
                                    ? 'Punched in, but no shift assigned — click to assign one'
                                    : null;
                          const title = [
                            statusNote,
                            ...cell.blocks.flatMap((b, i) => {
                              const label = isSplitDay ? `Shift ${i + 1} (${b.shiftNames.join(' + ')})`
                                : b.shiftNames.length > 1 ? `Continuous Shift Sequence (Merged Duty): ${b.shiftNames.join(' + ')}`
                                  : `Shift: ${b.shiftNames.join(' + ')}`;
                              return [
                                label,
                                b.checkIn ? `  Check-in: ${clockLabel(b.checkIn)}${dayOffsetLabel(b.checkIn, dateStr)} (${METHOD_LABEL[b.checkInMethod]})` : '  No check-in',
                                b.checkOut ? `  Check-out: ${clockLabel(b.checkOut)}${dayOffsetLabel(b.checkOut, dateStr)} (${METHOD_LABEL[b.checkOutMethod]})` : (b.checkIn ? '  No check-out' : null),
                                b.lateMinutes > 0 ? `  Late by ${formatMinutes(b.lateMinutes)}` : null,
                                b.earlyMinutes > 0 ? `  Left early by ${formatMinutes(b.earlyMinutes)}` : null,
                              ].filter((l): l is string => l !== null);
                            }),
                            exceedsLastShift ? `Checked out ${formatMinutes(cell.checkOutOverrunMinutes)} after the last shift's scheduled end` : null,
                            cell.spilloverCheckout ? `Checked out ${clockLabel(cell.spilloverCheckout.time)} today — closes a session that began on ${cell.spilloverCheckout.fromDate}. See that day for full details.` : null,
                            holiday ? HOLIDAY_LABELS[holiday] : null,
                            'Click for details',
                          ].filter(Boolean).join('\n');
                          const MethodIcon = isPresent ? METHOD_ICON[cell.checkInMethod] : null;
                          return (
                            <td key={dateStr} title={title}
                              onClick={() => setSelectedRef({ employee: emp, dateStr })}
                              className={`border-b border-border px-1 py-1 text-center align-middle cursor-pointer hover:ring-1 hover:ring-inset hover:ring-primary/30 ${isToday ? 'bg-primary/5' : holiday ? 'bg-[#a78bfa]/5' : ''}`}>
                              <div className={`h-6 rounded-md flex items-center justify-center gap-1 text-[9px] font-medium ${needsShift ? 'bg-warning/10 border border-dashed border-warning/50 text-warning' : STATUS_CELL[cell.status]}`}>
                                {cell.status === 'leave' && <CalendarOff className="w-2.5 h-2.5 flex-shrink-0" />}
                                {cell.status === 'dayoff' && <Coffee className="w-2.5 h-2.5 flex-shrink-0" />}
                                {needsShift && <AlertTriangle className="w-2.5 h-2.5 flex-shrink-0" />}
                                {isPresent && !needsShift && <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${STATUS_DOT[cell.status]}`} />}
                                {STATUS_LABEL[cell.status] ?? clockLabel(cell.checkIn)}
                                {MethodIcon && <MethodIcon className="w-2.5 h-2.5 flex-shrink-0 opacity-70" />}
                                {isMergedDuty && <Link2 className="w-2.5 h-2.5 flex-shrink-0 opacity-70" />}
                                {isSplitDay && <Layers className="w-2.5 h-2.5 flex-shrink-0 opacity-70" />}
                                {exceedsLastShift && <AlertTriangle className="w-2.5 h-2.5 flex-shrink-0 text-warning" />}
                                {cell.spilloverCheckout && (cell.status === 'absent' || cell.status === 'unscheduled') && (
                                  <CornerDownLeft className="w-2.5 h-2.5 flex-shrink-0 text-warning" />
                                )}
                              </div>
                            </td>
                          );
                        })}
                        <td className="border-b border-l-2 border-border px-2 py-2 text-center">
                          <Badge variant={totals && totals.lateMinutes > 0 ? 'destructive' : 'muted'} className="text-[10px] whitespace-nowrap">
                            {formatMinutes(totals?.lateMinutes ?? 0)}
                          </Badge>
                        </td>
                        <td className="border-b border-border px-2 py-2 text-center">
                          <Badge variant={totals && totals.earlyMinutes > 0 ? 'warning' : 'muted'} className="text-[10px] whitespace-nowrap">
                            {formatMinutes(totals?.earlyMinutes ?? 0)}
                          </Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {selected && selected.cell && (
        <CellDetailModal
          employee={selected.employee} dateStr={selected.dateStr} cell={selected.cell}
          holiday={selected.holiday} record={selected.record}
          assignments={selectedAssignments}
          assignableShifts={assignCtx?.shifts ?? []}
          assignDeptName={assignCtx?.dept?.name ?? null}
          canAssign={!!assignCtx?.dept}
          findOverlap={findOverlap}
          onAssignShift={handleAssignShift}
          onRemoveAssignment={handleRemoveAssignment}
          onJumpToDate={(d) => jumpToDate(selected.employee, d)}
          onClose={() => setSelectedRef(null)}
        />
      )}
    </div>
  );
}

// ─── Cell detail modal ────────────────────────────────────────────────────────────────────

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 border-b border-border/60 last:border-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-xs font-medium text-foreground text-right">{value}</span>
    </div>
  );
}

// Renders one punch (time + method icon + method label + optional device id) — shared by the
// block-level Check-in/Check-out rows and the itemized per-shift breakdown below, since a
// merged block's itemized first/last shift shows exactly the SAME actual punch as the block
// overall (there's only one real punch at each end of a merged sequence).
//
// `referenceDateStr` is the day this modal/cell is FOR — see dayOffsetFrom's own comment for
// why a bare time isn't enough once a session can cross midnight.
function PunchLabel({
  time, method, deviceId, referenceDateStr,
}: { time: Date | null; method: AttendanceMethod; deviceId?: string | null; referenceDateStr?: string }) {
  if (!time) return <span className="text-muted-foreground">—</span>;
  const Icon = METHOD_ICON[method];
  const dayOffset = referenceDateStr ? dayOffsetFrom(time, referenceDateStr) : 0;
  return (
    <span className="inline-flex items-center gap-1">
      {clockLabel(time)}
      {dayOffset !== 0 && (
        <span
          className="text-[10px] font-semibold text-warning"
          title={`This punch was recorded on ${localDateString(time)}, ${dayOffset > 0 ? `${dayOffset} day(s) after` : `${-dayOffset} day(s) before`} ${referenceDateStr}.`}
        >
          ({dayOffset > 0 ? `+${dayOffset}d` : `${dayOffset}d`})
        </span>
      )}
      <Icon className="w-3 h-3 opacity-70" />
      <span className="text-muted-foreground">({METHOD_LABEL[method]}{deviceId ? ` · ${deviceId}` : ''})</span>
    </span>
  );
}

function CellDetailModal({
  employee, dateStr, cell, holiday, record,
  assignments, assignableShifts, assignDeptName, canAssign, findOverlap, onAssignShift, onRemoveAssignment,
  onJumpToDate, onClose,
}: {
  employee: AppUser; dateStr: string; cell: DayCell; holiday: HolidayType | null; record: AttendanceRecord | null;
  assignments: ScheduleAssignment[];
  assignableShifts: Shift[];
  assignDeptName: string | null;
  canAssign: boolean;
  findOverlap: (shift: Shift) => ScheduleAssignment | null;
  onAssignShift: (shift: Shift) => Promise<void>;
  onRemoveAssignment: (assignment: ScheduleAssignment) => Promise<void>;
  onJumpToDate: (dateStr: string) => void;
  onClose: () => void;
}) {
  const [events, setEvents] = useState<FingerprintEventInfo[] | null>(null);
  // Shift id currently being assigned (null = idle) — disables the whole picker while a write
  // is in flight so a double-click can't create two rows.
  const [assigningId, setAssigningId] = useState<string | null>(null);
  // Assignment doc id currently being removed (null = idle).
  const [removingId, setRemovingId] = useState<string | null>(null);
  // Both fingerprint AND face scans land in the same fingerprint_attendance_events ledger
  // (see fingerprintApi.ts), so the Device ID lookup below fires for either. Falls back to the
  // cell-level method when there are no blocks yet (walk-in punches with no shift assigned) —
  // those still need the device id resolved so the raw-punch summary below can show it.
  const usesTerminalDevice = cell.blocks.length > 0
    ? cell.blocks.some(b =>
      b.checkInMethod === 'fingerprint' || b.checkOutMethod === 'fingerprint'
      || b.checkInMethod === 'face' || b.checkOutMethod === 'face')
    : cell.checkInMethod === 'fingerprint' || cell.checkOutMethod === 'fingerprint'
      || cell.checkInMethod === 'face' || cell.checkOutMethod === 'face';

  const doAssign = async (shift: Shift) => {
    setAssigningId(shift.id);
    try { await onAssignShift(shift); }
    finally { setAssigningId(null); }
  };

  const doRemove = async (assignment: ScheduleAssignment) => {
    setRemovingId(assignment.id);
    try { await onRemoveAssignment(assignment); }
    finally { setRemovingId(null); }
  };

  useEffect(() => {
    if (!record || !usesTerminalDevice) { setEvents(null); return; }
    let cancelled = false;
    getAttendanceFingerprintSource(record.id).then(rows => { if (!cancelled) setEvents(rows); }).catch(() => { if (!cancelled) setEvents([]); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record?.id, usesTerminalDevice]);

  // A split day can carry 2+ CHECK_IN/CHECK_OUT events under the same attendance_record_id
  // (one pair per shift) — matched to blocks in chronological order (device_timestamp
  // ascending), same pairing convention as sessions-to-blocks above.
  const checkInEvents = events?.filter(e => e.attendance_action === 'CHECK_IN')
    .sort((a, b) => String(a.device_timestamp).localeCompare(String(b.device_timestamp))) ?? [];
  const checkOutEvents = events?.filter(e => e.attendance_action === 'CHECK_OUT')
    .sort((a, b) => String(a.device_timestamp).localeCompare(String(b.device_timestamp))) ?? [];

  const isSplitDay = cell.blocks.length > 1;
  const totalShortfall = cell.lateMinutes + cell.earlyMinutes;

  return (
    <Dialog open onOpenChange={v => { if (!v) onClose(); }}>
      {/* Fixed-height shell: header and footer never move; only the middle content scrolls
          (relevant for a split day whose itemized breakdown can run tall). */}
      <DialogContent className="max-w-sm max-h-[90vh] p-0 gap-0 flex flex-col overflow-hidden">
        <DialogHeader className="flex-shrink-0 px-6 pt-6 pb-4">
          <DialogTitle className="flex items-center gap-2 flex-wrap">
            <span>{new Date(`${dateStr}T00:00:00`).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</span>
            <Badge variant={
              cell.status === 'leave' ? 'warning' : cell.status === 'dayoff' ? 'outline'
                : cell.status === 'absent' || cell.status === 'unscheduled' ? 'muted'
                : cell.status === 'late' ? 'destructive' : cell.status === 'early' ? 'warning' : 'success'
            } className="text-[10px] font-medium">
              {cell.status === 'leave' ? 'Leave' : cell.status === 'dayoff' ? 'Day Off'
                : cell.status === 'unscheduled' ? 'Unscheduled' : cell.status === 'absent' ? 'Absent'
                : cell.status === 'late' ? 'Present · Late' : cell.status === 'early' ? 'Present · Left early'
                : 'Present · On time'}
            </Badge>
          </DialogTitle>
          <DialogDescription>{employee.display_name} · {employee.epf_number}</DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-6 space-y-3">
          {cell.status === 'leave' && (
            <div className="space-y-1.5">
              {cell.leaves.map(l => (
                <div key={l.id} className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2">
                  <CalendarOff className="w-3.5 h-3.5 text-amber-600 flex-shrink-0 mt-0.5" />
                  <div className="min-w-0 text-xs">
                    <div className="flex items-center gap-1.5 flex-wrap font-medium text-foreground">
                      {l.leave_type_name}
                      <Badge variant={l.status === 'approved' ? 'success' : 'warning'} className="text-[9px] px-1.5 py-0 h-4 leading-none">{l.status}</Badge>
                      {l.is_half_day && (
                        <span className="text-muted-foreground font-normal">(half day{l.half_day_period ? ` · ${l.half_day_period}` : ''})</span>
                      )}
                    </div>
                    {l.reason && <div className="mt-0.5 text-muted-foreground truncate">{l.reason}</div>}
                  </div>
                </div>
              ))}
            </div>
          )}
          {cell.status === 'dayoff' && (
            <div className="flex items-start gap-2 rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-2">
              <Coffee className="w-3.5 h-3.5 text-sky-600 flex-shrink-0 mt-0.5" />
              <div className="min-w-0 text-xs">
                <div className="font-medium text-foreground">Day Off</div>
                {cell.dayOffs[0]?.reason && <div className="mt-0.5 text-muted-foreground truncate">{cell.dayOffs[0].reason}</div>}
              </div>
            </div>
          )}
          {cell.status === 'unscheduled' && (
            <div className="rounded-lg border border-dashed border-border/60 bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
              Unscheduled — no shift was assigned to {employee.display_name} on this date.
            </div>
          )}
          {cell.status === 'absent' && (
            <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
              Absent — a shift was scheduled, but no check-in was recorded.
            </div>
          )}
          {cell.spilloverCheckout && (
            <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2">
              <CornerDownLeft className="w-3.5 h-3.5 text-warning flex-shrink-0 mt-0.5" />
              <div className="min-w-0 text-xs">
                <div className="font-semibold text-foreground">
                  Checked out at {clockLabel(cell.spilloverCheckout.time)} this morning
                </div>
                <div className="text-muted-foreground">
                  This closed a session that began on{' '}
                  {new Date(`${cell.spilloverCheckout.fromDate}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  {' '}— the full check-in/check-out record lives on that day, not this one.
                </div>
                <Button
                  type="button" variant="link" size="sm" className="h-auto p-0 mt-1 text-xs"
                  onClick={() => onJumpToDate(cell.spilloverCheckout!.fromDate)}
                >
                  View {new Date(`${cell.spilloverCheckout.fromDate}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} →
                </Button>
              </div>
            </div>
          )}
          {isSplitDay && (
            <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
              <Layers className="w-3.5 h-3.5 text-foreground flex-shrink-0 mt-0.5" />
              <div className="text-[11px] text-foreground">
                <div className="font-semibold">{cell.blocks.length} Separate Shift Cycles Today</div>
                <div className="text-muted-foreground">These shifts are not back-to-back — each is checked independently against its own punch, and the gap between them is never counted as working time.</div>
              </div>
            </div>
          )}
          {cell.checkOutOverrunMinutes > 0 && (
            <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2">
              <AlertTriangle className="w-3.5 h-3.5 text-warning flex-shrink-0 mt-0.5" />
              <div className="min-w-0 text-xs">
                <div className="font-semibold text-foreground">Checked out {formatMinutes(cell.checkOutOverrunMinutes)} after the last shift ended</div>
                <div className="text-muted-foreground">The actual check-out runs past the last scheduled shift's end time — often means the assigned shift(s) don't cover the full punch. Review the shift assignment below.</div>
              </div>
            </div>
          )}

          {holiday && (
            <div className="text-[11px] rounded-lg px-3 py-2" style={{ background: 'rgba(167,139,250,0.08)', color: '#a78bfa' }}>
              {HOLIDAY_LABELS[holiday]}
            </div>
          )}

          {/* Skipped for leave/dayoff/unscheduled — their own banner above already says this;
              still shown for a walk-in Present day (checked in with no shift assigned). */}
          {cell.blocks.length === 0 && cell.status !== 'leave' && cell.status !== 'dayoff' && cell.status !== 'unscheduled' && (
            <p className="text-xs text-muted-foreground">
              No shift is scheduled for this day{cell.checkIn ? ' — the punches below aren’t being scored against anything yet' : ''}.
            </p>
          )}

          {/* No shift block exists yet to hang these under (see above), but the raw punches are
              exactly what decides which shift to assign — show them plainly rather than making
              the assigner guess from the compact grid cell. Earliest check-in / latest check-out
              that day, same pairing DayCell itself uses for the grid (see its comment). */}
          {cell.blocks.length === 0 && cell.checkIn && (
            <div className="space-y-1.5 rounded-lg border border-border/60 p-2.5">
              <DetailRow label="Check-in" value={<PunchLabel time={cell.checkIn} method={cell.checkInMethod} deviceId={checkInEvents[0]?.device_id} referenceDateStr={dateStr} />} />
              <DetailRow label="Check-out" value={cell.checkOut ? <PunchLabel time={cell.checkOut} method={cell.checkOutMethod} deviceId={checkOutEvents[checkOutEvents.length - 1]?.device_id} referenceDateStr={dateStr} /> : 'No check-out'} />
            </div>
          )}

          {/* Every raw ScheduleAssignment on this cell, each individually removable — the same
              write (and same soft-delete) the Schedule page's own cell dialog makes. Listed
              separately from the block-level punch breakdown below since a back-to-back merged
              block can collapse 2+ of these into one block. */}
          {assignments.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Assigned</div>
              <div className="space-y-1.5">
                {assignments.map(a => (
                  <div key={a.id} className="flex items-center justify-between gap-2 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2">
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-foreground truncate">{a.shift_name}</span>
                      <span className="block text-[11px] text-muted-foreground">{a.start_time || '—'} – {a.end_time || '—'}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => doRemove(a)}
                      disabled={removingId !== null}
                      aria-label={`Remove ${a.shift_name}`}
                      className="rounded-full p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50 flex-shrink-0"
                    >
                      {removingId === a.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Quick shift assignment — retro-assign a shift template so this day's punches get
              scored (Late/Early, and the monthly totals). Same write the Schedule page's cell
              dialog makes (createScheduleAssignment); the grid refreshes without a reload. An
              overlapping shift is hard-blocked, same as the Schedule page — its button is
              disabled outright, no "assign anyway". */}
          {(cell.blocks.length === 0 || assignableShifts.length > 0) && (
            <div className="space-y-1.5 rounded-lg border border-dashed border-border/60 p-2.5">
              <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                {cell.blocks.length === 0 ? 'Assign a shift' : 'Add another shift'}
              </div>
              {!canAssign ? (
                <p className="text-[11px] text-warning">
                  Couldn’t resolve {employee.display_name}’s department — assign this shift from the Schedule page instead.
                </p>
              ) : assignableShifts.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">
                  No shift templates are available for {assignDeptName ?? 'this department'} — create one under Shifts first.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {assignableShifts.map(s => {
                    // Flagged inline, before it's even clicked — an overlapping shift's button
                    // is disabled outright; doAssign's own overlap check (via onAssignShift) is
                    // just the belt-and-braces backstop. Two-row layout (name+time on top, the
                    // warning wrapped naturally underneath) so the warning text is never clipped
                    // or squeezed against the right-aligned time.
                    const overlap = findOverlap(s);
                    return (
                      <button
                        key={s.id}
                        type="button"
                        disabled={assigningId !== null || !!overlap}
                        onClick={() => doAssign(s)}
                        title={overlap ? `Overlaps ${overlap.shift_name} (${overlap.start_time || '—'} – ${overlap.end_time || '—'}) — overlapping shifts cannot be assigned` : undefined}
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
                            ) : assigningId === s.id ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin flex-shrink-0 text-primary" />
                            ) : (
                              <Plus className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                            )}
                            <span className="text-sm font-medium text-foreground truncate">{s.name}</span>
                          </span>
                          <span className="text-[11px] text-muted-foreground flex-shrink-0">
                            {(s.start_time || '—')} – {(s.end_time || '—')}
                          </span>
                        </span>
                        {overlap && (
                          <span className="block text-[10px] text-destructive leading-snug whitespace-normal break-words pl-[22px]">
                            Overlaps {overlap.shift_name} ({overlap.start_time || '—'} – {overlap.end_time || '—'}) — overlapping shifts cannot be assigned
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {cell.blocks.map((b, i) => {
            const isMergedDuty = b.shifts.length > 1;
            const checkInEvent = checkInEvents[i] ?? null;
            const checkOutEvent = checkOutEvents[i] ?? null;
            return (
              <div key={i} className="space-y-1.5 rounded-lg border border-border/60 p-2.5">
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                    {isSplitDay ? `Shift ${i + 1} · ` : ''}{b.shiftNames.join(' + ')}
                  </span>
                  {isMergedDuty && <Link2 className="w-3 h-3 text-brand flex-shrink-0" />}
                </div>

                {/* Overall anchors for this block — for a merged sequence this is the FIRST
                    shift's scheduled start / actual check-in and the LAST shift's scheduled
                    end / actual check-out; for a plain single shift it's just that one shift. */}
                <DetailRow label="Scheduled" value={`${formatScheduledClock(b.scheduledStartMin)} – ${formatScheduledClock(b.scheduledEndMin)}`} />
                <DetailRow label="Check-in" value={b.checkIn ? <PunchLabel time={b.checkIn} method={b.checkInMethod} deviceId={checkInEvent?.device_id} referenceDateStr={dateStr} /> : 'No check-in'} />
                <DetailRow label="Check-out" value={b.checkOut ? <PunchLabel time={b.checkOut} method={b.checkOutMethod} deviceId={checkOutEvent?.device_id} referenceDateStr={dateStr} /> : (b.checkIn ? 'No check-out' : '—')} />
                <DetailRow label="Late minutes" value={<Badge variant={b.lateMinutes > 0 ? 'destructive' : 'muted'}>{formatMinutes(b.lateMinutes)}</Badge>} />
                <DetailRow label="Early departure minutes" value={<Badge variant={b.earlyMinutes > 0 ? 'warning' : 'muted'}>{formatMinutes(b.earlyMinutes)}</Badge>} />

                {isMergedDuty && (
                  <div className="pt-1.5 mt-1 border-t border-border/40 space-y-1.5">
                    <div className="flex items-start gap-1.5 text-[10px] text-muted-foreground">
                      <Link2 className="w-3 h-3 text-brand flex-shrink-0 mt-0.5" />
                      <span>Continuous Shift Sequence (Merged Duty) — treated as one block: the FIRST shift's start is the check-in anchor, the LAST shift's end is the check-out anchor. Itemized below.</span>
                    </div>
                    <div className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider">Shift-by-Shift Breakdown</div>
                    <div className="space-y-1.5">
                      {b.shifts.map((shift, j) => {
                        const isFirst = j === 0;
                        const isLast = j === b.shifts.length - 1;
                        return (
                          <div key={j} className="rounded-md bg-muted/40 px-2 py-1.5 space-y-1">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-[11px] font-medium text-foreground">{shift.name}</span>
                              <span className="text-[10px] text-muted-foreground whitespace-nowrap">{formatScheduledClock(shift.scheduledStartMin)} – {formatScheduledClock(shift.scheduledEndMin)}</span>
                            </div>
                            {isFirst && (
                              <div className="flex items-center justify-between gap-2 text-[10px]">
                                <span className="text-muted-foreground">Check-in</span>
                                <span className="font-medium text-foreground">{b.checkIn ? <PunchLabel time={b.checkIn} method={b.checkInMethod} deviceId={checkInEvent?.device_id} /> : 'No check-in'}</span>
                              </div>
                            )}
                            {isLast && (
                              <div className="flex items-center justify-between gap-2 text-[10px]">
                                <span className="text-muted-foreground">Check-out</span>
                                <span className="font-medium text-foreground">{b.checkOut ? <PunchLabel time={b.checkOut} method={b.checkOutMethod} deviceId={checkOutEvent?.device_id} /> : 'No check-out'}</span>
                              </div>
                            )}
                            {!isFirst && !isLast && (
                              <p className="text-[10px] text-muted-foreground italic">Pass-through — no punch required (continuous with adjacent shifts).</p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {usesTerminalDevice && events === null && <p className="text-[10px] text-muted-foreground">Looking up device ID…</p>}

          <div className="pb-3">
            <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">Day Total</div>
            <DetailRow label="Total shortfall" value={<Badge variant={totalShortfall > 0 ? 'destructive' : 'success'}>{formatMinutes(totalShortfall)}</Badge>} />
          </div>
        </div>

        {/* Sticky footer — stays visible under the scrolling body above, same as the header. */}
        <div className="flex-shrink-0 flex justify-end px-6 py-4 border-t border-border">
          <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
