// Pure formatting helpers for the assigned-task lifecycle UI (start/end clock, durations,
// status tone). No React, no Firebase — safe to use from any surface.

export type StatusTone = 'success' | 'warning' | 'secondary' | 'brand';

/** Badge variant for a task status. Custom statuses (beyond the built-in three) read as brand. */
export function statusTone(status: string): StatusTone {
  if (status === 'Completed') return 'success';
  if (status === 'On Progress') return 'warning';
  if (status === 'Pending') return 'secondary';
  return 'brand';
}

/** "09:12" — the viewer's locale, hour and minute only. */
export function fmtClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** "Sep 5" from a YYYY-MM-DD string. Parsed as a local date so it never shifts a day. */
export function fmtDay(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) return ymd;
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** "Sep 5 · 09:12" for a timeline row. */
export function fmtStamp(ms: number): string {
  const d = new Date(ms);
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${fmtClock(ms)}`;
}

/**
 * "45m", "2h 10m", "3d 2h" — the largest two units that matter. Under a minute rounds to
 * "0m" rather than showing seconds; nobody times a task to the second.
 */
export function fmtDuration(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const m = mins % 60;
  if (hours < 24) return m ? `${hours}h ${m}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const h = hours % 24;
  return h ? `${days}d ${h}h` : `${days}d`;
}

/** Milliseconds between start and end — or between start and now while still running. */
export function elapsedSince(startMs: number, endMs: number | null | undefined, nowMs: number = Date.now()): number {
  return Math.max(0, (endMs ?? nowMs) - startMs);
}
