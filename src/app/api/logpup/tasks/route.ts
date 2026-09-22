import { NextRequest, NextResponse } from 'next/server';
import { resolveLogPupCaller } from '@/lib/logpupIdentity';
import { getLogPupTasks, logpupConfigured } from '@/lib/logpupApi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * What a caller gets when there is nothing to show. Never an error — see the catch below.
 *
 * `configured` separates "LogPup is switched off here" from "LogPup did not answer". Without
 * that distinction a deployment with the tenant flag on but no API key set yet would show every
 * user a permanent "Couldn't reach LogPup" line, which is both wrong and unfixable by them.
 */
const EMPTY = { success: false, configured: true, matched: false, count: 0, data: [] as unknown[] };

/**
 * Per-user LogPup task proxy. The browser POSTs the caller's Firebase ID token; we verify it,
 * resolve their work email from the authoritative Firestore profile, then fetch ONLY that
 * person's tasks from LogPup with the server-held LOGPUP_API_KEY. The key never reaches the
 * client, and a user can never request someone else's tasks.
 *
 * POST rather than GET because the ID token belongs in a body, not a query string that lands in
 * logs and history. Same shape as /api/solar/notifications.
 *
 * DEGRADES QUIETLY. Every failure answers 200 with an empty list: this app's job is attendance,
 * and LogPup being unreachable must not break the tasks page. The section renders empty with a
 * quiet notice instead (see useLogPupTasks, which reads `success` to decide).
 */
export async function POST(req: NextRequest) {
  try {
    if (!logpupConfigured()) return NextResponse.json({ ...EMPTY, configured: false });

    const body = await req.json().catch(() => ({}));
    const caller = await resolveLogPupCaller(req, body?.idToken);
    if (!caller.ok) {
      // A refusal is still an empty list, not an error page. The one thing worth distinguishing
      // is an expired token, which the client answers by refreshing and retrying.
      return NextResponse.json(
        { ...EMPTY, error: caller.error },
        { status: caller.status === 401 ? 401 : 200 },
      );
    }

    const status = body?.status === 'all' ? 'all' : 'open';
    const result = await getLogPupTasks({ email: caller.caller.email, status, limit: 100 });
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    // LogPup unreachable, misconfigured, or slow — no LogPup tasks this poll.
    return NextResponse.json(EMPTY, { status: 200 });
  }
}
