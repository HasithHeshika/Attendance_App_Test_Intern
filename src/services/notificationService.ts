'use client';
// Hybrid in-app notifications:
//   · Stored in Firestore and read with the CLIENT SDK — so the in-app bell works everywhere with
//     no server/admin creds, and even for users who declined browser push permission.
//   · A best-effort FCM push on top (via /api/notify) so recipients also hear about it when the app
//     is closed. The push is optional; the Firestore doc + live listener is the reliable path.
//
// Durable clear/read (fixes "old notifications come back after login"):
//   · "Clear all" writes a per-user cutoff (notif_cleared_at) to the caller's OWN user doc; the
//     store hides anything at/before it, on every device and every login.
//   · Direct notifications persist read=true on the doc.
//
// Queries deliberately avoid orderBy so NO composite index is required (the store sorts by time) —
// this also removes the recurring "notifications requires an index" errors.
//
// Document model (collection `notifications`): exactly one of `to_epf` (direct) or `audience`
// ('approvers' | 'all' broadcast) is set.

import {
  addDoc, collection, doc, getDoc, onSnapshot, query,
  serverTimestamp, updateDoc, where, writeBatch, Timestamp,
} from 'firebase/firestore';
import { db, auth } from '@/lib/firebase';
import { epfDocId, getActiveSystemAdmins } from '@/services/userService';

export type AppNotifAudience = 'approvers' | 'all';

export type AppNotifType =
  | 'leave_request'
  // A leave HR/Admin placed directly onto an employee (see assignRestrictedLeave in
  // apiCompat.ts) — the recipient did not apply for it themselves. Distinct from
  // leave_approved so the bell says "assigned a leave for you", not "your leave was approved".
  | 'leave_assigned'
  | 'leave_approved'
  | 'leave_rejected'
  // A request to delete an already-APPROVED leave (see requestLeaveDeletion/considerLeaveDeletion
  // in apiCompat.ts) — kept distinct from leave_request/leave_approved/leave_rejected above so the
  // bell never mislabels "requested to delete a leave" as "applied for leave" (see renderNotif in
  // NotificationCenter.tsx, which re-derives title/body from `type`, ignoring the stored ones for
  // known types).
  | 'leave_delete_request'
  | 'leave_delete_approved'
  | 'leave_delete_rejected'
  | 'attendance_edit'
  | 'edit_approved'
  | 'edit_rejected'
  | 'approval_request'
  | 'suspense_approved'
  | 'suspense_rejected'
  | 'suspense_request'
  | 'announcement'     // a person-composed notification (broadcast or selected users)
  | 'email_change'
  | 'reminder'
  | 'security_alert'      // Admin/System Admin login alert — see notifySystemAdminLogin
  | 'registration_pending' // new carecode.org self-registration awaiting approval —
                            // written server-side by src/app/api/register/route.ts
  | 'schedule_updated' // a roster's schedule was Saved/Updated on
                        // src/app/(pages)/roster/schedule/page.tsx — sent to every employee who
                        // appears anywhere in the saved date range, linking to /my-schedule (see
                        // src/app/(pages)/my-schedule/page.tsx) so they can see it.
  | 'task_mention'     // @mentioned in an Assigned Task comment
  // Assigned-task lifecycle (see assignedTaskService.ts): put on a task, a status change with
  // its note, a "cannot start" / "delayed" flag. All link to /tasks.
  | 'task_assigned'
  | 'task_status'
  | 'task_flagged'
  // Overtime request workflow (Southern Lanka payroll) — see src/services/otRequestService.ts.
  // NotificationCenter has no dedicated renderNotif branch yet, so these fall back to the
  // stored title/body (which the service fills in meaningfully).
  | 'ot_request'       // sent to each approver when an employee files an OT request
  | 'ot_approved'      // sent to the submitter when approved
  | 'ot_rejected'      // sent to the submitter when rejected
  // Automatic birthday / anniversary / special-day greeting from the daily cron
  // (src/app/api/cron/greetings/route.ts). meta: occasion, senders (JSON), years, special_title.
  | 'greeting'
  // A task assigned to this person in LogPup, arriving over the signed webhook at
  // /api/logpup/events (Alta Vision only — see LOGPUP_TASKS_INTEGRATION.md). Written by the
  // Admin SDK, never through createAppNotification, because a webhook has no signed-in user.
  //
  // DELIBERATELY NOT `task_assigned`. That one means an `assigned_tasks` document in this
  // app's own Firestore, and its meta.task_id resolves there; a LogPup task has no such
  // document, so anything opening a task detail from the bell would look up an id that does
  // not exist. meta carries { logpup: '1', task_id, app_slug } and the link is /tasks.
  | 'logpup_task_assigned'
  | 'general';

