// What the PersonDossier is allowed to show, and how each block gets its data.
//
// Two rules hold this file together:
//   1. A block is visible only when the VIEWER's capabilities allow it AND the tenant has the
//      module switched on. A block the viewer may not see is absent — never a locked box.
//   2. Every loader is independent. One failing read must cost its own block and nothing else,
//      so nothing here throws across block boundaries and the caller settles them separately.
import type { RoleCapabilities } from '@/lib/permissions';
import type { TenantFeatures } from '@/lib/tenants';
import type {
  AppUser, LeaveRecord, LeaveType, ScheduleAssignment, DayOff, LunchRequest,
  SuspenseAccount, SuspenseSubmission, AttendanceRecord,
} from '@/lib/types';
import type { PayrollEmployee, PayrollLoan, PayrollSalaryAdvance } from '@/lib/payrollTypes';
import type { IndicativeRate } from '@/lib/foodReport';
import { type WorkItem, toWorkItem, assignedTaskToWorkItem } from '@/lib/workItem';
import { localDateString } from '@/lib/utils';
import { mealOf, type MealType } from '@/lib/meals';

import { getUserByEpf } from '@/services/userService';
import { getMonthlyAttendance, getEmployeeAttendanceHistory } from '@/services/attendanceService';
import { computeWorkedHours } from '@/services/taskService';
import { getLeaveBalance, getLeaveTypes, getMyLeaves } from '@/services/leaveService';
import { _leaveApi as leaveApi } from '@/services/apiCompat';
import { getMonthlyTasks } from '@/services/taskService';
import { getMyAssignedTasks } from '@/services/assignedTaskService';
import { getScheduleAssignmentsForEmployee } from '@/services/scheduleAssignmentService';
import { getDayOffsForEmployee } from '@/services/dayOffService';
import { getUserAccounts, getMySubmissions } from '@/services/suspenseService';
import { getMyMealsThisMonth } from '@/services/mealService';
import { loadIndicativeRate } from '@/components/lunch/MyLunchCount';
import { getPayrollEmployee } from '@/services/payrollEmployeeService';
import { getActiveLoansForEmployee } from '@/services/payrollLoanService';
import { getSalaryAdvancesForEmployee } from '@/services/payrollSalaryAdvanceService';

// ── Which blocks this viewer gets ───────────────────────────────────────────────────────────
export type DossierBlockId =
  | 'identity' | 'attendance' | 'leave' | 'tasks' | 'schedule' | 'suspense' | 'food' | 'payroll' | 'links';

/** Pure: viewer capabilities + tenant modules → the blocks to render, in reading order.
 *  Identity and Quick links need no capability beyond reaching this page at all. */
export function visibleDossierBlocks(caps: RoleCapabilities, f: TenantFeatures): DossierBlockId[] {
  const admin = caps.is_system_admin;
  const ids: DossierBlockId[] = ['identity'];
  if (admin || caps.can_view_attendance || caps.can_report || caps.can_manage_users) ids.push('attendance');
  if (admin || caps.can_approve_leaves || caps.can_manage_leaves || caps.can_report) ids.push('leave');
  if (admin || caps.can_view_team_tasks) ids.push('tasks');
  if (f.schedule && (admin || caps.can_view_schedules || caps.can_manage_schedules)) ids.push('schedule');
  // Food rides on the same approver capability as the float it is deducted from. It also needs
  // `chamary` on top of `suspense` — that is the pair MODULE_ROUTES demands for /chamary, and
  // the meal records this block reads only exist where that subsystem is switched on.
  if (f.suspense && (admin || caps.can_approve_suspense)) {
    ids.push('suspense');
    if (f.chamary) ids.push('food');
  }
  if (f.payroll && (admin || caps.can_view_payroll)) ids.push('payroll');
  ids.push('links');
  return ids;
}

export interface DossierCtx { epf: string; year: number; month: number; day: string }

