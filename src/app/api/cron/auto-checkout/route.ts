import { NextRequest, NextResponse } from 'next/server';
import { adminDbsForRequest } from '@/lib/firebaseAdmin';
import { Timestamp, type Firestore, type DocumentData } from 'firebase-admin/firestore';
import { MAX_PLAUSIBLE_SHIFT_HOURS, reviewSeverityHours } from '@/lib/shiftAutoClose';
import { createReviewIfAbsent, notifyReviewFlag } from '@/lib/attendanceAutoClose';
import { secretEquals } from '@/lib/timingSafe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Open-session monitor — the hybrid model's safety net. Triggered every 15 min by the Netlify
 * Scheduled Function netlify/functions/auto-checkout-sweep.mjs (which POSTs this route with
 * ?tenant=all) — no external cron service.
 *
 * It scans the last few days of Southern Lanka attendance for sessions still OPEN past
 * MAX_PLAUSIBLE_SHIFT_HOURS and FLAGS them for supervisor review (attendance_reviews row +
 * a deduplicated in-app / FCM prompt). It NEVER closes a session or truncates physical
 * presence — the raw timestamps are sacred; a human decides how the extra hours are handled.
 *
 * Scoped to the `southernlanka` tenant only (shift rosters + fingerprint terminals are that
 * tenant's feature); a `?tenant=all` call still only touches southernlanka.
 *
 * Auth: shared secret in `Authorization: Bearer <CRON_SECRET>` (or `?key=`).
 *
 * Idempotent: the review row has a deterministic id and is created only if absent, so a re-run
 * (or the engine having already flagged the same session) never double-flags or double-notifies.
 */

const MAX_MS = MAX_PLAUSIBLE_SHIFT_HOURS * 3_600_000;
const LOOKBACK_DAYS = 4;

function epfDocId(epf: string): string {
  return epf.includes('/') ? epf.replace(/\//g, '%2F') : epf;
}

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed if unconfigured
  const header = req.headers.get('authorization') ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const key = bearer || req.nextUrl.searchParams.get('key') || '';
  return secretEquals(key, secret);
}

// Local 'YYYY-MM-DD' in Asia/Colombo, N days back from now (servers run in UTC).
function colomboDateStr(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Colombo' }).format(d);
}

function sessionsOf(rec: DocumentData | undefined): DocumentData[] {
  return rec && Array.isArray(rec.sessions) ? (rec.sessions as DocumentData[]) : [];
}
function checkInMillis(v: unknown): number | null {
  if (v instanceof Timestamp) return v.toMillis();
  if (v && typeof (v as { toMillis?: () => number }).toMillis === 'function') return (v as { toMillis: () => number }).toMillis();
  if (typeof v === 'string') { const t = new Date(v.replace(' ', 'T')).getTime(); return Number.isNaN(t) ? null : t; }
  return null;
}

async function run(db: Firestore, brand: string) {
  const now = Date.now();
  const fromDate = colomboDateStr(-LOOKBACK_DAYS);

  // Single-field range filter — auto-indexed, no composite needed.
  const snap = await db.collection('attendances').where('date', '>=', fromDate).get();

  let scanned = 0, flagged = 0, notified = 0;

  for (const doc of snap.docs) {
    const data = doc.data();
    if (data.is_deleted) continue;
    const epf = String(data.epf_number ?? '');
    const dateStr = String(data.date ?? '');
    if (!epf || !dateStr) continue;

    for (const s of sessionsOf(data)) {
      if (!s.check_in || s.check_out) continue;           // only sessions still open
      const inMs = checkInMillis(s.check_in);
      if (inMs == null || now - inMs < MAX_MS) continue;  // not yet implausibly long

      scanned++;
      const sessionId = String(s.id ?? `s@${inMs}`);
      const actualHrs = (now - inMs) / 3_600_000;
      const created = await createReviewIfAbsent(db, {
        epf,
        employeeName: String(data.employee_name ?? '') || null,
        dateStr,
        sessionId,
        reason: 'open_session_stale',
        actualHrs: Math.round(actualHrs * 100) / 100,
        scheduledHrs: null,
        severityHrs: reviewSeverityHours(actualHrs, null),
        source: 'cron',
      });
      if (!created) continue; // already flagged by the engine or an earlier run
      flagged++;

      // Mirror the flag onto the session so reports treat it as parked (raw times untouched).
      const sessions = sessionsOf((await doc.ref.get()).data());
      const idx = sessions.findIndex(x => String(x.id ?? `s@${checkInMillis(x.check_in)}`) === sessionId && x.check_in && !x.check_out);
      if (idx !== -1 && sessions[idx].review_status !== 'flagged') {
        const next = sessions.map((x, i) => (i === idx ? { ...x, review_status: 'flagged' } : x));
        await doc.ref.update({ sessions: next, updated_at: Timestamp.now() }).catch(() => undefined);
      }

      await notifyReviewFlag(db, { epf, dateStr, sessionId, actualHrs, brand }).catch(() => undefined);
      notified++;
    }
  }

  return { from: fromDate, docs: snap.size, scanned, flagged, notified };
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const tenants = [];
    for (const { tenant, db } of adminDbsForRequest(req)) {
      if (tenant.id !== 'southernlanka') continue; // rosters + fingerprint are southernlanka-only
      tenants.push({ tenant: tenant.id, ...(await run(db, tenant.appName)) });
    }
    return NextResponse.json({ success: true, tenants });
  } catch (e) {
    console.error('[cron/auto-checkout]', e);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

// Allow GET too — many cron/uptime pingers only issue GETs.
export async function GET(req: NextRequest) {
  return POST(req);
}