export interface AppNotification {
  id: string;
  to_epf: string | null;
  audience: AppNotifAudience | null;
  type: AppNotifType | string;
  actor_epf: string | null;
  actor_name: string | null;
  meta: Record<string, string>;
  title: string;
  body: string;
  link: string | null;
  read: boolean;
  created_at: Timestamp | null;
}

const COLLECTION = 'notifications';

// Fire the best-effort FCM push for one notification doc (server reads the doc, no client-supplied
// content). Silently no-ops when Firebase Admin isn't configured (e.g. local dev) — the Firestore
// listener already delivered it in-app.
function pushDoc(docId: string) {
  void (async () => {
    const idToken = await auth.currentUser?.getIdToken().catch(() => null);
    if (!idToken) return;
    void fetch('/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken, docId }),
    }).catch(() => { /* push is optional */ });
  })();
}

// Create a notification (workflow flows: leave / edit). Never throws.
export async function createAppNotification(n: {
  toEpf?: string;
  audience?: AppNotifAudience;
  type: AppNotifType;
  actorEpf?: string;
  actorName?: string;
  meta?: Record<string, string>;
  title: string;
  body: string;
  link?: string;
  push?: boolean;             // default true
}): Promise<void> {
  try {
    if (!n.toEpf && !n.audience) return;
    const ref = await addDoc(collection(db, COLLECTION), {
      to_epf:     n.toEpf ?? null,
      audience:   n.audience ?? null,
      type:       n.type,
      actor_epf:  n.actorEpf ?? null,
      actor_name: n.actorName ?? null,
      meta:       n.meta ?? {},
      title:      n.title,
      body:       n.body,
      link:       n.link ?? null,
      read:       false,
      created_at: serverTimestamp(),
    });
    if (n.push !== false) pushDoc(ref.id);
  } catch (e) {
    console.warn('createAppNotification failed (non-critical):', e);
  }
}

// Security alert: fired right after a successful login when the signed-in user has
// System-Admin-level capability (covers both the 'Admin' and 'System Admin' role names —
// see roleCan/'is_system_admin'). Notifies every OTHER active System Admin so a
// privileged login is visible to the rest of leadership, not just the person signing in.
// Fire-and-forget from the login page — never awaited, never throws, never blocks the
// redirect to /dashboard.
export async function notifySystemAdminLogin(actor: { epf_number: string; display_name: string; role: string }): Promise<void> {
  try {
    const recipients = await getActiveSystemAdmins(actor.epf_number);
    if (!recipients.length) return;
    const base = {
      type: 'security_alert' as const,
      actorEpf: actor.epf_number,
      actorName: actor.display_name,
      title: `${actor.display_name} (${actor.role}) just signed in`,
      body: 'Privileged account login — tap to review the Users list.',
      link: '/users',
    };
    await Promise.all(recipients.map(r => createAppNotification({ ...base, toEpf: r.epf_number })));
  } catch (e) {
    console.warn('notifySystemAdminLogin failed (non-critical):', e);
  }
}

// ─── The bell's "New notification" composer ──────────────────────────────────
/** Who a composed notification may be addressed to, as the server decides it. */
export type ComposeAudience = 'all' | 'my_team' | 'selected';

export interface ComposeAudienceInfo {
  /** The audiences this user may use. Empty means no composer at all. */
  allowed: ComposeAudience[];
  reach: { all: number; my_team: number };
  /** Only the people this user may write to. */
  people: Array<{ epf: string; name: string; role: string }>;
  /** Company-wide extras (type selection, approver broadcast) belong to broadcasters only. */
  may_broadcast: boolean;
}

async function composerToken(): Promise<string> {
  const tok = await auth.currentUser?.getIdToken();
  if (!tok) throw new Error('Not signed in');
  return tok;
}

/**
 * What this user may do in the composer. Answered by the server, because the answer depends on
 * the supervisor tree and a role capability — neither of which the browser may be trusted with.
 */
export async function getComposeAudience(): Promise<ComposeAudienceInfo> {
  const res = await fetch('/api/notify/compose', {
    cache: 'no-store',
    // A header, not the query string: a URL reaches the access log, the browser history and any
    // Referer the page sends, and an ID token is a live credential.
    headers: { authorization: `Bearer ${await composerToken()}` },
  });
  if (!res.ok) throw new Error('Could not load who you can send to');
  const d = await res.json();
  return {
    allowed: Array.isArray(d?.allowed) ? d.allowed : [],
    reach: { all: Number(d?.reach?.all ?? 0), my_team: Number(d?.reach?.my_team ?? 0) },
    people: Array.isArray(d?.people) ? d.people : [],
    may_broadcast: d?.may_broadcast === true,
  };
}

