import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FULL_DAY_HOURS, SATURDAY_HOURS, HOURS_GRACE,
  expectedHours, isHalfDay, dayMark, dayKey, isSameDay, isSameMonth, formatHours,
} from '../../components/attendance/workDayModel';

// These tests PIN the hardcoded working-day model — Mon–Fri 8h, Sat 4h, Sun rest — that
// src/components/attendance/workDayModel.ts is currently the single home of.
//
// The point is not that this model is right. CLAUDE.md says plainly that it is wrong for
// anyone who rests on a day other than Sunday, works six days, or works shifts, and there is
// a designed-but-unbuilt `work_patterns` spec that replaces it. The point is that when that
// migration lands, these tests say exactly what the old behaviour WAS, so the change is
// deliberate and visible rather than silent.

// A known week: 2026-09-07 is a Monday, so +5 is Saturday and +6 is Sunday.
const MON = new Date(2026, 8, 7);
const FRI = new Date(2026, 8, 11);
const SAT = new Date(2026, 8, 12);
const SUN = new Date(2026, 8, 13);

test('expectedHours: a weekday expects a full day, Saturday half', () => {
  assert.equal(MON.getDay(), 1);
  assert.equal(SAT.getDay(), 6);
  assert.equal(expectedHours(MON), FULL_DAY_HOURS);
  assert.equal(expectedHours(FRI), FULL_DAY_HOURS);
  assert.equal(expectedHours(SAT), SATURDAY_HOURS);
  // Sunday is a rest day, but the model still reports the weekday expectation for it — the
  // calendar decides Sunday elsewhere. Pinned because it is surprising, not because it is good.
  assert.equal(expectedHours(SUN), FULL_DAY_HOURS);
});

test('isHalfDay: Saturday only', () => {
  assert.equal(isHalfDay(SAT), true);
  for (const d of [MON, FRI, SUN]) assert.equal(isHalfDay(d), false);
});

test('dayMark: no hours reads as worked-but-empty, or as nothing at all', () => {
  assert.deepEqual(dayMark(0, MON, true),  { kind: 'empty', fraction: 0, half: false });
  assert.deepEqual(dayMark(0, MON, false), { kind: 'none',  fraction: 0, half: false });
  // Undefined and a negative are both "no hours", never a NaN gauge.
  assert.equal(dayMark(undefined, MON, true).kind, 'empty');
  assert.equal(dayMark(-3, MON, true).fraction, 0);
});

test('dayMark: the grace band is what stops an ordinary day reading as short or over', () => {
  // Exactly the expectation, and both edges of the grace band, are all a plain full day.
  assert.equal(dayMark(FULL_DAY_HOURS, MON, true).kind, 'full');
  assert.equal(dayMark(FULL_DAY_HOURS - HOURS_GRACE, MON, true).kind, 'full');
  assert.equal(dayMark(FULL_DAY_HOURS + HOURS_GRACE, MON, true).kind, 'full');
  // Only outside it does the day change character.
  assert.equal(dayMark(FULL_DAY_HOURS - HOURS_GRACE - 0.1, MON, true).kind, 'short');
  assert.equal(dayMark(FULL_DAY_HOURS + HOURS_GRACE + 0.1, MON, true).kind, 'over');
});

test('dayMark: a long day completes the gauge, it never laps it', () => {
  const m = dayMark(20, MON, true);
  assert.equal(m.kind, 'over');
  assert.equal(m.fraction, 1, 'fraction must clamp — a ring measured by eye is not a number');
});

test('dayMark: Saturday is judged against 4 hours and drawn as a half circle', () => {
  assert.equal(dayMark(SATURDAY_HOURS, SAT, true).kind, 'full');
  assert.equal(dayMark(SATURDAY_HOURS, SAT, true).half, true);
  // 8h on a Saturday is a long day, not a normal one — the bug this model exists to avoid.
  assert.equal(dayMark(FULL_DAY_HOURS, SAT, true).kind, 'over');
  assert.equal(dayMark(2, SAT, true).kind, 'short');
  assert.equal(dayMark(2, SAT, true).fraction, 0.5);
});

test('dayKey / isSameDay / isSameMonth are local-time, not UTC', () => {
  // A UTC-based key shifts the date either side of midnight in Asia/Colombo (+05:30), which
  // would put a late check-out on the wrong calendar day.
  assert.equal(dayKey(new Date(2026, 8, 7, 23, 45)), '2026-09-07');
  assert.equal(dayKey(new Date(2026, 8, 7, 0, 5)),   '2026-09-07');
  assert.equal(isSameDay(new Date(2026, 8, 7, 1), new Date(2026, 8, 7, 23)), true);
  assert.equal(isSameDay(MON, SAT), false);
  assert.equal(isSameMonth(MON, SAT), true);
  assert.equal(isSameMonth(MON, new Date(2026, 9, 1)), false);
});

test('formatHours drops trailing zeros without lying about the value', () => {
  assert.equal(formatHours(8), '8');
  assert.equal(formatHours(7.5), '7.5');
  assert.equal(formatHours(7.25), '7.3');
  assert.equal(formatHours(0), '0');
});
