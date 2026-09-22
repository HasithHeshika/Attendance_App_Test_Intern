import {
  collection, doc, getDoc, getDocs, addDoc, updateDoc, setDoc, deleteDoc,
  query, where, orderBy, Timestamp, arrayUnion, arrayRemove, increment,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import type {
  AssignedTask, AssignedTaskPerson, AssignedTaskComment, TaskType,
  AssignedTaskEvent, AssignedTaskEventKind, AssignedTaskFlag, AssignedTaskFlagKind,
} from '@/lib/types';
import { localDateString } from '@/lib/utils';
import { getTeamRoster, type RosterMember } from './taskService';
import { createAppNotification } from './notificationService';

const ASSIGNED_TASK_COL = 'assigned_tasks';
const STATUS_CONFIG_COL = 'task_status_config';
const EVENTS_SUB = 'events';

/** Whoever is acting on a task — the signed-in user. */
export interface TaskActor { epf: string; name: string; }

function today() { return localDateString(); }

function millis(t: { toMillis?: () => number } | null | undefined): number {
  return t?.toMillis?.() ?? 0;
}

// ─── Write ─────────────────────────────────────────────────────────────────────
export interface AssignedTaskInput {
  company_id: string; company_name: string;
  description: string; task_type: TaskType; date: string;
  assignees: RosterMember[];
  assigned_by: string; assigned_by_name: string;
}

export async function createAssignedTask(input: AssignedTaskInput): Promise<string> {
  const now = Timestamp.now();
  const assignees: AssignedTaskPerson[] = input.assignees.map(m => ({
    epf_number: m.epf_number, employee_name: m.employee_name,
  }));
  const ref = await addDoc(collection(db, ASSIGNED_TASK_COL), {
    company_id: input.company_id, company_name: input.company_name,
    description: input.description, task_type: input.task_type, date: input.date,
    assignees, assignee_epfs: assignees.map(a => a.epf_number),
    status: 'Pending', completed_on: null,
    assigned_by: input.assigned_by, assigned_by_name: input.assigned_by_name,
    comment_count: 0,
    started_at: null, started_by: null, started_by_name: null,
    ended_at: null, ended_by: null, ended_by_name: null,
    status_note: null, status_changed_at: null, status_changed_by: null, status_changed_by_name: null,
    flag: null, original_date: null,
    created_at: now, updated_at: now,
  });
  await updateDoc(ref, { id: ref.id });

  const actor: TaskActor = { epf: input.assigned_by, name: input.assigned_by_name };
  await logEvent(ref.id, { kind: 'assigned', to_status: 'Pending', note: '' }, actor);
  // Everyone put on the task hears about it — a task nobody was told about is not assigned,
  // it is filed. The assigner assigning themselves needs no bell. createAppNotification never throws.
  await Promise.all(assignees
    .filter(a => a.epf_number !== input.assigned_by)
    .map(a => createAppNotification({
      toEpf: a.epf_number, type: 'task_assigned',
      actorEpf: input.assigned_by, actorName: input.assigned_by_name,
      meta: { task_id: ref.id, date: input.date },
      title: `${input.assigned_by_name} assigned you a task`,
      body: `"${input.description}" — due ${input.date}`.slice(0, 200),
      link: '/tasks',
    })));
  return ref.id;
}

// ─── Lifecycle: the trail, the clock, the flags ───────────────────────────────
// Every change below writes one append-only event under the task and mirrors the latest of
// it onto the task doc, so lists read one doc and the detail view reads the trail.

async function logEvent(
  taskId: string,
  e: { kind: AssignedTaskEventKind; from_status?: string | null; to_status?: string | null;
       note?: string; reason?: string | null; from_date?: string | null; to_date?: string | null },
  actor: TaskActor,
): Promise<void> {
  try {
    await addDoc(collection(db, ASSIGNED_TASK_COL, taskId, EVENTS_SUB), {
      kind: e.kind,
      from_status: e.from_status ?? null, to_status: e.to_status ?? null,
      note: (e.note ?? '').trim(),
      reason: e.reason ?? null,
      from_date: e.from_date ?? null, to_date: e.to_date ?? null,
      by_epf: actor.epf, by_name: actor.name,
      at: Timestamp.now(),
    });
  } catch (err) {
    // The trail is evidence, never a gate: a denied event write must not fail the change.
    console.warn('[assignedTask] event not recorded:', (err as { message?: string })?.message ?? err);
  }
}

export async function getAssignedTaskEvents(taskId: string): Promise<AssignedTaskEvent[]> {
  const snap = await getDocs(query(collection(db, ASSIGNED_TASK_COL, taskId, EVENTS_SUB), orderBy('at', 'asc')));
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as AssignedTaskEvent));
}

