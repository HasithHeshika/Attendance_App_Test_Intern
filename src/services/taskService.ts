import {
  collection, doc, getDocs, updateDoc, deleteDoc, setDoc, writeBatch,
  query, where, Timestamp,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import type {
  DailyTask, TaskType, TaskStatus, AttendanceRecord, AttendanceSession,
} from '@/lib/types';
import { localDateString } from '@/lib/utils';
import { getAttendanceByDate } from './attendanceService';

const TASK_COL = 'tasks';

function today() { return localDateString(); }

function millis(t: { toMillis?: () => number } | null | undefined): number {
  return t?.toMillis?.() ?? 0;
}

// ─── Read ──────────────────────────────────────────────────────────────────────
export async function getTasksByDate(epf: string, date: string): Promise<DailyTask[]> {
  // Equality-only filters merge on single-field indexes — no composite required.
  const q = query(collection(db, TASK_COL), where('epf_number', '==', epf), where('date', '==', date));
  const snap = await getDocs(q);
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() } as DailyTask))
    .sort((a, b) => millis(a.created_at) - millis(b.created_at));
}

export async function getMonthlyTasks(
  epf: string, year: number, month: number,
): Promise<DailyTask[]> {
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  // Range on date uses the tasks(epf_number, date) composite index. If the deployed
  // index set is ever behind the repo (failed-precondition), fall back to the old
  // full-history scan filtered client-side rather than showing an empty month.
  let snap;
  try {
    snap = await getDocs(query(
      collection(db, TASK_COL),
      where('epf_number', '==', epf),
      where('date', '>=', `${prefix}-01`),
      where('date', '<=', `${prefix}-31`),
    ));
  } catch {
    snap = await getDocs(query(collection(db, TASK_COL), where('epf_number', '==', epf)));
  }
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() } as DailyTask))
    .filter(t => typeof t.date === 'string' && t.date.startsWith(prefix))
    .sort((a, b) => a.date.localeCompare(b.date) || millis(a.created_at) - millis(b.created_at));
}

// Tasks due today or overdue (date <= today, not yet Completed) — powers the
// Dashboard "Today's Tasks" widget. Bounded to a lookback window so a long-tenured
// user's ancient abandoned tasks don't turn this into a full-history scan; anything
// older simply stops nagging the dashboard while staying visible on the full /tasks
// page. Same range-query + client-filter shape as getMonthlyTasks.
export async function getDueTasks(epf: string, lookbackDays = 30): Promise<DailyTask[]> {
  const todayStr = today();
  const from = new Date();
  from.setDate(from.getDate() - lookbackDays);
  const fromStr = localDateString(from);
  let snap;
  try {
    snap = await getDocs(query(
      collection(db, TASK_COL),
      where('epf_number', '==', epf),
      where('date', '>=', fromStr),
      where('date', '<=', todayStr),
    ));
  } catch {
    snap = await getDocs(query(collection(db, TASK_COL), where('epf_number', '==', epf)));
  }
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() } as DailyTask))
    .filter(t => t.status !== 'Completed' && t.date >= fromStr && t.date <= todayStr)
    .sort((a, b) => a.date.localeCompare(b.date));
}

// Distinct still-open ('On Progress') tasks for autocomplete, so a user can quickly
// continue pending work. Excludes already-rolled originals (rolled_to set) so each
// open work item appears once, most recent first.
export interface TaskSuggestion {
  description: string; task_type: TaskType; remarks: string; date: string;
}

export async function getOpenTaskSuggestions(epf: string): Promise<TaskSuggestion[]> {
  if (!epf) return [];
  // Status filtered server-side (equality-only) — open tasks are a tiny slice of history.
  const q = query(collection(db, TASK_COL), where('epf_number', '==', epf), where('status', '==', 'On Progress'));
  const snap = await getDocs(q);
  const open = snap.docs
    .map(d => ({ id: d.id, ...d.data() } as DailyTask))
    .filter(t => !t.rolled_to && t.description?.trim())
    .sort((a, b) => a.date.localeCompare(b.date)); // ascending → later overwrites keep the most recent

  const byDesc = new Map<string, TaskSuggestion>();
  for (const t of open) {
    byDesc.set(t.description.trim().toLowerCase(), {
      description: t.description.trim(), task_type: t.task_type, remarks: t.remarks ?? '', date: t.date,
    });
  }
  return Array.from(byDesc.values()).sort((a, b) => b.date.localeCompare(a.date));
}