const monthPrefix = (year: number, month: number) => `${year}-${String(month).padStart(2, '0')}`;
const ms = (t: { toMillis?: () => number } | null | undefined): number => t?.toMillis?.() ?? 0;

// ── 1. Identity ─────────────────────────────────────────────────────────────────────────────
export interface IdentityData { user: AppUser | null; supervisorName: string | null }

export async function loadIdentity({ epf }: DossierCtx): Promise<IdentityData> {
  const user = await getUserByEpf(epf);
  // The supervisor is stored as an EPF; resolving the name is a nicety, never a reason to fail
  // the block that carries everything else about the person.
  const supervisor = user?.supervisor_epf
    ? await getUserByEpf(user.supervisor_epf).catch(() => null)
    : null;
  return { user, supervisorName: supervisor?.display_name ?? user?.supervisor_epf ?? null };
}

// ── 2. Attendance ───────────────────────────────────────────────────────────────────────────
export interface AttendanceData {
  workedDays: number; totalHours: number; avgHours: number;
  hoursByDate: Record<string, number>;
  pendingDays: number;      // days still waiting on an approval decision
  records?: AttendanceRecord[];
  // Yearly aggregations for the selected year
  yearWorkedDays: number;
  yearTotalHours: number;
  yearAvgHours: number;
  yearHoursByMonth: number[]; // 12 numbers for Jan..Dec (0..11)
  yearDaysByMonth: number[];  // 12 numbers for Jan..Dec (0..11)
}

export async function loadAttendance({ epf, year, month }: DossierCtx): Promise<AttendanceData> {
  const allRecs = await getEmployeeAttendanceHistory(epf).catch(() => []);
  const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;
  const yearPrefix = `${year}-`;

  const monthRecs = allRecs.filter(r => typeof r.date === 'string' && r.date.startsWith(monthPrefix));
  const yearRecs = allRecs.filter(r => typeof r.date === 'string' && r.date.startsWith(yearPrefix));

  // Monthly stats
  const hoursByDate: Record<string, number> = {};
  let totalHours = 0, workedDays = 0, pendingDays = 0;
  for (const r of monthRecs) {
    const h = computeWorkedHours(r);
    hoursByDate[r.date] = h;
    // A day counts as worked when it has a check-in, even if the hours total 0 because the
    // check-out never landed — otherwise a month of missing check-outs reads as no work at all.
    const hasIn = (r.sessions ?? []).some(s => s.check_in) || !!r.check_in;
    if (hasIn) workedDays += 1;
    totalHours += h;
    if (r.check_in_status === 'pending' || r.check_out_status === 'pending') pendingDays += 1;
  }
  totalHours = Math.round(totalHours * 10) / 10;

  // Yearly stats across all 12 months
  const yearHoursByMonth = Array(12).fill(0);
  const yearDaysByMonth = Array(12).fill(0);
  let yearTotalHours = 0, yearWorkedDays = 0;
  for (const r of yearRecs) {
    const h = computeWorkedHours(r);
    const mIdx = Number(r.date.slice(5, 7)) - 1;
    if (mIdx >= 0 && mIdx < 12) {
      yearHoursByMonth[mIdx] = Math.round((yearHoursByMonth[mIdx] + h) * 10) / 10;
      const hasIn = (r.sessions ?? []).some(s => s.check_in) || !!r.check_in;
      if (hasIn) {
        yearDaysByMonth[mIdx] += 1;
        yearWorkedDays += 1;
      }
    }
    yearTotalHours += h;
  }
  yearTotalHours = Math.round(yearTotalHours * 10) / 10;

  return {
    workedDays, totalHours, pendingDays, hoursByDate,
    records: monthRecs,
    avgHours: workedDays ? Math.round((totalHours / workedDays) * 10) / 10 : 0,
    yearWorkedDays,
    yearTotalHours,
    yearAvgHours: yearWorkedDays ? Math.round((yearTotalHours / yearWorkedDays) * 10) / 10 : 0,
    yearHoursByMonth,
    yearDaysByMonth,
  };
}

