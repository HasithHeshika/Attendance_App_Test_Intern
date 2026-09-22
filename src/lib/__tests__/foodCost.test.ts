import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MEAL_MULTIPLIERS, isMealMultiplier, multiplierOf, splitFoodCost, personCharge, personCost,
  isMonthProvisional, colomboMonthWindow, type CostBooking,
} from '../foodCost';

const bk = (epf: string, multiplier?: unknown): CostBooking =>
  (multiplier === undefined ? { epf } : { epf, multiplier });

/** N bookings for N distinct people, all at the default multiplier. */
const people = (n: number, from = 1): CostBooking[] =>
  Array.from({ length: n }, (_, i) => bk(`E${i + from}`));

// ── multiplierOf ──────────────────────────────────────────────────────────────

test('multiplierOf: the four real values survive, everything else reads as 1', () => {
  for (const m of MEAL_MULTIPLIERS) assert.equal(multiplierOf({ multiplier: m }), m);
  // A value nobody can justify must not silently change what somebody is charged.
  for (const bad of [3, 0, -1, 2.5, '2', '1.5', null, undefined, NaN, Infinity, {}, []]) {
    assert.equal(multiplierOf({ multiplier: bad }), 1, String(bad));
  }
  assert.equal(multiplierOf({}), 1);
  assert.equal(multiplierOf(null), 1);
  assert.equal(multiplierOf(undefined), 1);
});

test('isMealMultiplier: only the four numbers, and never their string forms', () => {
  assert.equal(isMealMultiplier(0.5), true);
  assert.equal(isMealMultiplier(1), true);
  assert.equal(isMealMultiplier(1.5), true);
  assert.equal(isMealMultiplier(2), true);
  assert.equal(isMealMultiplier('2'), false);
  assert.equal(isMealMultiplier(2.0000001), false);
  assert.equal(isMealMultiplier(NaN), false);
});

// ── The worked example from the spec ──────────────────────────────────────────

test('the spec\'s worked example: the books balance against the bills', () => {
  // 100 bookings, LKR 30,000 of bills, one person late twice at 2x.
  const bookings = [
    ...people(98),                                  // E1…E98 at 1
    bk('LATE', 2), bk('LATE', 2),                   // two meals at 2x
  ];
  const s = splitFoodCost({ bookings, billsTotal: 30_000 });

  assert.equal(s.weightedShares, 98 + 4);           // 102, not 100
  assert.ok(Math.abs(s.sharePrice - 30_000 / 102) < 1e-9);

  // The late person pays for four shares; everyone else for one.
  assert.equal(personCharge(s, 'LATE'), 1176.47);
  assert.equal(personCharge(s, 'E1'), 294.12);

  // The half that proves the money came from somewhere: everyone else pays LESS than the
  // unweighted 300.00 they would have paid with no penalty in the month at all.
  assert.ok(personCharge(s, 'E1') < 300);

  // And nothing is invented: what is charged plus what rounding could not place is the bills.
  assert.equal(s.chargedTotal + s.unallocated, s.billsTotal);
});

// ── The two rules ─────────────────────────────────────────────────────────────

test('every booking at 1: everyone pays the same, and it is bills ÷ bookings', () => {
  const s = splitFoodCost({ bookings: people(4), billsTotal: 1000 });
  assert.equal(s.weightedShares, 4);
  assert.equal(s.sharePrice, 250);
  for (const epf of ['E1', 'E2', 'E3', 'E4']) assert.equal(personCharge(s, epf), 250);
  assert.equal(s.chargedTotal, 1000);
  assert.equal(s.unallocated, 0);
});

test('a 2x charge is exactly double a 1x charge AND lowers everyone else', () => {
  const flat = splitFoodCost({ bookings: people(4), billsTotal: 1200 });
  const weighted = splitFoodCost({
    bookings: [bk('E1', 2), bk('E2'), bk('E3'), bk('E4')],
    billsTotal: 1200,
  });
  assert.equal(weighted.weightedShares, 5);
  assert.equal(weighted.sharePrice, 240);
  assert.equal(personCharge(weighted, 'E1'), 480);
  assert.equal(personCharge(weighted, 'E2'), 240);
  // Double a normal share…
  assert.equal(personCharge(weighted, 'E1'), personCharge(weighted, 'E2') * 2);
  // …and the others really did get cheaper. This is the property a count-divisor would fail.
  assert.ok(personCharge(weighted, 'E2') < personCharge(flat, 'E2'));
  assert.equal(weighted.chargedTotal + weighted.unallocated, 1200);
});

