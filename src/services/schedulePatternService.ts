import {
  collection, doc, getDoc, getDocs, addDoc, updateDoc, onSnapshot, writeBatch,
  query, where, Timestamp,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import type { SchedulePattern, ScheduleAssignment, DayOff, Shift, AppUser } from '@/lib/types';
import {
  expandPattern, horizonEnd, diffMaterialization, describeWeekdays, patternIsVoid, HORIZON_WEEKS,
} from '@/lib/schedulePattern';
import { shiftIsRestricted, isRecurringDayOffEligible } from '@/lib/shiftAccess';
import { localDateString } from '@/lib/utils';
import { getHolidayTypesForRange } from '@/services/holidayService';
import { getShiftDefinitions } from '@/services/shiftDefinitionService';
import { getUserByEpf } from '@/services/userService';
import { invalidateScheduleAssignmentsCache } from '@/services/scheduleAssignmentService';
import { createAppNotification } from '@/services/notificationService';

// Weekly recurring shift patterns (Southern Lanka). A pattern is one employee's "work shift
// X every <weekdays>", materialised into ordinary schedule_assignments docs on a rolling
// horizon (today + HORIZON_WEEKS). Nothing else reads schedule_patterns — the grid, My
// Schedule, the Excel report and payroll all keep reading schedule_assignments unchanged.
// The pure date/diff logic lives in @/lib/schedulePattern (unit-tested); this file is the
// thin Firestore wrapper around it.
const PATTERN_COL = 'schedule_patterns';
const ASSIGN_COL = 'schedule_assignments';
const DAYOFF_COL = 'day_offs';

const FIRESTORE_BATCH_LIMIT = 450; // same headroom under the 500 cap as bulkCreateScheduleAssignments

function formatDate(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ─── Reads ───────────────────────────────────────────────────────────────────
// Small collections (a handful of live patterns per department) — no TTL cache, unlike
// scheduleAssignmentService. Filtered client-side rather than where('is_deleted','==',false):
// an equality filter drops any doc missing the field, which would hide older rows.

export async function getSchedulePatternsForDepartment(departmentId: string): Promise<SchedulePattern[]> {
  if (!departmentId) return [];
  const snap = await getDocs(query(collection(db, PATTERN_COL), where('department_id', '==', departmentId)));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as SchedulePattern)).filter((p) => !p.is_deleted);
}

export async function getSchedulePatternsForEmployee(epfNumber: string): Promise<SchedulePattern[]> {
  if (!epfNumber) return [];
  const snap = await getDocs(query(collection(db, PATTERN_COL), where('epf_number', '==', epfNumber)));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as SchedulePattern)).filter((p) => !p.is_deleted);
}

// Real-time for the Schedule page — a pattern created/edited/removed elsewhere re-renders
// the grid's ↻ affordance without a refresh. Callers MUST call the returned unsubscribe.
export function subscribeSchedulePatternsForDepartment(
  departmentId: string, cb: (patterns: SchedulePattern[]) => void,
): () => void {
  if (!departmentId) { cb([]); return () => {}; }
  const q = query(collection(db, PATTERN_COL), where('department_id', '==', departmentId));
  const emit = () => { getSchedulePatternsForDepartment(departmentId).then(cb).catch(() => { /* keep last-known */ }); };
  emit();
  return onSnapshot(q, emit, (err) => console.warn('subscribeSchedulePatternsForDepartment failed:', err?.message ?? err));
}

// Patterns for SEVERAL departments at once — the Schedule page's "All departments" view. One
// `in` query per 30 ids (Firestore's cap), merged. An empty-string id is a legitimate member:
// it picks up patterns written for employees who have no department at all.
export async function getSchedulePatternsForDepartments(departmentIds: string[]): Promise<SchedulePattern[]> {
  const ids = [...new Set(departmentIds)];
  if (!ids.length) return [];
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += 30) chunks.push(ids.slice(i, i + 30));
  const snaps = await Promise.all(chunks.map((chunk) =>
    getDocs(query(collection(db, PATTERN_COL), where('department_id', 'in', chunk)))));
  return snaps
    .flatMap((snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() } as SchedulePattern)))
    .filter((p) => !p.is_deleted);
}