/**
 * Send a composed notification.
 *
 * Goes through /api/notify/compose rather than writing to Firestore from here. The write used to
 * happen in the browser, which meant nothing enforced who a sender could reach: firestore.rules
 * cannot tell one signed-in user from another (every can*() helper reduces to isAuth()), and
 * /api/notify only ever gated the PUSH — the bell entry had already landed by then. The route
 * re-derives the sender's reach from their verified token and refuses anything outside it.
 *
 * `actorEpf` / `actorName` are accepted for the callers that still pass them and ignored: the
 * actor is taken from the token, so a sender cannot write in somebody else's name.
 */
export async function sendCustomNotification(n: {
  audience?: ComposeAudience;
  toEpfs?: string[];
  title: string;
  body: string;
  link?: string;
  actorEpf?: string;
  actorName?: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const audience: ComposeAudience = n.audience ?? (n.toEpfs?.length ? 'selected' : 'all');
    const res = await fetch('/api/notify/compose', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        idToken: await composerToken(),
        audience,
        toEpfs: n.toEpfs ?? [],
        title: n.title,
        body: n.body,
        link: n.link ?? '',
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

// Live inbox subscription: the user's direct notifications + the broadcast feeds they belong to
// ('all' for everyone; 'approvers' for approvers). No orderBy → no composite index; the store sorts.
export function subscribeAppNotifications(
  epf: string,
  audiences: AppNotifAudience[],
  onItems: (items: AppNotification[]) => void,
): () => void {
  const buckets = new Map<string, AppNotification[]>();
  const unsubs: Array<() => void> = [];

  const emit = () => onItems([...buckets.values()].flat());
  const mapDoc = (d: { id: string; data: () => unknown }): AppNotification => {
    const v = (d.data() ?? {}) as Record<string, unknown>;
    return {
      id: d.id,
      to_epf:     (v.to_epf as string) ?? null,
      audience:   (v.audience as AppNotifAudience) ?? null,
      type:       (v.type as string) ?? 'general',
      actor_epf:  (v.actor_epf as string) ?? null,
      actor_name: (v.actor_name as string) ?? null,
      meta:       (v.meta as Record<string, string>) ?? {},
      title:      (v.title as string) ?? '',
      body:       (v.body as string) ?? '',
      link:       (v.link as string) ?? null,
      read:       v.read === true,
      created_at: (v.created_at as Timestamp) ?? null,
    };
  };

  const listen = (key: string, q: ReturnType<typeof query>) => {
    unsubs.push(onSnapshot(q, snap => {
      buckets.set(key, snap.docs.map(mapDoc));
      emit();
    }, err => {
      console.warn(`notifications subscription '${key}' failed:`, err?.message ?? err);
    }));
  };

  // No limit() here, deliberately — same fix as getMyEditRequests' comment explains: limit()
  // without orderBy returns an arbitrary (effectively doc-id-ordered) subset, so once a person
  // passes the cap a brand-new notification can fall outside it and never appear in the live
  // snapshot at all — exactly the "notification never shows in the bell" bug this caused.
  // notificationsStore already sorts by time and caps to MAX_ITEMS after merging, so nothing
  // downstream needs a Firestore-side limit to stay bounded.
  listen('direct', query(collection(db, COLLECTION), where('to_epf', '==', epf)));
  for (const audience of audiences) {
    listen(`audience:${audience}`, query(collection(db, COLLECTION), where('audience', '==', audience)));
  }

  return () => unsubs.forEach(u => u());
}

// Persist read=true on a DIRECT notification doc (cross-device read state).
export async function markNotificationReadRemote(docId: string): Promise<void> {
  try { await updateDoc(doc(db, COLLECTION, docId), { read: true }); }
  catch { /* offline / permission — local read state still applies */ }
}

export async function markManyReadRemote(docIds: string[]): Promise<void> {
  if (!docIds.length) return;
  try {
    const batch = writeBatch(db);
    docIds.slice(0, 400).forEach(id => batch.update(doc(db, COLLECTION, id), { read: true }));
    await batch.commit();
  } catch { /* non-critical */ }
}

// ─── Durable "Clear all" cutoff (per user) ──────────────────────────────────────
// Stored as an ISO string on the caller's own user doc so it survives re-login and syncs across
// devices. Reads never throw; writes degrade to local-only if the rule isn't deployed yet.
export async function getNotifClearedAt(epf: string): Promise<string> {
  try {
    const snap = await getDoc(doc(db, 'users', epfDocId(epf)));
    const v = snap.exists() ? (snap.data() as { notif_cleared_at?: unknown }).notif_cleared_at : null;
    if (!v) return '';
    if (typeof v === 'string') return v;
    if ((v as Timestamp)?.toDate) return (v as Timestamp).toDate().toISOString();
    return '';
  } catch { return ''; }
}

export async function setNotifClearedAt(epf: string, iso: string): Promise<void> {
  try { await updateDoc(doc(db, 'users', epfDocId(epf)), { notif_cleared_at: iso }); }
  catch { /* rule may block until firestore.rules is deployed — the local cutoff still applies */ }
}
