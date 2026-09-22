import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MEAL_TYPES,
  DAY_MINUTES,
  DEFAULT_MEAL_SLOTS,
  mealSlots,
  mealSlotAtMinute,
  mealWindow,
  mealOpenAt,
  formatMealTime,
  minutesToTimeInput,
  timeInputToMinutes,
  chamaryMeals,
  mealOf,
  type MealType,
} from '../meals';

const at = (h: number, m = 0) => h * 60 + m;

test('mealSlotAtMinute: every minute of the day maps to exactly one meal', () => {
  for (let m = 0; m < DAY_MINUTES; m++) {
    assert.ok(MEAL_TYPES.includes(mealSlotAtMinute(m)), `minute ${m} produced a non-meal`);
  }
});

test('default slots: breakfast until 08:00, lunch until 12:00, dinner after', () => {
  assert.equal(mealSlotAtMinute(at(0)),      'breakfast');
  assert.equal(mealSlotAtMinute(at(7, 59)),  'breakfast');
  assert.equal(mealSlotAtMinute(at(8)),      'lunch');
  assert.equal(mealSlotAtMinute(at(11, 59)), 'lunch');
  assert.equal(mealSlotAtMinute(at(12)),     'dinner');
  assert.equal(mealSlotAtMinute(at(23, 59)), 'dinner');
});

test('lunch can be ordered right up to noon, and not a minute past', () => {
  assert.equal(mealOpenAt('lunch', at(11, 59)), true);
  assert.equal(mealOpenAt('lunch', at(12)),     false);
});

test('a boundary minute belongs to the later meal', () => {
  assert.equal(mealSlotAtMinute(DEFAULT_MEAL_SLOTS.lunch_from),  'lunch');
  assert.equal(mealSlotAtMinute(DEFAULT_MEAL_SLOTS.dinner_from), 'dinner');
});

test('per-chamary slots move the boundaries', () => {
  const late = { lunch_from: at(9, 30), dinner_from: at(15) };
  assert.equal(mealSlotAtMinute(at(9),  late), 'breakfast');
  assert.equal(mealSlotAtMinute(at(12), late), 'lunch');
  assert.equal(mealSlotAtMinute(at(15), late), 'dinner');
  assert.equal(mealOpenAt('lunch', at(12), late), true);
});

test('mealSlots: absent or partial config falls back to the defaults', () => {
  assert.deepEqual(mealSlots(undefined), DEFAULT_MEAL_SLOTS);
  assert.deepEqual(mealSlots(null),      DEFAULT_MEAL_SLOTS);
  assert.deepEqual(mealSlots({ lunch_from: at(7) }), { lunch_from: at(7), dinner_from: DEFAULT_MEAL_SLOTS.dinner_from });
});

test('mealSlots: a dinner that starts before lunch is pulled back, never left negative', () => {
  const s = mealSlots({ lunch_from: at(11), dinner_from: at(9) });
  assert.deepEqual(s, { lunch_from: at(11), dinner_from: at(11) });
  // Lunch has a zero-length window, so it is simply never open — not open all day.
  assert.equal(mealOpenAt('lunch', at(11), s), false);
  assert.equal(mealSlotAtMinute(at(11), s), 'dinner');
});

test('mealSlots: out-of-range and non-numeric values are clamped, not trusted', () => {
  assert.deepEqual(mealSlots({ lunch_from: -60, dinner_from: 99999 }), { lunch_from: 0, dinner_from: DAY_MINUTES });
  assert.deepEqual(mealSlots({ lunch_from: Number.NaN } as Partial<{ lunch_from: number }>), DEFAULT_MEAL_SLOTS);
});

test('mealWindow: the three windows tile the whole day with no gap or overlap', () => {
  const s = { lunch_from: at(9), dinner_from: at(14) };
  assert.deepEqual(mealWindow('breakfast', s), { from: 0,      to: at(9) });
  assert.deepEqual(mealWindow('lunch', s),     { from: at(9),  to: at(14) });
  assert.deepEqual(mealWindow('dinner', s),    { from: at(14), to: DAY_MINUTES });
});

test('formatMealTime: reads like a clock', () => {
  assert.equal(formatMealTime(0),         '12:00 AM');
  assert.equal(formatMealTime(at(8)),     '8:00 AM');
  assert.equal(formatMealTime(at(12)),    '12:00 PM');
  assert.equal(formatMealTime(at(17, 5)), '5:05 PM');
});

test('time-input conversion round-trips', () => {
  assert.equal(minutesToTimeInput(at(8)),     '08:00');
  assert.equal(minutesToTimeInput(at(12, 30)), '12:30');
  assert.equal(timeInputToMinutes('08:00', 0), at(8));
  assert.equal(timeInputToMinutes('', at(9)),  at(9));
});

test('chamaryMeals: a chamary with no meals field serves lunch only', () => {
  assert.deepEqual(chamaryMeals(undefined), ['lunch']);
  assert.deepEqual(chamaryMeals(null), ['lunch']);
  assert.deepEqual(chamaryMeals([]), ['lunch']);
});

test('chamaryMeals: returns the configured meals in display order', () => {
  assert.deepEqual(chamaryMeals(['dinner', 'breakfast']), ['breakfast', 'dinner']);
  assert.deepEqual(chamaryMeals(['dinner', 'lunch', 'breakfast']), ['breakfast', 'lunch', 'dinner']);
});

test('chamaryMeals: an unrecognised value is dropped, not trusted', () => {
  assert.deepEqual(chamaryMeals(['supper' as MealType, 'dinner']), ['dinner']);
  // Dropping every entry leaves nothing configured, which still means lunch only.
  assert.deepEqual(chamaryMeals(['supper' as MealType]), ['lunch']);
});

test('mealOf: a record written before meal types existed is a lunch booking', () => {
  assert.equal(mealOf(undefined), 'lunch');
  assert.equal(mealOf(null), 'lunch');
});

test('mealOf: a stored meal is returned as-is, an unknown one falls back to lunch', () => {
  assert.equal(mealOf('breakfast'), 'breakfast');
  assert.equal(mealOf('dinner'), 'dinner');
  assert.equal(mealOf('brunch' as MealType), 'lunch');
});