async function readTask(taskId: string): Promise<AssignedTask> {
  const snap = await getDoc(doc(db, ASSIGNED_TASK_COL, taskId));
  if (!snap.exists()) throw new Error('Task not found.');
  return { id: snap.id, ...snap.data() } as AssignedTask;
}

// Tell the assigner and the other people on the task — never the person acting.
async function notifyTaskPeople(
  task: AssignedTask, actor: TaskActor,
  n: { type: 'task_status' | 'task_flagged'; title: string; body: string },
): Promise<void> {
  const targets = new Set<string>([task.assigned_by, ...(task.assignee_epfs ?? [])]);
  targets.delete(actor.epf);
  await Promise.all([...targets].filter(Boolean).map(toEpf => createAppNotification({
    toEpf, type: n.type, actorEpf: actor.epf, actorName: actor.name,
    meta: { task_id: task.id, date: task.date },
    title: n.title, body: n.body.slice(0, 200), link: '/tasks',
  })));
}

const clock = (t: Timestamp) => t.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export async function deleteAssignedTask(id: string): Promise<void> {
  await deleteDoc(doc(db, ASSIGNED_TASK_COL, id));
}

// One status, shared by the whole task — a plain updateDoc is enough (no transaction):
// unlike a per-assignee array element, a single scalar field under concurrent writes is
// just an ordinary last-write-wins, not a lost update of separate people's data.
//
// With an `actor` this also keeps the clock and the trail: the first move out of 'Pending'
// stamps started_at, 'Completed' stamps ended_at (cleared again on reopen), any flag is
// cleared once work is moving, the note lands on the task and in the trail, and the assigner
// plus the other assignees are told. Without an actor it is the old bare status flip — kept
// so nothing that calls it with three arguments changes behaviour.
export async function updateAssignedTaskStatus(
  taskId: string, status: string, taskDate: string,
  opts: { actor?: TaskActor; note?: string } = {},
): Promise<void> {
  const now = Timestamp.now();
  if (!opts.actor) {
    await updateDoc(doc(db, ASSIGNED_TASK_COL, taskId), {
      status, completed_on: status === 'Completed' ? taskDate : null, updated_at: now,
    });
    return;
  }
  const actor = opts.actor;
  const task = await readTask(taskId);
  const from = task.status;
  const note = (opts.note ?? '').trim();
  const starting  = status !== 'Pending' && !task.started_at;
  const finishing = status === 'Completed';
  const reopening = from === 'Completed' && status !== 'Completed';

  const patch: Record<string, unknown> = {
    status, completed_on: finishing ? taskDate : null, updated_at: now,
    status_note: note || null, status_changed_at: now,
    status_changed_by: actor.epf, status_changed_by_name: actor.name,
  };
  if (starting)  { patch.started_at = now; patch.started_by = actor.epf; patch.started_by_name = actor.name; }
  if (finishing) { patch.ended_at = now; patch.ended_by = actor.epf; patch.ended_by_name = actor.name; }
  if (reopening) { patch.ended_at = null; patch.ended_by = null; patch.ended_by_name = null; }
  // Work is moving again, so a raised hand no longer applies.
  if (task.flag && status !== 'Pending') patch.flag = null;
  await updateDoc(doc(db, ASSIGNED_TASK_COL, taskId), patch);

  if (from !== status) await logEvent(taskId, { kind: 'status', from_status: from, to_status: status, note }, actor);
  else if (note)       await logEvent(taskId, { kind: 'note', note }, actor);
  if (starting)  await logEvent(taskId, { kind: 'started', note: '' }, actor);
  if (finishing && !task.ended_at) await logEvent(taskId, { kind: 'ended', note: '' }, actor);
  if (task.flag && status !== 'Pending') await logEvent(taskId, { kind: 'flag_cleared', note: 'Cleared — work moved on' }, actor);

  if (from !== status) {
    await notifyTaskPeople(task, actor, {
      type: 'task_status',
      title: finishing ? `${actor.name} completed a task` : `${actor.name} moved a task to ${status}`,
      body: `"${task.description}"${note ? ` — ${note}` : ''}${starting ? ` · started ${clock(now)}` : ''}${finishing ? ` · finished ${clock(now)}` : ''}`,
    });
  }
}

/** Start now: 'On Progress' with the clock stamped. */
export async function startAssignedTask(taskId: string, taskDate: string, actor: TaskActor, note?: string): Promise<void> {
  await updateAssignedTaskStatus(taskId, 'On Progress', taskDate, { actor, note });
}

