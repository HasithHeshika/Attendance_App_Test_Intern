import { NextRequest, NextResponse } from 'next/server';
import { adminAuth, adminDbFor } from '@/lib/firebaseAdmin';
import { getMessaging } from 'firebase-admin/messaging';
import { getApps } from 'firebase-admin/app';
import { formatPushText } from '@/lib/serverPush';

export async function POST(req: NextRequest) {
  try {
    const { idToken, oldEmail, newEmail } = await req.json();
    if (!idToken || !newEmail) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const auth = adminAuth();
    const db   = adminDbFor(req);

    // Verify caller
    let callerUid: string;
    try {
      const decoded = await auth.verifyIdToken(idToken);
      callerUid = decoded.uid;
    } catch {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Find the caller's profile (the user who changed their email)
    const callerSnap = await db.collection('users').where('uid', '==', callerUid).limit(1).get();
    const caller = callerSnap.empty ? null : callerSnap.docs[0].data();
    const callerName = caller?.display_name ?? caller?.email ?? 'A user';
    const callerEpf  = caller?.epf_number ?? '';

    // Collect FCM tokens of all active user-managers (System Admin + can_manage_users),
    // resolved from the data-driven roles collection, excluding the caller.
    const rolesSnap = await db.collection('roles').get();
    const managerRoleNames = rolesSnap.docs
      .map(d => d.data())
      .filter(r => r.is_system_admin || r.can_manage_users)
      .map(r => r.name as string);

    const tokens: string[] = [];
    if (managerRoleNames.length > 0) {
      const adminsSnap = await db.collection('users')
        .where('role', 'in', managerRoleNames.slice(0, 30))
        .get();
      adminsSnap.docs.forEach(d => {
        const u = d.data();
        if (u.is_active === false) return;
        if (u.uid === callerUid) return;
        if (u.fcm_token) tokens.push(u.fcm_token as string);
      });
    }

    if (tokens.length === 0) {
      return NextResponse.json({ success: true, sent: 0 });
    }

    const messaging = getMessaging(getApps()[0]);
    const rawTitle = 'Email Changed';
    const rawBody  = `${callerName}${callerEpf ? ` (${callerEpf})` : ''} changed their email from ${oldEmail || 'unknown'} to ${newEmail}`;
    const { title, body } = formatPushText(rawTitle, rawBody, 'email_change');

    const tag = `email-change:${callerEpf || 'x'}`;
    const origin    = req.nextUrl.origin;
    const clickLink = /^https:/i.test(origin) ? `${origin}/users` : undefined;
    const webpush = {
      headers: {
        Urgency: 'high',
        TTL: '86400',
        Topic: tag.replace(/[^a-zA-Z0-9-_.~%]/g, '').slice(0, 32),
      },
      ...(clickLink ? { fcmOptions: { link: clickLink } } : {}),
    };
    const resp = await messaging.sendEachForMulticast({
      tokens,
      data: {
        type: 'email_change',
        realType: 'email_change',
        title,
        body,
        link: '/users',
        epf_number: String(callerEpf),
        docId: tag,
        tag,
        icon: '/app.png',
        badge: '/app.png',
      },
      webpush,
    });

    return NextResponse.json({ success: true, sent: resp.successCount });
  } catch (e) {
    console.error('[notify-email-change]', e);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