// Real-time counterpart to getSchedulePatternsForDepartments — one listener per 30-id chunk,
// each re-reading the whole set on any change so the callback always sees one merged list.
// Callers MUST call the returned unsubscribe.
export function subscribeSchedulePatternsForDepartments(
  departmentIds: string[], cb: (patterns: SchedulePattern[]) => void,
): () => void {
  const ids = [...new Set(departmentIds)];
  if (!ids.length) { cb([]); return () => {}; }
  const emit = () => { getSchedulePatternsForDepartments(ids).then(cb).catch(() => { /* keep last-known */ }); };
  emit();
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += 30) chunks.push(ids.slice(i, i + 30));
  const unsubs = chunks.map((chunk) => onSnapshot(
    query(collection(db, PATTERN_COL), where('department_id', 'in', chunk)),
    emit,
    (err) => console.warn('subscribeSchedulePatternsForDepartments failed:', err?.message ?? err),
  ));
  return () => { unsubs.forEach((u) => u()); };
}

// ─── Materialise engine ──────────────────────────────────────────────────────
// Reconcile one pattern's future schedule_assignments with what it SHOULD produce, from
// `today` out to the rolling horizon. Idempotent — safe to call repeatedly (create, every
// edit, the weekly cron). NEVER touches past rows or rows without this pattern_id; a
// hand-removed occurrence (tombstone) is not resurrected. Fires no notification — callers
// decide. Returns the write counts.
export async function materializePattern(pattern: SchedulePattern): Promise<{ created: number; removed: number }> {
  const today = localDateString();
  const rangeStart = pattern.effective_from > today ? pattern.effective_from : today;
  const rangeEnd = horizonEnd(today, HORIZON_WEEKS);

  // A paused / deleted / expired pattern wants nothing — expandPattern returns [] and the
  // diff tombstones every future live row it owns.
  const active = pattern.is_active && !pattern.is_deleted;
  const wanted = active
    ? expandPattern(
        { weekdays: pattern.weekdays, effective_from: pattern.effective_from, effective_to: pattern.effective_to },
        rangeStart, rangeEnd,
      )
    : [];

  const counts = pattern.is_day_off
    ? await materializeDayOffRows(pattern, wanted, today)
    : await materializeShiftRows(pattern, wanted, today);

  await updateDoc(doc(db, PATTERN_COL, pattern.id), {
    materialized_through: active ? rangeEnd : null,
    updated_at: Timestamp.now(),
  });

  return counts;
}

