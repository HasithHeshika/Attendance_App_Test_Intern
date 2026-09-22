import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WEEKDAYS, MON_FRI, weekdayOf, addDaysStr, expandPattern, horizonEnd, describeWeekdays,
  diffMaterialization, patternIsVoid,
} from '../schedulePattern';

test('WEEKDAYS: Monday-first display order, 0=Sun..6=Sat values, 7 entries', () => {
  assert.equal(WEEKDAYS.length, 7);
  assert.deepEqual(WEEKDAYS.map((w) => w.value), [1, 2, 3, 4, 5, 6, 0]);
  assert.deepEqual(WEEKDAYS.map((w) => w.short), ['M', 'T', 'W', 'T', 'F', 'S', 'S']);
});

test('weekdayOf: local-parsed getDay, no UTC drift', () => {
  assert.equal(weekdayOf('2026-09-01'), 2); // Tuesday
  assert.equal(weekdayOf('2026-09-06'), 0); // Sunday
  assert.equal(weekdayOf('2026-09-05'), 6); // Saturday
});

test('addDaysStr: rolls month and year boundaries', () => {
  assert.equal(addDaysStr('2026-09-01', 1), '2026-09-02');
  assert.equal(addDaysStr('2026-09-30', 1), '2026-10-01');
  assert.equal(addDaysStr('2026-12-31', 1), '2027-01-01');
  assert.equal(addDaysStr('2026-09-01', -1), '2026-08-31');
  assert.equal(addDaysStr('2026-09-01', 56), '2026-10-27');
});

test('expandPattern: Mon–Fri over one week yields the five weekdays', () => {
  // 2026-09-07 is a Monday
  const dates = expandPattern(
    { weekdays: MON_FRI, effective_from: '2026-09-07', effective_to: null },
    '2026-09-07', '2026-09-13',
  );
  assert.deepEqual(dates, ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11']);
});

test('expandPattern: clamps to the pattern effective window', () => {
  const dates = expandPattern(
    { weekdays: [1], effective_from: '2026-09-14', effective_to: '2026-09-21' },
    '2026-09-01', '2026-12-31',
  );
  assert.deepEqual(dates, ['2026-09-14', '2026-09-21']); // only the two Mondays in-window
});

test('expandPattern: empty weekday set or inverted range -> []', () => {
  assert.deepEqual(expandPattern({ weekdays: [], effective_from: '2026-09-01', effective_to: null }, '2026-09-01', '2026-12-31'), []);
  assert.deepEqual(expandPattern({ weekdays: [1], effective_from: '2026-09-01', effective_to: null }, '2026-09-10', '2026-09-05'), []);
});

test('expandPattern: open-ended pattern fills to the given horizon only', () => {
  const end = horizonEnd('2026-09-07'); // +8 weeks
  const dates = expandPattern(
    { weekdays: [0], effective_from: '2026-09-07', effective_to: null },
    '2026-09-07', end,
  );
  assert.equal(dates.length, 8);           // 8 Sundays
  assert.ok(dates.every((d) => weekdayOf(d) === 0));
  assert.ok(dates[dates.length - 1] <= end);
});

const TODAY = '2026-09-07'; // a Monday

test('diffMaterialization: first run — every wanted date is created', () => {
  const wanted = ['2026-09-07', '2026-09-08', '2026-09-09'];
  const d = diffMaterialization(wanted, [], TODAY);
  assert.deepEqual(d.toCreate, wanted);
  assert.deepEqual(d.toTombstone, []);
});

test('diffMaterialization: steady state — nothing to do when live rows match wanted', () => {
  const wanted = ['2026-09-07', '2026-09-08'];
  const existing = [{ date: '2026-09-07' }, { date: '2026-09-08' }];
  const d = diffMaterialization(wanted, existing, TODAY);
  assert.deepEqual(d.toCreate, []);
  assert.deepEqual(d.toTombstone, []);
});

test('diffMaterialization: a dropped weekday tombstones its future live rows', () => {
  const wanted = ['2026-09-07']; // Tue removed
  const existing = [{ date: '2026-09-07' }, { date: '2026-09-08' }];
  const d = diffMaterialization(wanted, existing, TODAY);
  assert.deepEqual(d.toCreate, []);
  assert.deepEqual(d.toTombstone, ['2026-09-08']);
});

test('diffMaterialization: a hand-removed occurrence (tombstone) is NOT recreated', () => {
  const wanted = ['2026-09-07', '2026-09-08', '2026-09-09'];
  const existing = [
    { date: '2026-09-07' },
    { date: '2026-09-08', is_deleted: true }, // scheduler deleted just this day
  ];
  const d = diffMaterialization(wanted, existing, TODAY);
  assert.deepEqual(d.toCreate, ['2026-09-09']); // 08 stays skipped
  assert.deepEqual(d.toTombstone, []);
});

test('diffMaterialization: past dates are never created or tombstoned', () => {
  const wanted = ['2026-09-01', '2026-09-07', '2026-09-14']; // 09-01 is before today
  const existing = [{ date: '2026-08-31' }, { date: '2026-09-07' }];
  const d = diffMaterialization(wanted, existing, TODAY);
  assert.deepEqual(d.toCreate, ['2026-09-14']);   // 09-01 ignored (past)
  assert.deepEqual(d.toTombstone, []);            // 08-31 live row untouched (past)
});

test('diffMaterialization: a deactivated pattern (wanted=[]) tombstones all future live rows', () => {
  const existing = [{ date: '2026-09-07' }, { date: '2026-09-08' }, { date: '2026-08-01' }];
  const d = diffMaterialization([], existing, TODAY);
  assert.deepEqual(d.toCreate, []);
  assert.deepEqual(d.toTombstone, ['2026-09-07', '2026-09-08']); // past 08-01 left alone
});

test('patternIsVoid: owner gone voids everything', () => {
  assert.equal(patternIsVoid({ is_day_off: true }, true, true, false), true);
  assert.equal(patternIsVoid({}, true, true, true), true);
});

test('patternIsVoid: still HOD/exec keeps everything', () => {
  assert.equal(patternIsVoid({ is_day_off: true }, false, true, false), false);
  assert.equal(patternIsVoid({}, false, true, true), false);
});

test('patternIsVoid: lost HOD status voids day-off + restricted-shift patterns, keeps ordinary', () => {
  assert.equal(patternIsVoid({ is_day_off: true }, false, false, false), true);   // day-off pattern
  assert.equal(patternIsVoid({}, false, false, true), true);                      // restricted shift
  assert.equal(patternIsVoid({}, false, false, false), false);                    // ordinary shift → kept
});

test('describeWeekdays: recognises the common shapes', () => {
  assert.equal(describeWeekdays(MON_FRI), 'Mon–Fri');
  assert.equal(describeWeekdays([0, 1, 2, 3, 4, 5, 6]), 'Every day');
  assert.equal(describeWeekdays([0, 6]), 'Sat & Sun');
  assert.equal(describeWeekdays([1, 3, 5]), 'Mon, Wed, Fri');
  assert.equal(describeWeekdays([]), 'No days selected');
});