/** Finish now: 'Completed' with the clock stamped. */
export async function completeAssignedTask(taskId: string, taskDate: string, actor: TaskActor, note?: string): Promise<void> {
  await updateAssignedTaskStatus(taskId, 'Completed', taskDate, { actor, note });
}

/** A note on its own — no status change, but it lands on the task and in the trail. */
export async function addAssignedTaskNote(taskId: string, actor: TaskActor, note: string): Promise<void> {
  const text = note.trim();
  if (!text) throw new Error('Write the note first.');
  await updateDoc(doc(db, ASSIGNED_TASK_COL, taskId), {
    status_note: text, status_changed_at: Timestamp.now(),
    status_changed_by: actor.epf, status_changed_by_name: actor.name, updated_at: Timestamp.now(),
  });
  await logEvent(taskId, { kind: 'note', note: text }, actor);
}

/**
 * Raise a hand: "cannot start" (with why) or "delayed" (with why, and optionally a new due
 * date). A reason is required — the assigner was not there. A new date moves the task's
 * `date` and keeps the first one in `original_date`, so the calendar shows it where it now
 * lands and the detail still says when it was first due. Tells the assigner and the others.
 */
export async function flagAssignedTask(
  taskId: string,
  input: { kind: AssignedTaskFlagKind; reason: string; until?: string | null },
  actor: TaskActor,
): Promise<void> {
  const reason = input.reason.trim();
  if (!reason) throw new Error('Say why.');
  const task = await readTask(taskId);
  const until = input.kind === 'delayed' && input.until && input.until !== task.date ? input.until : null;
  const now = Timestamp.now();
  const flag: AssignedTaskFlag = { kind: input.kind, reason, until, by_epf: actor.epf, by_name: actor.name, at: now };
  const patch: Record<string, unknown> = { flag, updated_at: now, status_note: reason, status_changed_at: now, status_changed_by: actor.epf, status_changed_by_name: actor.name };
  if (until) { patch.date = until; patch.original_date = task.original_date ?? task.date; }
  await updateDoc(doc(db, ASSIGNED_TASK_COL, taskId), patch);

  await logEvent(taskId, { kind: 'flagged', reason, note: input.kind === 'cannot_start' ? 'Cannot start' : 'Delayed', to_date: until }, actor);
  if (until) await logEvent(taskId, { kind: 'rescheduled', from_date: task.date, to_date: until, note: reason }, actor);

  await notifyTaskPeople(task, actor, {
    type: 'task_flagged',
    title: input.kind === 'cannot_start' ? `${actor.name} cannot start a task` : `${actor.name} flagged a task as delayed`,
    body: `"${task.description}" — ${reason}${until ? ` · now due ${until}` : ''}`,
  });
}

/** Lower the hand without changing status. */
export async function clearAssignedTaskFlag(taskId: string, actor: TaskActor, note?: string): Promise<void> {
  const task = await readTask(taskId);
  if (!task.flag) return;
  await updateDoc(doc(db, ASSIGNED_TASK_COL, taskId), { flag: null, updated_at: Timestamp.now() });
  await logEvent(taskId, { kind: 'flag_cleared', note: note ?? '' }, actor);
}

// Appends a new assignee without disturbing existing ones or the task's status.
// arrayUnion is itself atomic/idempotent — no transaction needed, and it naturally
// no-ops if this exact person is already present.
export async function addAssigneeToTask(taskId: string, member: RosterMember): Promise<void> {
  const person: AssignedTaskPerson = { epf_number: member.epf_number, employee_name: member.employee_name };
  await updateDoc(doc(db, ASSIGNED_TASK_COL, taskId), {
    assignees: arrayUnion(person),
    assignee_epfs: arrayUnion(member.epf_number),
    updated_at: Timestamp.now(),
  });
}