test('a 0.5x credit costs that person half and raises everyone else slightly', () => {
  const flat = splitFoodCost({ bookings: people(4), billsTotal: 1200 });
  const s = splitFoodCost({
    bookings: [bk('E1', 0.5), bk('E2'), bk('E3'), bk('E4')],
    billsTotal: 1200,
  });
  assert.equal(s.weightedShares, 3.5);
  assert.equal(personCharge(s, 'E1'), personCharge(s, 'E2') / 2);
  assert.ok(personCharge(s, 'E2') > personCharge(flat, 'E2'));
  assert.equal(s.chargedTotal + s.unallocated, 1200);
});

test('0.5 and 2 in the same month still balance', () => {
  const s = splitFoodCost({
    bookings: [bk('A', 0.5), bk('B', 2), bk('C'), bk('D', 1.5)],
    billsTotal: 500,
  });
  assert.equal(s.weightedShares, 5);
  assert.equal(s.sharePrice, 100);
  assert.equal(personCharge(s, 'A'), 50);
  assert.equal(personCharge(s, 'B'), 200);
  assert.equal(personCharge(s, 'C'), 100);
  assert.equal(personCharge(s, 'D'), 150);
  assert.equal(s.chargedTotal, 500);
  assert.equal(s.unallocated, 0);
});

test('collection does not enter the formula: a no-show at 2x is still charged 2x', () => {
  // The module is never told whether a meal was collected — that is the point of rule 1.
  // A booking is a share whatever happened to the food.
  const s = splitFoodCost({ bookings: [bk('SKIP', 2), bk('ATE')], billsTotal: 300 });
  assert.equal(s.weightedShares, 3);
  assert.equal(personCharge(s, 'SKIP'), 200);
  assert.equal(personCharge(s, 'ATE'), 100);
});

test('one person with several bookings at different multipliers', () => {
  const s = splitFoodCost({
    bookings: [bk('E1'), bk('E1', 2), bk('E1', 0.5), bk('E2')],
    billsTotal: 450,
  });
  assert.equal(s.weightedShares, 4.5);
  assert.equal(s.sharePrice, 100);
  const p = personCost(s, 'E1');
  assert.equal(p.bookings, 3);
  assert.equal(p.shares, 3.5);
  assert.equal(p.charge, 350);
  assert.equal(personCharge(s, 'E2'), 100);
});

// ── The edges that would otherwise show somebody a wrong number ───────────────

test('no bookings: no division by zero, and the bills sit in unallocated', () => {
  const s = splitFoodCost({ bookings: [], billsTotal: 5000 });
  assert.equal(s.weightedShares, 0);
  assert.equal(s.sharePrice, 0);            // not Infinity, not NaN
  assert.equal(s.chargedTotal, 0);
  // Visible rather than silently lost — somebody has to notice bills nobody was charged for.
  assert.equal(s.unallocated, 5000);
});

test('no bills yet: everyone is charged nothing, and it is distinguishable from free', () => {
  const s = splitFoodCost({ bookings: people(3), billsTotal: 0 });
  assert.equal(s.sharePrice, 0);
  assert.equal(personCharge(s, 'E1'), 0);
  assert.equal(s.unallocated, 0);
  // billsTotal is what tells the caller to say "not priced yet" rather than "LKR 0.00".
  assert.equal(s.billsTotal, 0);
});

test('junk input cannot produce a junk money figure', () => {
  for (const bad of [NaN, Infinity, -5, undefined as unknown as number]) {
    const s = splitFoodCost({ bookings: people(2), billsTotal: bad });
    assert.equal(s.billsTotal, 0, String(bad));
    assert.equal(personCharge(s, 'E1'), 0);
  }
  // A booking with no owner is skipped rather than charged to ''.
  const s = splitFoodCost({ bookings: [bk(''), bk('  '), bk('E1')], billsTotal: 100 });
  assert.equal(s.weightedShares, 1);
  assert.equal(personCharge(s, 'E1'), 100);
  assert.deepEqual(Object.keys(s.byPerson), ['E1']);
});

test('personCharge and personCost are safe for somebody who did not book', () => {
  const s = splitFoodCost({ bookings: people(2), billsTotal: 100 });
  assert.equal(personCharge(s, 'NOBODY'), 0);
  assert.deepEqual(personCost(s, 'NOBODY'), { bookings: 0, shares: 0, charge: 0 });
});

// ── Rounding, stated as a bound rather than hoped for ─────────────────────────