// ── 3. Leave ────────────────────────────────────────────────────────────────────────────────
export interface LeaveBalanceRow {
  typeId: string;
  typeName: string;
  remaining: number;
  total?: number;
  used?: number;
}
export interface LeaveData {
  balances: LeaveBalanceRow[];
  /** Types that are tracked but carry no entitlement (LeaveType.excluded_from_quota) — days
   *  TAKEN, never a balance. Kept out of `balances` so nothing that reads a remaining figure
   *  off that list can reach them. */
  takenOnly: { typeName: string; taken: number }[];
  daysTakenThisYear: number;
  upcoming: LeaveRecord[];
  pending: LeaveRecord[];
  approved?: LeaveRecord[];
}

/** Inclusive CALENDAR days a leave record spans (half day = 0.5). Deliberately not the
 *  entitlement engine's working-day count — that one drops Saturdays, holidays and rest days
 *  and lives in the leave balance itself. Labelled "calendar days" in the UI for that reason. */
function leaveCalendarDays(l: LeaveRecord): number {
  if (l.is_half_day) return 0.5;
  const a = Date.parse(`${String(l.from_date).slice(0, 10)}T00:00:00`);
  const b = Date.parse(`${String(l.to_date).slice(0, 10)}T00:00:00`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
  return Math.round((b - a) / 86_400_000) + 1;
}

export async function loadLeave({ epf, year }: DossierCtx): Promise<LeaveData> {
  const [summaryRes, balance, types, leaves] = await Promise.all([
    // getLeaveSummary is the single source of truth across the app (calculates quota - approved leaves).
    leaveApi.getLeaveSummary(epf).catch(() => null),
    // Fallback: legacy leave_balances collection if present.
    getLeaveBalance(epf, year).catch(() => null),
    getLeaveTypes().catch(() => [] as LeaveType[]),
    getMyLeaves(epf).catch(() => [] as LeaveRecord[]),
  ]);
  const nameOf = new Map(types.map(t => [t.id, t.name]));

  let balances: LeaveBalanceRow[] = [];
  const summaryRows = (summaryRes as any)?.data?.data;
  // The tracked-but-not-entitled types ride on the summary array as an attached prop. Read
  // BEFORE the branch below: a tenant whose every type is one of these has an empty row array,
  // drops through to the fallback, and would otherwise lose them silently.
  let takenOnly: { typeName: string; taken: number }[] =
    Array.isArray((summaryRows as any)?.excluded_leave_types)
      ? (summaryRows as any).excluded_leave_types
          .map((r: any) => ({
            typeName: String(r?.leave_type ?? r?.type ?? ''),
            taken:    Math.round((Number(r?.taken) || 0) * 2) / 2,
          }))
          .filter((r: { typeName: string }) => r.typeName)
      : [];
  if (Array.isArray(summaryRows) && summaryRows.length > 0) {
    balances = summaryRows.map((r: any, idx: number) => {
      const typeName = String(r.leave_type ?? r.type ?? `Type ${idx + 1}`);
      const matched = types.find(t => t.name.trim().toLowerCase() === typeName.trim().toLowerCase());
      return {
        typeId: matched?.id ?? `summary_${idx}`,
        typeName,
        remaining: Math.round((Number(r.remaining) || 0) * 2) / 2,
        total: r.total != null ? Math.round((Number(r.total) || 0) * 2) / 2 : undefined,
        used: r.used != null ? Math.round((Number(r.used) || 0) * 2) / 2 : undefined,
      };
    }).sort((a, b) => a.typeName.localeCompare(b.typeName));
  } else if (balance?.balances && Object.keys(balance.balances).length > 0) {
    balances = Object.entries(balance.balances)
      .map(([typeId, remaining]) => ({
        typeId,
        typeName: nameOf.get(typeId) ?? typeId,
        remaining: Number(remaining) || 0,
      }))
      .sort((a, b) => a.typeName.localeCompare(b.typeName));
  } else if (types.length > 0) {
    // Graceful calculation fallback if summary was unavailable and no legacy document exists
    const liveApproved = leaves.filter(l => !l.is_deleted && l.status === 'approved' && String(l.from_date).slice(0, 4) === String(year));
    const daysOn = (t: LeaveType): number => liveApproved
      .filter(l => l.leave_type_id === t.id || l.leave_type_name === t.name)
      .reduce((sum, l) => sum + leaveCalendarDays(l), 0);
    // Only if the summary didn't already supply them — this arm runs when that read failed.
    if (takenOnly.length === 0) {
      takenOnly = types
        .filter(t => t.is_active !== false && t.excluded_from_quota === true)
        .map(t => ({ typeName: t.name, taken: Math.round(daysOn(t) * 10) / 10 }))
        .sort((a, b) => a.typeName.localeCompare(b.typeName));
    }
    // A non-entitlement type has no quota to subtract from, so it can never be a balance row —
    // the same rule getLeaveSummary applies, kept here so the fallback doesn't reintroduce the
    // quota this whole change exists to remove.
    balances = types.filter(t => t.is_active !== false && t.excluded_from_quota !== true).map(t => {
      const quota = t.annual_quota ?? 0;
      const used = daysOn(t);
      return {
        typeId: t.id,
        typeName: t.name,
        remaining: Math.max(0, quota - used),
        total: quota,
        used,
      };
    }).sort((a, b) => a.typeName.localeCompare(b.typeName));
  }

  const today = localDateString();
  const live = leaves.filter(l => !l.is_deleted);
  return {
    balances,
    takenOnly,
    daysTakenThisYear: Math.round(live
      .filter(l => l.status === 'approved' && String(l.from_date).slice(0, 4) === String(year))
      .reduce((sum, l) => sum + leaveCalendarDays(l), 0) * 10) / 10,
    upcoming: live.filter(l => l.status === 'approved' && String(l.to_date).slice(0, 10) >= today)
      .sort((a, b) => a.from_date.localeCompare(b.from_date)).slice(0, 5),
    pending: live.filter(l => l.status === 'pending')
      .sort((a, b) => a.from_date.localeCompare(b.from_date)).slice(0, 5),
    approved: live.filter(l => l.status === 'approved'),
  };
}

// ── 4. Tasks ────────────────────────────────────────────────────────────────────────────────
export interface TaskData { open: number; overdue: number; recent: WorkItem[] }

export async function loadTasks({ epf, year, month }: DossierCtx): Promise<TaskData> {
  const [daily, assigned] = await Promise.all([
    // Caught for the same reason as the leave balance: half a block is worth more to the
    // reader than an error where a block used to be.
    getMonthlyTasks(epf, year, month).catch(() => []),
    // Default window: the last 30 days up to today — the same one the person's own board uses.
    getMyAssignedTasks(epf).catch(() => []),
  ]);
  const items = [...daily.map(toWorkItem), ...assigned.map(assignedTaskToWorkItem)];
  const today = localDateString();
  const open = items.filter(i => i.status !== 'Completed');
  return {
    open: open.length,
    overdue: open.filter(i => i.date < today).length,
    recent: [...items].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6),
  };
}