// Shift pattern → schedule_assignments rows. Every row this pattern has written (past +
// future, live + tombstoned); `where('pattern_id','==',id)` only matches docs that carry
// the field, so manual assignments are excluded automatically.
async function materializeShiftRows(
  pattern: SchedulePattern, wanted: string[], today: string,
): Promise<{ created: number; removed: number }> {
  const snap = await getDocs(query(collection(db, ASSIGN_COL), where('pattern_id', '==', pattern.id)));
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() } as ScheduleAssignment));

  const { toCreate, toTombstone } = diffMaterialization(
    wanted, rows.map((r) => ({ date: r.date, is_deleted: r.is_deleted })), today,
  );
  if (!toCreate.length && !toTombstone.length) return { created: 0, removed: 0 };

  // Snapshot each new date's holiday class now, exactly as createScheduleAssignment does —
  // payroll's PH/Poya multipliers read this off the assignment.
  const holidayTypes = toCreate.length
    ? await getHolidayTypesForRange(toCreate[0], toCreate[toCreate.length - 1])
    : new Map<string, 'poya' | 'public' | 'mercantile'>();
  const liveIdByDate = new Map(rows.filter((r) => !r.is_deleted).map((r) => [r.date, r.id]));
  const now = Timestamp.now();

  const writes: Array<{ kind: 'create'; date: string } | { kind: 'tombstone'; id: string }> = [
    ...toCreate.map((date) => ({ kind: 'create' as const, date })),
    ...toTombstone.map((date) => ({ kind: 'tombstone' as const, id: liveIdByDate.get(date)! })),
  ];
  for (let i = 0; i < writes.length; i += FIRESTORE_BATCH_LIMIT) {
    const batch = writeBatch(db);
    for (const w of writes.slice(i, i + FIRESTORE_BATCH_LIMIT)) {
      if (w.kind === 'create') {
        batch.set(doc(collection(db, ASSIGN_COL)), {
          department_id:    pattern.department_id,
          department_name:  pattern.department_name,
          epf_number:       pattern.epf_number,
          employee_name:    pattern.employee_name,
          date:             w.date,
          shift_id:         pattern.shift_id,
          shift_name:       pattern.shift_name,
          start_time:       pattern.start_time,
          end_time:         pattern.end_time,
          holiday_type:     holidayTypes.get(w.date) ?? null,
          assigned_by:      pattern.created_by,
          assigned_by_name: 'Recurring pattern',
          pattern_id:       pattern.id,
          is_deleted:       false,
          created_at:       now,
        });
      } else {
        batch.update(doc(db, ASSIGN_COL, w.id), { is_deleted: true, deleted_at: now });
      }
    }
    await batch.commit();
  }
  invalidateScheduleAssignmentsCache(pattern.department_id);
  return { created: toCreate.length, removed: toTombstone.length };
}

// Day-off pattern → day_offs rows. No pattern_id filter available server-side that also
// spares manual rows, so query the employee's whole day_offs set and split: `mine` (this
// pattern) feeds the diff; a live row from any OTHER source blocks a create on that date and
// is never tombstoned.
async function materializeDayOffRows(
  pattern: SchedulePattern, wanted: string[], today: string,
): Promise<{ created: number; removed: number }> {
  const snap = await getDocs(query(collection(db, DAYOFF_COL), where('epf_number', '==', String(pattern.epf_number))));
  const all = snap.docs.map((d) => ({ id: d.id, ...d.data() } as DayOff));
  const mine = all.filter((r) => r.pattern_id === pattern.id);
  const foreignLiveDates = new Set(all.filter((r) => r.pattern_id !== pattern.id && !r.is_deleted).map((r) => r.date));

  const { toCreate, toTombstone } = diffMaterialization(
    wanted, mine.map((r) => ({ date: r.date, is_deleted: r.is_deleted })), today,
  );
  const createDates = toCreate.filter((d) => !foreignLiveDates.has(d));
  if (!createDates.length && !toTombstone.length) return { created: 0, removed: 0 };

  const liveIdByDate = new Map(mine.filter((r) => !r.is_deleted).map((r) => [r.date, r.id]));
  const now = Timestamp.now();
  const writes: Array<{ kind: 'create'; date: string } | { kind: 'tombstone'; id: string }> = [
    ...createDates.map((date) => ({ kind: 'create' as const, date })),
    ...toTombstone.map((date) => ({ kind: 'tombstone' as const, id: liveIdByDate.get(date)! })),
  ];
  for (let i = 0; i < writes.length; i += FIRESTORE_BATCH_LIMIT) {
    const batch = writeBatch(db);
    for (const w of writes.slice(i, i + FIRESTORE_BATCH_LIMIT)) {
      if (w.kind === 'create') {
        batch.set(doc(collection(db, DAYOFF_COL)), {
          epf_number:    String(pattern.epf_number),
          employee_name: pattern.employee_name || String(pattern.epf_number),
          date:          w.date,
          reason:        '',
          source:        'pattern',
          pattern_id:    pattern.id,
          created_by:    pattern.created_by,
          created_at:    now,
          is_deleted:    false,
        });
      } else {
        batch.update(doc(db, DAYOFF_COL, w.id), { is_deleted: true, deleted_at: now });
      }
    }
    await batch.commit();
  }
  return { created: createDates.length, removed: toTombstone.length };
}

