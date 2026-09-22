// Bill numbering — the decision half of keeping a run gap-free.
//
// A bill number is a plain dense counter WITHIN its run (one run per company per fiscal year;
// see billScopeKey/nextBillNo in src/services/suspenseService.ts). Cancelling a bill frees its
// slot and the run's highest un-approved bill drops into it, so the live set keeps reading
// 1,2,3,4… with no holes.
//
// Everything here is pure, dependency-free and side-effect-free — plain data in, a decision out —
// so the numbering rules can be unit tested without Firestore (see
// src/lib/__tests__/billNumbering.test.ts). The service maps its documents onto BillRunEntry and
// applies what these functions decide; it never re-derives the rules itself.

/** One live bill in a run, as the planner needs to see it. */
export interface BillRunEntry {
  id:      string;
  /** The slot it occupies, or null when its number can't be read (legacy/malformed). */
  slot:    number | null;
  bill_no: string | null;
  /** Approved (or ever voucher-ed) — its number is on a voucher and can never move or be reused. */
  frozen:  boolean;
}

/** Which bill (if any) takes the freed slot, or why the hole has to stay open. */
export interface BillBackfillMove {
  slot:           number;          // the slot being freed
  move_id:        string | null;   // the bill that takes it, if one can
  move_from_slot: number | null;
  move_from_no:   string | null;
  blocked:        boolean;
  blocked_reason: string | null;
}

// The two reasons a hole can't be closed. Exported so the audit trail and the tests read the same
// text rather than two copies that can drift apart.
export const BILL_GAP_UNREADABLE_IN_RUN =
  'A bill in this run has no readable number — the slot was left open rather than risk reusing a number.';
export const BILL_GAP_FROZEN_ABOVE =
  'An approved bill holds a higher number in this run, so the cancelled number can’t be reused.';

/**
 * The slot a `bill_seq` value stands for, or null for a legacy "YYMM<epf>####" number (and for
 * any malformed value) — never throws, so an old or half-written row simply sits out the density
 * maths instead of being guessed at.
 */
export function readBillSlot(seq: unknown): number | null {
  return typeof seq === 'number' && Number.isFinite(seq) && seq >= 1 ? Math.floor(seq) : null;
}

/**
 * Work out which bill backfills the slot freed by cancelling `cancelled`.
 *
 * BACKFILL, NEVER A SHIFT. The run's highest un-approved bill drops into the freed slot: ONE
 * document write, and the set stays dense. Shifting every later bill down by one is not an option
 * at company/fiscal-year scope — a run reaches thousands of bills, far past Firestore's 500-write
 * transaction cap, and it deadlocks the moment a frozen approved bill sits in the path.
 *
 * `run` is every OTHER live (not cancelled) bill in the same run. Returns null when there is no
 * run to keep dense — a legacy-numbered bill carries no scope and no readable slot.
 */
export function planBillBackfillMove(
  cancelled: { scope?: string | null; seq?: unknown },
  run: BillRunEntry[],
): BillBackfillMove | null {
  const slot = readBillSlot(cancelled.seq);
  if (!cancelled.scope || slot === null) return null;   // legacy-numbered bill — no run to keep dense

  const gap = (reason: string): BillBackfillMove => ({
    slot, move_id: null, move_from_slot: null, move_from_no: null, blocked: true, blocked_reason: reason,
  });

  // A live bill in this run with no readable slot means the run's bookkeeping is already off; the
  // counter can't be stepped back safely because that bill's real slot is unknown. Leave it alone.
  if (run.some(e => e.slot === null)) return gap(BILL_GAP_UNREADABLE_IN_RUN);

  const above = run.filter(e => (e.slot as number) > slot);

  // THE ONE CASE WHERE DENSITY IS IMPOSSIBLE. An approved bill above the hole can't come down (its
  // number is on a voucher and in the exports) and the run can't shrink past it, so the gap has to
  // stay. Accounting integrity outranks a tidy sequence: leave it, record it, carry on.
  if (above.some(e => e.frozen)) return gap(BILL_GAP_FROZEN_ABOVE);

  const highest = above.reduce<BillRunEntry | null>(
    (best, e) => (best && (best.slot as number) >= (e.slot as number) ? best : e), null);

  return {
    slot,
    move_id:        highest?.id ?? null,
    move_from_slot: highest?.slot ?? null,
    move_from_no:   highest?.bill_no ?? null,
    blocked:        false,
    blocked_reason: null,
  };
}

/**
 * Where the run's counter ends up once `move` is applied: the highest slot STILL OCCUPIED
 * afterwards, so the next submission fills the top of the run instead of opening a fresh hole
 * above it. With the highest bill moved down that's the second-highest bill above the hole (or the
 * freed slot itself, now filled); with nothing above the hole at all it's the highest bill below it
 * — 0 when the run empties out. Never lands below an occupied slot, which would hand a live bill's
 * number to the next submission.
 *
 * `run` is the same list given to planBillBackfillMove. Only meaningful for an unblocked move — a
 * blocked one leaves the counter exactly where it is.
 */
export function nextCounterSeq(move: BillBackfillMove, run: BillRunEntry[]): number {
  const remaining = move.move_id ? run.filter(e => e.id !== move.move_id) : run;
  return remaining.reduce((m, e) => Math.max(m, e.slot ?? 0), move.move_id ? move.slot : 0);
}
