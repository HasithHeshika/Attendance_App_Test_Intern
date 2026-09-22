import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeChamaryFoodReport, indicativeMealRate, INDICATIVE_LOOKBACK_MONTHS } from '../foodReport';
import type { LunchRequest } from '../types';

function booking(over: Partial<LunchRequest> & { epf_number: string; employee_name: string }): LunchRequest {
  return {
    id:                 `${over.epf_number}__${over.date ?? '2026-08-01'}`,
    company_id:         'c1',
    company_name:       'Alta Vision',
    date:               '2026-08-01',
    chamary_id:         'ch1',
    chamary_name:       'Site A Canteen',
    working_place_id:   'wp1',
    working_place_name: 'Site A',
    requested_by:       over.epf_number,
    requested_by_name:  over.employee_name,
    created_at:         null as unknown as LunchRequest['created_at'],
    updated_at:         null as unknown as LunchRequest['updated_at'],
    ...over,
  };
}

// ─── equal split across meal types ────────────────────────────────────────────────

test('every meal type costs the same share of the spend', () => {
  const { rows, totalMeals, perMealCost } = computeChamaryFoodReport({
    approvedSpend: 400,
    bookings: [
      booking({ epf_number: 'E1', employee_name: 'Amal', meal: 'breakfast' }),
      booking({ epf_number: 'E1', employee_name: 'Amal', meal: 'dinner', date: '2026-08-02' }),
      booking({ epf_number: 'E2', employee_name: 'Nimal', meal: 'lunch' }),
      booking({ epf_number: 'E3', employee_name: 'Sunil', meal: 'dinner' }),
    ],
  });

  assert.equal(totalMeals, 4);
  assert.equal(perMealCost, 100);
  assert.deepEqual(rows.map(r => [r.employee_name, r.total, r.deduction]), [
    ['Amal', 2, 200],
    ['Nimal', 1, 100],
    ['Sunil', 1, 100],
  ]);
});

test('meal columns are counted per type and rows sort by employee name', () => {
  const { rows } = computeChamaryFoodReport({
    approvedSpend: 0,
    bookings: [
      booking({ epf_number: 'E2', employee_name: 'Zoysa', meal: 'dinner' }),
      booking({ epf_number: 'E1', employee_name: 'Amal', meal: 'breakfast' }),
      booking({ epf_number: 'E1', employee_name: 'Amal', meal: 'breakfast', date: '2026-08-02' }),
      booking({ epf_number: 'E1', employee_name: 'Amal', meal: 'lunch', date: '2026-08-03' }),
    ],
  });

  assert.deepEqual(rows.map(r => r.employee_name), ['Amal', 'Zoysa']);
  assert.deepEqual(
    { breakfast: rows[0].breakfast, lunch: rows[0].lunch, dinner: rows[0].dinner, total: rows[0].total },
    { breakfast: 2, lunch: 1, dinner: 0, total: 3 },
  );
});

// ─── legacy bookings ──────────────────────────────────────────────────────────────

test('a booking written before meal types existed counts as lunch', () => {
  const { rows } = computeChamaryFoodReport({
    approvedSpend: 300,
    bookings: [
      booking({ epf_number: 'E1', employee_name: 'Amal' }),
      booking({ epf_number: 'E1', employee_name: 'Amal', meal: undefined, date: '2026-08-02' }),
      booking({ epf_number: 'E2', employee_name: 'Nimal', meal: 'lunch' }),
    ],
  });

  assert.equal(rows[0].lunch, 2);
  assert.equal(rows[0].breakfast, 0);
  assert.equal(rows[0].dinner, 0);
  assert.equal(rows[0].deduction, 200);
});

// ─── no-shows are still charged ───────────────────────────────────────────────────

test('an unserved booking is still charged and lands in the no-show column', () => {
  const { rows, totalMeals } = computeChamaryFoodReport({
    approvedSpend: 200,
    bookings: [
      booking({ epf_number: 'E1', employee_name: 'Amal', meal: 'lunch', served: true }),
      booking({ epf_number: 'E2', employee_name: 'Nimal', meal: 'lunch', served: false }),
    ],
  });

  assert.equal(totalMeals, 2);
  assert.deepEqual(rows.map(r => [r.served, r.noShows, r.deduction]), [
    [1, 0, 100],
    [0, 1, 100],
  ]);
});

test('a booking with no served flag at all is a no-show, not a served meal', () => {
  const { rows } = computeChamaryFoodReport({
    approvedSpend: 100,
    bookings: [booking({ epf_number: 'E1', employee_name: 'Amal', meal: 'lunch' })],
  });

  assert.equal(rows[0].served, 0);
  assert.equal(rows[0].noShows, 1);
  assert.equal(rows[0].deduction, 100);
});

// ─── empty month ──────────────────────────────────────────────────────────────────

test('no bookings: no rows, no deduction, no division by zero', () => {
  const { rows, totalMeals, perMealCost } = computeChamaryFoodReport({
    approvedSpend: 5000,
    bookings: [],
  });

  assert.deepEqual(rows, []);
  assert.equal(totalMeals, 0);
  assert.equal(perMealCost, 0);
  assert.ok(Number.isFinite(perMealCost));
});

test('bookings but no approved spend: every deduction is zero', () => {
  const { rows, perMealCost } = computeChamaryFoodReport({
    approvedSpend: 0,
    bookings: [
      booking({ epf_number: 'E1', employee_name: 'Amal', meal: 'lunch' }),
      booking({ epf_number: 'E2', employee_name: 'Nimal', meal: 'dinner' }),
    ],
  });

  assert.equal(perMealCost, 0);
  assert.deepEqual(rows.map(r => r.deduction), [0, 0]);
});

