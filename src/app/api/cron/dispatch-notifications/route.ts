import { NextRequest, NextResponse } from 'next/server';
import { adminDbsForRequest } from '@/lib/firebaseAdmin';
import type { Firestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getApps } from 'firebase-admin/app';
import { secretEquals } from '@/lib/timingSafe';
import { formatPushText } from '@/lib/serverPush';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Scheduled-notification dispatcher — poll this every few minutes from Firebase Cloud
 * Scheduler (same pattern as /api/cron/greetings). Finds `scheduled_notifications` whose
 * send_at has passed and are still pending, then for each:
 *   • writes the in-app `notifications` doc(s) (broadcast, or one per recipient), and
 *   • sends an FCM push to the recipients' tokens,
 * and flips the scheduled doc to `sent`.
 *
 * Auth: shared secret in `Authorization: Bearer <CRON_SECRET>` (or `?key=`). Never callable
 * by end users.
 *
 * Idempotent: each due doc is claimed pending→sending in a transaction before sending, and
 * the fan-out uses deterministic notification doc ids (`sched-<id>` / `sched-<id>-<epf>`) so a
 * retry overwrites rather than duplicates. A `sending` doc left stale (>10 min, e.g. a crashed
 * run) is retried.
 */

const STALE_MS = 10 * 60 * 1000;

function epfDocId(epf: string): string {
  return epf.includes('/') ? epf.replace(/\//g, '%2F') : epf;
}

function tokensOf(u: FirebaseFirestore.DocumentData): string[] {
  const arr = Array.isArray(u.fcm_tokens) ? u.fcm_tokens.filter((t: unknown) => typeof t === 'string') : [];
  if (typeof u.fcm_token === 'string' && u.fcm_token) arr.push(u.fcm_token);
  return [...new Set(arr)] as string[];
}

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed if unconfigured
  const header = req.headers.get('authorization') ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const key = bearer || req.nextUrl.searchParams.get('key') || '';
  return secretEquals(key, secret);
}