test('300 people × 22 bookings: the residue stays under a cent per person', () => {
  const bookings = Array.from({ length: 300 }, (_, p) =>
    Array.from({ length: 22 }, () => bk(`E${p + 1}`))).flat();
  // A bill total that does not divide evenly by 6,600 shares.
  const s = splitFoodCost({ bookings, billsTotal: 1_234_567.89 });
  assert.equal(s.weightedShares, 6600);
  assert.equal(s.chargedTotal + s.unallocated, s.billsTotal);
  assert.ok(Math.abs(s.unallocated) < 300 * 0.01, `residue ${s.unallocated}`);
});

test('a third-of-a-cent price still balances to the cent', () => {
  const s = splitFoodCost({ bookings: people(3), billsTotal: 0.01 });
  assert.equal(s.chargedTotal + s.unallocated, 0.01);
});

// ── Provisional vs settled ────────────────────────────────────────────────────

// ── The bill window ───────────────────────────────────────────────────────────
// These are the tests that stop /food and /chamary drifting apart: both bracket the month with
// this one function, so a bill filed just after midnight lands in the same month on both.

test('colomboMonthWindow: the bracket is Colombo midnight to Colombo midnight', () => {
  const w = colomboMonthWindow('2026-09');
  assert.equal(w.fromMs, Date.parse('2026-09-01T00:00:00+05:30'));
  assert.equal(w.toMs, Date.parse('2026-10-01T00:00:00+05:30') - 1);
  // The half-hour offset is the whole point: 02:00 on the 1st in Colombo is still 20:30 on the
  // PREVIOUS day in UTC, so a UTC-anchored window would push that bill into the month before.
  assert.ok(Date.parse('2026-09-01T02:00:00+05:30') >= w.fromMs);
  assert.ok(Date.parse('2026-08-31T23:59:59+05:30') < w.fromMs);
});

test('colomboMonthWindow: December rolls into the next year', () => {
  const w = colomboMonthWindow('2026-12');
  assert.equal(w.toMs, Date.parse('2027-01-01T00:00:00+05:30') - 1);
  assert.ok(Date.parse('2026-12-31T23:59:59+05:30') <= w.toMs);
  assert.ok(Date.parse('2027-01-01T00:00:00+05:30') > w.toMs);
});

test('colomboMonthWindow: every month is its own length, with no gaps or overlaps', () => {
  const DAY = 86_400_000;
  const lengths: Record<string, number> = {
    '2026-01': 31, '2026-02': 28, '2026-03': 31, '2026-04': 30, '2026-05': 31, '2026-06': 30,
    '2026-07': 31, '2026-08': 31, '2026-09': 30, '2026-10': 31, '2026-11': 30, '2026-12': 31,
    '2028-02': 29,   // a leap February
  };
  for (const [key, days] of Object.entries(lengths)) {
    const w = colomboMonthWindow(key);
    assert.equal(w.toMs - w.fromMs + 1, days * DAY, key);
  }
  // Consecutive months meet exactly: no millisecond belongs to both, and none to neither.
  for (let m = 1; m <= 11; m++) {
    const a = colomboMonthWindow(`2026-${String(m).padStart(2, '0')}`);
    const b = colomboMonthWindow(`2026-${String(m + 1).padStart(2, '0')}`);
    assert.equal(a.toMs + 1, b.fromMs, `${m} -> ${m + 1}`);
  }
});

test('colomboMonthWindow: a malformed key prices nothing rather than pricing a year', () => {
  for (const bad of ['', 'nonsense', '2026-13', '2026-00', 'xxxx-09', '2026']) {
    const w = colomboMonthWindow(bad);
    assert.ok(w.toMs < w.fromMs, bad);          // no instant can satisfy from <= at <= to
    assert.ok(!(1_757_000_000_000 >= w.fromMs && 1_757_000_000_000 <= w.toMs), bad);
  }
});

test('isMonthProvisional: this month and any future month are still moving', () => {
  assert.equal(isMonthProvisional('2026-09', '2026-09-06'), true);
  assert.equal(isMonthProvisional('2026-10', '2026-09-06'), true);
  assert.equal(isMonthProvisional('2026-08', '2026-09-06'), false);
  assert.equal(isMonthProvisional('2025-12', '2026-01-01'), false);
  // A full date is accepted where a month key is expected — both are sliced to 'YYYY-MM'.
  assert.equal(isMonthProvisional('2026-09-30', '2026-09-06'), true);
});