test('deduction is rounded to 2 decimals', () => {
  const { rows } = computeChamaryFoodReport({
    approvedSpend: 100,
    bookings: [
      booking({ epf_number: 'E1', employee_name: 'Amal', meal: 'lunch' }),
      booking({ epf_number: 'E2', employee_name: 'Nimal', meal: 'lunch' }),
      booking({ epf_number: 'E3', employee_name: 'Sunil', meal: 'lunch' }),
    ],
  });

  assert.deepEqual(rows.map(r => r.deduction), [33.33, 33.33, 33.33]);
});

// ─── the indicative rate shown to employees ───────────────────────────────────────

test('the last closed month sets the rate', () => {
  const rate = indicativeMealRate([
    { month: '2026-07', approvedSpend: 1500, bookings: [
      booking({ epf_number: 'E1', employee_name: 'Amal', meal: 'lunch', date: '2026-07-01' }),
      booking({ epf_number: 'E2', employee_name: 'Nimal', meal: 'lunch', date: '2026-07-01' }),
      booking({ epf_number: 'E3', employee_name: 'Sunil', meal: 'dinner', date: '2026-07-02' }),
    ] },
    { month: '2026-06', approvedSpend: 900, bookings: [
      booking({ epf_number: 'E1', employee_name: 'Amal', meal: 'lunch', date: '2026-06-01' }),
    ] },
  ]);

  assert.deepEqual(rate, { ratePerMeal: 500, basisMonth: '2026-07', basisMeals: 3 });
});

test('a closed month with no meals is skipped for the newest older month that has some', () => {
  const rate = indicativeMealRate([
    { month: '2026-07', approvedSpend: 4000, bookings: [] },
    { month: '2026-06', approvedSpend: 600, bookings: [
      booking({ epf_number: 'E1', employee_name: 'Amal', meal: 'lunch', date: '2026-06-01' }),
      booking({ epf_number: 'E2', employee_name: 'Nimal', meal: 'lunch', date: '2026-06-01' }),
    ] },
    { month: '2026-05', approvedSpend: 100, bookings: [
      booking({ epf_number: 'E1', employee_name: 'Amal', meal: 'lunch', date: '2026-05-01' }),
    ] },
  ]);

  assert.deepEqual(rate, { ratePerMeal: 300, basisMonth: '2026-06', basisMeals: 2 });
});

test('an unserved booking still sets the rate — the food was cooked for it', () => {
  const rate = indicativeMealRate([
    { month: '2026-07', approvedSpend: 400, bookings: [
      booking({ epf_number: 'E1', employee_name: 'Amal', meal: 'lunch', date: '2026-07-01', served: true }),
      booking({ epf_number: 'E2', employee_name: 'Nimal', meal: 'lunch', date: '2026-07-01', served: false }),
    ] },
  ]);

  assert.equal(rate.ratePerMeal, 200);
  assert.equal(rate.basisMeals, 2);
});

test('a legacy booking with no meal field still counts toward the rate', () => {
  const rate = indicativeMealRate([
    { month: '2026-07', approvedSpend: 300, bookings: [
      booking({ epf_number: 'E1', employee_name: 'Amal', meal: undefined, date: '2026-07-01' }),
      booking({ epf_number: 'E2', employee_name: 'Nimal', meal: undefined, date: '2026-07-02' }),
    ] },
  ]);

  assert.equal(rate.ratePerMeal, 150);
  assert.equal(rate.basisMeals, 2);
});

test('the rate is rounded to 2 decimals', () => {
  const rate = indicativeMealRate([
    { month: '2026-07', approvedSpend: 100, bookings: [
      booking({ epf_number: 'E1', employee_name: 'Amal', meal: 'lunch', date: '2026-07-01' }),
      booking({ epf_number: 'E2', employee_name: 'Nimal', meal: 'lunch', date: '2026-07-01' }),
      booking({ epf_number: 'E3', employee_name: 'Sunil', meal: 'lunch', date: '2026-07-01' }),
    ] },
  ]);

  assert.equal(rate.ratePerMeal, 33.33);
});

// ─── no settled rate to show ──────────────────────────────────────────────────────

test('a brand-new chamary gets no rate at all, not a zero and not a division by zero', () => {
  const rate = indicativeMealRate([
    { month: '2026-07', approvedSpend: 8000, bookings: [] },
    { month: '2026-06', approvedSpend: 0, bookings: [] },
    { month: '2026-05', approvedSpend: 0, bookings: [] },
  ]);

  assert.deepEqual(rate, { ratePerMeal: null, basisMonth: null, basisMeals: 0 });
});

test('no closed months at all: no rate', () => {
  assert.deepEqual(indicativeMealRate([]), { ratePerMeal: null, basisMonth: null, basisMeals: 0 });
});

test('only the lookback window is considered — the oldest month in it still counts', () => {
  // The window is the caller's to fill: what it hands over is all this sees, so a month older
  // than INDICATIVE_LOOKBACK_MONTHS can never become the basis however many meals it had.
  const window = Array.from({ length: INDICATIVE_LOOKBACK_MONTHS }, (_, i) => ({
    month: `2026-0${7 - i}`, approvedSpend: 0, bookings: [] as LunchRequest[],
  }));

  assert.equal(indicativeMealRate(window).basisMonth, null);

  const oldest = window[window.length - 1].month;
  window[window.length - 1] = {
    month: oldest, approvedSpend: 500, bookings: [
      booking({ epf_number: 'E1', employee_name: 'Amal', meal: 'lunch', date: `${oldest}-01` }),
    ],
  };
  assert.equal(indicativeMealRate(window).basisMonth, oldest);
  assert.equal(indicativeMealRate(window).ratePerMeal, 500);
});
