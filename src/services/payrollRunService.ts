// Payroll run lifecycle: open a run, populate its Bulk Sheet rows (payroll_monthly_entries)
// from the active employee list, and read/patch those rows directly (Direct Monthly Input —
// no attendance-sync dependency). Advancing a run past 'draft'/'generated' happens
// exclusively through the generate/review/finalize Admin-SDK API routes (see firestore.rules:
// payroll_runs blocks a client write that sets status to 'reviewed'/'finalized').

import {
  collection, doc, getDoc, getDocs, setDoc, updateDoc, query, where, writeBatch, Timestamp,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import type { PayrollRun, PayrollMonthlyEntry, PayrollOneOffLine } from '@/lib/payrollTypes';
import { emptyMonthlyEntry } from '@/lib/payrollTypes';
import type { ScheduleAssignment } from '@/lib/types';
import { epfDocId, getAllEmployees } from '@/services/userService';
import { getActivePayrollEmployees } from '@/services/payrollEmployeeService';
import { writePayrollAudit } from '@/services/payrollAuditService';
import { getDepartments } from '@/services/departmentService';
import { getScheduleAssignmentsForDepartment } from '@/services/scheduleAssignmentService';
import { getPayrollSettings } from '@/services/payrollSettingsService';
import { mergeShiftBlocks } from '@/lib/attendanceShortfallEngine';
import { getOtRequestsForPeriod, OT_REQUESTS_COL } from '@/services/otRequestService';
import {
  type OtRequest, type ApprovedOtByType, emptyApprovedOt,
  OT_TYPES, OT_TYPE_TO_ENTRY_FIELD, OT_TYPE_TO_SYNC_FIELD,
} from '@/types/otRequest';
import { getCompanyAttendanceForMonth } from '@/services/attendanceService';
import { getDayOffsForRange } from '@/services/dayOffService';
import { computeRosterCoverageGaps, type RosterCoverageGap } from '@/lib/rosterCoverage';

const RUN_COL = 'payroll_runs';
const ENTRY_COL = 'payroll_monthly_entries';

function runDocId(companyId: string, year: number, month: number): string {
  return `${companyId}_${year}_${String(month).padStart(2, '0')}`;
}

export async function getPayrollRun(runId: string): Promise<PayrollRun | null> {
  const snap = await getDoc(doc(db, RUN_COL, runId));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() } as PayrollRun;
}

export async function getPayrollRunsForCompany(companyId: string): Promise<PayrollRun[]> {
  const snap = await getDocs(query(collection(db, RUN_COL), where('company_id', '==', companyId)));
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() } as PayrollRun))
    .sort((a, b) => (b.year - a.year) || (b.month - a.month));
}

/** Creates the run doc if it doesn't exist yet (status 'draft'); returns its id either way. */
export async function getOrCreatePayrollRun(opts: {
  companyId: string; companyName: string; year: number; month: number;
  actorEpf: string; actorName: string;
}): Promise<string> {
  const { companyId, companyName, year, month, actorEpf, actorName } = opts;
  const id = runDocId(companyId, year, month);
  const ref = doc(db, RUN_COL, id);
  const existing = await getDoc(ref);
  if (existing.exists()) return id;

  const now = Timestamp.now();
  await setDoc(ref, {
    company_id: companyId, company_name: companyName,
    year, month,
    status: 'draft', employee_count: 0,
    generated_at: null, generated_by_epf: null, generated_by_name: null,
    reviewed_at: null, reviewed_by_epf: null, reviewed_by_name: null,
    finalized_at: null, finalized_by_epf: null, finalized_by_name: null,
    created_by_epf: actorEpf, created_at: now, updated_at: now,
  } satisfies Omit<PayrollRun, 'id'>);

  await writePayrollAudit({
    company_id: companyId, action: 'RUN_CREATED', entity_type: 'payroll_run', entity_id: id,
    performed_by_epf: actorEpf, performed_by_name: actorName,
  });
  return id;
}

