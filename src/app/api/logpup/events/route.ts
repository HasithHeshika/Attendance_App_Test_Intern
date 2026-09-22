import { createHmac, timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import type { DocumentData, DocumentReference } from 'firebase-admin/firestore';
import { adminDbFor, tenantForRequest } from '@/lib/firebaseAdmin';
import { checkRateLimit, clientIp } from '@/lib/rateLimit';
import { sendServerPush } from '@/lib/serverPush';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_TENANT_ID = 'altavision';
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 120;
/** How far out of date a signed request may be. Bounds replay of a captured body. */
const MAX_SKEW_MS = 5 * 60 * 1000;
/** One POST carries a batch; a bigger one is a bug or an attempt to make us work. */
const MAX_EVENTS = 50;

interface LogPupEvent {
  eventId: string;
  kind: string;
  recipientEmail: string;
  actorName?: string;
  title: string;
  body?: string;
  taskId?: string;
  appSlug?: string;
}

/**
 * Doc ids must not carry arbitrary characters — an EPF can contain '/', which Firestore reads
 * as a path separator, and `eventId` comes from a foreign system. Same sanitiser the register
 * route applies to an EPF before using it in a notification doc id.
 */
function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
}

/**
 * Verify the HMAC over the EXACT bytes LogPup signed.
 *
 * The raw body is required, not the parsed object: re-serialising a parsed object does not
 * reproduce the original bytes (key order and whitespace differ), so the signature would fail
 * for reasons that look exactly like a wrong secret. The caller therefore reads req.text()
 * before any JSON.parse — calling req.json() first consumes the stream and leaves nothing to
 * verify against.
 *
 * The timestamp is part of the signed string, so it cannot be edited to extend the window of a
 * captured request.
 */
function signatureValid(rawBody: string, timestamp: string, provided: string | null): boolean {
  const secret = process.env.LOGPUP_WEBHOOK_SECRET;
  if (!secret || !provided || !timestamp) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > MAX_SKEW_MS) return false;

  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest();
  let got: Buffer;
  try {
    got = Buffer.from(provided, 'hex');
  } catch {
    return false;
  }
  // timingSafeEqual throws on a length mismatch, which would leak the digest length.
  if (got.length !== expected.length) return false;
  return timingSafeEqual(got, expected);
}

/**
 * Inbound task events from LogPup — today only "a task was assigned to this person".
 *
 * Authenticated by SIGNATURE, not by a session: the caller is a server, and there is no user to
 * verify. A bearer key would be replayable forever from a captured log line; an HMAC binds the
 * secret to the body and the timestamp bounds the replay window.
 *
 * Writes the bell document with the Admin SDK and fires the FCM push. Deliberately NOT through
 * createAppNotification, which is client-side and reads auth.currentUser to send its push — a
 * webhook has no signed-in user. serverPush.ts exists for exactly this case.
 */
export async function POST(req: NextRequest) {
  if (tenantForRequest(req).id !== ALLOWED_TENANT_ID) {
    return NextResponse.json({ error: 'Not available on this domain' }, { status: 403 });
  }

  const rawBody = await req.text();
  const timestamp = req.headers.get('x-logpup-timestamp') ?? '';
  if (!signatureValid(rawBody, timestamp, req.headers.get('x-logpup-signature'))) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  const db = adminDbFor(req);
  const retryAfterMs = await checkRateLimit(
    db, 'logpup_events', clientIp(req), RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX,
  );
  if (retryAfterMs > 0) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(retryAfterMs / 1000)) } },
    );
  }

  let events: LogPupEvent[];
  try {
    const parsed = JSON.parse(rawBody);
    events = Array.isArray(parsed?.events) ? parsed.events : [];
  } catch {
    return NextResponse.json({ error: 'Malformed body' }, { status: 400 });
  }
  if (events.length === 0) return NextResponse.json({ ok: true, results: [] });
  if (events.length > MAX_EVENTS) {
    return NextResponse.json({ error: `At most ${MAX_EVENTS} events per request` }, { status: 400 });
  }

  // Each event stands alone. One unknown recipient must not make LogPup consider the whole
  // batch lost and (in a later version) retry the ones that already landed.
  const results = await Promise.all(events.map(e => deliver(db, req, e)));
  return NextResponse.json({ ok: true, results }, { headers: { 'Cache-Control': 'no-store' } });
}

type Delivery = { eventId: string; delivered: boolean; reason?: string };

async function deliver(
  db: ReturnType<typeof adminDbFor>,
  req: NextRequest,
  event: LogPupEvent,
): Promise<Delivery> {
  const eventId = typeof event?.eventId === 'string' ? event.eventId : '';
  try {
    if (!eventId || !event.title || typeof event.recipientEmail !== 'string') {
      return { eventId, delivered: false, reason: 'incomplete' };
    }
    if (event.kind !== 'task.assigned') {
      // Forward-compatible: a LogPup that starts sending a new kind gets a clean "not handled"
      // rather than a 400 that makes it look like the whole integration broke.
      return { eventId, delivered: false, reason: 'unhandled kind' };
    }

    const email = event.recipientEmail.trim().toLowerCase();
    const snap = await db.collection('users').where('email', '==', email).limit(1).get();
    if (snap.empty) return { eventId, delivered: false, reason: 'no match' };

    const ref: DocumentReference = snap.docs[0].ref;
    const data: DocumentData = snap.docs[0].data();
    if (data.is_active === false || data.date_of_resign) {
      return { eventId, delivered: false, reason: 'inactive' };
    }

    const epf = String(data.epf_number ?? '');
    if (!epf) return { eventId, delivered: false, reason: 'no epf' };

    const title = String(event.title).slice(0, 200);
    const body = String(event.body ?? '').slice(0, 300);
    const link = '/tasks';

    // PER-RECIPIENT doc id, and set() rather than add(). Two separate properties:
    //   • set() on a deterministic id makes a retried webhook overwrite the same document
    //     instead of ringing the bell twice.
    //   • including the EPF is what /api/register's comment records as the fix for a real
    //     duplicate-notification bug: the service worker's click handler matches the push to
    //     the live Firestore doc by docId, and an event-level id shared across recipients
    //     leaves it unable to find that item, so it renders a second, un-deduped entry.
    const docId = `logpup_${safeId(eventId)}_${safeId(epf)}`;
    await db.collection('notifications').doc(docId).set({
      to_epf: epf,
      audience: null,
      type: 'logpup_task_assigned',
      // The assigner may have no Attendance account at all. actor_name carries the display
      // name for the bell; nothing tries to resolve a foreign actor to a local employee.
      actor_epf: null,
      actor_name: event.actorName ? String(event.actorName).slice(0, 120) : 'LogPup',
      meta: {
        logpup: '1',
        ...(event.taskId ? { task_id: String(event.taskId) } : {}),
        ...(event.appSlug ? { app_slug: String(event.appSlug) } : {}),
      },
      title,
      body,
      link,
      read: false,
      created_at: FieldValue.serverTimestamp(),
    });

    await sendServerPush([{ ref, data }], {
      type: 'logpup_task_assigned',
      title,
      body,
      link,
      tag: docId,
      originUrl: req.nextUrl.origin,
    });

    return { eventId, delivered: true };
  } catch (e) {
    console.warn('[logpup/events] delivery failed:', (e as { message?: string })?.message ?? e);
    return { eventId, delivered: false, reason: 'error' };
  }
}