// Roster of teammates a viewer may see/assign tasks to:
//   • Line supervisors → their direct reports (users whose supervisor_epf is theirs).
//   • Company-wide viewers (HR / managers / admins) → everyone active in their company,
//     including themselves, so back-office roles get the full picture.
export interface RosterMember {
  epf_number: string; employee_name: string; company_id: string;
  company_name: string; department: string;
}

export async function getTeamRoster(opts: {
  viewerEpf: string;
  companyId?: string;
  companyWide?: boolean;
}): Promise<RosterMember[]> {
  const { viewerEpf, companyId, companyWide } = opts;
  const empQ = companyWide
    ? (companyId
        ? query(collection(db, 'users'), where('company_id', '==', companyId), where('is_active', '==', true))
        : query(collection(db, 'users'), where('is_active', '==', true)))
    : query(collection(db, 'users'), where('supervisor_epf', '==', viewerEpf), where('is_active', '==', true));

  const empSnap = await getDocs(empQ);
  const byEpf = new Map<string, RosterMember>();
  empSnap.docs.forEach(d => {
    const u = d.data() as Record<string, unknown>;
    const epf = u.epf_number as string;
    if (!epf || byEpf.has(epf)) return;
    byEpf.set(epf, {
      epf_number:   epf,
      employee_name: (u.display_name as string) ?? epf,
      company_id:    (u.company_id as string) ?? '',
      company_name:  (u.company_name as string) ?? '',
      department:    (u.department as string) ?? '',
    });
  });
  return Array.from(byEpf.values()).sort((a, b) => a.employee_name.localeCompare(b.employee_name));
}

// Read-only team view of tasks on a given date (see getTeamRoster for the audience rules).
export async function getTeamTasks(opts: {
  viewerEpf: string;
  date: string;
  companyId?: string;
  companyWide?: boolean;
}): Promise<DailyTask[]> {
  const { date } = opts;
  const roster = await getTeamRoster(opts);
  const epfs = roster.map(r => r.epf_number);
  if (!epfs.length) return [];

  // Firestore 'in' supports max 30 values — chunk, and run the chunks concurrently.
  // The date is filtered server-side ('in' counts as equality, so it merges with the
  // date equality on single-field indexes) — previously this downloaded every task
  // ever logged by the whole team to keep one day.
  const chunks: string[][] = [];
  for (let i = 0; i < epfs.length; i += 30) chunks.push(epfs.slice(i, i + 30));
  const snaps = await Promise.all(chunks.map(chunk => getDocs(query(
    collection(db, TASK_COL), where('epf_number', 'in', chunk), where('date', '==', date),
  ))));
  const all: DailyTask[] = [];
  snaps.forEach(snap => snap.docs.forEach(d => {
    const t = { id: d.id, ...d.data() } as DailyTask;
    if (t.date === date) all.push(t);
  }));
  return all.sort(
    (a, b) => a.employee_name.localeCompare(b.employee_name) || millis(a.created_at) - millis(b.created_at),
  );
}

// Month-ranged team view — powers the team Board (a single day is too narrow for a
// persistent Kanban view). Same roster/audience rules as getTeamTasks, but a date
// RANGE instead of equality; still fits the tasks(epf_number, date) composite index
// (Firestore merges 'in' with one range field under the same index shape).
export async function getTeamTasksForMonth(opts: {
  viewerEpf: string;
  year: number;
  month: number;
  companyId?: string;
  companyWide?: boolean;
}): Promise<DailyTask[]> {
  const { year, month } = opts;
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  const roster = await getTeamRoster(opts);
  const epfs = roster.map(r => r.epf_number);
  if (!epfs.length) return [];

  const chunks: string[][] = [];
  for (let i = 0; i < epfs.length; i += 30) chunks.push(epfs.slice(i, i + 30));
  const snaps = await Promise.all(chunks.map(chunk => getDocs(query(
    collection(db, TASK_COL), where('epf_number', 'in', chunk),
    where('date', '>=', `${prefix}-01`), where('date', '<=', `${prefix}-31`),
  ))));
  const all: DailyTask[] = [];
  snaps.forEach(snap => snap.docs.forEach(d => {
    const t = { id: d.id, ...d.data() } as DailyTask;
    if (typeof t.date === 'string' && t.date.startsWith(prefix)) all.push(t);
  }));
  return all.sort(
    (a, b) => a.employee_name.localeCompare(b.employee_name) || millis(a.created_at) - millis(b.created_at),
  );
}

