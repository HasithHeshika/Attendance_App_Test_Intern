import type { TaskStatus } from '@/lib/types';

/**
 * The status vocabulary boundary between LogPup and this app.
 *
 * LogPup's `task_status` is a Postgres enum with exactly three lowercase values and no others.
 * Ours is `TASK_STATUSES` — title-case, shown to people, and (for AssignedTask) deliberately
 * widened to a plain `string` so a tenant can configure custom statuses beyond the three.
 *
 * That asymmetry is the whole reason this file exists as its own module rather than two inline
 * object literals. Mapping LogPup → here is total and safe: every value it can send has a home.
 * Mapping here → LogPup is NOT, because our side can legitimately hold a status LogPup has no
 * word for, and the tempting fallback ("anything unrecognised becomes todo") would silently
 * reopen finished work. So that direction throws, and the caller is required to have narrowed
 * the value first — which in practice means the picker on a LogPup row offers only these three
 * and never the custom statuses the assigned_tasks picker offers.
 */

/** LogPup's `task_status` enum, exactly. */
export const LOGPUP_STATUSES = ['todo', 'in_progress', 'done'] as const;
export type LogPupStatus = (typeof LOGPUP_STATUSES)[number];

/** The three Attendance statuses a LogPup task can be in. A subset of TASK_STATUSES. */
export type LogPupMappedStatus = Extract<TaskStatus, 'Pending' | 'On Progress' | 'Completed'>;

const TO_ATTENDANCE: Record<LogPupStatus, LogPupMappedStatus> = {
  todo: 'Pending',
  in_progress: 'On Progress',
  done: 'Completed',
};

const TO_LOGPUP: Record<LogPupMappedStatus, LogPupStatus> = {
  Pending: 'todo',
  'On Progress': 'in_progress',
  Completed: 'done',
};

/** The order the three are shown in — LogPup's own board order, not alphabetical. */
export const LOGPUP_STATUS_ORDER: readonly LogPupMappedStatus[] = [
  'Pending', 'On Progress', 'Completed',
];

export function isLogPupStatus(value: unknown): value is LogPupStatus {
  return typeof value === 'string' && (LOGPUP_STATUSES as readonly string[]).includes(value);
}

/**
 * LogPup's word → ours. Total over the enum.
 *
 * An unknown value means LogPup grew a fourth status and this app has not been told. Falling
 * back to 'Pending' would render finished work as outstanding, so the caller gets null and
 * decides — the list shows the row with its raw status rather than a wrong one.
 */
export function toAttendanceStatus(status: string): LogPupMappedStatus | null {
  return isLogPupStatus(status) ? TO_ATTENDANCE[status] : null;
}

/**
 * Ours → LogPup's word. PARTIAL, and it throws rather than guessing.
 *
 * Only ever called with a value the caller took from LOGPUP_STATUS_ORDER. A custom tenant
 * status reaching here is a bug at the call site — a picker offering something LogPup cannot
 * store — and the throw is how that bug surfaces in development instead of quietly writing the
 * wrong status to somebody else's database.
 */
export function toLogPupStatus(status: string): LogPupStatus {
  const mapped = (TO_LOGPUP as Record<string, LogPupStatus | undefined>)[status];
  if (!mapped) {
    throw new Error(`No LogPup status for "${status}" — LogPup stores only ${LOGPUP_STATUSES.join(', ')}`);
  }
  return mapped;
}

/** Whether a status means the work is finished. Used for the open/done split in the list. */
export function isLogPupDone(status: string): boolean {
  return status === 'done';
}
