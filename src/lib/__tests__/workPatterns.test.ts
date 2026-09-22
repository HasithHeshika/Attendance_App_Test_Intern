import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DAYS, expectedHoursFor, isPartialDay, isRestDay, localDateKey, resolvePattern,
  type WorkPattern,
} from '../workPatterns';

// The spec asks for exactly these cases: each scope winning in turn, a future effective_from
// being ignored, a rest day returning 0, a shift worker with and without an assignment, and the
// no-pattern fallback matching today's behaviour exactly.

const pattern = (over: Partial<WorkPattern> & Pick<WorkPattern, 'id' | 'scope'>): WorkPattern => ({
  name: over.id,
  company_id: 'c1',
  scope_id: '',
  days: { 1: 8, 2: 8, 3: 8, 4: 8, 5: 8 },   // Mon–Fri, rest at the weekend
  is_shift: false,
  effective_from: '2020-01-01',
  is_active: true,
  ...over,
});

// Local-time constructor on purpose — `new Date('2026-09-07')` is parsed as UTC midnight and
// lands on the previous day east of Greenwich.
const d = (y: number, m: number, day: number) => new Date(y, m - 1, day);

const MONDAY = d(2026, 9, 7);
const SATURDAY = d(2026, 9, 5);
const SUNDAY = d(2026, 9, 6);

test('localDateKey uses local time, not UTC', () => {
  // 23:30 local on the 7th is the 8th in UTC for Asia/Colombo. The key must still say the 7th,
  // or an effective_from comparison flips a day early.
  assert.equal(localDateKey(new Date(2026, 8, 7, 23, 30)), '2026-09-07');
});

test('with no patterns, the fallback reproduces the shipped hardcoded week exactly', () => {
  // workDayModel.expectedHours is `getDay() === 6 ? 4 : 8`. Note Sunday is 8, NOT a rest day,
  // despite that file's header comment claiming otherwise — see the module header.
  assert.equal(expectedHoursFor(MONDAY, []), 8);
  assert.equal(expectedHoursFor(SATURDAY, []), 4);
  assert.equal(expectedHoursFor(SUNDAY, []), 8);
  assert.equal(DEFAULT_DAYS[0], 8);
});

test('a company pattern applies when nothing more specific does', () => {
  const p = [pattern({ id: 'co', scope: 'company' })];
  assert.equal(expectedHoursFor(MONDAY, p, { company_id: 'c1' }), 8);
  assert.equal(expectedHoursFor(SATURDAY, p, { company_id: 'c1' }), 0);   // unlisted = rest
});

test('a location pattern beats the company pattern', () => {
  const p = [
    pattern({ id: 'co', scope: 'company', days: { 6: 4 } }),
    pattern({ id: 'loc', scope: 'location', scope_id: 'wp1', days: { 6: 6 } }),
  ];
  assert.equal(expectedHoursFor(SATURDAY, p, { company_id: 'c1', working_place: 'wp1' }), 6);
  // Someone at a different place falls back to the company pattern.
  assert.equal(expectedHoursFor(SATURDAY, p, { company_id: 'c1', working_place: 'wp2' }), 4);
});

test('a role pattern beats both location and company', () => {
  const p = [
    pattern({ id: 'co', scope: 'company', days: { 6: 4 } }),
    pattern({ id: 'loc', scope: 'location', scope_id: 'wp1', days: { 6: 6 } }),
    pattern({ id: 'role', scope: 'role', scope_id: 'Technician', days: { 6: 8 } }),
  ];
  const subject = { company_id: 'c1', working_place: 'wp1', role: 'Technician' };
  assert.equal(expectedHoursFor(SATURDAY, p, subject), 8);
});

test('role matching ignores case and surrounding spaces', () => {
  // Role names are typed by an admin in one place and selected in another; a stray space is
  // not a distinction anyone intended to make.
  const p = [pattern({ id: 'role', scope: 'role', scope_id: 'technician ', days: { 6: 7 } })];
  assert.equal(expectedHoursFor(SATURDAY, p, { company_id: 'c1', role: ' Technician' }), 7);
});

test('a pattern that is not in force yet is ignored', () => {
  const p = [
    pattern({ id: 'now', scope: 'company', effective_from: '2020-01-01', days: { 6: 4 } }),
    pattern({ id: 'later', scope: 'company', effective_from: '2027-01-01', days: { 6: 0 } }),
  ];
  // An admin scheduling next year's five-day week must not rewrite the month we are in.
  assert.equal(expectedHoursFor(SATURDAY, p, { company_id: 'c1' }), 4);
});

test('within a scope the newest effective_from on or before the date wins', () => {
  const p = [
    pattern({ id: 'old', scope: 'company', effective_from: '2020-01-01', days: { 6: 4 } }),
    pattern({ id: 'new', scope: 'company', effective_from: '2026-06-01', days: { 6: 2 } }),
  ];
  assert.equal(expectedHoursFor(SATURDAY, p, { company_id: 'c1' }), 2);
  // ...and history stays correct: a date before the change still gets the old shape.
  assert.equal(expectedHoursFor(d(2026, 3, 7), p, { company_id: 'c1' }), 4);
});