// ─── Writes ──────────────────────────────────────────────────────────────────

export interface SchedulePatternInput {
  epf_number:     string;
  employee_name:  string;
  department_id:  string;
  department_name:string;
  is_day_off?:    boolean;      // true → shift_id/times '' , shift_name 'Day Off'; engine writes day_offs
  shift_id:       string;
  shift_name:     string;
  start_time:     string;
  end_time:       string;
  weekdays:       number[];     // 0=Sun … 6=Sat
  effective_from: string;       // 'yyyy-MM-dd'
  effective_to:   string | null;
}

// Create a pattern, materialise its first horizon, and tell the employee once.
export async function createSchedulePattern(
  input: SchedulePatternInput,
  actor: { epf_number: string; name: string },
): Promise<string> {
  const now = Timestamp.now();
  const ref = await addDoc(collection(db, PATTERN_COL), {
    ...input,
    is_active:            true,
    materialized_through: null,
    created_by:           actor.epf_number,
    created_at:           now,
    is_deleted:           false,
  });

  const pattern: SchedulePattern = { id: ref.id, ...input, is_active: true, materialized_through: null, created_by: actor.epf_number, created_at: now };
  const { created } = await materializePattern(pattern);

  if (actor.epf_number !== input.epf_number) {
    const when = `${describeWeekdays(input.weekdays)}, from ${formatDate(input.effective_from)}`;
    await createAppNotification({
      toEpf: input.epf_number,
      type: 'schedule_updated',
      actorEpf: actor.epf_number,
      actorName: actor.name,
      meta: { shift_id: input.shift_id, department_id: input.department_id },
      title: input.is_day_off ? 'Recurring day off' : `Recurring ${input.shift_name} shift`,
      body: input.is_day_off
        ? `You now have a repeating day off — ${when}. ${created} date${created === 1 ? '' : 's'} added so far.`
        : `You're now on a repeating ${input.shift_name} (${input.start_time}–${input.end_time}) pattern — ${when}. ${created} date${created === 1 ? '' : 's'} added so far.`,
      link: '/my-schedule',
    });
  }
  return ref.id;
}

// Edit a pattern (weekdays, end date, shift window snapshot, …) and re-reconcile forward.
// No notification — routine roster housekeeping; the employee sees the grid/My Schedule change.
export async function updateSchedulePattern(
  id: string,
  patch: Partial<Omit<SchedulePattern, 'id' | 'created_at' | 'created_by'>>,
): Promise<{ created: number; removed: number }> {
  await updateDoc(doc(db, PATTERN_COL, id), { ...patch, updated_at: Timestamp.now() });
  const fresh = await getDoc(doc(db, PATTERN_COL, id));
  if (!fresh.exists()) return { created: 0, removed: 0 };
  return materializePattern({ id: fresh.id, ...fresh.data() } as SchedulePattern);
}

// Pause a pattern: keeps the record (shows as inactive) but clears every future occurrence.
// Reactivating + re-materialising restores them.
export async function setSchedulePatternActive(id: string, isActive: boolean): Promise<{ created: number; removed: number }> {
  return updateSchedulePattern(id, { is_active: isActive });
}

// Soft-delete: tombstone the pattern AND clear its future rows. Past rows stay as history.
export async function deleteSchedulePattern(id: string): Promise<{ removed: number }> {
  await updateDoc(doc(db, PATTERN_COL, id), { is_deleted: true, deleted_at: Timestamp.now() });
  const fresh = await getDoc(doc(db, PATTERN_COL, id));
  if (!fresh.exists()) return { removed: 0 };
  const { removed } = await materializePattern({ id: fresh.id, ...fresh.data() } as SchedulePattern);
  return { removed };
}

