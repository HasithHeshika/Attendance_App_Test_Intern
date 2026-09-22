import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { adminDbFor } from '@/lib/firebaseAdmin';
import { verifySignedInCaller } from '@/lib/adminCaller';
import { resolveCapabilities } from '@/lib/permissions';
import { isMealMultiplier, MEAL_MULTIPLIERS } from '@/lib/foodCost';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Set the penalty or credit on one meal booking: 0.5 (they helped), 1 (default), 1.5, 2 (late).
 *
 * This is a money write. The chamary's bills are divided by the SUM of multipliers, so a 2× meal
 * costs that person double and lowers everyone else's share (see splitFoodCost in
 * src/lib/foodCost.ts). A client path is impossible by design: firestore.rules refuses
 * `multiplier` on create and refuses to let an update change it, because every can*() helper in
 * that file reduces to isAuth() and a writable field would let any signed-in employee halve
 * their own food bill or double a colleague's. The Admin SDK bypasses rules, so this route is
 * the only door — and it checks who is knocking.
 *
 * Who may: the chamary's own responsible person, a system admin, or a suspense approver (the
 * food deduction is theirs to answer for). The two admin kinds may price any chamary.
 */

/** The note is shown to the person being charged, so it is short and trimmed. */
const NOTE_MAX = 200;

interface Body {
  idToken?: unknown;
  /** The lunch_requests document id. */
  bookingId?: unknown;
  multiplier?: unknown;
  note?: unknown;
}

export async function POST(req: NextRequest) {
  const db = adminDbFor(req);
  let body: Body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad JSON' }, { status: 400 }); }

  const caller = await verifySignedInCaller(db, body.idToken);
  if (!caller) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });

  const bookingId = String(body.bookingId ?? '').trim();
  if (!bookingId) return NextResponse.json({ error: 'Missing booking' }, { status: 400 });

  // Only the four real values, and refused rather than coerced: a coerced multiplier is a
  // silent change to what somebody pays.
  const multiplier = typeof body.multiplier === 'number' ? body.multiplier : Number.NaN;
  if (!isMealMultiplier(multiplier)) {
    return NextResponse.json(
      { error: `Multiplier must be one of ${MEAL_MULTIPLIERS.join(', ')}` },
      { status: 400 },
    );
  }

  const ref = db.collection('lunch_requests').doc(bookingId);
  const snap = await ref.get();
  if (!snap.exists) return NextResponse.json({ error: 'That booking no longer exists' }, { status: 404 });
  const booking = snap.data() ?? {};

  // ── May this caller price this chamary's food? ──
  const roleSnap = caller.role
    ? await db.collection('roles').where('name', '==', caller.role).limit(1).get()
    : null;
  const roleDoc = roleSnap && !roleSnap.empty ? roleSnap.docs[0].data() : null;
  // The employee type is passed, not omitted: resolveCapabilities narrows a role to the trainee
  // access set only when it is TOLD the type, so leaving it out would let a trainee whose parent
  // role carries can_approve_suspense re-price anybody's meals.
  const caps = resolveCapabilities(roleDoc as never, caller.employeeType || undefined);
  let mayPrice = !!(caps.is_system_admin || caps.can_approve_suspense || caller.systemAdmin);

  if (!mayPrice) {
    // A chamary is a nested entry inside its working_places document, which is exactly why
    // firestore.rules cannot make this decision itself without a read per write — and why this
    // route exists at all.
    const chamaryId = String(booking.chamary_id ?? '').trim();
    if (chamaryId) {
      const places = await db.collection('working_places').get();
      for (const place of places.docs) {
        const list = place.data()?.chamaries;
        const hit = Array.isArray(list)
          ? (list as Array<Record<string, unknown>>).find(c => String(c?.id ?? '') === chamaryId)
          : undefined;
        if (hit) {
          mayPrice = String(hit.responsible_epf ?? '').trim() === caller.epf;
          break;
        }
      }
    }
  }
  if (!mayPrice) return NextResponse.json({ error: 'You do not run that chamary' }, { status: 403 });

  // A month payroll has already finalised is a fact about a payslip somebody has been paid.
  // Re-pricing it would move money after the fact, so it is refused.
  //
  // Read by document id rather than queried: a run's id is `${company}_${year}_${MM}` and its
  // year/month are NUMBERS, so a where() on all three would demand a composite index — the
  // failure this codebase has already been bitten by. One get, no index.
  const date = String(booking.date ?? '');
  const companyId = String(booking.company_id ?? '').trim();
  if (companyId && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const runId = `${companyId}_${date.slice(0, 4)}_${date.slice(5, 7)}`;
    const run = await db.collection('payroll_runs').doc(runId).get().catch(() => null);
    if (run?.exists && String(run.data()?.status ?? '') === 'finalized') {
      return NextResponse.json(
        { error: 'Payroll for that month is already finalised' },
        { status: 409 },
      );
    }
  }

  const note = String(body.note ?? '').trim().slice(0, NOTE_MAX);
  await ref.update({
    multiplier,
    multiplier_by: caller.epf,
    multiplier_by_name: caller.name,
    multiplier_at: FieldValue.serverTimestamp(),
    // A blank note removes the old one rather than leaving a stale reason attached to a new
    // multiplier — the reason has to match the charge.
    multiplier_note: note ? note : FieldValue.delete(),
  });

  return NextResponse.json({ ok: true, multiplier, note: note || null });
}
