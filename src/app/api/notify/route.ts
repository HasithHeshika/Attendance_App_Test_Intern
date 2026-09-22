import { NextRequest, NextResponse } from 'next/server';
import { adminAuth, adminDbFor } from '@/lib/firebaseAdmin';
import { getMessaging } from 'firebase-admin/messaging';
import { FieldValue } from 'firebase-admin/firestore';
import { getApps } from 'firebase-admin/app';
import { resolveCapabilities } from '@/lib/permissions';
import { PUSHABLE_NOTIF_TYPE_SET } from '@/lib/notificationTypes';
import { formatPushText } from '@/lib/serverPush';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Best-effort FCM fan-out for in-app notifications. The client writes the notification document to
 * Firestore (the reliable, always-delivered path — the in-app bell reads it via a live listener)
 * then calls this route so recipients ALSO get a system push when the app is closed. When Firebase
 * Admin isn't configured (e.g. local dev) this route 401s and the caller ignores it — the in-app
 * delivery already happened.
 *
 * Security: the request carries only the caller's ID token + the `docId` it just wrote. Every push
 * field is derived from the stored doc, and the doc's `actor_epf` must be the caller — so a caller
 * can't push arbitrary content or spoof another actor. A broadcast additionally requires the
 * caller's role to have `can_send_notifications`.
 */


// The static SW (public/firebase-messaging-sw.js) routes clicks by these legacy names.
function legacyType(type: string): string {
  switch (type) {
    case 'leave_request':
    case 'leave_approved':
    case 'leave_rejected':
    case 'leave_delete_request':
    case 'leave_delete_approved':
    case 'leave_delete_rejected': return 'leave_update';
    default: return type;
  }
}

