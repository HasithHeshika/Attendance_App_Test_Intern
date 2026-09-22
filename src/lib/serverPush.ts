import type { DocumentData, DocumentReference } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { getApps } from 'firebase-admin/app';

// The multicast-send + dead-token-pruning half of src/app/api/notify/route.ts, pulled out
// so a server route that already has its OWN resolved recipient list (and doesn't have a
// caller idToken to authorize a call to that route — e.g. a public/unauthenticated flow
// like self-registration) can push directly instead. /api/notify keeps its own copy of the
// recipient-resolution + caller-authorization logic; only the "send it" mechanics live here.

function tokensOf(u: DocumentData): string[] {
  const arr = Array.isArray(u.fcm_tokens) ? u.fcm_tokens.filter((t: unknown) => typeof t === 'string') : [];
  if (typeof u.fcm_token === 'string' && u.fcm_token) arr.push(u.fcm_token);
  return [...new Set(arr)];
}

export interface ServerPushPayload {
  type: string;
  title: string;
  body: string;
  link?: string;
  /** Used as the FCM 'tag' so the SDK-rendered + SW-rendered notification collapse into
   *  one, and as data.docId for the in-app click handler. Pass the notification doc id. */
  tag: string;
  /** Absolute origin (e.g. `req.nextUrl.origin`) — builds the https click link. */
  originUrl?: string;
}

import { formatPushText, type FormattedPushText } from './pushFormat';
export { formatPushText, type FormattedPushText };

export async function sendServerPush(
  recipientDocs: Array<{ ref: DocumentReference; data: DocumentData }>,
  payload: ServerPushPayload,
): Promise<number> {
  try {
    const tokenOwner = new Map<string, DocumentReference>();
    for (const { ref, data } of recipientDocs) {
      if (data.is_active === false) continue;
      for (const tok of tokensOf(data)) if (!tokenOwner.has(tok)) tokenOwner.set(tok, ref);
    }
    const tokens = [...tokenOwner.keys()];
    if (!tokens.length) return 0;

    const { title, body } = formatPushText(payload.title, payload.body, payload.type);
    const link = payload.link?.startsWith('/') ? payload.link : '';
    const tag = payload.tag;
    const data = {
      type: payload.type,
      realType: payload.type,
      title,
      body,
      link,
      docId: tag,
      tag,
      icon: '/app.png',
      badge: '/app.png',
    };
    const clickLink = payload.originUrl && /^https:/i.test(payload.originUrl)
      ? new URL(link || '/dashboard', payload.originUrl).toString()
      : undefined;
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

    return sent;
  } catch (e) {
    console.warn('sendServerPush failed (non-critical):', e);
    return 0;
  }
}
