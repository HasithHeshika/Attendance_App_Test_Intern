import { NextRequest, NextResponse } from 'next/server';
import { adminDbsForRequest } from '@/lib/firebaseAdmin';
import type { Firestore, DocumentData } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { FieldValue } from 'firebase-admin/firestore';
import { getApps } from 'firebase-admin/app';
import { secretEquals } from '@/lib/timingSafe';
import { formatPushText } from '@/lib/serverPush';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Planned-maintenance lifecycle — poll this every few minutes from Firebase Cloud Scheduler
 * (same pattern as /api/cron/dispatch-notifications). Mirrors the maintenanceLifecycle Cloud
 * Function in functions/src/index.ts — see that file for the full design note. In short: reads
 * settings/maintenance and, purely from the wall clock, announces "started" once the window
 * opens and "back online" (+ enabled:false) once it closes, each deduped by comparing a stamped
 * copy of the boundary value against the doc's CURRENT startAtMs/endAtMs so a re-armed window
 * announces again with no explicit reset needed.
 *
 * Auth: shared secret in `Authorization: Bearer <CRON_SECRET>` (or `?key=`). Never callable by
 * end users.
 *
 * It also carries the LogPup SSO redemption sweep — see sweepLogPupRedemptions below. That is a
 * step in this job rather than a cron of its own, which is what LOGPUP_TASKS_INTEGRATION.md
 * asked for: one small collection's retention does not justify another scheduler entry, another
 * secret check and another thing to notice has stopped running.
 */

const KIND_TITLES: Record<string, string> = {
  maintenance: 'Scheduled Maintenance',
  upgrade: 'System Upgrade',
  emergency: 'Emergency Maintenance',
};

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

async function notifyAllUsers(db: Firestore, docId: string, title: string, body: string): Promise<void> {
  await db.collection('notifications').doc(docId).set({
    to_epf: null,
    audience: 'all',
    type: 'announcement',
    actor_epf: null,
    actor_name: 'PearlCluster',
    meta: { maintenance: '1' },
    title, body,
    link: null,
    read: false,
    created_at: FieldValue.serverTimestamp(),
  });

  const users = await db.collection('users').get();
  const tokens: string[] = [];
  users.forEach(u => { const ud = u.data(); if (ud.is_active !== false) tokens.push(...tokensOf(ud)); });
  const uniqueTokens = [...new Set(tokens)];
  if (!uniqueTokens.length) return;

  const messaging = getMessaging(getApps()[0]);
  const formatted = formatPushText(title, body, 'maintenance');
  const webpush = {
    headers: {
      Urgency: 'high',
      TTL: '86400',
      Topic: docId.replace(/[^a-zA-Z0-9-_.~%]/g, '').slice(0, 32),
    },
    fcmOptions: {
      link: '/dashboard',
    },
  };
  for (let i = 0; i < uniqueTokens.length; i += 500) {
    const chunk = uniqueTokens.slice(i, i + 500);
    try {
      await messaging.sendEachForMulticast({
        tokens: chunk,
        data: {
          type: 'general',
          realType: 'maintenance',
          title: formatted.title,
          body: formatted.body,
          link: '/dashboard',
          docId,
          tag: docId,
          icon: '/app.png',
          badge: '/app.png',
        },
        webpush,
      });
    } catch { /* push is optional */ }
  }
}

async function run(db: Firestore): Promise<{ started: boolean; ended: boolean }> {
  const ref = db.collection('settings').doc('maintenance');
  const nowMs = Date.now();

  type Claim = { started: boolean; ended: boolean; kind: string; message: string; startAtMs: number; endAtMs: number };

  const result = await db.runTransaction<Claim | null>(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const data = snap.data() as DocumentData;
    if (data.enabled !== true) return null;

    const startAtMs = data.startAtMs;
    const endAtMs = data.endAtMs;
    // Malformed doc -> never act on it.
    if (typeof startAtMs !== 'number' || typeof endAtMs !== 'number' || !(endAtMs > startAtMs)) return null;

    const started = nowMs >= startAtMs && nowMs < endAtMs && data.startNotifiedAtMs !== startAtMs;
    const ended = nowMs >= endAtMs && data.endNotifiedAtMs !== endAtMs;
    if (!started && !ended) return null;

    const updates: DocumentData = {};
    if (started) updates.startNotifiedAtMs = startAtMs;
    if (ended) { updates.endNotifiedAtMs = endAtMs; updates.enabled = false; }
    tx.update(ref, updates);

    return {
      started, ended,
      kind: typeof data.kind === 'string' ? data.kind : 'maintenance',
      message: typeof data.message === 'string' ? data.message : '',
      startAtMs, endAtMs,
    };
  });

  if (!result) return { started: false, ended: false };

  if (result.started) {
    const label = KIND_TITLES[result.kind] ?? KIND_TITLES.maintenance;
    await notifyAllUsers(db, `maint-start-${result.startAtMs}`, `${label} started`, result.message || 'Maintenance is now in progress.');
  }
  if (result.ended) {
    await notifyAllUsers(db, `maint-end-${result.endAtMs}`, "We're back online", "Maintenance has finished — everything is back to normal. Thanks for your patience!");
  }

  return { started: result.started, ended: result.ended };
}

/** Redeemed LogPup handoff tokens. Written by /api/auth/logpup-sso, keyed by jti. */
const LOGPUP_REDEMPTIONS = 'logpup_sso_redemptions';

/** One batch per run. Firestore's own batch ceiling is 500, and a bounded sweep cannot become a
 *  surprise bill on a database nobody has swept in a year — it just takes a few more runs. */
const SWEEP_LIMIT = 500;

/**
 * Delete redemption rows whose expiry has passed.
 *
 * THE ROW'S JOB IS TO MAKE A SECOND REDEMPTION LOSE A DATABASE RACE, so it is needed for exactly
 * as long as the token can still verify. The redeem route stamps `expires_at` at one hour out
 * against a token that lives three minutes, so by the time a row is eligible here its token has
 * been dead for the better part of an hour. There is no window in which this deletes something
 * still doing work.
 *
 * Returns the number deleted so a run says what it did. Never throws: a failed sweep must not
 * fail the maintenance announcements, which are the reason this endpoint is polled. The
 * collection is Alta Vision-only, so on every other tenant this is one empty query.
 */
async function sweepLogPupRedemptions(db: Firestore): Promise<number> {
  try {
    const stale = await db.collection(LOGPUP_REDEMPTIONS)
      .where('expires_at', '<=', new Date())
      .limit(SWEEP_LIMIT)
      .get();
    if (stale.empty) return 0;

    const batch = db.batch();
    stale.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    return stale.size;
  } catch (e) {
    console.error('[cron/maintenance-lifecycle] logpup redemption sweep', e);
    return 0;
  }
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const tenants = [];
    for (const { tenant, db } of adminDbsForRequest(req)) {
      const lifecycle = await run(db);
      tenants.push({ tenant: tenant.id, ...lifecycle, sweptRedemptions: await sweepLogPupRedemptions(db) });
    }
    return NextResponse.json({ success: true, tenants });
  } catch (e) {
    console.error('[cron/maintenance-lifecycle]', e);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

// Allow GET too — many cron/uptime pingers only issue GETs.
export async function GET(req: NextRequest) {
  return POST(req);
}
