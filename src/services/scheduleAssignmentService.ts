import {
  collection, doc, getDocs, getDocsFromServer, addDoc, updateDoc, onSnapshot, writeBatch,
  query, where, Timestamp,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import type { AttendanceRecord, ScheduleAssignment } from '@/lib/types';
import type { AttendanceReviewStatus } from '@/lib/shiftAutoClose';
import { createAppNotification } from '@/services/notificationService';
import { getAttendanceByDate } from '@/services/attendanceService';
import { localDateString } from '@/lib/utils';
import { mergeShiftBlocks, computeCheckOutOverrunMinutes, formatMinutes } from '@/lib/attendanceShortfallEngine';

// Southern Lanka (carecode.org) tenant only — the Google-Calendar-style grid on
// src/app/(pages)/schedule/page.tsx. Not used by any other tenant.
const COL = 'schedule_assignments';

export const RECALC_QUEUE_COL = 'recalc_queue';

// Back-dating / editing / removing a roster row changes the "scheduled hours" a past RAW
// attendance session (see src/lib/shiftAutoClose.computeShiftSegments) should be split
// against. Enqueue the affected (employee, date-range) so the recalc drain can re-derive the
// scheduled vs. extra-unverified segments for supervisor sign-off — WITHOUT touching the raw
// session timestamps. Best-effort: a failure never blocks the roster write.
// TODO(recalc-drain): a scheduled function drains recalc_queue → computeShiftSegments →
// attendance_segments + a 'retro_roster_split' attendance_reviews row. Not built yet.
export async function enqueueRecalc(
  epf: string, from: string, to: string,
  reason: 'roster_saved' | 'roster_deleted' | 'shift_edited',
): Promise<void> {
  try {
    await addDoc(collection(db, RECALC_QUEUE_COL), {
      epf_number: String(epf),
      from, to, reason,
      status: 'pending',
      enqueued_at: Timestamp.now(),
      processed_at: null,
      error: null,
    });
  } catch { /* non-critical — the roster write already succeeded */ }
}

// Per-department cache, same short-TTL + invalidate-on-write pattern used across this app's
// other Southern Lanka services — small dataset, read whenever the Schedule page (re)loads a
// month for a department.
// "yyyy-MM-dd" -> "Aug 18, 2026", for notification bodies — same rendering the Schedule page's
// own cell dialog uses (new Date(`${date}T00:00:00`)…), local-time not UTC, so it never lands
// on the wrong day near midnight.
function formatDate(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// The employee's LATEST session for that day — sessions-vs-legacy-fields fallback, same
// convention as the Attendance View page's own sessionsOf(). null when there's no punch at all.
function lastSessionOf(record: AttendanceRecord | null): { check_in: Timestamp | null; check_out: Timestamp | null; review_status?: AttendanceReviewStatus } | null {
  if (!record) return null;
  if (record.sessions && record.sessions.length > 0) return record.sessions[record.sessions.length - 1];
  if (record.check_in || record.check_out) return { check_in: record.check_in, check_out: record.check_out };
  return null;
}

const ASSIGNMENTS_TTL_MS = 5 * 60 * 1000;
const _deptCache = new Map<string, { rows: ScheduleAssignment[]; cachedAt: number }>();
const _deptInflight = new Map<string, Promise<ScheduleAssignment[]>>();

export function invalidateScheduleAssignmentsCache(departmentId?: string): void {
  if (departmentId) { _deptCache.delete(departmentId); _deptInflight.delete(departmentId); }
  else { _deptCache.clear(); _deptInflight.clear(); }
}

// Whether ANY live (non-deleted) schedule assignment currently references this shift — the
// usage guard deleteShiftDefinition() checks before soft-deleting a shift, so a shift still
// on someone's actual roster can never disappear out from under it.
export async function isShiftInUse(shiftId: string): Promise<boolean> {
  if (!shiftId) return false;
  const snap = await getDocs(query(collection(db, COL), where('shift_id', '==', shiftId)));
  return snap.docs.some((d) => !d.data().is_deleted);
}

// Whether ANY live (non-deleted) schedule assignment currently references this department —
// one of the usage checks deleteDepartment() runs before soft-deleting a department.
export async function isDepartmentInUse(departmentId: string): Promise<boolean> {
  if (!departmentId) return false;
  const assignments = await getScheduleAssignmentsForDepartment(departmentId);
  return assignments.length > 0;
}

// Dynamic Entity Name/Time Resolution — a ScheduleAssignment stores department_id/shift_id
// alongside a denormalized snapshot (name, start_time, end_time) taken when it was created. If
// the Department was renamed, or the Shift was renamed/re-timed, since, that snapshot goes
// stale — an admin editing a shift's hours in Shift Management otherwise never reaches
// existing assignments referencing it, on the admin grid OR the employee's My Schedule (both
// read through here). Resolve every one of those fields from the live (cached) departments/
// shifts lists here — the single choke point every consumer of this service (Schedule grid, My
// Schedule, the "next shift" strip) reads through — and fall back to the stored snapshot only
// when the entity can't be found live (deleted, or a lookup failure). Dynamic imports avoid a
// circular dependency: both shiftDefinitionService and departmentService already import FROM
// this module (isShiftInUse / isDepartmentInUse).
async function resolveLiveNames(rows: ScheduleAssignment[]): Promise<ScheduleAssignment[]> {
  if (!rows.length) return rows;
  try {
    const [{ getShiftDefinitions }, { getDepartments }] = await Promise.all([
      import('@/services/shiftDefinitionService'),
      import('@/services/departmentService'),
    ]);
    const [shifts, departments] = await Promise.all([getShiftDefinitions(), getDepartments()]);
    const shiftById    = new Map(shifts.map((s) => [s.id, s]));
    const deptNameById = new Map(departments.map((d) => [d.id, d.name]));
    return rows.map((r) => {
      const shift = shiftById.get(r.shift_id);
      return {
        ...r,
        shift_name:      shift?.name ?? r.shift_name,
        start_time:      shift?.start_time ?? r.start_time,
        end_time:        shift?.end_time ?? r.end_time,
        department_name: deptNameById.get(r.department_id) ?? r.department_name,
      };
    });
  } catch {
    return rows; // lookup failed (offline, etc.) — safe fallback to the stored snapshot
  }
}

// Every live (non-deleted) assignment for one department, regardless of date — the Schedule
// page filters down to the visible month client-side, same as the rest of this app's small
// collections (avoids a composite index for a department_id + date range query). Filtered
// client-side rather than `where('is_deleted', '==', false)` — an equality filter on a field
// drops any doc that doesn't have it set at all. An employee may have SEVERAL of these for the
// same date (one department can hand someone more than one shift that day) — this returns the
// flat list; callers group by employee+date as needed.
export async function getScheduleAssignmentsForDepartment(
  departmentId: string, force = false,
): Promise<ScheduleAssignment[]> {
  if (!departmentId) return [];
  const cached = _deptCache.get(departmentId);
  if (!force && cached && Date.now() - cached.cachedAt < ASSIGNMENTS_TTL_MS) return cached.rows;
  const inflight = _deptInflight.get(departmentId);
  if (!force && inflight) return inflight;
  const p = (async () => {
    const snap = await getDocs(query(collection(db, COL), where('department_id', '==', departmentId)));
    const raw = snap.docs
      .map((d) => ({ id: d.id, ...d.data() } as ScheduleAssignment))
      .filter((r) => !r.is_deleted);
    const rows = await resolveLiveNames(raw);
    _deptCache.set(departmentId, { rows, cachedAt: Date.now() });
    return rows;
  })();
  _deptInflight.set(departmentId, p);
  try { return await p; } finally { _deptInflight.delete(departmentId); }
}

// Every live (non-deleted) assignment across the WHOLE tenant for one calendar month, bounded
// by a `date` range query — same single-field-range approach getCompanyAttendanceForMonth uses
// (no composite index to deploy). For the Reports page's "Download Report" flow, which needs
// one month across every department in scope: calling getScheduleAssignmentsForDepartment once
// per department instead would fetch each department's ENTIRE unbounded history (that function
// deliberately ignores date — see its own comment), which gets slower every month as roster
// history piles up. Callers filter down to their department/company scope client-side.
export async function getScheduleAssignmentsForMonth(year: number, month: number): Promise<ScheduleAssignment[]> {
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  const snap = await getDocs(query(
    collection(db, COL),
    where('date', '>=', `${prefix}-01`),
    where('date', '<=', `${prefix}-31`),
  ));
  const raw = snap.docs
    .map((d) => ({ id: d.id, ...d.data() } as ScheduleAssignment))
    .filter((r) => !r.is_deleted);
  return resolveLiveNames(raw);
}

// Re-fires `onChange` whenever the shift_definitions collection changes, skipping its own
// initial snapshot (the caller already has current data at subscribe time). Editing a shift's
// name/hours in Shift Management never writes a schedule_assignments doc, so the assignment
// listeners below wouldn't otherwise fire for it at all — this is what makes that edit reach an
// already-open Schedule grid or My Schedule immediately instead of waiting on an unrelated
// assignment write or a manual refresh. Dynamic import — same circular-dependency reason as
// resolveLiveNames above; the subscription itself starts async as a result, which is fine since
// the caller's own initial `emit()` already covers the "just opened the page" case.
function watchShiftDefinitionChanges(onChange: () => void): () => void {
  let unsub = () => {};
  let cancelled = false;
  let sawFirstEmit = false;
  import('@/services/shiftDefinitionService').then(({ subscribeShiftDefinitions }) => {
    if (cancelled) return;
    unsub = subscribeShiftDefinitions(() => {
      if (!sawFirstEmit) { sawFirstEmit = true; return; }
      onChange();
    });
  });
  return () => { cancelled = true; unsub(); };
}

// Real-time counterpart to getScheduleAssignmentsForDepartment above — the Schedule page's
// admin/HOD grid. force=true bypasses the 5-minute TTL cache on every fire so the listener
// never re-serves data an admin's own create/remove already invalidated a moment earlier.
// Re-subscribe when `departmentId` changes (the caller's useEffect dep array does this).
// Fires once immediately with current data, then again on every create/update/remove for this
// department (or an edit to any shift definition — see watchShiftDefinitionChanges) — callers
// MUST invoke the returned unsubscribe on unmount / department change.
export function subscribeScheduleAssignmentsForDepartment(
  departmentId: string,
  cb: (assignments: ScheduleAssignment[]) => void,
): () => void {
  if (!departmentId) { cb([]); return () => {}; }
  // A failed emit() re-fires cb with the LAST successful result rather than skipping the
  // callback outright — this used to be a bare `.catch(() => {})`, which really did "keep the
  // last-known list" on screen, but also meant a single transient fetch failure (a permission
  // blip on a fast department switch, a network hiccup) left every caller's own "loading"
  // flag — which only ever clears inside this callback — stuck true forever, spinning next to
  // an already-rendered, perfectly correct grid (see the Schedule page's assignmentsLoading).
  let lastKnown: ScheduleAssignment[] = [];
  const emit = () => {
    getScheduleAssignmentsForDepartment(departmentId, true)
      .then((rows) => { lastKnown = rows; cb(rows); })
      .catch((err) => {
        console.warn('subscribeScheduleAssignmentsForDepartment emit failed, keeping last-known list:', err?.message ?? err);
        cb(lastKnown);
      });
  };
  emit();
  const unsubAssignments = onSnapshot(
    query(collection(db, COL), where('department_id', '==', departmentId)),
    emit,
    (err) => console.warn('subscribeScheduleAssignmentsForDepartment failed:', err?.message ?? err),
  );
  const unsubShifts = watchShiftDefinitionChanges(emit);
  return () => { unsubAssignments(); unsubShifts(); };
}

// Every live assignment dated inside [fromDate, toDate] ('yyyy-MM-dd'), across EVERY
// department — the Schedule page's "All departments" view, which shows the whole org (or all of
// a HOD's departments) on one grid. A single-field range on `date` needs no composite index.
// Not cached: it is one read per visible month, and the range listener below keeps it fresh.
export async function getScheduleAssignmentsForRange(
  fromDate: string, toDate: string,
): Promise<ScheduleAssignment[]> {
  if (!fromDate || !toDate) return [];
  const snap = await getDocs(query(
    collection(db, COL), where('date', '>=', fromDate), where('date', '<=', toDate),
  ));
  const raw = snap.docs
    .map((d) => ({ id: d.id, ...d.data() } as ScheduleAssignment))
    .filter((r) => !r.is_deleted);
  return resolveLiveNames(raw);
}

// Real-time counterpart to getScheduleAssignmentsForRange — same contract as the per-department
// listener above: fires once with current data, then on every write inside the range. Callers
// MUST invoke the returned unsubscribe on unmount / month change.
export function subscribeScheduleAssignmentsForRange(
  fromDate: string, toDate: string,
  cb: (assignments: ScheduleAssignment[]) => void,
): () => void {
  if (!fromDate || !toDate) { cb([]); return () => {}; }
  // See subscribeScheduleAssignmentsForDepartment's comment — cb must fire every emit(), even
  // a failed one, or the caller's own loading flag (cleared only inside cb) sticks forever.
  let lastKnown: ScheduleAssignment[] = [];
  const emit = () => {
    getScheduleAssignmentsForRange(fromDate, toDate)
      .then((rows) => { lastKnown = rows; cb(rows); })
      .catch((err) => {
        console.warn('subscribeScheduleAssignmentsForRange emit failed, keeping last-known list:', err?.message ?? err);
        cb(lastKnown);
      });
  };
  emit();
  return onSnapshot(
    query(collection(db, COL), where('date', '>=', fromDate), where('date', '<=', toDate)),
    emit,
    (err) => console.warn('subscribeScheduleAssignmentsForRange failed:', err?.message ?? err),
  );
}

// Real-time counterpart to getScheduleAssignmentsForEmployee below — My Schedule. An admin/HOD
// creating, updating or removing this employee's shift assignment (or editing any shift
// definition's name/hours — see watchShiftDefinitionChanges) re-renders their own calendar
// instantly, with no page refresh. Callers MUST invoke the returned unsubscribe on unmount.
export function subscribeScheduleAssignmentsForEmployee(
  epfNumber: string,
  cb: (assignments: ScheduleAssignment[]) => void,
): () => void {
  if (!epfNumber) { cb([]); return () => {}; }
  // See subscribeScheduleAssignmentsForDepartment's comment — cb must fire every emit(), even
  // a failed one, or the caller's own loading flag (cleared only inside cb) sticks forever.
  let lastKnown: ScheduleAssignment[] = [];
  const emit = () => {
    getScheduleAssignmentsForEmployee(epfNumber)
      .then((rows) => { lastKnown = rows; cb(rows); })
      .catch((err) => {
        console.warn('subscribeScheduleAssignmentsForEmployee emit failed, keeping last-known list:', err?.message ?? err);
        cb(lastKnown);
      });
  };
  emit();
  const unsubAssignments = onSnapshot(
    query(collection(db, COL), where('epf_number', '==', epfNumber)),
    emit,
    (err) => console.warn('subscribeScheduleAssignmentsForEmployee failed:', err?.message ?? err),
  );
  const unsubShifts = watchShiftDefinitionChanges(emit);
  return () => { unsubAssignments(); unsubShifts(); };
}

// Every live assignment for ONE employee, across every department — powers My Schedule and the
// "next shift" strip on TodayCheckInOut, neither of which knows in advance which department an
// employee belongs to. May include several rows for the same date. Not cached: read once per
// page load for one person's own data, low traffic, same reasoning as the old
// rosterScheduleOverrideService.getScheduleOverridesForEmployee.
// `opts.server` forces a network round-trip (getDocsFromServer) instead of letting Firestore
// answer from its local cache. The My Schedule page keeps a live onSnapshot listener on this
// exact query, so a plain getDocs there resolves instantly from cache — which made the manual
// "Refresh" button a silent no-op. The button passes { server: true }; the initial load and
// the subscription's first callback stay on the cache-friendly path.
export async function getScheduleAssignmentsForEmployee(
  epfNumber: string,
  opts?: { server?: boolean },
): Promise<ScheduleAssignment[]> {
  if (!epfNumber) return [];
  const q = query(collection(db, COL), where('epf_number', '==', epfNumber));
  const snap = await (opts?.server ? getDocsFromServer(q) : getDocs(q));
  const raw = snap.docs
    .map((d) => ({ id: d.id, ...d.data() } as ScheduleAssignment))
    .filter((r) => !r.is_deleted);
  return resolveLiveNames(raw);
}

// Adds one shift assignment for this employee/date — clicking a shift in the Schedule grid's
// cell dialog. An employee can hold more than one shift on the same date (e.g. covering two
// back-to-back shifts), so this always creates a new doc rather than overwriting one; the
// dialog itself is responsible for only offering shifts not already assigned to that cell, so
// the same shift is never added twice.
export async function createScheduleAssignment(input: {
  department_id: string;
  department_name: string;
  epf_number: string;
  employee_name: string;
  date: string;
  shift_id: string;
  shift_name: string;
  start_time: string;
  end_time: string;
  // See ScheduleAssignment.holiday_type — pass the date's holiday classification (or
  // null/omit for an ordinary working day) so it's captured at assignment time.
  holiday_type?: 'poya' | 'public' | 'mercantile' | null;
  assigned_by: string;
  assigned_by_name: string;
}): Promise<string> {
  const now = Timestamp.now();
  const ref = await addDoc(collection(db, COL), {
    department_id:    input.department_id,
    department_name:  input.department_name,
    epf_number:       input.epf_number,
    employee_name:    input.employee_name,
    date:             input.date,
    shift_id:         input.shift_id,
    shift_name:       input.shift_name,
    start_time:       input.start_time,
    end_time:         input.end_time,
    // addDoc rejects `undefined` field values outright — always write an explicit null
    // rather than omitting the key on an ordinary (non-holiday) date.
    holiday_type:      input.holiday_type ?? null,
    assigned_by:      input.assigned_by,
    assigned_by_name: input.assigned_by_name,
    is_deleted:        false,
    created_at:        now,
  });
  invalidateScheduleAssignmentsCache(input.department_id);
  await enqueueRecalc(input.epf_number, input.date, input.date, 'roster_saved');

  // Let the employee know — reuses the 'schedule_updated' notification type (icon + /my-schedule
  // link already wired up in NotificationCenter.tsx from the old Roster system, just unused
  // since that page was replaced). Skipped when someone assigns themselves a shift — an admin
  // who's also in their own department's employee list doesn't need to be told about their own
  // click. createAppNotification never throws, so this can't fail the assignment itself.
  if (input.assigned_by !== input.epf_number) {
    await createAppNotification({
      toEpf: input.epf_number,
      type: 'schedule_updated',
      actorEpf: input.assigned_by,
      actorName: input.assigned_by_name,
      meta: { date: input.date, shift_id: input.shift_id, department_id: input.department_id },
      title: `${input.shift_name} shift assigned`,
      body: `You've been scheduled for ${input.shift_name} (${input.start_time}–${input.end_time}) on ${formatDate(input.date)}, ${input.department_name}.`,
      link: '/my-schedule',
    });

    // Retro-assigning a shift to a PAST day the employee already punched can leave that day's
    // check-out in a state that needs their attention before anyone can trust it — with nothing
    // else that would ever tell them so. Fired as a SEPARATE notification from the "shift
    // assigned" one above — that one is about the schedule, this one is about a data gap the
    // schedule change just surfaced. Reuses the 'reminder' type (already Clock-iconed and
    // routed to /attendance in NotificationCenter), rather than adding a new type for a nudge.
    //
    // Three independent reasons trip this, checked in order of how much they matter:
    //   1. MISSING  — no check-out at all (fingerprint-only tenants can't check out from the
    //      app — the terminal is the only clock).
    //   2. FLAGGED  — a check-out exists but was written by Rule 2's auto-close on a stale open
    //      session (src/lib/attendanceAutoClose.ts's closeSessionRaw) and is still sitting
    //      unconfirmed (`review_status: 'flagged'`) — real, but not yet trusted.
    //   3. OVERRUN  — a check-out exists and isn't flagged, but once EVERY one of this date's
    //      shift assignments is merged (mergeShiftBlocks — a back-to-back pair collapses into
    //      one block, so "the last shift's end" means the END of that merged block, not just
    //      the shift just added), it still runs past that block's own scheduled end
    //      (computeCheckOutOverrunMinutes). This is exactly what the Attendance View page's own
    //      grid indicator flags for the admin — this is the same signal, sent to the employee.
    if (input.date < localDateString()) {
      try {
        const existingRecord = await getAttendanceByDate(input.epf_number, input.date);
        const last = lastSessionOf(existingRecord);
        const missing = !!last && !!last.check_in && !last.check_out;
        const flagged = !missing && last?.review_status === 'flagged';
        let overrunMinutes = 0;
        if (!missing && !flagged && last?.check_out) {
          const dayAssignments = (await getScheduleAssignmentsForDepartment(input.department_id, true))
            .filter(a => a.epf_number === input.epf_number && a.date === input.date);
          overrunMinutes = computeCheckOutOverrunMinutes(mergeShiftBlocks(dayAssignments), last.check_out.toDate());
        }
        if (missing || flagged || overrunMinutes > 0) {
          const reason = missing
            ? 'your check-out that day is still missing'
            : flagged
              ? 'your check-out that day was auto-recorded and is still awaiting supervisor review'
              : `your check-out that day runs ${formatMinutes(overrunMinutes)} past this shift's scheduled end`;
          await createAppNotification({
            toEpf: input.epf_number,
            type: 'reminder',
            actorEpf: input.assigned_by,
            actorName: input.assigned_by_name,
            meta: { date: input.date, shift_id: input.shift_id, department_id: input.department_id },
            title: `Check-out needs review for ${formatDate(input.date)}`,
            body: `You were scheduled for ${input.shift_name} on ${formatDate(input.date)}, but ${reason}. Submit an attendance edit request to confirm it — if you worked beyond your shift, you may then be eligible to request OT.`,
            link: '/attendance',
          });
        }
      } catch { /* non-critical — the shift assignment itself already succeeded */ }
    }
  }

  return ref.id;
}

export interface BulkScheduleAssignmentInput {
  department_id: string;
  department_name: string;
  epf_number: string;
  employee_name: string;
  date: string;        // 'yyyy-MM-dd'
  shift_id: string;
  shift_name: string;
  start_time: string;
  end_time: string;
  holiday_type?: 'poya' | 'public' | 'mercantile' | null;
}

// Bulk shift-roster import (see src/components/ImportShiftsDialog.tsx). Writes many assignments
// in chunked batches, skipping any (employee, date, shift) that already exists so a re-import
// of the same sheet is idempotent. Unlike createScheduleAssignment it does NOT fire a
// notification per row — instead ONE `schedule_updated` per affected employee (skipping the
// importer themselves), summarising how many shifts landed and over what date range.
export async function bulkCreateScheduleAssignments(
  inputs: BulkScheduleAssignmentInput[],
  actor: { epf_number: string; name: string },
): Promise<{ created: number; skipped: number }> {
  if (!inputs.length) return { created: 0, skipped: 0 };

  // Existing (epf|date|shift) keys for every department touched by this batch.
  const deptIds = [...new Set(inputs.map((i) => i.department_id).filter(Boolean))];
  const existing = new Set<string>();
  await Promise.all(deptIds.map(async (id) => {
    const rows = await getScheduleAssignmentsForDepartment(id, true);
    for (const r of rows) existing.add(`${r.epf_number}|${r.date}|${r.shift_id}`);
  }));

  const now = Timestamp.now();
  const fresh: BulkScheduleAssignmentInput[] = [];
  let skipped = 0;
  for (const inp of inputs) {
    const key = `${inp.epf_number}|${inp.date}|${inp.shift_id}`;
    if (existing.has(key)) { skipped++; continue; }
    existing.add(key); // also de-dupes within the incoming batch
    fresh.push(inp);
  }

  for (let i = 0; i < fresh.length; i += 450) {
    const batch = writeBatch(db);
    for (const inp of fresh.slice(i, i + 450)) {
      batch.set(doc(collection(db, COL)), {
        department_id:    inp.department_id,
        department_name:  inp.department_name,
        epf_number:       inp.epf_number,
        employee_name:    inp.employee_name,
        date:             inp.date,
        shift_id:         inp.shift_id,
        shift_name:       inp.shift_name,
        start_time:       inp.start_time,
        end_time:         inp.end_time,
        holiday_type:     inp.holiday_type ?? null,
        assigned_by:      actor.epf_number,
        assigned_by_name: actor.name,
        is_deleted:       false,
        created_at:       now,
      });
    }
    await batch.commit();
  }

  deptIds.forEach((id) => invalidateScheduleAssignmentsCache(id));

  // One summary notification per affected employee (not per shift).
  const perEmployee = new Map<string, { name: string; dates: string[]; count: number }>();
  for (const inp of fresh) {
    const e = perEmployee.get(inp.epf_number) ?? { name: inp.employee_name, dates: [], count: 0 };
    e.dates.push(inp.date);
    e.count += 1;
    perEmployee.set(inp.epf_number, e);
  }

  // One recalc-queue entry per affected employee, covering their touched date range.
  await Promise.all([...perEmployee.entries()].map(([epf, e]) => {
    const sorted = [...e.dates].sort();
    return enqueueRecalc(epf, sorted[0], sorted[sorted.length - 1], 'roster_saved');
  }));
  await Promise.all([...perEmployee.entries()].map(([epf, e]) => {
    if (epf === actor.epf_number) return Promise.resolve();
    const sorted = [...e.dates].sort();
    const range = sorted[0] === sorted[sorted.length - 1]
      ? formatDate(sorted[0])
      : `${formatDate(sorted[0])} – ${formatDate(sorted[sorted.length - 1])}`;
    return createAppNotification({
      toEpf: epf,
      type: 'schedule_updated',
      actorEpf: actor.epf_number,
      actorName: actor.name,
      meta: { count: String(e.count) },
      title: 'Your shift roster was updated',
      body: `${e.count} shift${e.count === 1 ? '' : 's'} added to your schedule (${range}).`,
      link: '/my-schedule',
    });
  }));

  return { created: fresh.length, skipped };
}

// Removes one shift assignment (one row in the cell, not the whole cell). Soft delete, same
// convention as everywhere else; getScheduleAssignmentsFor* filters these out. Takes the full
// assignment (not just its id) so the removal notification below has something to describe —
// the caller already has it in hand (it's what rendered the "Remove" button).
export async function removeScheduleAssignment(
  assignment: ScheduleAssignment,
  actor: { epf_number: string; name: string },
): Promise<void> {
  await updateDoc(doc(db, COL, assignment.id), { is_deleted: true, deleted_at: Timestamp.now() });
  invalidateScheduleAssignmentsCache(assignment.department_id);
  await enqueueRecalc(assignment.epf_number, assignment.date, assignment.date, 'roster_deleted');

  if (actor.epf_number !== assignment.epf_number) {
    await createAppNotification({
      toEpf: assignment.epf_number,
      type: 'schedule_updated',
      actorEpf: actor.epf_number,
      actorName: actor.name,
      meta: { date: assignment.date, shift_id: assignment.shift_id, department_id: assignment.department_id },
      title: `${assignment.shift_name} shift removed`,
      body: `Your ${assignment.shift_name} shift (${assignment.start_time}–${assignment.end_time}) on ${formatDate(assignment.date)} was removed from your schedule.`,
      link: '/my-schedule',
    });
  }
}