// ─── Write ─────────────────────────────────────────────────────────────────────
export interface TaskInput {
  epf_number:    string;
  employee_name: string;
  company_id:    string;
  company_name:  string;
  department:    string;
  date:          string;
  session_id:    string | null;
  working_place: string | null;
  description:   string;
  task_type:     TaskType;
  status:        TaskStatus;
  hours:         number;
  remarks:       string;
  // Set when a supervisor assigns this task via the Team "Assign Task" flow;
  // absent/null for a task the owner logged themselves.
  assigned_by?:      string | null;
  assigned_by_name?: string | null;
  // Shared by every doc created from one multi-assignee Assign Task submission.
  assignment_group_id?: string | null;
}

export async function createTask(input: TaskInput): Promise<string> {
  const now = Timestamp.now();
  // The id is generated up front and written INSIDE the create — never mirrored on by a
  // second updateDoc. firestore.rules allows the create on `epf_number != null` alone but
  // gates the update on the owner/approver branches, so a caller whose token is missing
  // its claims used to land the create and get denied on the mirror: the toast said
  // "Failed to save task" while an id-less ghost doc stayed behind, and every retry made
  // another one. One write means the task exists complete or not at all.
  const ref = doc(collection(db, TASK_COL));
  await setDoc(ref, {
    ...input,
    id:               ref.id,
    assigned_by:      input.assigned_by ?? null,
    assigned_by_name: input.assigned_by_name ?? null,
    assignment_group_id: input.assignment_group_id ?? null,
    rolled_from:  null,
    rolled_to:    null,
    // A brand-new task created directly as Completed is finished the same day.
    completed_on: input.status === 'Completed' ? input.date : null,
    created_at:   now,
    updated_at:   now,
  });
  return ref.id;
}

// Status state machine shared by the Tasks page checkbox-cycle and the Dashboard
// widget, so the click-to-advance behaviour can't drift between the two.
export function nextTaskStatus(s: TaskStatus): TaskStatus {
  if (s === 'Pending') return 'On Progress';
  if (s === 'On Progress') return 'Completed';
  return 'On Progress'; // Completed → reopen
}

export async function updateTask(
  id: string, patch: Partial<Omit<DailyTask, 'id' | 'created_at'>>,
): Promise<void> {
  await updateDoc(doc(db, TASK_COL, id), { ...patch, updated_at: Timestamp.now() });
}

// ─── Completion date propagation ─────────────────────────────────────────────────
// A carried-over task is really one logical task spread across several day-docs linked
// via rolled_from/rolled_to. Walk the whole chain (both directions) from a starting id.
function chainIds(startId: string, byId: Map<string, DailyTask>): string[] {
  const ids = new Set<string>([startId]);
  let cur = byId.get(startId);
  while (cur?.rolled_from && byId.has(cur.rolled_from) && !ids.has(cur.rolled_from)) {
    ids.add(cur.rolled_from);
    cur = byId.get(cur.rolled_from);
  }
  cur = byId.get(startId);
  while (cur?.rolled_to && byId.has(cur.rolled_to) && !ids.has(cur.rolled_to)) {
    ids.add(cur.rolled_to);
    cur = byId.get(cur.rolled_to);
  }
  return Array.from(ids);
}

