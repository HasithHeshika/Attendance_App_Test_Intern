import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planAutoServe, mealClosed, autoServeKey, AUTO_SERVE_MAX_PER_RUN } from '../mealAutoServe';
import { DEFAULT_MEAL_SLOTS } from '../meals';
import type { LunchRequest, ChamaryMealOffday } from '../types';

function booking(over: Partial<LunchRequest> & { epf_number: string; date: string }): LunchRequest {
  return {
    id: `${over.epf_number}__${over.date}`,
    employee_name: over.epf_number,
    company_id: 'c1', company_name: 'Alta Vision',
    chamary_id: 'ch1', chamary_name: 'Site A Canteen',
    working_place_id: 'wp1', working_place_name: 'Site A',
    requested_by: over.epf_number, requested_by_name: '',
    created_at: null as unknown as LunchRequest['created_at'],
    updated_at: null as unknown as LunchRequest['updated_at'],
    ...over,
  };
}
function off(over: Partial<ChamaryMealOffday> & { date: string }): ChamaryMealOffday {
  return {
    id: `ch1__${over.date}__${over.meal ?? 'lunch'}`, chamary_id: 'ch1', chamary_name: 'Site A Canteen',
    meal: 'lunch', reason: '', set_by: 'R', set_by_name: 'Ravi',
    created_at: null as unknown as ChamaryMealOffday['created_at'],
    ...over,
  };
}

const noSlots = () => DEFAULT_MEAL_SLOTS;   // lunch_from 08:00, dinner_from 12:00

// ── mealClosed ────────────────────────────────────────────────────────────────

test('a day still ahead is never closed, a day already gone always is', () => {
  assert.equal(mealClosed('2026-09-07', 'lunch', '2026-09-06', 1439, null), false);
  assert.equal(mealClosed('2026-09-05', 'lunch', '2026-09-06', 0, null), true);
  assert.equal(mealClosed('2026-09-05', 'dinner', '2026-09-06', 0, null), true);
});

test('today closes meal by meal, at the point the kitchen stops taking names', () => {
  const today = '2026-09-06';
  // Breakfast runs to lunch_from (08:00).
  assert.equal(mealClosed(today, 'breakfast', today, 7 * 60 + 59, null), false);
  assert.equal(mealClosed(today, 'breakfast', today, 8 * 60, null), true);
  // Lunch runs to dinner_from (12:00).
  assert.equal(mealClosed(today, 'lunch', today, 11 * 60 + 59, null), false);
  assert.equal(mealClosed(today, 'lunch', today, 12 * 60, null), true);
  // Dinner runs to midnight — never settled on its own day.
  assert.equal(mealClosed(today, 'dinner', today, 23 * 60 + 59, null), false);
});

test("a kitchen's own slots move the boundary", () => {
  const today = '2026-09-06';
  const late = { lunch_from: 10 * 60, dinner_from: 15 * 60 };
  assert.equal(mealClosed(today, 'lunch', today, 12 * 60, late), false);
  assert.equal(mealClosed(today, 'lunch', today, 15 * 60, late), true);
});

// ── planAutoServe ─────────────────────────────────────────────────────────────

test('a finished day serves everyone nobody spoke for', () => {
  const plan = planAutoServe({
    bookings: [
      booking({ epf_number: 'E1', date: '2026-09-04', meal: 'lunch' }),
      booking({ epf_number: 'E2', date: '2026-09-04', meal: 'lunch' }),
      booking({ epf_number: 'E3', date: '2026-09-04', meal: 'dinner' }),
    ],
    offdays: [], today: '2026-09-06', nowMinute: 9 * 60, slotsFor: noSlots,
  });
  assert.equal(plan.targets.length, 3);
  assert.deepEqual(plan.targets.map(t => t.epf_number).sort(), ['E1', 'E2', 'E3']);
  assert.equal(plan.deferred, 0);
});

test('re-running writes nothing — an already-served booking is never a target', () => {
  const rows = [
    booking({ epf_number: 'E1', date: '2026-09-04', meal: 'lunch', served: true }),
    booking({ epf_number: 'E2', date: '2026-09-04', meal: 'lunch' }),
  ];
  const first = planAutoServe({
    bookings: rows, offdays: [], today: '2026-09-06', nowMinute: 0, slotsFor: noSlots,
  });
  assert.deepEqual(first.targets.map(t => t.epf_number), ['E2']);

  // What the DB looks like after that pass lands.
  const after = rows.map(r => (r.epf_number === 'E2' ? { ...r, served: true } : r));
  const second = planAutoServe({
    bookings: after, offdays: [], today: '2026-09-06', nowMinute: 0, slotsFor: noSlots,
  });
  assert.equal(second.targets.length, 0);
});