export async function getMonthlyEntriesForRun(runId: string): Promise<PayrollMonthlyEntry[]> {
  const snap = await getDocs(query(collection(db, ENTRY_COL), where('run_id', '==', runId)));
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() } as PayrollMonthlyEntry))
    .sort((a, b) => a.employee_name.localeCompare(b.employee_name));
}

/**
 * Adds a Bulk Sheet row for each given employee — creates a zeroed default row for anyone
 * missing one; leaves existing rows (and any figures already typed in) untouched. Backs all
 * 5 "Load Employees" selection modes (Single/Multiple/By Department/By Designation/All
 * Active) — the caller resolves the target list, this just makes it so. Idempotent and
 * re-runnable, so loading overlapping selections (e.g. a department, then a couple more
 * people individually) never overwrites anything already entered.
 */
export async function addEmployeesToRun(
  runId: string,
  employees: { epf_number: string; employee_name: string }[],
  actorEpf: string,
): Promise<{ added: number; alreadyPresent: number }> {
  const run = await getPayrollRun(runId);
  if (!run) throw new Error('Payroll run not found.');
  // 'reviewed' stays editable — the run only truly locks at Finalize (see generate/route.ts's
  // matching guard).
  if (run.status !== 'draft' && run.status !== 'generated' && run.status !== 'reviewed') {
    throw new Error(`Employees cannot be added to a ${run.status} run.`);
  }

  const existing = await getMonthlyEntriesForRun(runId);
  const existingEpfs = new Set(existing.map(e => e.epf_number));

  const batch = writeBatch(db);
  let added = 0;
  for (const emp of employees) {
    if (existingEpfs.has(emp.epf_number)) continue;
    const id = `${runId}__${epfDocId(emp.epf_number)}`;
    batch.set(doc(db, ENTRY_COL, id), emptyMonthlyEntry(runId, run.company_id, emp.epf_number, emp.employee_name));
    added++;
  }
  if (added > 0) {
    await batch.commit();
    await updateDoc(doc(db, RUN_COL, runId), {
      employee_count: existing.length + added,
      updated_at: Timestamp.now(),
    });
  }
  return { added, alreadyPresent: employees.length - added };
}

/** Mode 5 — every active payroll employee in this company. */
export async function addAllActiveEmployeesToRun(runId: string, actorEpf: string): Promise<{ added: number; alreadyPresent: number }> {
  const run = await getPayrollRun(runId);
  if (!run) throw new Error('Payroll run not found.');
  const employees = await getActivePayrollEmployees(run.company_id);
  return addEmployeesToRun(runId, employees.map(e => ({ epf_number: e.epf_number, employee_name: e.employee_name })), actorEpf);
}

/** Patches one row's editable fields. `locked` is a soft, informational control — it does
 *  not block Generate. */
export async function updateMonthlyEntry(
  entryId: string,
  patch: Partial<Pick<PayrollMonthlyEntry,
    'ot_hours_normal' | 'ot_hours_double' | 'no_pay_hours' | 'no_pay_days' | 'hours_per_day'
    | 'total_hours' | 'ph_hours_normal' | 'ph_hours_overtime' | 'ph_days'
    | 'poya_hours_normal' | 'poya_days' | 'poya_hours_overtime'
    | 'mercantile_days' | 'mercantile_hours_normal' | 'mercantile_hours_overtime'
    | 'ot_synced_normal' | 'ot_synced_double' | 'ot_synced_ph' | 'ot_synced_poya' | 'ot_synced_mercantile' | 'ot_synced_at'
    | 'one_off_lines' | 'locked' | 'notes'>>,
  actorEpf: string,
): Promise<void> {
  await updateDoc(doc(db, ENTRY_COL, entryId), {
    ...patch,
    updated_by_epf: actorEpf,
    updated_at: Timestamp.now(),
  });
}

export function addOneOffLine(lines: PayrollOneOffLine[], componentId: string, amount: number): PayrollOneOffLine[] {
  return [...lines, { component_id: componentId, amount }];
}

