/**
 * Server-side client for LogPup's external REST API (`/api/external/*`). The shared
 * `LOGPUP_API_KEY` is sent server-to-server only — NEVER import this from client code (it would
 * leak the key). Use it inside API route handlers (src/app/api/logpup/**) that the browser calls
 * instead.
 *
 * Same shape and the same rules as src/lib/solarApi.ts, which is the pattern this follows.
 *
 * Docs: LOGPUP_TASKS_INTEGRATION.md, and LogPup/docs/attendance-task-bridge.md for the far side.
 */
import type { LogPupStatus } from '@/lib/logpupStatus';

// LogPup is deployed at management.altavision.lk, NOT at a logpup.* host — the fallback said
// otherwise, so a dropped LOGPUP_APP_URL would have sent every bridge call to a hostname that
// does not serve LogPup, and the tasks section would have degraded to "empty" rather than
// "misconfigured". The env var still wins; this is only what happens when it is missing.
const BASE = (process.env.LOGPUP_APP_URL || 'https://management.altavision.lk').replace(/\/$/, '');

/** How long we wait on LogPup before giving up. The tasks page must not hang on it. */
const TIMEOUT_MS = 8000;

function authHeaders(): Record<string, string> {
  // TRIMMED because a key pasted into a hosting dashboard keeps its surrounding whitespace,
  // while a .env file's parser strips it — so the same value works locally and 401s in
  // production, which is an unpleasant afternoon. LogPup compares sha256 digests
  // (bridge-auth.ts, bridgeKeyValid) with no trim of its own, and a shared secret never
  // legitimately begins or ends with a space.
  const key = process.env.LOGPUP_API_KEY?.trim();
  if (!key) throw new Error('LOGPUP_API_KEY is not configured');
  return { 'x-api-key': key, Accept: 'application/json' };
}

/** True when the integration is configured at all. Lets a route answer "off" rather than throw. */
export function logpupConfigured(): boolean {
  return !!process.env.LOGPUP_API_KEY?.trim();
}

export const LOGPUP_BASE_URL = BASE;

// ─── Wire types (what LogPup sends) ─────────────────────────────────────────────
export interface LogPupTaskApp { id: string; name: string; slug: string }
export interface LogPupTaskSprint { id: string; name: string; endDate: string | null }

export interface LogPupTask {
  id: string;
  title: string;
  description: string | null;
  /** LogPup's enum: todo | in_progress | done. Mapped for display by @/lib/logpupStatus. */
  status: string;
  priority: number;
  /** Plain YYYY-MM-DD, or null. NEVER parse this into a Date — see the note in the UI. */
  dueDate: string | null;
  dueKind: 'target' | 'committed';
  dueCommitmentNote: string | null;
  originalDueDate: string | null;
  isPrimaryAssignee: boolean;
  assigneeCount: number;
  app: LogPupTaskApp | null;
  sprint: LogPupTaskSprint | null;
  completedAt: string | null;
  createdAt: string;
  /** Deep link into LogPup's board for this task's app. */
  url: string | null;
}

export interface LogPupTasksResponse {
  success: boolean;
  /** false when the email is unknown to LogPup or outside its bridge domains. Not an error. */
  matched: boolean;
  user?: { id: string; email: string; name: string };
  count: number;
  data: LogPupTask[];
  timestamp?: string;
}

export interface LogPupTaskResponse {
  success: boolean;
  task?: LogPupTask;
  error?: string;
}

/** What a caller gets back from a failed write, with LogPup's own sentence preserved. */
export class LogPupError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'LogPupError';
  }
}

async function withTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal, cache: 'no-store' });
  } finally {
    clearTimeout(timer);
  }
}

// ─── Read ───────────────────────────────────────────────────────────────────────
export async function getLogPupTasks(who: {
  email: string;
  status?: 'open' | 'all';
  limit?: number;
}): Promise<LogPupTasksResponse> {
  const url = new URL(`${BASE}/api/external/tasks`);
  url.searchParams.set('email', who.email);
  if (who.status) url.searchParams.set('status', who.status);
  if (who.limit) url.searchParams.set('limit', String(who.limit));

  const res = await withTimeout(url.toString(), { headers: authHeaders() });
  if (!res.ok) throw new LogPupError(`LogPup tasks → ${res.status}`, res.status);
  return (await res.json()) as LogPupTasksResponse;
}

// ─── Write ──────────────────────────────────────────────────────────────────────
/**
 * Move one task's status.
 *
 * `email` is the ACTING person, resolved server-side from a verified ID token by the caller —
 * never from a request body. LogPup re-derives permission from it and refuses anyone who is not
 * an assignee, so this is not a trusted assertion, but sending the wrong one would still move
 * somebody else's work if they happened to be on the task.
 *
 * Throws LogPupError carrying LogPup's own sentence. Unlike the read, this must NOT be
 * swallowed: a write that silently fails shows a status that did not save.
 */
export async function setLogPupTaskStatus(args: {
  taskId: string;
  email: string;
  status: LogPupStatus;
  note?: string;
}): Promise<LogPupTaskResponse> {
  const res = await withTimeout(
    `${BASE}/api/external/tasks/${encodeURIComponent(args.taskId)}/status`,
    {
      method: 'PATCH',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: args.email, status: args.status, note: args.note }),
    },
  );

  const text = await res.text();
  let parsed: LogPupTaskResponse | undefined;
  try { parsed = JSON.parse(text) as LogPupTaskResponse; } catch { /* not JSON */ }

  if (!res.ok) {
    // LogPup answers refusals with a sentence written for a person ("You are not on this
    // task", "LogPup is in a maintenance window"). Keeping it is the whole point — rewriting
    // it into "Something went wrong" throws away the only useful part.
    throw new LogPupError(parsed?.error || `LogPup rejected the change (${res.status})`, res.status);
  }
  if (!parsed?.success || !parsed.task) {
    throw new LogPupError(parsed?.error || 'LogPup did not confirm the change', 502);
  }
  return parsed;
}