test("an operator's no-show outranks the default and survives every later pass", () => {
  const rows = [
    booking({ epf_number: 'E1', date: '2026-09-04', meal: 'lunch', served: false, no_show: true }),
    booking({ epf_number: 'E2', date: '2026-09-04', meal: 'lunch', served: false }),
  ];
  const plan = planAutoServe({
    bookings: rows, offdays: [], today: '2026-09-06', nowMinute: 0, slotsFor: noSlots,
  });
  assert.deepEqual(plan.targets.map(t => t.epf_number), ['E2']);
  assert.equal(plan.noShows, 1);
});

test('a booking left behind for a meal the kitchen closed is not served', () => {
  const plan = planAutoServe({
    bookings: [
      booking({ epf_number: 'E1', date: '2026-09-04', meal: 'lunch' }),
      booking({ epf_number: 'E2', date: '2026-09-04', meal: 'dinner' }),
    ],
    offdays: [off({ date: '2026-09-04', meal: 'lunch' })],
    today: '2026-09-06', nowMinute: 0, slotsFor: noSlots,
  });
  assert.deepEqual(plan.targets.map(t => t.epf_number), ['E2']);
});

test('an off-day at another chamary does not shield this one', () => {
  const plan = planAutoServe({
    bookings: [booking({ epf_number: 'E1', date: '2026-09-04', meal: 'lunch', chamary_id: 'ch1' })],
    offdays: [off({ date: '2026-09-04', meal: 'lunch', chamary_id: 'ch2' })],
    today: '2026-09-06', nowMinute: 0, slotsFor: noSlots,
  });
  assert.equal(plan.targets.length, 1);
});

test("tomorrow's bookings are never touched", () => {
  const plan = planAutoServe({
    bookings: [booking({ epf_number: 'E1', date: '2026-09-07', meal: 'lunch' })],
    offdays: [], today: '2026-09-06', nowMinute: 23 * 60, slotsFor: noSlots,
  });
  assert.equal(plan.targets.length, 0);
});

test("today settles meal by meal as the day passes", () => {
  const today = '2026-09-06';
  const rows = [
    booking({ epf_number: 'E1', date: today, meal: 'breakfast' }),
    booking({ epf_number: 'E1', date: today, meal: 'lunch' }),
    booking({ epf_number: 'E1', date: today, meal: 'dinner' }),
  ];
  const at9 = planAutoServe({ bookings: rows, offdays: [], today, nowMinute: 9 * 60, slotsFor: noSlots });
  assert.deepEqual(at9.targets.map(t => t.meal), ['breakfast']);

  const at13 = planAutoServe({ bookings: rows, offdays: [], today, nowMinute: 13 * 60, slotsFor: noSlots });
  assert.deepEqual(at13.targets.map(t => t.meal), ['breakfast', 'lunch']);

  const at2359 = planAutoServe({ bookings: rows, offdays: [], today, nowMinute: 23 * 60 + 59, slotsFor: noSlots });
  assert.deepEqual(at2359.targets.map(t => t.meal), ['breakfast', 'lunch']);
});

test('a booking with no meal field is the lunch it has always been', () => {
  const plan = planAutoServe({
    bookings: [booking({ epf_number: 'E1', date: '2026-09-06' })],   // no `meal`
    offdays: [], today: '2026-09-06', nowMinute: 12 * 60, slotsFor: noSlots,
  });
  assert.deepEqual(plan.targets.map(t => t.meal), ['lunch']);
});

test('the same booking returned by two chamary reads is one target', () => {
  const row = booking({ epf_number: 'E1', date: '2026-09-04', meal: 'lunch' });
  const plan = planAutoServe({
    bookings: [row, { ...row }], offdays: [], today: '2026-09-06', nowMinute: 0, slotsFor: noSlots,
  });
  assert.equal(plan.targets.length, 1);
});

test('rows with nothing to address by are dropped, not written blind', () => {
  const plan = planAutoServe({
    bookings: [
      booking({ epf_number: '', date: '2026-09-04', meal: 'lunch' }),
      booking({ epf_number: 'E2', date: '', meal: 'lunch' }),
      booking({ epf_number: 'E3', date: '2026-09-04', meal: 'lunch', chamary_id: '' }),
    ],
    offdays: [], today: '2026-09-06', nowMinute: 0, slotsFor: noSlots,
  });
  assert.equal(plan.targets.length, 0);
});