// ─── Sync from Attendance ────────────────────────────────────────────────────────────────
// "Sync from Attendance" button on the Bulk Sheet — derives Total Hours / PH Days / Poya Days
// / Mercantile Days (and their informational "normal hours" companions) straight from each
// employee's REAL schedule_assignments for the run's month, using the exact same shift-merge
// rules the Attendance View page scores lateness with (mergeShiftBlocks — contiguous shifts
// merge, non-contiguous ones don't). Purely a starting point: the caller writes these onto the
// Bulk Sheet rows as plain field values, which stay normal editable Inputs afterward — this
// never locks anything and is safely re-runnable.
//
// Also suggests OT (1.5x bucket): once Total Hours is known, Base Worked Hours = Total Hours
// − Normal Poya Hours − Normal PH Hours − Normal Mercantile Hours (holiday hours are already
// paid at their own day premium, so they're excluded before comparing against the target) —
// whatever's left beyond the employee's own target hours (target_hours_override, else the
// company default) is suggested as OT 1.5x. This is the one exception to "not derivable from
// schedule alone": unlike genuine clock-in/out overtime, THIS specific rule is exactly
// "scheduled hours past the target," which the schedule alone is sufficient to compute.
//
// Also suggests PH/Poya/Mercantile Overtime Hours: on a day flagged public/poya/mercantile,
// hours scheduled BEYOND a standard day's length (settings.default_hours_per_day) are
// suggested as ph_hours_overtime/poya_hours_overtime/mercantile_hours_overtime — e.g. a nurse
// rostered for a 6h morning shift AND a 12h night shift (18h total) on one Poya day gets
// 18 − 8 = 10h suggested as Poya Overtime, on top of (never instead of) the flat Poya Day
// premium and the informational Normal Poya Hours figure. This is the fix for a real gap:
// without it, extra hours worked specifically ON a holiday were invisible on the payslip —
// carved out of the ordinary-OT pool (correctly, to avoid double-paying the day premium) but
// never suggested anywhere else either.
//
// Deliberately does NOT derive No-Pay hours/days: that stays a deliberate human decision,
// never auto-derived from lateness/absence — see attendanceShortfallEngine.ts's own module
// comment. Late Time itself isn't a Bulk Sheet field at all; it's read live from
// attendance_shortfall_summary already (the Bulk Sheet's own "Late Time" column, and
// payroll_results.late_minutes_snapshot at Generate).

export interface AttendanceSyncSuggestion {
  total_hours: number;
  ph_days: number;
  ph_hours_normal: number;
  ph_hours_overtime: number;
  poya_days: number;
  poya_hours_normal: number;
  poya_hours_overtime: number;
  mercantile_days: number;
  mercantile_hours_normal: number;
  mercantile_hours_overtime: number;
  ot_hours_normal: number; // suggested OT 1.5x — Base Worked Hours beyond target hours
}

