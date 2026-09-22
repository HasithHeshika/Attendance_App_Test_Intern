import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readBillSlot,
  planBillBackfillMove,
  nextCounterSeq,
  BILL_GAP_FROZEN_ABOVE,
  BILL_GAP_UNREADABLE_IN_RUN,
  type BillRunEntry,
  type BillBackfillMove,
} from '../billNumbering';

const SCOPE = 'companyA__2025';

// One live bill in the run. `slot: null` is a current-scheme bill whose bill_seq can't be read.
const bill = (id: string, slot: number | null, frozen = false): BillRunEntry =>
  ({ id, slot, bill_no: slot === null ? 'broken' : String(slot), frozen });

// planBillBackfillMove returns null only for a bill with no run to keep dense (its own tests
// below); everywhere else a plan is expected, and this keeps the assertions readable.
function planned(cancelled: { scope?: string | null; seq?: unknown }, run: BillRunEntry[]): BillBackfillMove {
  const move = planBillBackfillMove(cancelled, run);
  if (!move) throw new Error('expected a plan for a scoped, numbered bill');
  return move;
}

test('readBillSlot: a whole number ≥ 1 is a slot, anything else is unreadable', () => {
  assert.equal(readBillSlot(1), 1);
  assert.equal(readBillSlot(37), 37);
  assert.equal(readBillSlot(0), null);
  assert.equal(readBillSlot(-2), null);
  assert.equal(readBillSlot(undefined), null);
  assert.equal(readBillSlot(null), null);
  assert.equal(readBillSlot(NaN), null);
  assert.equal(readBillSlot(Infinity), null);
  // A legacy "YYMM<epf>####" bill carries no bill_seq at all; a string is never trusted as one.
  assert.equal(readBillSlot('3'), null);
});

test('planBillBackfillMove: the run’s highest bill drops into the freed slot', () => {
  const run = [bill('a', 1), bill('b', 2), bill('d', 4), bill('e', 5)];
  const move = planned({ scope: SCOPE, seq: 3 }, run);
  assert.equal(move.blocked, false);
  assert.equal(move.slot, 3);
  assert.equal(move.move_id, 'e');
  assert.equal(move.move_from_slot, 5);
  assert.equal(move.move_from_no, '5');
  // 1,2,4 stay put and the mover now sits in 3 — the top of the run is 4.
  assert.equal(nextCounterSeq(move, run), 4);
});

test('planBillBackfillMove: the highest bill is picked whatever order the run comes back in', () => {
  // The run is read with an unordered equality query, so nothing may depend on document order.
  const run = [bill('e', 5), bill('a', 1), bill('d', 4), bill('b', 2)];
  assert.equal(planned({ scope: SCOPE, seq: 3 }, run).move_id, 'e');
  assert.equal(planned({ scope: SCOPE, seq: 3 }, [...run].reverse()).move_id, 'e');
});

test('planBillBackfillMove: cancelling the highest number moves nothing and steps the counter back', () => {
  const run = [bill('a', 1), bill('b', 2), bill('c', 3), bill('d', 4)];
  const move = planned({ scope: SCOPE, seq: 5 }, run);
  assert.equal(move.blocked, false);
  assert.equal(move.move_id, null);
  assert.equal(move.move_from_slot, null);
  // Nothing sits above the hole, so the counter lands on the highest bill left — the next
  // submission fills 5 again instead of opening a hole at 5 and taking 6.
  assert.equal(nextCounterSeq(move, run), 4);
});

test('planBillBackfillMove: cancelling the run’s only bill empties it back to zero', () => {
  const move = planned({ scope: SCOPE, seq: 1 }, []);
  assert.equal(move.blocked, false);
  assert.equal(move.move_id, null);
  assert.equal(nextCounterSeq(move, []), 0);
});

test('planBillBackfillMove: an approved bill above the hole leaves the gap open', () => {
  // Its number is on a voucher and in the exports — it can never come down, and the run can't
  // shrink past it. Accounting integrity outranks a dense sequence.
  const run = [bill('a', 1), bill('d', 4, true), bill('e', 5)];
  const move = planned({ scope: SCOPE, seq: 3 }, run);
  assert.equal(move.blocked, true);
  assert.equal(move.blocked_reason, BILL_GAP_FROZEN_ABOVE);
  assert.equal(move.move_id, null);
  assert.equal(move.move_from_slot, null);
  assert.equal(move.move_from_no, null);
});

