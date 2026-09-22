import { NextRequest, NextResponse } from 'next/server';
import { adminDbFor, tenantForRequest } from '@/lib/firebaseAdmin';
import { verifySignedInCaller } from '@/lib/adminCaller';
import {
  GREETING_SEND_HOUR, colomboHour, colomboToday, sweepGreetingsForDb,
} from '@/lib/greetingsServer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The second way today's greetings can go out: a device noticed the 08:00 job had not run.
 *
 * WHY THIS EXISTS. A birthday card is worth nothing the day after. The daily job is a single
 * scheduled function, and a single scheduled function that misses its window takes the whole
 * organisation's greetings down with it, silently, on the one day each person would notice.
 * This gives that a second chance without a second schedule: whichever employee opens the app
 * first after 08:00 asks whether the day was covered, and if it was not, covers it.
 *
 * WHY THE DEVICE ONLY ASKS, NEVER SENDS. It is tempting to have the phone count down and post
 * the greeting itself. It cannot, and it should not:
 *   • A web app has no background execution. setTimeout dies with the tab, a service worker
 *     wakes only for a push, and Periodic Background Sync is Chromium-only — this workforce is
 *     largely iOS, where it does not exist at all. A phone cannot wake itself at 08:00.
 *   • Sending from the device would mean every phone holding the recipient list and every
 *     message body. firestore.rules cannot police data that is already on the client.
 *   • Two phones, or three hundred, would each believe they were the sender.
 * So the device contributes the one thing it actually has — the knowledge that somebody is
 * awake and looking — and the server does the work with the identity and the data it already
 * holds.
 *
 * NO DUPLICATES, AND NOT BECAUSE CALLERS ARE CAREFUL. deliverGreeting claims a once-per-year
 * marker per person per occasion with `.create()`, which fails if the document already exists.
 * That is an atomic compare-and-set: the loser of the race writes nothing and reports
 * 'skipped'. So the cron and this route may run at the same moment, on the same second, and
 * the recipient still gets exactly one card. The lease below is NOT what makes that true — it
 * is only there so that three hundred phones opening at 08:01 do not each sweep the roll.
 *
 * WHICH IS WHY THE CRON DOES NOT DEPEND ON THE LEASE. It runs unconditionally and remains
 * authoritative; it merely stamps the same document afterwards, so a device that arrives later
 * can tell the day was handled without reading anything else.
 */

interface Body { idToken?: unknown }

export async function POST(req: NextRequest) {
  let body: Body;
  try { body = (await req.json()) as Body; } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }

  const db = adminDbFor(req);
  const tenant = tenantForRequest(req);

  // Identity, not authority. Any employee's device may report that the morning looks uncovered;
  // what it can trigger is exactly what the scheduled job would have done anyway, to exactly
  // the same people. There is no capability that would make this safer and several that would
  // make it useless — an approver-only gate means a company whose approvers are all on leave
  // never recovers a missed morning. The token is required so this is not an open trigger for
  // anyone who can reach the domain.
  const caller = await verifySignedInCaller(db, body.idToken);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const today = colomboToday();

  // The server's clock decides, never the caller's. A phone an hour fast would otherwise send
  // the whole organisation's greetings an hour early, and one set to yesterday would re-open a
  // day that is closed. Before the scheduled hour this is not a missed run, it is an early
  // riser: say so and do nothing.
  if (colomboHour() < GREETING_SEND_HOUR) {
    return NextResponse.json({ ran: false, reason: 'not_due', today });
  }

  // The lease. `.create()` fails if the document exists, so the first caller of the day wins it
  // and everyone after is a no-op — including after the cron, which stamps this same document
  // when it finishes. Admin-SDK only; firestore.rules denies the browser outright, because a
  // client that could write this could pre-claim the day and suppress every greeting in the
  // organisation with a single document.
  const lease = db.collection('greeting_runs').doc(today);
  try {
    await lease.create({ by: 'device', epf: caller.epf, at: new Date().toISOString() });
  } catch {
    return NextResponse.json({ ran: false, reason: 'already_run', today });
  }

  try {
    const result = await sweepGreetingsForDb(
      db, { brand: tenant.appName, originUrl: req.nextUrl.origin }, today,
    );
    return NextResponse.json({ ran: true, today, ...result });
  } catch (e) {
    // Release the lease so the next device — or the cron — can still cover the day. A lease
    // held by a run that died is worse than no lease at all: it turns one transient failure
    // into everybody's birthday being missed.
    await lease.delete().catch(() => {});
    console.error('[greetings/catch-up]', e);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