/** One suggestion per epf in `epfNumbers`, always present (zeroed if nothing was scheduled). */
export async function computeAttendanceSyncSuggestions(
  companyId: string, year: number, month: number, epfNumbers: string[],
): Promise<Map<string, AttendanceSyncSuggestion>> {
  const result = new Map<string, AttendanceSyncSuggestion>();
  for (const epf of epfNumbers) {
    result.set(epf, {
      total_hours: 0, ph_days: 0, ph_hours_normal: 0, ph_hours_overtime: 0,
      poya_days: 0, poya_hours_normal: 0, poya_hours_overtime: 0,
      mercantile_days: 0, mercantile_hours_normal: 0, mercantile_hours_overtime: 0,
      ot_hours_normal: 0,
    });
  }
  if (epfNumbers.length === 0) return result;

  const fromDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const toDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  // Fetched up front (not after the day loop) — default_hours_per_day is needed INSIDE the
  // loop now, to know how much of a holiday day's hours count as "overtime" beyond a
  // standard day's length.
  const [settings, employees, depts] = await Promise.all([
    getPayrollSettings(),
    getActivePayrollEmployees(companyId),
    getDepartments().then(all => all.filter(d => d.company_id === companyId)),
  ]);
  const defaultTargetHours = settings?.default_target_hours ?? null;
  const defaultHoursPerDay = settings?.default_hours_per_day ?? null;
  const targetHoursByEpf = new Map(employees.map(e => [e.epf_number, e.target_hours_override ?? defaultTargetHours]));
  // Same per-employee override the calculation engine itself resolves — a nurse whose profile
  // sets its own Hours per Day gets her holiday-overtime suggestion sized against THAT, not
  // blindly against the company default.
  const hoursPerDayByEpf = new Map(employees.map(e => [e.epf_number, e.hours_per_day ?? defaultHoursPerDay]));

  const perDept = await Promise.all(depts.map(d => getScheduleAssignmentsForDepartment(d.id)));
  const epfSet = new Set(epfNumbers);
  const assignments = perDept.flat().filter(a =>
    !a.is_deleted && epfSet.has(a.epf_number) && a.date >= fromDate && a.date <= toDate);

  const byEpfDate = new Map<string, ScheduleAssignment[]>();
  for (const a of assignments) {
    const key = `${a.epf_number}|${a.date}`;
    const list = byEpfDate.get(key) ?? [];
    list.push(a);
    byEpfDate.set(key, list);
  }

  for (const [key, dayAssignments] of byEpfDate) {
    const epf = key.slice(0, key.indexOf('|'));
    const suggestion = result.get(epf);
    if (!suggestion) continue; // shouldn't happen — every key comes from an epf in epfNumbers

    const blocks = mergeShiftBlocks(dayAssignments);
    const dayHours = blocks.reduce((s, b) => s + (b.scheduledEndMin - b.scheduledStartMin) / 60, 0);
    suggestion.total_hours += dayHours;

    // A day counts as PH/Poya only when EVERY assignment on it agrees — a day split between
    // an ordinary shift and a holiday-flagged one is ambiguous, so it's left uncounted rather
    // than guessed. The excess beyond a standard day's length (if configured) is suggested as
    // that holiday's own Overtime Hours — the FULL day's hours still count toward the
    // informational "Normal" figure regardless; this is additive, not a split.
    const hoursPerDay = hoursPerDayByEpf.get(epf) ?? defaultHoursPerDay;
    const excessHours = (hoursPerDay != null && hoursPerDay > 0 && dayHours > hoursPerDay) ? dayHours - hoursPerDay : 0;
    if (dayAssignments.every(a => a.holiday_type === 'public')) {
      suggestion.ph_days += 1; suggestion.ph_hours_normal += dayHours; suggestion.ph_hours_overtime += excessHours;
    }
    if (dayAssignments.every(a => a.holiday_type === 'poya')) {
      suggestion.poya_days += 1; suggestion.poya_hours_normal += dayHours; suggestion.poya_hours_overtime += excessHours;
    }
    if (dayAssignments.every(a => a.holiday_type === 'mercantile')) {
      suggestion.mercantile_days += 1; suggestion.mercantile_hours_normal += dayHours; suggestion.mercantile_hours_overtime += excessHours;
    }
  }

  // ── Suggested OT: same "dynamically pull target hours, employee override first, else the
  //    company default" resolution the calculation engine itself uses. ──
  for (const [epf, suggestion] of result) {
    const targetHours = targetHoursByEpf.get(epf) ?? defaultTargetHours;
    if (targetHours == null || targetHours <= 0) continue; // unresolved — leave the OT suggestion at 0, same "can't honestly compute" rule as the engine
    const baseWorkedHours = suggestion.total_hours - suggestion.poya_hours_normal - suggestion.ph_hours_normal - suggestion.mercantile_hours_normal;
    if (baseWorkedHours > targetHours) suggestion.ot_hours_normal = baseWorkedHours - targetHours;
  }

  return result;
}