test('planBillBackfillMove: an approved bill BELOW the hole blocks nothing', () => {
  // It isn't in the way — only a frozen number above the freed slot makes density impossible.
  const run = [bill('a', 1, true), bill('b', 2, true), bill('e', 5)];
  const move = planned({ scope: SCOPE, seq: 3 }, run);
  assert.equal(move.blocked, false);
  assert.equal(move.move_id, 'e');
  assert.equal(nextCounterSeq(move, run), 3);
});

test('planBillBackfillMove: a legacy-numbered bill is a no-op — there is no run to keep dense', () => {
  const run = [bill('a', 1), bill('b', 2)];
  // Legacy bills carry neither a scope nor a readable seq; either one missing means no plan at all,
  // so the service never even queries the run for them.
  assert.equal(planBillBackfillMove({ scope: undefined, seq: 3 }, run), null);
  assert.equal(planBillBackfillMove({ scope: null, seq: 3 }, run), null);
  assert.equal(planBillBackfillMove({ scope: '', seq: 3 }, run), null);
  assert.equal(planBillBackfillMove({ scope: SCOPE, seq: undefined }, run), null);
  assert.equal(planBillBackfillMove({ scope: SCOPE, seq: '3' }, run), null);
  assert.equal(planBillBackfillMove({ scope: SCOPE, seq: 0 }, run), null);
});

test('planBillBackfillMove: an unreadable bill in the run blocks rather than guessing', () => {
  // A live bill in this run whose slot can't be read means the bookkeeping is already off: its real
  // slot is unknown, so moving anything (or stepping the counter back) could reuse a live number.
  const run = [bill('a', 1), bill('x', null), bill('e', 5)];
  const move = planned({ scope: SCOPE, seq: 3 }, run);
  assert.equal(move.blocked, true);
  assert.equal(move.blocked_reason, BILL_GAP_UNREADABLE_IN_RUN);
  assert.equal(move.move_id, null);
});

test('planBillBackfillMove: an unreadable bill blocks even when it sits below the hole', () => {
  const run = [bill('x', null), bill('e', 5)];
  assert.equal(planned({ scope: SCOPE, seq: 6 }, run).blocked_reason, BILL_GAP_UNREADABLE_IN_RUN);
});

test('nextCounterSeq: the mover’s old slot is vacated, so the counter drops to the next one down', () => {
  const run = [bill('a', 1), bill('d', 4), bill('e', 9)];
  const move = planned({ scope: SCOPE, seq: 2 }, run);
  assert.equal(move.move_id, 'e');
  // 9 moved into 2, so 9 is free and the top of the run is 4.
  assert.equal(nextCounterSeq(move, run), 4);
});

test('nextCounterSeq: the counter never lands below a slot that is still occupied', () => {
  // Handing the next submission a number a live bill already holds is the one outcome that must be
  // impossible, so this is checked across whole shapes of run rather than a single example.
  const runs: BillRunEntry[][] = [
    [],
    [bill('a', 1)],
    [bill('a', 1), bill('b', 2), bill('d', 4), bill('e', 5)],
    [bill('a', 1, true), bill('b', 2), bill('c', 3, true)],
    [bill('a', 7), bill('b', 9)],
    [bill('a', 2), bill('b', 3), bill('c', 6), bill('d', 8), bill('e', 11)],
  ];
  for (const run of runs) {
    for (let slot = 1; slot <= 12; slot++) {
      if (run.some(e => e.slot === slot)) continue;   // a bill already holds it — not a freed slot
      const move = planned({ scope: SCOPE, seq: slot }, run);
      if (move.blocked) continue;                     // a blocked plan leaves the counter untouched
      const occupied = run
        .filter(e => e.id !== move.move_id)
        .map(e => e.slot as number)
        .concat(move.move_id ? [move.slot] : []);
      const counter = nextCounterSeq(move, run);
      for (const s of occupied) {
        assert.ok(counter >= s, `freeing ${slot}: counter ${counter} sits below occupied slot ${s}`);
      }
    }
  }
});
