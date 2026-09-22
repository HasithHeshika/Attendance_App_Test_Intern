import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChamaryMonth, mealsWithActivity } from '../chamaryMonth';
import type { LunchRequest, ChamaryMealOffday } from '../types';

function booking(over: Partial<LunchRequest> & { epf_number: string; date: string }): LunchRequest {
  return {
    id: `${over.epf_number}__${over.date}`,
    employee_name: over.epf_number === 'E1' ? 'Amal' : over.epf_number === 'E2' ? 'Nimal' : 'Sunil',
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

test('per-day counts, per-meal split, off-days and who ate', () => {
  const v = buildChamaryMonth({
    year: 2026, month: 8, today: '2026-08-20',
    bookings: [
      booking({ epf_number: 'E1', date: '2026-08-03', served: true }),
      booking({ epf_number: 'E1', date: '2026-08-03', meal: 'dinner' }),
      booking({ epf_number: 'E2', date: '2026-08-03', served: true }),
      booking({ epf_number: 'E1', date: '2026-08-04' }),                           // past, unticked → no-show
      booking({ epf_number: 'E3', date: '2026-08-25', chamary_id: 'ch2', chamary_name: 'Site B' }),  // future, unticked → not a no-show
      booking({ epf_number: 'E3', date: '2026-07-31' }),                           // last month, ignored
      booking({ epf_number: 'E1', date: '2026-08-03', served: true }),             // duplicate row
    ],
    offdays: [
      off({ date: '2026-08-10' }),
      off({ date: '2026-08-10', meal: 'dinner', reason: 'Power cut' }),
      off({ date: '2026-08-10', meal: 'dinner', chamary_id: 'ch2', id: 'ch2__2026-08-10__dinner' }),
      off({ date: '2026-09-01' }),
    ],
  });

  assert.equal(v.days.length, 31);
  const third = v.byDate['2026-08-03'];
  assert.equal(third.total, 3);
  assert.deepEqual(third.byMeal, { breakfast: 0, lunch: 2, dinner: 1 });
  assert.equal(third.served, 2);
  assert.equal(third.chamaries, 1);

  const tenth = v.byDate['2026-08-10'];
  assert.deepEqual(tenth.off, ['lunch', 'dinner']);
  assert.equal(tenth.offReason.dinner, 'Power cut');
  assert.equal(tenth.offReason.lunch, undefined);

  assert.equal(v.totals.meals, 5);
  assert.deepEqual(v.totals.byMeal, { breakfast: 0, lunch: 4, dinner: 1 });
  assert.equal(v.totals.served, 2);
  assert.equal(v.totals.noShows, 2);      // E1 dinner on the 3rd, E1 lunch on the 4th
  assert.equal(v.totals.people, 3);
  assert.equal(v.totals.offDays, 1);
  assert.equal(v.totals.offMeals, 3);     // two kitchens closed dinner on the 10th
  assert.equal(v.totals.activeDays, 3);
  assert.deepEqual(v.totals.busiest, { date: '2026-08-03', total: 3 });

  assert.deepEqual(v.people.map(p => [p.name, p.total, p.served, p.noShows, p.days]), [
    ['Amal', 3, 1, 2, 2],
    ['Nimal', 1, 1, 0, 1],
    ['Sunil', 1, 0, 0, 1],
  ]);
  assert.deepEqual(v.people[2].chamaries, ['Site B']);
});

test('without today, every unticked booking is a no-show (a closed month)', () => {
  const v = buildChamaryMonth({
    year: 2026, month: 7,
    bookings: [booking({ epf_number: 'E1', date: '2026-07-31' })],
    offdays: [],
  });
  assert.equal(v.totals.noShows, 1);
  assert.equal(v.totals.busiest?.date, '2026-07-31');
});

test('an empty month is all zeros, not an error', () => {
  const v = buildChamaryMonth({ year: 2026, month: 2, bookings: [], offdays: [] });
  assert.equal(v.days.length, 28);
  assert.equal(v.totals.meals, 0);
  assert.equal(v.totals.busiest, null);
  assert.deepEqual(v.people, []);
});

test('mealsWithActivity keeps only meals a day has something to say about', () => {
  const v = buildChamaryMonth({
    year: 2026, month: 8,
    bookings: [booking({ epf_number: 'E1', date: '2026-08-03', meal: 'breakfast' })],
    offdays: [off({ date: '2026-08-03', meal: 'dinner' })],
  });
  assert.deepEqual(mealsWithActivity(v.byDate['2026-08-03']), ['breakfast', 'dinner']);
  assert.deepEqual(mealsWithActivity(v.byDate['2026-08-03'], ['lunch', 'dinner']), ['dinner']);
  assert.deepEqual(mealsWithActivity(v.byDate['2026-08-04']), []);
});

// ── The invariants ChamaryCalendar leans on ───────────────────────────────────
// The calendar builds its own grid from year/month and looks each date up in byDate. It used to
// crash reading `day.byMeal` when it held a view for a DIFFERENT month than the grid it was
// drawing — so both halves of that contract are now asserted here: a view covers its whole
// month, and it says which month it is.

test('byDate covers every day of the month, including a short one and a leap February', () => {
  for (const [year, month, expected] of [
    [2026, 2, 28],   // ordinary February
    [2024, 2, 29],   // leap February
    [2026, 4, 30],
    [2026, 12, 31],
  ] as const) {
    const v = buildChamaryMonth({ bookings: [], offdays: [], year, month, today: '2026-01-01' });
    assert.equal(v.days.length, expected, `${year}-${month} day count`);
    for (let d = 1; d <= expected; d++) {
      const key = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const day = v.byDate[key];
      assert.ok(day, `${key} missing from byDate`);
      // The two fields the calendar reads on every cell. Undefined here was the crash.
      assert.ok(day.byMeal, `${key} has no byMeal`);
      assert.ok(Array.isArray(day.off), `${key} has no off list`);
      // mealsWithActivity must survive a completely empty day.
      assert.deepEqual(mealsWithActivity(day), []);
    }
    // Nothing outside the month, so a stale view cannot masquerade as a complete one.
    const next = `${year}-${String(month).padStart(2, '0')}-${String(expected + 1).padStart(2, '0')}`;
    assert.equal(v.byDate[next], undefined);
  }
});

test('the view names the month it was built for, so a stale one is detectable', () => {
  const v = buildChamaryMonth({ bookings: [], offdays: [], year: 2026, month: 2, today: '2026-02-10' });
  assert.equal(v.year, 2026);
  assert.equal(v.month, 2);
});

test('a month with bookings on five days still yields every calendar day', () => {
  // The reported bug was "the calendar is broken — days 7-30 are blank". They are blank because
  // nothing is booked on them, not because anything is dropped: buildChamaryMonth seeds all
  // thirty rows before it reads a single booking. This is the assertion that says so.
  const bookings = [
    ...Array.from({ length: 3 }, (_, i) => booking({ epf_number: `E${i}`, date: '2026-09-01' })),
    ...Array.from({ length: 4 }, (_, i) => booking({ epf_number: `E${i}`, date: '2026-09-02' })),
    ...Array.from({ length: 7 }, (_, i) => booking({ epf_number: `E${i}`, date: '2026-09-03' })),
    ...Array.from({ length: 5 }, (_, i) => booking({ epf_number: `E${i}`, date: '2026-09-04' })),
    ...Array.from({ length: 2 }, (_, i) => booking({ epf_number: `E${i}`, date: '2026-09-05' })),
  ];
  const v = buildChamaryMonth({ bookings, offdays: [], year: 2026, month: 9, today: '2026-09-06' });

  assert.equal(v.days.length, 30);
  assert.equal(v.days.filter(d => d.total === 0).length, 25);
  assert.equal(v.totals.activeDays, 5);
  assert.deepEqual(v.totals.busiest, { date: '2026-09-03', total: 7 });
  // Every quiet day is a real row the grid can draw, not a hole it has to skip.
  for (const d of v.days.filter(x => x.total === 0)) {
    assert.equal(d.served, 0);
    assert.deepEqual(d.off, []);
    assert.deepEqual(mealsWithActivity(d), []);
  }
});