// ─── Roster coverage pre-check (Southern Lanka, TenantFeatures.strictRosterPayroll) ────────
// Before opening a Monthly Run, find every active employee who has a real attendance
// check-in on a date nobody rostered them for — neither a schedule_assignments row nor a
// declared day_offs row. Called from the Payroll Runs page BEFORE getOrCreatePayrollRun; a
// non-empty result hard-blocks opening the run (see computeRosterCoverageGaps for the pure
// cross-referencing logic and why a declared day off still counts as "covered").
export async function findRosterCoverageGaps(
  companyId: string, year: number, month: number,
): Promise<RosterCoverageGap[]> {
  const fromDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const toDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  const [employees, attendance, depts, dayOffs] = await Promise.all([
    getAllEmployees(companyId),
    getCompanyAttendanceForMonth(companyId, year, month),
    getDepartments().then(all => all.filter(d => d.company_id === companyId)),
    getDayOffsForRange(fromDate, toDate),
  ]);
  const epfSet = new Set(employees.map(e => e.epf_number));

  const perDept = await Promise.all(depts.map(d => getScheduleAssignmentsForDepartment(d.id)));
  const assignments = perDept.flat().filter(a =>
    !a.is_deleted && epfSet.has(a.epf_number) && a.date >= fromDate && a.date <= toDate);

  const coveredDatesByEpf = new Map<string, Set<string>>();
  const addCovered = (epf: string, date: string) => {
    const set = coveredDatesByEpf.get(epf) ?? new Set<string>();
    set.add(date);
    coveredDatesByEpf.set(epf, set);
  };
  for (const a of assignments) addCovered(a.epf_number, a.date);
  for (const d of dayOffs) if (epfSet.has(d.epf_number)) addCovered(d.epf_number, d.date);

  const attendanceDatesByEpf = new Map<string, Set<string>>();
  for (const record of attendance) {
    if (!epfSet.has(record.epf_number)) continue;
    // A day counts as attended if any session (or the legacy single-session fields) carries a
    // real check-in — same convention used across the codebase for "did this day happen".
    const hasCheckIn = !!record.check_in || (record.sessions?.some(s => !!s.check_in) ?? false);
    if (!hasCheckIn) continue;
    const set = attendanceDatesByEpf.get(record.epf_number) ?? new Set<string>();
    set.add(record.date);
    attendanceDatesByEpf.set(record.epf_number, set);
  }

  return computeRosterCoverageGaps({
    employees: employees.map(e => ({ epf_number: e.epf_number, display_name: e.display_name })),
    attendanceDatesByEpf,
    coveredDatesByEpf,
  });
}

// ─── Sync Approved OT ────────────────────────────────────────────────────────────────────
// The dedicated companion to "Sync from Attendance". Where that derives an OT SUGGESTION
// from the schedule roster (scheduled month-hours beyond target), this pulls in the hours a
// human actually attested and an approver signed off — the APPROVED ot_requests for the
// run's period (see src/services/otRequestService.ts). Kept separate on purpose: the two draw
// on different sources and "Sync from Attendance" is a destructive re-runnable overwrite of
// ot_hours_normal, so sharing that field would clobber or double-count.
//
// ot_type maps 1:1 onto the four OT hour fields the calculation engine already prices
// (OT_TYPE_TO_ENTRY_FIELD) — no engine change, no new money line.
//
// Idempotent by construction: each entry records how many hours of each field came from
// approved requests at the last sync (ot_synced_*). This applies (newApprovedTotal −
// lastSynced) as a DELTA, so re-running does nothing, manual edits on top survive, and a
// request approved (or later rejected/soft-deleted) after the first sync is added or
// subtracted correctly. Math.max(0, …) stops a subtraction pushing a field negative.
//
// This is the ONLY writer of the four OT_TYPE_TO_ENTRY_FIELD fields sourced from approved
// ot_requests — grep those field names across src/ before adding another one. The passive
// "Extra hours" on the attendance calendar (workDayModel.ts) has no path here at all; see
// src/lib/__tests__/payrollCalculationEngine.test.ts for the regression test that pins the
// engine to reading OT/PH/Poya pay exclusively from these fields.