// ─── Weekly extend (Step 6 entry point) ──────────────────────────────────────
// Re-materialise every active pattern whose horizon has slipped behind. Called by the
// scheduled job. Idempotent and cheap when nothing is due. Returns a per-pattern summary.
export async function materializeDuePatterns(): Promise<{ scanned: number; extended: number; created: number; removed: number }> {
  const today = localDateString();
  const target = horizonEnd(today, HORIZON_WEEKS);
  const snap = await getDocs(query(collection(db, PATTERN_COL), where('is_active', '==', true)));
  const due = snap.docs
    .map((d) => ({ id: d.id, ...d.data() } as SchedulePattern))
    .filter((p) => !p.is_deleted && (p.materialized_through ?? '') < target);

  let created = 0, removed = 0;
  for (const p of due) {
    const r = await materializePattern(p);
    created += r.created;
    removed += r.removed;
  }
  return { scanned: snap.size, extended: due.length, created, removed };
}

// ─── Eligibility reconciliation ──────────────────────────────────────────────
// Called when an employee may have lost entitlement to a recurring pattern — HOD status
// cleared, offboarded, deactivated. Deactivates (is_active:false) every pattern that
// patternIsVoid() flags for them, which makes materializePattern clear every future row
// (>= today) that pattern owns; past rows stay as history. Idempotent — safe to call on
// every Schedule-page load and from the weekly cron.

// One employee. Pass `ctx` to reuse already-loaded data.
export async function reconcilePatternsForEmployee(
  epfNumber: string,
  ctx?: { user?: AppUser | null; shifts?: Shift[] },
): Promise<{ deactivated: number; removed: number }> {
  if (!epfNumber) return { deactivated: 0, removed: 0 };
  const active = (await getSchedulePatternsForEmployee(epfNumber)).filter((p) => p.is_active !== false);
  if (!active.length) return { deactivated: 0, removed: 0 };

  const user = ctx && 'user' in ctx ? ctx.user ?? null : await getUserByEpf(epfNumber);
  const shifts = ctx?.shifts ?? await getShiftDefinitions();
  const restrictedShifts = shifts.filter(shiftIsRestricted);
  const restrictedShiftIds = new Set(restrictedShifts.map((s) => s.id));

  const ownerGone = !user || user.is_active === false;
  const restrictedEligible = isRecurringDayOffEligible(user, restrictedShifts);

  let deactivated = 0, removed = 0;
  for (const p of active) {
    if (!patternIsVoid(p, ownerGone, restrictedEligible, restrictedShiftIds.has(p.shift_id))) continue;
    const r = await setSchedulePatternActive(p.id, false); // → materializePattern tombstones future rows
    removed += r.removed;
    deactivated += 1;
  }
  return { deactivated, removed };
}

// Every active pattern owner in one department — the Schedule page fires this on load as a
// self-heal (mirrors the auto-checkout inline guard + cron backstop pattern).
export async function reconcilePatternsForDepartment(
  departmentId: string,
): Promise<{ deactivated: number; removed: number }> {
  const active = (await getSchedulePatternsForDepartment(departmentId)).filter((p) => p.is_active !== false);
  if (!active.length) return { deactivated: 0, removed: 0 };
  const shifts = await getShiftDefinitions();
  const epfs = [...new Set(active.map((p) => p.epf_number))].filter(Boolean);
  const users = await Promise.all(epfs.map((e) => getUserByEpf(e).catch(() => null)));
  const userByEpf = new Map(epfs.map((e, i) => [e, users[i]]));

  let deactivated = 0, removed = 0;
  for (const epf of epfs) {
    const r = await reconcilePatternsForEmployee(epf, { user: userByEpf.get(epf) ?? null, shifts });
    deactivated += r.deactivated;
    removed += r.removed;
  }
  return { deactivated, removed };
}
