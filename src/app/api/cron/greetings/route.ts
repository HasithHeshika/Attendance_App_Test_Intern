import { NextRequest, NextResponse } from 'next/server';
import { adminDbsForRequest } from '@/lib/firebaseAdmin';
import { colomboToday, sweepGreetingsForDb } from '@/lib/greetingsServer';
import { secretEquals } from '@/lib/timingSafe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Daily greetings job — run at 08:00 Asia/Colombo by netlify/functions/greetings-daily.mjs
 * (see netlify.toml). For every tenant database whose settings/greetings.enabled is true it
 * finds today's birthdays, work anniversaries and admin special days, and for each person:
 *   • claims a once-per-year marker (birthday_sent / greetings_sent) so a re-run is a no-op,
 *   • writes a direct `notifications` doc of type 'greeting' (deterministic id), and
 *   • pushes via FCM, best-effort.
 * Replaces the old /api/cron/birthday route.
 *
 * Auth: `Authorization: Bearer <CRON_SECRET>` (or `?key=`). Never callable by end users.
 */
function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed if unconfigured
  const header = req.headers.get('authorization') ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const key = bearer || req.nextUrl.searchParams.get('key') || '';
  return secretEquals(key, secret);
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const today = colomboToday();
    const originUrl = req.nextUrl.origin;
    const seenDbs = new Set<string>();
    const tenants: Array<Record<string, unknown>> = [];
    for (const { tenant, db } of adminDbsForRequest(req)) {
      // Two tenant records can share one database (test / test-local): process it once.
      const dbKey = tenant.dbId || '(default)';
      if (seenDbs.has(dbKey)) continue;
      seenDbs.add(dbKey);

      // The sweep itself lives in greetingsServer.ts so that the catch-up route runs the SAME
      // rules (sweepGreetingsForDb). More than one thing may now start a send; only one thing
      // may decide who gets what, or the two drift and somebody gets two cards or none.
      const r = await sweepGreetingsForDb(db, { brand: tenant.appName, originUrl }, today);
      // Stamp the day as handled. /api/greetings/catch-up claims this same document with
      // `.create()`, so once this exists a device that opens later reads one small doc, sees
      // the morning was covered and stops — instead of sweeping the whole roll to discover
      // that every marker is already claimed. Merged, never conditional: this job is
      // authoritative and must not be gated on a lease a dead device could be holding.
      await db.collection('greeting_runs').doc(today)
        .set({ by: 'cron', at: new Date().toISOString(), ...r }, { merge: true })
        .catch(() => {});
      tenants.push({ id: tenant.id, today, ...r });
    }
    return NextResponse.json({ ok: true, tenants });
  } catch (e) {
    console.error('[cron/greetings]', e);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

// Allow GET too — many cron/uptime pingers only issue GETs.
export async function GET(req: NextRequest) {
  return POST(req);
}