/** Sum of APPROVED, non-deleted OT request hours for the period, per employee, per bucket. */
export async function computeApprovedOtByEmployee(
  companyId: string, period: string,
): Promise<Map<string, ApprovedOtByType>> {
  const reqs = await getOtRequestsForPeriod(companyId, period, 'approved');
  const map = new Map<string, ApprovedOtByType>();
  for (const r of reqs) {
    const bucket = map.get(r.epf_number) ?? emptyApprovedOt();
    bucket[r.ot_type] += Number(r.requested_hours) || 0;
    map.set(r.epf_number, bucket);
  }
  return map;
}

export interface SyncApprovedOtResult {
  rowsTouched: number;       // Bulk Sheet rows whose OT fields changed
  requestsStamped: number;   // ot_requests marked applied_to_run_id in this pass
  skippedOtherRun: number;   // approved requests already applied to a DIFFERENT run (left alone)
}

/** Applies the approved-OT delta onto every affected Bulk Sheet row of `runId` and stamps
 *  the contributing requests, all in one batch. Safe to re-run; blocked once finalized. */
export async function syncApprovedOtToRun(runId: string, actorEpf: string): Promise<SyncApprovedOtResult> {
  const run = await getPayrollRun(runId);
  if (!run) throw new Error('Payroll run not found.');
  if (run.status === 'finalized') throw new Error('This run is finalized — reopen it before syncing OT.');

  const period = `${run.year}-${String(run.month).padStart(2, '0')}`;
  const [entries, approvedRequests] = await Promise.all([
    getMonthlyEntriesForRun(runId),
    getOtRequestsForPeriod(run.company_id, period, 'approved'),
  ]);

  const mineForRun = (r: OtRequest) => !r.applied_to_run_id || r.applied_to_run_id === runId;
  const skippedOtherRun = approvedRequests.filter(r => !mineForRun(r)).length;

  const byEpf = new Map<string, ApprovedOtByType>();
  const requestsByEpf = new Map<string, OtRequest[]>();
  for (const r of approvedRequests) {
    if (!mineForRun(r)) continue;
    const bucket = byEpf.get(r.epf_number) ?? emptyApprovedOt();
    bucket[r.ot_type] += Number(r.requested_hours) || 0;
    byEpf.set(r.epf_number, bucket);
    const list = requestsByEpf.get(r.epf_number) ?? [];
    list.push(r);
    requestsByEpf.set(r.epf_number, list);
  }

  const batch = writeBatch(db);
  const now = Timestamp.now();
  let rowsTouched = 0;
  let requestsStamped = 0;

  for (const entry of entries) {
    const approved = byEpf.get(entry.epf_number) ?? emptyApprovedOt();
    const row = entry as unknown as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    let changed = false;

    for (const t of OT_TYPES) {
      const field = OT_TYPE_TO_ENTRY_FIELD[t];
      const syncField = OT_TYPE_TO_SYNC_FIELD[t];
      const syncedBefore = Number(row[syncField]) || 0;
      const delta = approved[t] - syncedBefore;
      if (delta === 0) continue;
      patch[field] = Math.max(0, (Number(row[field]) || 0) + delta);
      patch[syncField] = approved[t];
      changed = true;
    }

    // A row with no approved OT and nothing previously synced is left completely untouched.
    if (!changed) continue;
    patch.ot_synced_at = now;
    patch.updated_by_epf = actorEpf;
    patch.updated_at = now;
    batch.update(doc(db, ENTRY_COL, entry.id as string), patch);
    rowsTouched++;

    for (const r of requestsByEpf.get(entry.epf_number) ?? []) {
      if (r.applied_to_run_id === runId && r.applied_hours === (Number(r.requested_hours) || 0)) continue;
      batch.update(doc(db, OT_REQUESTS_COL, r.id), {
        applied_to_run_id: runId,
        applied_hours: Number(r.requested_hours) || 0,
        applied_at: now,
      });
      requestsStamped++;
    }
  }

  if (rowsTouched > 0) await batch.commit();
  return { rowsTouched, requestsStamped, skippedOtherRun };
}

export { runDocId as payrollRunDocId };
