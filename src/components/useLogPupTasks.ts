'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { auth, tenant } from '@/lib/firebase';
import type { LogPupTask } from '@/lib/logpupApi';
import { toLogPupStatus, type LogPupMappedStatus } from '@/lib/logpupStatus';

export type { LogPupTask };

/**
 * The signed-in person's own LogPup tasks, polled through the server proxy (/api/logpup/tasks).
 *
 * INERT ON EVERY OTHER TENANT. LogPup is an Alta Vision system (tenant.features.logpupTasks), so
 * on Southern Lanka this hook issues NO request at all — not "fetch then hide". Same posture as
 * useSolarNotifications, and for the same reason: another organisation's people must never
 * appear in a request to a system that is not theirs.
 *
 * Degrades quietly. The proxy answers 200 with an empty list when LogPup is unreachable, so a
 * failure shows an empty section with a notice rather than breaking the tasks page.
 */
export function useLogPupTasks(enabled: boolean): {
  tasks: LogPupTask[];
  loading: boolean;
  /** False once a poll has come back without success — drives the quiet "couldn't reach" line. */
  reachable: boolean;
  refetch: () => Promise<void>;
  setStatus: (taskId: string, next: LogPupMappedStatus) => Promise<void>;
  /** Task ids currently being saved, so rows can show a pending state. */
  saving: ReadonlySet<string>;
} {
  const on = enabled && tenant.features.logpupTasks;

  const [tasks, setTasks] = useState<LogPupTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [reachable, setReachable] = useState(true);
  const [saving, setSaving] = useState<Set<string>>(() => new Set());
  // Held in a ref so setStatus can await the same poll the interval uses, without either one
  // being rebuilt on every render.
  const pollRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    if (!on) return;
    let stopped = false;

    const poll = async () => {
      try {
        const idToken = await auth.currentUser?.getIdToken();
        if (!idToken || stopped) return;
        const res = await fetch('/api/logpup/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken }),
        });
        if (stopped) return;
        const data = await res.json().catch(() => null);
        if (stopped) return;
        if (!res.ok || !data?.success) {
          // `configured: false` means the integration is switched off at this deployment, not
          // that LogPup is down. Saying "couldn't reach LogPup" there would be a permanent,
          // wrong line the user cannot act on.
          setReachable(data?.configured === false ? true : false);
          return;
        }
        setReachable(true);
        setTasks(Array.isArray(data.data) ? (data.data as LogPupTask[]) : []);
      } catch {
        if (!stopped) setReachable(false);
      } finally {
        if (!stopped) setLoading(false);
      }
    };

    pollRef.current = poll;
    setLoading(true);
    void poll();
    // 60s, matching the Solar feed. Its comment records that 30s doubled backend load at 300+
    // users for no visible freshness win, and this poll crosses an application boundary too.
    const id = setInterval(poll, 60_000);
    const onFocus = () => void poll();
    window.addEventListener('focus', onFocus);
    return () => {
      stopped = true;
      clearInterval(id);
      window.removeEventListener('focus', onFocus);
    };
  }, [on]);

  const refetch = useCallback(async () => {
    if (on) await pollRef.current();
  }, [on]);

  /**
   * Move a task's status.
   *
   * NO OPTIMISTIC UPDATE, deliberately: the authoritative status is the one LogPup returns, not
   * the one we sent. The row stays in a saving state until the response lands, and the task in
   * the response replaces the local one. Throws on failure so the caller can show LogPup's own
   * sentence.
   */
  const setStatus = useCallback(async (taskId: string, next: LogPupMappedStatus) => {
    const idToken = await auth.currentUser?.getIdToken();
    if (!idToken) throw new Error('Please sign in again');

    setSaving(prev => new Set(prev).add(taskId));
    try {
      const res = await fetch(`/api/logpup/tasks/${encodeURIComponent(taskId)}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken, status: toLogPupStatus(next) }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success || !data.task) {
        throw new Error(data?.error || 'Could not update the task in LogPup');
      }
      const updated = data.task as LogPupTask;
      setTasks(prev => prev.map(t => (t.id === updated.id ? updated : t)));
    } finally {
      setSaving(prev => {
        const nextSet = new Set(prev);
        nextSet.delete(taskId);
        return nextSet;
      });
    }
  }, []);

  return { tasks, loading, reachable, refetch, setStatus, saving };
}
