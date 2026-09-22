import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addMonthKey, daysCovered, densityStep, groupByDay, monthBounds, monthGrid, monthKeyOf,
  nextDay, overlapsWindow,
} from '../onLeaveCalendar';

const leave = (from: string, to: string) => ({ from_date: from, to_date: to });

// ─── daysCovered: the one that decides whether the calendar is honest ─────────

test('a leave covers both its end days — Mon to Fri is five days off, not four', () => {
  assert.deepEqual(
    daysCovered(leave('2026-09-07', '2026-09-11'), '2026-09-01', '2026-09-30'),
    ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11'],
  );
});

test('a single-day leave covers exactly that day', () => {
  assert.deepEqual(daysCovered(leave('2026-09-05', '2026-09-05'), '2026-09-01', '2026-09-30'), ['2026-09-05']);
});

// A leave that started in August is still absence in September. If the clamp dropped it, the 1st
// and 2nd would look staffed when they are not — the failure that actually costs someone cover.
test('a leave spanning a month boundary appears in BOTH months, clamped to each', () => {
  const l = leave('2026-08-30', '2026-09-02');
  assert.deepEqual(daysCovered(l, '2026-08-01', '2026-08-31'), ['2026-08-30', '2026-08-31']);
  assert.deepEqual(daysCovered(l, '2026-09-01', '2026-09-30'), ['2026-09-01', '2026-09-02']);
});

test('a leave spanning a year boundary clamps on both sides', () => {
  const l = leave('2026-12-30', '2027-01-02');
  assert.deepEqual(daysCovered(l, '2026-12-01', '2026-12-31'), ['2026-12-30', '2026-12-31']);
  assert.deepEqual(daysCovered(l, '2027-01-01', '2027-01-31'), ['2027-01-01', '2027-01-02']);
});

test('a leave entirely outside the window covers nothing', () => {
  assert.deepEqual(daysCovered(leave('2026-07-01', '2026-07-05'), '2026-09-01', '2026-09-30'), []);
  assert.deepEqual(daysCovered(leave('2026-11-01', '2026-11-05'), '2026-09-01', '2026-09-30'), []);
});

test('a leave touching the window by exactly one day still covers it', () => {
  assert.deepEqual(daysCovered(leave('2026-08-01', '2026-09-01'), '2026-09-01', '2026-09-30'), ['2026-09-01']);
  assert.deepEqual(daysCovered(leave('2026-09-30', '2026-10-15'), '2026-09-01', '2026-09-30'), ['2026-09-30']);
});

// Bad data must not hang the render loop — this walks day by day, so a backwards range without a
// guard is an infinite loop, not a wrong answer.
test('malformed or backwards ranges yield nothing instead of looping', () => {
  assert.deepEqual(daysCovered(leave('2026-09-10', '2026-09-01'), '2026-09-01', '2026-09-30'), []);
  assert.deepEqual(daysCovered(leave('', '2026-09-05'), '2026-09-01', '2026-09-30'), []);
  assert.deepEqual(daysCovered(leave('not-a-date', 'nope'), '2026-09-01', '2026-09-30'), []);
  assert.deepEqual(daysCovered(leave('2026-09-05', '2026-09-06'), '2026-09-30', '2026-09-01'), []);
});

test('a timestamped date still reads as its own day', () => {
  assert.deepEqual(
    daysCovered({ from_date: '2026-09-05T00:00:00Z', to_date: '2026-09-05T23:59:00Z' }, '2026-09-01', '2026-09-30'),
    ['2026-09-05'],
  );
});

test('February gets its 29th in a leap year and stops at 28 otherwise', () => {
  assert.equal(daysCovered(leave('2028-02-01', '2028-03-01'), '2028-02-01', '2028-02-29').length, 29);
  assert.equal(daysCovered(leave('2026-02-01', '2026-03-01'), '2026-02-01', '2026-02-28').length, 28);
});

// ─── overlapsWindow: what the range read filters on ──────────────────────────

test('overlapsWindow agrees with daysCovered about what is in the window', () => {
  const cases = [
    leave('2026-08-30', '2026-09-02'), leave('2026-09-15', '2026-09-15'),
    leave('2026-07-01', '2026-07-02'), leave('2026-10-01', '2026-10-02'),
    leave('2026-09-30', '2026-10-05'), leave('2026-08-01', '2026-10-31'),
  ];
  for (const l of cases) {
    assert.equal(
      overlapsWindow(l, '2026-09-01', '2026-09-30'),
      daysCovered(l, '2026-09-01', '2026-09-30').length > 0,
      `${l.from_date}..${l.to_date}`,
    );
  }
});