// ── 5. Schedule / shifts ────────────────────────────────────────────────────────────────────
export interface ScheduleData { shifts: ScheduleAssignment[]; dayOffs: DayOff[] }

export async function loadSchedule({ epf, year, month }: DossierCtx): Promise<ScheduleData> {
  const prefix = monthPrefix(year, month);
  const [shifts, dayOffs] = await Promise.all([
    getScheduleAssignmentsForEmployee(epf).catch(() => [] as ScheduleAssignment[]),
    getDayOffsForEmployee(epf).catch(() => [] as DayOff[]),
  ]);
  return {
    shifts: shifts.filter(s => typeof s.date === 'string' && s.date.startsWith(prefix)),
    dayOffs: dayOffs.filter(d => typeof d.date === 'string' && d.date.startsWith(prefix)),
  };
}

// ── 6. Suspense float ───────────────────────────────────────────────────────────────────────
export interface SuspenseData {
  accounts: SuspenseAccount[];
  spentThisMonth: number;
  pendingBills: SuspenseSubmission[];
  currency: string;
}

export async function loadSuspense({ epf, year, month }: DossierCtx): Promise<SuspenseData> {
  const [accounts, subs] = await Promise.all([getUserAccounts(epf), getMySubmissions(epf)]);
  const from = new Date(year, month - 1, 1).getTime();
  const to = new Date(year, month, 1).getTime() - 1;
  // bill_date is when the bill was ISSUED and is what the money reports key off; it is absent on
  // submissions written before that field existed, so fall back to created_at exactly as the
  // suspense pages do.
  const inMonth = (s: SuspenseSubmission) => {
    const at = ms(s.bill_date) || ms(s.created_at);
    return at >= from && at <= to;
  };
  return {
    accounts,
    currency: accounts[0]?.currency ?? 'LKR',
    spentThisMonth: subs.filter(s => s.status === 'approved' && inMonth(s)).reduce((t, s) => t + (s.amount || 0), 0),
    pendingBills: subs.filter(s => s.status === 'pending').slice(0, 5),
  };
}