async function run(db: Firestore) {
  const nowMs = Date.now();

  // Equality-only queries (auto-indexed): pull pending + sending, filter "due"/"stale" in memory.
  const [pendingSnap, sendingSnap] = await Promise.all([
    db.collection('scheduled_notifications').where('status', '==', 'pending').get(),
    db.collection('scheduled_notifications').where('status', '==', 'sending').get(),
  ]);

  const due = [
    ...pendingSnap.docs.filter(d => {
      const sa = d.get('send_at') as Timestamp | undefined;
      return sa ? sa.toMillis() <= nowMs : false;
    }),
    // Retry crashed sends: a doc stuck in `sending` past the stale window.
    ...sendingSnap.docs.filter(d => {
      const ua = d.get('updated_at') as Timestamp | undefined;
      return ua ? nowMs - ua.toMillis() > STALE_MS : true;
    }),
  ];

  const messaging = getMessaging(getApps()[0]);
  let processed = 0, delivered = 0, pushed = 0;

  for (const d of due) {
    const ref = d.ref;

    // Claim: only proceed if still pending, or a stale `sending` we're allowed to retry.
    let claimed = false;
    try {
      await db.runTransaction(async tx => {
        const cur = await tx.get(ref);
        const status = cur.get('status');
        const ua = cur.get('updated_at') as Timestamp | undefined;
        const stale = status === 'sending' && (!ua || nowMs - ua.toMillis() > STALE_MS);
        if (status !== 'pending' && !stale) return;
        tx.update(ref, { status: 'sending', updated_at: FieldValue.serverTimestamp() });
        claimed = true;
      });
    } catch { claimed = false; }
    if (!claimed) continue;

    const data = d.data();
    const title = String(data.title ?? '');
    const body  = String(data.body ?? '');
    const link  = (data.link as string) ?? null;
    const isAll = data.audience === 'all';
    const toEpfs = Array.isArray(data.to_epfs) ? [...new Set(data.to_epfs.map(String))] : [];

    try {
      const common = {
        type:       'announcement',
        actor_epf:  (data.actor_epf as string) ?? null,
        actor_name: (data.actor_name as string) ?? null,
        title, body,
        link:       link ?? null,
        read:       false,
        created_at: FieldValue.serverTimestamp(),
      };

      // Remember each token's owner doc so a dead token (below) can be pruned off the
      // right user — same pattern as /api/notify.
      const tokenOwner = new Map<string, FirebaseFirestore.DocumentReference>();
      if (isAll) {
        // One broadcast doc (deterministic id → retry overwrites).
        await db.collection('notifications').doc(`sched-${ref.id}`).set({
          ...common, to_epf: null, audience: 'all', meta: { broadcast: '1', scheduled: '1' },
        });
        // Collect every active user's push tokens.
        const users = await db.collection('users').get();
        users.forEach(u => {
          const ud = u.data();
          if (ud.is_active === false) return;
          for (const tok of tokensOf(ud)) if (!tokenOwner.has(tok)) tokenOwner.set(tok, u.ref);
        });
      } else {
        for (const epf of toEpfs) {
          const safe = epfDocId(epf);
          await db.collection('notifications').doc(`sched-${ref.id}-${safe}`).set({
            ...common, to_epf: epf, audience: null, meta: { scheduled: '1' },
          });
          const us = await db.collection('users').doc(safe).get();
          if (us.exists) {
            for (const tok of tokensOf(us.data() as FirebaseFirestore.DocumentData)) if (!tokenOwner.has(tok)) tokenOwner.set(tok, us.ref);
          }
        }
      }
      delivered++;

      // FCM push (best-effort; the in-app docs are the reliable channel). Chunk to the 500-token cap.
      const uniqueTokens = [...tokenOwner.keys()];
      if (uniqueTokens.length) {
        const tag = `sched-${ref.id}`;
        const { title: cleanTitle, body: cleanBody } = formatPushText(title, body, 'general');
        const dataPayload = {
          type: 'general',
          title: cleanTitle,
          body: cleanBody,
          link: link ?? '/dashboard',
          docId: tag,
          tag,
          icon: '/app.png',
          badge: '/app.png',
        };
        const webpush = {
          headers: {
            Urgency: 'high',
            TTL: '86400',
            Topic: tag.replace(/[^a-zA-Z0-9-_.~%]/g, '').slice(0, 32),
          },
          fcmOptions: {},
        };
        const deadByRef = new Map<string, { ownerRef: FirebaseFirestore.DocumentReference; dead: Set<string> }>();
        for (let i = 0; i < uniqueTokens.length; i += 500) {
          const chunk = uniqueTokens.slice(i, i + 500);
          try {
            const resp = await messaging.sendEachForMulticast({ tokens: chunk, data: dataPayload, webpush });
            pushed += resp.successCount;
            resp.responses.forEach((r, j) => {
              const code = r.error?.code ?? '';
              if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
                const tok = chunk[j];
                const ownerRef = tokenOwner.get(tok);
                if (!ownerRef) return;
                if (!deadByRef.has(ownerRef.path)) deadByRef.set(ownerRef.path, { ownerRef, dead: new Set() });
                deadByRef.get(ownerRef.path)!.dead.add(tok);
              }
            });
          } catch { /* push is optional */ }
        }
        await Promise.all([...deadByRef.values()].map(async ({ ownerRef, dead }) => {
          const patch: Record<string, unknown> = { fcm_tokens: FieldValue.arrayRemove(...dead) };
          const snap = await ownerRef.get().catch(() => null);
          if (snap && dead.has(String(snap.data()?.fcm_token))) patch.fcm_token = null;
          await ownerRef.update(patch).catch(() => undefined);
        }));
      }

      await ref.update({
        status: 'sent', sent_at: FieldValue.serverTimestamp(),
        updated_at: FieldValue.serverTimestamp(), error: null,
      });
      processed++;
    } catch (e) {
      await ref.update({
        status: 'failed', error: String((e as Error)?.message ?? 'failed'),
        updated_at: FieldValue.serverTimestamp(),
      }).catch(() => { /* best effort */ });
    }
  }

  return { due: due.length, processed, delivered, pushed };
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    // One deployment, several tenant databases. Call with `?tenant=all` so the scheduler's
    // single url drains every tenant's queue; without it only the tenant that owns the
    // request host is processed. Each claim/marker lives in its own database, so the
    // pending→sending transaction stays idempotent per tenant.
    const tenants = [];
    for (const { tenant, db } of adminDbsForRequest(req)) {
      tenants.push({ tenant: tenant.id, ...(await run(db)) });
    }
    return NextResponse.json({ success: true, tenants });
  } catch (e) {
    console.error('[cron/dispatch-notifications]', e);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

// Allow GET too — many cron/uptime pingers only issue GETs.
export async function GET(req: NextRequest) {
  return POST(req);
}