test('a very large month is capped and the rest deferred to the next run', () => {
  const bookings = Array.from({ length: 12 }, (_, i) =>
    booking({ epf_number: `E${i}`, date: '2026-09-04', meal: 'lunch' }));
  const plan = planAutoServe({
    bookings, offdays: [], today: '2026-09-06', nowMinute: 0, slotsFor: noSlots, max: 5,
  });
  assert.equal(plan.targets.length, 5);
  assert.equal(plan.deferred, 7);
  assert.ok(AUTO_SERVE_MAX_PER_RUN > 0);
});

test('the key is what identifies one booking — person, day, meal', () => {
  assert.equal(autoServeKey({ epf_number: 'E1', date: '2026-09-04', meal: 'lunch' }), 'E1__2026-09-04__lunch');
  assert.notEqual(
    autoServeKey({ epf_number: 'E1', date: '2026-09-04', meal: 'lunch' }),
    autoServeKey({ epf_number: 'E1', date: '2026-09-04', meal: 'dinner' }),
  );
});

// ── The allow-list ────────────────────────────────────────────────────────────
// A partial month read is the case that broke here: the page fetches bookings and closures per
// chamary, and a kitchen whose closure list did not arrive must be left alone. An unread off-day
// is indistinguishable from no off-day, and settling on that guess records a meal that was never
// cooked.

test('a chamary left out of the allow-list is never a target, even with its meal long over', () => {
  const plan = planAutoServe({
    bookings: [
      booking({ epf_number: 'E1', date: '2026-09-04', meal: 'lunch', chamary_id: 'ch1' }),
      booking({ epf_number: 'E2', date: '2026-09-04', meal: 'lunch', chamary_id: 'ch2' }),
    ],
    offdays: [], today: '2026-09-06', nowMinute: 0, slotsFor: noSlots,
    chamaries: ['ch1'],
  });
  assert.deepEqual(plan.targets.map(t => t.epf_number), ['E1']);
});

test('a filtered chamary still contributes its no-shows to the count', () => {
  const plan = planAutoServe({
    bookings: [
      booking({ epf_number: 'E1', date: '2026-09-04', meal: 'lunch', chamary_id: 'ch2', no_show: true }),
    ],
    offdays: [], today: '2026-09-06', nowMinute: 0, slotsFor: noSlots,
    chamaries: ['ch1'],
  });
  assert.equal(plan.targets.length, 0);
  assert.equal(plan.noShows, 1);
});

test('an empty allow-list settles nothing — a read that returned no kitchens writes no rows', () => {
  const plan = planAutoServe({
    bookings: [booking({ epf_number: 'E1', date: '2026-09-04', meal: 'lunch' })],
    offdays: [], today: '2026-09-06', nowMinute: 0, slotsFor: noSlots,
    chamaries: [],
  });
  assert.equal(plan.targets.length, 0);
});

test('omitting the allow-list settles every chamary, as before', () => {
  const plan = planAutoServe({
    bookings: [
      booking({ epf_number: 'E1', date: '2026-09-04', meal: 'lunch', chamary_id: 'ch1' }),
      booking({ epf_number: 'E2', date: '2026-09-04', meal: 'lunch', chamary_id: 'ch2' }),
    ],
    offdays: [], today: '2026-09-06', nowMinute: 0, slotsFor: noSlots,
  });
  assert.equal(plan.targets.length, 2);
});

test('a no-show is skipped even when its chamary is allowed and the meal is closed', () => {
  const plan = planAutoServe({
    bookings: [booking({ epf_number: 'E1', date: '2026-09-04', meal: 'lunch', no_show: true })],
    offdays: [], today: '2026-09-06', nowMinute: 0, slotsFor: noSlots,
    chamaries: ['ch1'],
  });
  assert.equal(plan.targets.length, 0);
  assert.equal(plan.noShows, 1);
});

test('a second plan over the rows the first one flipped is empty, allow-list and all', () => {
  const rows = [
    booking({ epf_number: 'E1', date: '2026-09-04', meal: 'lunch' }),
    booking({ epf_number: 'E2', date: '2026-09-04', meal: 'lunch' }),
  ];
  const args = {
    offdays: [] as ChamaryMealOffday[], today: '2026-09-06', nowMinute: 0,
    slotsFor: noSlots, chamaries: ['ch1'],
  };
  const first = planAutoServe({ bookings: rows, ...args });
  assert.equal(first.targets.length, 2);

  const flipped = new Set(first.targets.map(autoServeKey));
  const after = rows.map(r => (flipped.has(autoServeKey({ ...r, meal: 'lunch' })) ? { ...r, served: true } : r));
  assert.equal(planAutoServe({ bookings: after, ...args }).targets.length, 0);
});