// ── 7. Food ─────────────────────────────────────────────────────────────────────────────────
export interface FoodData {
  counts: Record<MealType, number>;
  total: number;
  /** Indicative cost of this month's meals, or null when no chamary has a closed month to
   *  price from. Never priced off the running month — see indicativeMealRate. */
  likelyCost: number | null;
  ratedMeals: number;   // how many of `total` the estimate actually covers
}

export async function loadFood({ epf, year, month }: DossierCtx): Promise<FoodData> {
  const meals: LunchRequest[] = await getMyMealsThisMonth(epf, year, month);
  const counts: Record<MealType, number> = { breakfast: 0, lunch: 0, dinner: 0 };
  meals.forEach(m => { counts[mealOf(m.meal)] += 1; });

  const chamaryIds = Array.from(new Set(meals.map(m => m.chamary_id).filter(Boolean)));
  const ref = new Date(year, month - 1, 1);
  const rates = new Map<string, IndicativeRate>();
  await Promise.all(chamaryIds.map(async id => {
    try { rates.set(id, await loadIndicativeRate(id, ref)); } catch { /* priced as unknown */ }
  }));

  let likelyCost = 0, ratedMeals = 0;
  for (const m of meals) {
    const rate = rates.get(m.chamary_id)?.ratePerMeal;
    if (rate == null) continue;
    likelyCost += rate;
    ratedMeals += 1;
  }
  return {
    counts, total: meals.length, ratedMeals,
    likelyCost: ratedMeals ? Math.round(likelyCost) : null,
  };
}

// ── 8. Payroll ──────────────────────────────────────────────────────────────────────────────
export interface PayrollData {
  hasProfile: boolean;
  profile: PayrollEmployee | null;
  loans: PayrollLoan[];
  loanOutstanding: number;
  advances: PayrollSalaryAdvance[];   // still to be recovered
  advanceOutstanding: number;
}

export async function loadPayroll({ epf }: DossierCtx): Promise<PayrollData> {
  const [profile, loans, advances] = await Promise.all([
    getPayrollEmployee(epf).catch(() => null),
    getActiveLoansForEmployee(epf).catch(() => [] as PayrollLoan[]),
    getSalaryAdvancesForEmployee(epf).catch(() => [] as PayrollSalaryAdvance[]),
  ]);
  const openAdvances = advances.filter(a => a.status === 'pending');
  return {
    profile, hasProfile: !!profile, loans,
    loanOutstanding: loans.reduce((t, l) => t + (l.current_balance || 0), 0),
    advances: openAdvances,
    advanceOutstanding: openAdvances.reduce((t, a) => t + (a.amount || 0), 0),
  };
}