// ─── groupByDay ──────────────────────────────────────────────────────────────

test('a span appears under every one of its days, and two leaves can share a day', () => {
  const a = { from_date: '2026-09-07', to_date: '2026-09-09', epf: 'A' };
  const b = { from_date: '2026-09-09', to_date: '2026-09-09', epf: 'B' };
  const by = groupByDay([a, b], '2026-09-01', '2026-09-30');
  assert.deepEqual(by.get('2026-09-07')?.map(x => x.epf), ['A']);
  assert.deepEqual(by.get('2026-09-09')?.map(x => x.epf), ['A', 'B']);
  assert.equal(by.has('2026-09-10'), false);
});

test('grouping an empty list gives an empty map, not a throw', () => {
  assert.equal(groupByDay([], '2026-09-01', '2026-09-30').size, 0);
});

// ─── month arithmetic ────────────────────────────────────────────────────────

test('month bounds land on the real last day, February included', () => {
  assert.deepEqual(monthBounds('2026-09'), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(monthBounds('2026-02'), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(monthBounds('2028-02'), { from: '2028-02-01', to: '2028-02-29' });
  assert.deepEqual(monthBounds('2026-12'), { from: '2026-12-01', to: '2026-12-31' });
});

test('month keys step across a year boundary in both directions', () => {
  assert.equal(addMonthKey('2026-12', 1), '2027-01');
  assert.equal(addMonthKey('2026-01', -1), '2025-12');
  assert.equal(addMonthKey('2026-09', 0), '2026-09');
  assert.equal(addMonthKey('2026-09', 12), '2027-09');
  assert.equal(addMonthKey('2026-09', -12), '2025-09');
});

test('monthKeyOf and nextDay roll over correctly', () => {
  assert.equal(monthKeyOf('2026-09-05'), '2026-09');
  assert.equal(nextDay('2026-09-30'), '2026-10-01');
  assert.equal(nextDay('2026-12-31'), '2027-01-01');
  assert.equal(nextDay('2028-02-28'), '2028-02-29');
  assert.equal(nextDay('2026-02-28'), '2026-03-01');
});

// ─── monthGrid ───────────────────────────────────────────────────────────────

test('a month grid is whole Sunday-first weeks that contain every day of the month', () => {
  for (const key of ['2026-09', '2026-02', '2028-02', '2026-12', '2027-01', '2026-08']) {
    const cells = monthGrid(key);
    assert.equal(cells.length % 7, 0, `${key} is not whole weeks`);
    assert.equal(cells[0].weekday, 0, `${key} does not start on a Sunday`);
    assert.equal(cells[cells.length - 1].weekday, 6, `${key} does not end on a Saturday`);

    const { from, to } = monthBounds(key);
    const inMonth = cells.filter(c => c.inMonth).map(c => c.date);
    assert.equal(inMonth[0], from, `${key} missing its 1st`);
    assert.equal(inMonth[inMonth.length - 1], to, `${key} missing its last day`);
    // Consecutive, no gaps, no repeats.
    for (let i = 1; i < cells.length; i++) {
      assert.equal(cells[i].date, nextDay(cells[i - 1].date), `${key} broke at ${cells[i].date}`);
    }
  }
});

// The padding days are real dates on purpose — a leave running from 30 August into September has
// to be visible on September's leading row.
test('grid padding carries the neighbouring months real dates, marked out of month', () => {
  const cells = monthGrid('2026-09');           // 1 Sep 2026 is a Tuesday
  assert.equal(cells[0].date, '2026-08-30');
  assert.equal(cells[0].inMonth, false);
  assert.equal(cells[2].date, '2026-09-01');
  assert.equal(cells[2].inMonth, true);
});

// A month whose weeks fit in fewer rows must not carry a whole extra row of somebody else's days.
test('a grid is trimmed to the rows the month actually needs', () => {
  assert.equal(monthGrid('2026-02').length, 28);   // Feb 2026 starts Sunday, ends Saturday: 4 rows
  assert.equal(monthGrid('2026-08').length, 42);   // Aug 2026 starts Saturday: needs 6
});

// ─── densityStep ─────────────────────────────────────────────────────────────

test('density is relative to the busiest day of the month', () => {
  assert.equal(densityStep(0, 9), 0);
  assert.equal(densityStep(1, 9), 1);
  assert.equal(densityStep(5, 9), 2);
  assert.equal(densityStep(9, 9), 3);
  // A month where one person is off once must not read as empty.
  assert.equal(densityStep(1, 1), 3);
  assert.equal(densityStep(0, 0), 0);
  assert.equal(densityStep(3, 0), 0);
});
