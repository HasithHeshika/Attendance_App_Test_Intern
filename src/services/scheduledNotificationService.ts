'use client';
// Scheduled (one-time) notifications. A composer writes a `pending` doc here with a send_at;
// a server cron (/api/cron/dispatch-notifications, triggered by Firebase Cloud Scheduler)
// fans it out to the `notifications` collection + FCM at the scheduled time and flips it to
// `sent`. Gated in the UI by `can_send_notifications`.

import {
  collection, doc, getDocs, updateDoc, serverTimestamp, Timestamp,
} from 'firebase/firestore';
import { auth, db } from '@/lib/firebase';

const COL = 'scheduled_notifications';

export type ScheduledStatus = 'pending' | 'sending' | 'sent' | 'canceled' | 'failed';

export interface ScheduledNotification {
  id:              string;
  audience:        'all' | null;
  to_epfs:         string[] | null;
  title:           string;
  body:            string;
  link:            string | null;
  send_at:         Timestamp | null;
  status:          ScheduledStatus;
  actor_epf:       string | null;
  actor_name:      string | null;
  recipient_count: number;         // 0 for a broadcast; N for selected recipients
  created_at:      Timestamp | null;
  sent_at:         Timestamp | null;
  error:           string | null;
}

/**
 * Queue a one-time notification.
 *
 * Goes through /api/notify/compose, the same route an immediate send uses, for the same reason:
 * a scheduled notification is a promise to write to those people later, so who the sender may
 * reach has to be checked when they press the button — by the server, from their token. This
 * used to be a client-side addDoc, which meant the reach was never checked at all and the
 * dispatch cron would faithfully deliver whatever list it found.
 *
 * The route freezes the expanded recipient list onto the pending document, so the cron sends
 * exactly the audience the sender was entitled to address at that moment.
 *
 * `actorEpf` / `actorName` are accepted for existing callers and ignored — the actor comes from
 * the verified token.
 */
export async function scheduleNotification(n: {
  audience?: 'all' | 'my_team' | 'selected';
  toEpfs?:   string[];
  title:     string;
  body:      string;
  link?:     string;
  sendAt:    Date;
  actorEpf?: string;
  actorName?: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    if (!(n.sendAt instanceof Date) || Number.isNaN(n.sendAt.getTime())) return { ok: false, error: 'bad-time' };
    if (n.sendAt.getTime() <= Date.now()) return { ok: false, error: 'past-time' };
    const audience = n.audience ?? (n.toEpfs?.length ? 'selected' : 'all');
    const idToken = await auth.currentUser?.getIdToken();
    if (!idToken) return { ok: false, error: 'not-signed-in' };

    const res = await fetch('/api/notify/compose', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        idToken,
        audience,
        toEpfs: n.toEpfs ?? [],
        title: n.title,
        body: n.body,
        link: n.link ?? '',
        sendAt: n.sendAt.toISOString(),
      }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      return { ok: false, error: typeof j?.error === 'string' ? j.error : `failed-${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? 'failed' };
  }
}

// All scheduled notifications, newest send_at first. No orderBy → no composite index needed
// (sorted client-side). The set is small (admin-created), so a full read is fine.
export async function listScheduledNotifications(): Promise<ScheduledNotification[]> {
  const snap = await getDocs(collection(db, COL));
  return snap.docs
    .map(d => ({ id: d.id, ...(d.data() as Omit<ScheduledNotification, 'id'>) }))
    .sort((a, b) => (b.send_at?.toMillis() ?? 0) - (a.send_at?.toMillis() ?? 0));
}

// Cancel a still-pending notification so the cron skips it.
export async function cancelScheduledNotification(id: string): Promise<void> {
  await updateDoc(doc(db, COL, id), { status: 'canceled', updated_at: serverTimestamp() });
}
