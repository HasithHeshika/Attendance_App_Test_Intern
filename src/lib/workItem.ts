import type { AssignedTask, DailyTask } from '@/lib/types';

// Normalizes a personal DailyTask and a shared AssignedTask into the same shape, so
// the Tasks page Board and the Dashboard "Today's Tasks" widget can render + act on
// both side by side even though they're backed by different Firestore
// collections/services. `kind` tells the caller which service to dispatch a status
// change to. An AssignedTask maps to exactly ONE WorkItem (one shared status for the
// whole task, not one per assignee).
export interface WorkItem {
  key: string;                       // stable render/dnd id: `daily:${id}` or `assigned:${id}`
  kind: 'daily' | 'assigned';
  id: string;                        // DailyTask id, or AssignedTask id
  description: string; date: string;
  status: string;                    // TaskStatus for 'daily'; free-form for 'assigned'
  employee_name: string;             // owner's name (daily), or joined assignee names (assigned)
  employee_epf?: string;             // dispatch target — only meaningful for 'daily'
  assigned_by_name?: string | null;
  hours?: number;
  commentCount?: number;
  // ── Assigned-task lifecycle (undefined for 'daily') — see AssignedTask in types.ts ──
  startedAt?: number | null;         // ms
  endedAt?: number | null;           // ms
  statusNote?: string | null;
  flag?: { kind: 'cannot_start' | 'delayed'; reason: string; until: string | null; by_name: string } | null;
  originalDate?: string | null;
  assigneeEpfs?: string[];
}

const ms = (t: { toMillis?: () => number } | null | undefined): number | null => t?.toMillis?.() ?? null;

export function toWorkItem(t: DailyTask): WorkItem {
  return {
    key: `daily:${t.id}`, kind: 'daily', id: t.id,
    description: t.description, date: t.date, status: t.status,
    employee_name: t.employee_name, employee_epf: t.epf_number,
    assigned_by_name: t.assigned_by_name, hours: Number(t.hours) || 0,
  };
}

export function assignedTaskToWorkItem(a: AssignedTask): WorkItem {
  return {
    key: `assigned:${a.id}`, kind: 'assigned', id: a.id,
    description: a.description, date: a.date, status: a.status,
    employee_name: (a.assignees ?? []).map(p => p.employee_name).join(', '),
    assigned_by_name: a.assigned_by_name, commentCount: a.comment_count,
    startedAt: ms(a.started_at), endedAt: ms(a.ended_at),
    statusNote: a.status_note ?? null,
    flag: a.flag ? { kind: a.flag.kind, reason: a.flag.reason, until: a.flag.until ?? null, by_name: a.flag.by_name } : null,
    originalDate: a.original_date ?? null,
    assigneeEpfs: a.assignee_epfs ?? [],
  };
}