test('an inactive pattern never applies', () => {
  const p = [pattern({ id: 'off', scope: 'company', is_active: false, days: { 6: 0 } })];
  assert.equal(expectedHoursFor(SATURDAY, p, { company_id: 'c1' }), 4);   // fallback, not 0
});

test('a pattern for another company does not leak across', () => {
  const p = [pattern({ id: 'other', scope: 'company', company_id: 'c2', days: { 6: 0 } })];
  assert.equal(expectedHoursFor(SATURDAY, p, { company_id: 'c1' }), 4);
});

test('a shift worker takes the rostered hours for that date', () => {
  const p = [pattern({ id: 'shift', scope: 'company', is_shift: true, days: {} })];
  assert.equal(expectedHoursFor(MONDAY, p, { company_id: 'c1' }, 12), 12);
});

test('a shift worker with no assignment has NO expectation, not a short day', () => {
  // Returning 8 here would fill the calendar with false exceptions for every unrostered day.
  const p = [pattern({ id: 'shift', scope: 'company', is_shift: true, days: { 1: 8 } })];
  assert.equal(expectedHoursFor(MONDAY, p, { company_id: 'c1' }), 0);
  assert.equal(isRestDay(MONDAY, p, { company_id: 'c1' }), true);
});

test('isRestDay is true for a day the pattern gives no hours', () => {
  const p = [pattern({ id: 'co', scope: 'company' })];   // Mon–Fri only
  assert.equal(isRestDay(SUNDAY, p, { company_id: 'c1' }), true);
  assert.equal(isRestDay(MONDAY, p, { company_id: 'c1' }), false);
});

test('isPartialDay keys on the hours, so a midweek half day draws the half circle', () => {
  // The whole point of the change: not `getDay() === 6`.
  const p = [pattern({ id: 'co', scope: 'company', days: { 1: 8, 3: 4, 6: 0 } })];
  const WEDNESDAY = d(2026, 9, 9);
  assert.equal(isPartialDay(WEDNESDAY, p, { company_id: 'c1' }), true);
  assert.equal(isPartialDay(MONDAY, p, { company_id: 'c1' }), false);   // a full day
  assert.equal(isPartialDay(SATURDAY, p, { company_id: 'c1' }), false); // a rest day, not partial
});

test('resolvePattern returns null when nothing matches, so callers can fall back knowingly', () => {
  assert.equal(resolvePattern(MONDAY, [], {}), null);
  const p = [pattern({ id: 'loc', scope: 'location', scope_id: 'wp1' })];
  assert.equal(resolvePattern(MONDAY, p, { company_id: 'c1', working_place: 'wp9' }), null);
});

test('two patterns sharing an effective_from resolve the same way every time', () => {
  // Firestore iteration order is not guaranteed; an unstable winner here would make the same
  // report produce different numbers on two runs.
  const p = [
    pattern({ id: 'aaa', scope: 'company', effective_from: '2026-01-01', days: { 6: 3 } }),
    pattern({ id: 'zzz', scope: 'company', effective_from: '2026-01-01', days: { 6: 5 } }),
  ];
  const forward = expectedHoursFor(SATURDAY, p, { company_id: 'c1' });
  const reversed = expectedHoursFor(SATURDAY, [...p].reverse(), { company_id: 'c1' });
  assert.equal(forward, reversed);
});

// ─── The calendar's day mark, driven by a resolved week ───────────────────────

test('dayMark: a worked rest day gets its own mark, not "over"', async () => {
  const { dayMark } = await import('../../components/attendance/workDayModel');
  const { patternExpectation } = await import('../workPatterns');
  // A Mon–Fri pattern: Sunday expects nothing.
  const exp = patternExpectation(
    [pattern({ id: 'co', scope: 'company' })],
    { company_id: 'c1' },
  );
  const mark = dayMark(6, SUNDAY, true, exp);
  // 'over' would say "you worked more than expected"; the truth is "you worked a day you were
  // not expected to work at all". Different facts, and only the second interests an approver.
  assert.equal(mark.kind, 'rest');
  assert.equal(mark.fraction, 1);
});

test('dayMark: a rest day with no hours is still just an ordinary unworked day', () => {
  // Nobody worked, so there is nothing to mark — a rest day is not an exception by itself.
  return import('../../components/attendance/workDayModel').then(async ({ dayMark }) => {
    const { patternExpectation } = await import('../workPatterns');
    const exp = patternExpectation([pattern({ id: 'co', scope: 'company' })], { company_id: 'c1' });
    assert.equal(dayMark(0, SUNDAY, false, exp).kind, 'none');
    assert.equal(dayMark(0, SUNDAY, true, exp).kind, 'empty');
  });
});

test('dayMark: a midweek half day fills its gauge at the half-day hours', async () => {
  const { dayMark } = await import('../../components/attendance/workDayModel');
  const { patternExpectation } = await import('../workPatterns');
  const exp = patternExpectation(
    [pattern({ id: 'co', scope: 'company', days: { 3: 4 } })],
    { company_id: 'c1' },
  );
  const WEDNESDAY = d(2026, 9, 9);
  const mark = dayMark(4, WEDNESDAY, true, exp);
  assert.equal(mark.kind, 'full');
  assert.equal(mark.half, true);   // drawn as a half circle, though it is not a Saturday
});