// Stamp (or clear) the completion date on EVERY other day-doc in the task's rolled chain,
// so each day the task appeared shows when it was finished. The origin doc itself is left
// to the caller (updateTask sets its status + completed_on together). No-op for a task with
// no chain. `completedOn` is a YYYY-MM-DD date, or null to clear on re-open.
export async function propagateCompletion(
  task: DailyTask, completedOn: string | null,
): Promise<void> {
  const snap = await getDocs(query(collection(db, TASK_COL), where('epf_number', '==', task.epf_number)));
  const byId = new Map(snap.docs.map(d => [d.id, { id: d.id, ...d.data() } as DailyTask]));
  const ids = chainIds(task.id, byId).filter(id => id !== task.id);
  if (!ids.length) return;
  const now = Timestamp.now();
  await Promise.all(ids.map(id =>
    updateDoc(doc(db, TASK_COL, id), { completed_on: completedOn, updated_at: now }),
  ));
}

export async function deleteTask(id: string): Promise<void> {
  await deleteDoc(doc(db, TASK_COL, id));
}

// ─── Carry-over ────────────────────────────────────────────────────────────────
// Roll every still-'On Progress' task from a previous day forward to TODAY, once.
// Idempotent: a task that has already been rolled (rolled_to set) is skipped, so
// repeatedly opening the page never duplicates. Returns the number rolled.
export async function rollOverOpenTasks(epf: string): Promise<number> {
  const todayStr = today();
  // Status filtered server-side (equality-only); date/rolled_to filtered client-side.
  const q = query(collection(db, TASK_COL), where('epf_number', '==', epf), where('status', '==', 'On Progress'));
  const snap = await getDocs(q);
  const open = snap.docs
    .map(d => ({ id: d.id, ...d.data() } as DailyTask))
    .filter(t => t.date < todayStr && !t.rolled_to);

  // Each task rolls independently — run them concurrently instead of 3 serial
  // round trips per task, which used to stall the page for users returning
  // after a few days away.
  await Promise.all(open.map(async (t) => {
    const now = Timestamp.now();
    // ONE batch: the new day's copy and the source's rolled_to marker commit together or
    // not at all. Split across two writes, a caller the rules let create but not update
    // (a token missing its capability claims) would land the copy and never mark the
    // source rolled — so the next page open rolled it AGAIN, duplicating the task on
    // every single load. Atomicity is what makes the "idempotent" claim above true.
    const batch = writeBatch(db);
    const ref = doc(collection(db, TASK_COL));
    batch.set(ref, {
      id:            ref.id,
      epf_number:    t.epf_number,
      employee_name: t.employee_name,
      company_id:    t.company_id,
      company_name:  t.company_name,
      department:    t.department,
      date:          todayStr,
      session_id:    null,        // day-level until the user attaches it to a session
      working_place: null,
      description:   t.description,
      task_type:     t.task_type,
      status:        'On Progress' as TaskStatus,
      hours:         0,           // fresh hours for the new day
      remarks:       t.remarks,
      rolled_from:   t.id,
      rolled_to:     null,
      completed_on:  null,        // still open on the new day
      created_at:    now,
      updated_at:    now,
    });
    batch.update(doc(db, TASK_COL, t.id), { rolled_to: ref.id, updated_at: now });
    await batch.commit();
  }));
  return open.length;
}

// ─── Hours reconciliation ──────────────────────────────────────────────────────
// Worked hours derived from an attendance record's sessions (Σ check_out − check_in),
// rounded to 2dp. Falls back to the legacy single-session fields for old docs.
export function computeWorkedHours(record: AttendanceRecord | null): number {
  if (!record) return 0;
  const sessions: AttendanceSession[] = record.sessions?.length
    ? record.sessions
    : [{ check_in: record.check_in, check_out: record.check_out } as AttendanceSession];
  let mins = 0;
  for (const s of sessions) {
    const ci = millis(s.check_in);
    const co = millis(s.check_out);
    if (ci && co && co > ci) mins += (co - ci) / 60_000;
  }
  return Math.round((mins / 60) * 100) / 100;
}

// The day's attendance record (with sessions) — used both to list sessions a task
// can attach to and to reconcile logged hours against attended hours.
export async function getDayAttendance(
  epf: string, date: string,
): Promise<AttendanceRecord | null> {
  return getAttendanceByDate(epf, date);
}