// Removes one assignee. arrayRemove needs the exact stored object, so this reads the
// doc first to find it — refuses (throws) if that would leave the task with nobody on
// it, since an assignee-less task would vanish from every board/dashboard silently.
export async function removeAssigneeFromTask(taskId: string, epf: string): Promise<void> {
  const ref = doc(db, ASSIGNED_TASK_COL, taskId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const data = snap.data() as AssignedTask;
  const target = (data.assignees ?? []).find(a => a.epf_number === epf);
  if (!target) return;
  if ((data.assignees ?? []).length <= 1) throw new Error('at-least-one-assignee-required');
  await updateDoc(ref, {
    assignees: arrayRemove(target),
    assignee_epfs: arrayRemove(epf),
    updated_at: Timestamp.now(),
  });
}

// ─── Comments (+ @mentions) ─────────────────────────────────────────────────────
export interface CommentInput {
  author_epf: string; author_name: string; text: string;
  mentioned: RosterMember[];       // resolved via src/lib/mentions.ts#parseMentions before calling
  taskDescription: string;         // for the notification title/link context
}

export async function addComment(taskId: string, input: CommentInput): Promise<void> {
  const now = Timestamp.now();
  const mentionedEpfs = input.mentioned.map(m => m.epf_number);
  await addDoc(collection(db, ASSIGNED_TASK_COL, taskId, 'comments'), {
    author_epf: input.author_epf, author_name: input.author_name, text: input.text,
    mentioned_epfs: mentionedEpfs, created_at: now,
  });
  // Best-effort denormalized count — not transactional, a slightly-off badge is low-stakes.
  await updateDoc(doc(db, ASSIGNED_TASK_COL, taskId), { comment_count: increment(1) }).catch(() => {});

  // Notify anyone mentioned (excluding the author mentioning themselves). Reuses the
  // existing notification system as-is — createAppNotification never throws.
  await Promise.all(
    input.mentioned
      .filter(m => m.epf_number !== input.author_epf)
      .map(m => createAppNotification({
        toEpf: m.epf_number,
        type: 'task_mention',
        actorEpf: input.author_epf,
        actorName: input.author_name,
        meta: { task_id: taskId },
        title: `${input.author_name} mentioned you`,
        body: `"${input.taskDescription}" — ${input.text}`.slice(0, 200),
        link: '/tasks',
      })),
  );
}

export async function getComments(taskId: string): Promise<AssignedTaskComment[]> {
  const snap = await getDocs(query(
    collection(db, ASSIGNED_TASK_COL, taskId, 'comments'), orderBy('created_at', 'asc'),
  ));
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as AssignedTaskComment));
}

// ─── Custom statuses (per-company shared Board columns) ─────────────────────────
export async function getCustomStatuses(companyId: string): Promise<string[]> {
  if (!companyId) return [];
  const snap = await getDoc(doc(db, STATUS_CONFIG_COL, companyId));
  const data = snap.data() as { statuses?: string[] } | undefined;
  return data?.statuses ?? [];
}

export async function addCustomStatus(companyId: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!companyId || !trimmed) return;
  await setDoc(doc(db, STATUS_CONFIG_COL, companyId), {
    company_id: companyId, statuses: arrayUnion(trimmed), updated_at: Timestamp.now(),
  }, { merge: true });
}

// ─── Read ──────────────────────────────────────────────────────────────────────
// Tasks assigned to (or including) `epf`, due today/overdue by default — powers the
// Dashboard widget and the personal Board. Bounded lookback like taskService's
// getDueTasks, with the same try/catch-fallback shape if the composite index isn't
// deployed yet.
export async function getMyAssignedTasks(
  epf: string, opts: { fromDate?: string; toDate?: string } = {},
): Promise<AssignedTask[]> {
  const toDate = opts.toDate ?? today();
  const from = new Date();
  from.setDate(from.getDate() - 30);
  const fromDate = opts.fromDate ?? localDateString(from);
  let snap;
  try {
    snap = await getDocs(query(
      collection(db, ASSIGNED_TASK_COL),
      where('assignee_epfs', 'array-contains', epf),
      where('date', '>=', fromDate),
      where('date', '<=', toDate),
    ));
  } catch {
    snap = await getDocs(query(collection(db, ASSIGNED_TASK_COL), where('assignee_epfs', 'array-contains', epf)));
  }
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() } as AssignedTask))
    .filter(t => t.date >= fromDate && t.date <= toDate)
    .sort((a, b) => a.date.localeCompare(b.date) || millis(a.created_at) - millis(b.created_at));
}

// Every assigned task visible to a supervisor/manager: same roster-scoping rules as
// taskService's getTeamTasks (direct reports, or company-wide) — a task shows if ANY
// of its assignees falls within the viewer's roster.
export async function getTeamAssignedTasks(opts: {
  viewerEpf: string; companyId?: string; companyWide?: boolean;
}): Promise<AssignedTask[]> {
  const roster = await getTeamRoster(opts);
  const rosterEpfs = new Set(roster.map(r => r.epf_number));
  if (!rosterEpfs.size) return [];
  const q = opts.companyId
    ? query(collection(db, ASSIGNED_TASK_COL), where('company_id', '==', opts.companyId))
    : query(collection(db, ASSIGNED_TASK_COL));
  const snap = await getDocs(q);
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() } as AssignedTask))
    .filter(t => (t.assignee_epfs ?? []).some(epf => rosterEpfs.has(epf)))
    .sort((a, b) => a.date.localeCompare(b.date) || millis(a.created_at) - millis(b.created_at));
}