function epfDocId(epf: string): string {
  return epf.includes('/') ? epf.replace(/\//g, '%2F') : epf;
}

function tokensOf(u: FirebaseFirestore.DocumentData): string[] {
  const arr = Array.isArray(u.fcm_tokens) ? u.fcm_tokens.filter((t: unknown) => typeof t === 'string') : [];
  if (typeof u.fcm_token === 'string' && u.fcm_token) arr.push(u.fcm_token);
  return [...new Set(arr)];
}

export async function POST(req: NextRequest) {
  try {
    const { idToken, docId } = await req.json().catch(() => ({}));
    if (!idToken || !docId || typeof docId !== 'string') {
      return NextResponse.json({ error: 'idToken and docId required' }, { status: 400 });
    }

    let callerUid: string;
    try { callerUid = (await adminAuth().verifyIdToken(idToken)).uid; }
    catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

    const db = adminDbFor(req);

    // Load the notification the caller just wrote; every push field comes from here.
    const notifSnap = await db.collection('notifications').doc(docId).get();
    if (!notifSnap.exists) return NextResponse.json({ error: 'Notification not found' }, { status: 404 });
    const n = notifSnap.data()!;

    const type = String(n.type ?? '');
    // A type nobody has declared is not pushed. The list is kept in lockstep with
    // AppNotifType by a compile-time guard — see src/lib/notificationTypes.ts.
    if (!PUSHABLE_NOTIF_TYPE_SET.has(type)) {
      console.warn('[api/notify] no push for undeclared notification type:', type);
      return NextResponse.json({ success: true, sent: 0, skipped: 'unknown_type' });
    }

    // The caller must be the actor recorded on the doc (resolve their EPF + role from the uid).
    const callerSnap = await db.collection('users').where('uid', '==', callerUid).limit(1).get();
    const callerData = callerSnap.empty ? null : callerSnap.docs[0].data();
    const callerEpf  = callerData ? String(callerData.epf_number ?? '') : '';
    if (n.actor_epf && String(n.actor_epf) !== callerEpf) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const toEpf    = n.to_epf != null ? String(n.to_epf) : '';
    const audience = n.audience != null ? String(n.audience) : '';

    // Any broadcast requires the sender's role to have can_send_notifications.
    if (audience) {
      const roleSnap = callerData?.role
        ? await db.collection('roles').where('name', '==', String(callerData.role)).limit(1).get()
        : null;
      const role = roleSnap && !roleSnap.empty ? roleSnap.docs[0].data() : null;
      const caps = resolveCapabilities(role as never, callerData?.employee_type);
      const broadcastAllowed = caps.is_system_admin || caps.can_send_notifications
        || (audience === 'approvers' && caps.can_approve);   // legacy approver fan-out
      if (!broadcastAllowed) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const rawTitle = String(n.title ?? '');
    const rawBody  = String(n.body ?? '');
    const { title, body } = formatPushText(rawTitle, rawBody, type);
    const link  = typeof n.link === 'string' && n.link.startsWith('/') ? n.link : '';

    // Resolve recipient user docs from the stored addressing.
    const recipientDocs: Array<{ ref: FirebaseFirestore.DocumentReference; data: FirebaseFirestore.DocumentData }> = [];
    if (toEpf) {
      const snap = await db.collection('users').doc(epfDocId(toEpf)).get();
      if (snap.exists) recipientDocs.push({ ref: snap.ref, data: snap.data()! });
    } else if (audience === 'all') {
      const snap = await db.collection('users').get();
      snap.docs.forEach(d => recipientDocs.push({ ref: d.ref, data: d.data() }));
    } else if (audience === 'approvers') {
      const rolesSnap = await db.collection('roles').get();
      const roleByName = new Map<string, FirebaseFirestore.DocumentData>();
      const candidateNames: string[] = [];
      rolesSnap.docs.forEach(d => {
        const r = d.data();
        roleByName.set(String(r.name), r);
        if (r.is_system_admin || r.can_approve) candidateNames.push(String(r.name));
      });
      for (let i = 0; i < candidateNames.length; i += 30) {   // Firestore 'in' caps at 30
        const snap = await db.collection('users').where('role', 'in', candidateNames.slice(i, i + 30)).get();
        snap.docs.forEach(d => {
          const u = d.data();
          const caps = resolveCapabilities(roleByName.get(String(u.role)) as never, u.employee_type);
          if (caps.is_system_admin || caps.can_approve) recipientDocs.push({ ref: d.ref, data: u });
        });
      }
    } else {
      return NextResponse.json({ error: 'Bad recipient' }, { status: 400 });
    }

    // Collect tokens (skip the caller + inactive users), remembering each token's owner doc.
    const tokenOwner = new Map<string, FirebaseFirestore.DocumentReference>();
    const seenUsers = new Set<string>();
    for (const { ref, data } of recipientDocs) {
      if (seenUsers.has(ref.path)) continue;
      seenUsers.add(ref.path);
      if (data.is_active === false) continue;
      if (data.uid && data.uid === callerUid) continue;
      for (const tok of tokensOf(data)) if (!tokenOwner.has(tok)) tokenOwner.set(tok, ref);
    }
    const tokens = [...tokenOwner.keys()];
    if (!tokens.length) return NextResponse.json({ success: true, sent: 0 });

    // Pushes are sent as DATA-ONLY messages so the Service Worker handles and renders
    // exactly ONE notification. Sending a `notification` payload causes the browser/FCM
    // SDK to auto-display an uncustomized notification while the Service Worker ALSO
    // displays one, resulting in duplicate notifications on macOS/iOS/Android.
    const tag = String(docId);
    const data = {
      type: legacyType(type),
      realType: type,
      title,
      body,
      link,
      docId: tag,
      tag,
      icon: '/app.png',
      badge: '/app.png',
    };
    const origin    = req.nextUrl.origin;
    const clickLink = /^https:/i.test(origin) ? new URL(link || '/dashboard', origin).toString() : undefined;
    const webpush = {
      headers: {
        Urgency: 'high',
        TTL: '86400',
        Topic: tag.replace(/[^a-zA-Z0-9-_.~%]/g, '').slice(0, 32),
      },
      ...(clickLink ? { fcmOptions: { link: clickLink } } : {}),
    };
    const messaging = getMessaging(getApps()[0]);
    const deadByRef = new Map<string, Set<string>>();
    let sent = 0;
    for (let i = 0; i < tokens.length; i += 500) {
      const chunk = tokens.slice(i, i + 500);
      const resp = await messaging.sendEachForMulticast({ tokens: chunk, data, webpush });
      sent += resp.successCount;
      resp.responses.forEach((r, j) => {
        const code = r.error?.code ?? '';
        if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
          const ref = tokenOwner.get(chunk[j]);
          if (ref) {
            if (!deadByRef.has(ref.path)) deadByRef.set(ref.path, new Set());
            deadByRef.get(ref.path)!.add(chunk[j]);
          }
        }
      });
    }

    await Promise.all([...deadByRef.entries()].map(async ([, dead]) => {
      const first = [...dead][0];
      const ref = tokenOwner.get(first)!;
      const patch: Record<string, unknown> = { fcm_tokens: FieldValue.arrayRemove(...dead) };
      const snap = await ref.get().catch(() => null);
      if (snap && dead.has(snap.data()?.fcm_token)) patch.fcm_token = null;
      await ref.update(patch).catch(() => { /* pruning is best-effort */ });
    }));

    return NextResponse.json({ success: true, sent });
  } catch (e) {
    console.error('[notify]', e);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
