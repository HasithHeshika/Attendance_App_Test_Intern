import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeUserMonthlyReport, LEAVE_COUNT_CUTOFF } from '../userMonthlyReport';
import type { AppUser, AttendanceRecord, LeaveRecord } from '../types';
import type { WorkPattern } from '../workPatterns';

// August 2026: Saturdays fall on the 1st, 8th, 15th, 22nd and 29th; Sundays on the 2nd and
// 9th. Every fixture below leans on that shape, so read a date as its weekday.
const YEAR = 2026, MONTH = 8;

function att(date: string, over: Record<string, unknown> = {}): AttendanceRecord {
  return {
    id: `E1__${date}`,
    epf_number: 'E1',
    date,
    check_in:  `${date}T08:00:00.000Z`,
    check_out: `${date}T17:00:00.000Z`,
    check_in_status: 'approved',
    check_out_status: 'approved',
    check_in_approved_by: null,
    check_out_approved_by: null,
    is_outstation: false,
    outstation_location_id: null,
    outstation_name: null,
    working_place: null,
    morning_allowance: 0,
    evening_allowance: 0,
    ...over,
  } as unknown as AttendanceRecord;
}

function leave(from: string, to: string, over: Record<string, unknown> = {}): LeaveRecord {
  return {
    id: `L__${from}`,
    epf_number: 'E1',
    from_date: from,
    to_date: to,
    leave_type_id: '1',
    leave_type_name: 'Annual',
    status: 'approved',
    is_paid: true,
    is_half_day: false,
    ...over,
  } as unknown as LeaveRecord;
}

// `today` is pinned so the absent walk covers exactly 1–10 August and never drifts.
const BASE = {
  user: { display_name: 'Tester', epf_number: 'E1', company_name: 'Alta Vision' } as unknown as AppUser,
  isTechnician: true,
  outstations: [],
  holidays: new Set<string>(),
  year: YEAR,
  month: MONTH,
  today: '2026-08-10',
};

const run = (over: Record<string, unknown>) =>
  computeUserMonthlyReport({ attendance: [], leaves: [], ...BASE, ...over } as never);

// ─── working days ──────────────────────────────────────────────────────────────

test('without the flag a Saturday is a whole working day', () => {
  const r = run({ attendance: [att('2026-08-03'), att('2026-08-08')] });
  assert.equal(r.workingDays, 2);
});

test('with the flag a normal Saturday is half a working day', () => {
  const r = run({
    attendance: [att('2026-08-03'), att('2026-08-08')],
    saturdayHalfDay: true,
  });
  assert.equal(r.workingDays, 1.5);
});

test('a rostered Saturday stays a whole day — a shift is a shift whatever the weekday', () => {
  const r = run({
    attendance: [att('2026-08-03'), att('2026-08-08')],
    shiftAssignments: [{ from_date: '2026-08-08', to_date: '2026-08-08' }],
    saturdayHalfDay: true,
  });
  assert.equal(r.workingDays, 2);
  assert.equal(r.shiftWorkingDays, 1);
});

test('an unapproved Saturday counts nothing, half day or not', () => {
  const r = run({
    attendance: [att('2026-08-08', { check_in_status: 'pending', check_out_status: 'pending' })],
    saturdayHalfDay: true,
  });
  assert.equal(r.workingDays, 0);
});

// ─── food points ───────────────────────────────────────────────────────────────

test('food points count meals eaten, so a half Saturday is still a full 3 points', () => {
  const whole = run({ attendance: [att('2026-08-03'), att('2026-08-08')] });
  const half  = run({ attendance: [att('2026-08-03'), att('2026-08-08')], saturdayHalfDay: true });
  assert.equal(whole.foodPoints, 6);
  assert.equal(half.foodPoints, 6);
});

// ─── leave days ────────────────────────────────────────────────────────────────

test('without the flag a Fri–Mon leave is four whole days', () => {
  const r = run({ leaves: [leave('2026-08-07', '2026-08-10')] });
  assert.equal(r.totalLeaves, 4);
  assert.equal(r.approvedLeaves, 4);
});

test('with the flag the Saturday inside a leave weighs half', () => {
  const r = run({ leaves: [leave('2026-08-07', '2026-08-10')], saturdayHalfDay: true });
  assert.equal(r.totalLeaves, 3.5);   // Fri 1 + Sat 0.5 + Sun 1 + Mon 1
  assert.equal(r.approvedLeaves, 3.5);
});

test('a leave Saturday the roster covers stays whole', () => {
  const r = run({
    leaves: [leave('2026-08-07', '2026-08-10')],
    shiftAssignments: [{ from_date: '2026-08-08', to_date: '2026-08-08' }],
    saturdayHalfDay: true,
  });
  assert.equal(r.totalLeaves, 4);
});

test('the month clamp still holds — only the part inside the month counts', () => {
  const r = run({ leaves: [leave('2026-07-28', '2026-08-03')], saturdayHalfDay: true });
  assert.equal(r.totalLeaves, 2.5);   // Sat 1 Aug 0.5 + Sun 2 Aug 1 + Mon 3 Aug 1
});

// ─── holidays inside a leave ───────────────────────────────────────────────────
// Tuesday 4 August is the company holiday. The leave runs from Monday 3 to Wednesday 5.

test('without a cut-off a holiday inside a leave is still charged', () => {
  const r = run({
    leaves: [leave('2026-08-03', '2026-08-05')],
    holidays: new Set(['2026-08-04']),
  });
  assert.equal(r.totalLeaves, 3);
});

test('from the cut-off a holiday inside a leave is not charged', () => {
  const r = run({
    leaves: [leave('2026-08-03', '2026-08-05')],
    holidays: new Set(['2026-08-04']),
    leaveCountCutoff: '2026-08-01',
  });
  assert.equal(r.totalLeaves, 2);
  assert.equal(r.approvedLeaves, 2);
});

test('a holiday before the cut-off is still charged, so past months do not change', () => {
  const r = run({
    leaves: [leave('2026-08-03', '2026-08-05')],
    holidays: new Set(['2026-08-04']),
    leaveCountCutoff: '2026-08-05',
  });
  assert.equal(r.totalLeaves, 3);
});

test('a holiday the roster covers is still charged', () => {
  const r = run({
    leaves: [leave('2026-08-03', '2026-08-05')],
    holidays: new Set(['2026-08-04']),
    shiftAssignments: [{ from_date: '2026-08-04', to_date: '2026-08-04' }],
    leaveCountCutoff: '2026-08-01',
  });
  assert.equal(r.totalLeaves, 3);
});

test('the cut-off is written as a full yyyy-MM-dd date', () => {
  // Dates are compared as text, so '2026-9-11' would sort after '2026-09-11' and the
  // rule would silently start on the wrong day.
  assert.match(LEAVE_COUNT_CUTOFF, /^\d{4}-\d{2}-\d{2}$/);
});

// ─── rest days inside a leave ──────────────────────────────────────────────────
// The leave runs from Friday 7 to Monday 10 August, so Sunday 9 is inside it. Without the
// saturdayHalfDay flag, the Saturday counts as a whole day, exactly as before.

function pattern(over: Record<string, unknown> = {}): WorkPattern {
  return {
    id: 'P1',
    name: 'Monday to Saturday',
    company_id: '',
    scope: 'company',
    scope_id: '',
    days: { 1: 8, 2: 8, 3: 8, 4: 8, 5: 8, 6: 4 },   // Sunday is not listed: a rest day
    is_shift: false,
    effective_from: '2026-01-01',
    is_active: true,
    ...over,
  } as unknown as WorkPattern;
}

test('from the cut-off a rest day in the work pattern is not charged', () => {
  const r = run({
    leaves: [leave('2026-08-07', '2026-08-10')],
    workPatterns: [pattern()],
    leaveCountCutoff: '2026-08-01',
  });
  assert.equal(r.totalLeaves, 3);   // Friday, Saturday and Monday; Sunday is not charged
});

test('without a work pattern a Sunday is still charged', () => {
  const r = run({
    leaves: [leave('2026-08-07', '2026-08-10')],
    leaveCountCutoff: '2026-08-01',
  });
  assert.equal(r.totalLeaves, 4);
});

test('a rest day before the cut-off is still charged', () => {
  const r = run({
    leaves: [leave('2026-08-07', '2026-08-10')],
    workPatterns: [pattern()],
    leaveCountCutoff: '2026-08-10',
  });
  assert.equal(r.totalLeaves, 4);
});

test('a shift pattern leaves the count unchanged', () => {
  const r = run({
    leaves: [leave('2026-08-07', '2026-08-10')],
    workPatterns: [pattern({ is_shift: true })],
    leaveCountCutoff: '2026-08-01',
  });
  assert.equal(r.totalLeaves, 4);
});

// ─── absent days ───────────────────────────────────────────────────────────────

test('without the flag every missed weekday-or-Saturday is a whole absent day', () => {
  const r = run({});
  assert.equal(r.absentDays, 8);      // 1,3,4,5,6,7,8,10 August; Sundays skipped
});

test('with the flag a missed Saturday costs only the half day it was worth', () => {
  const r = run({ saturdayHalfDay: true });
  assert.equal(r.absentDays, 7);      // the two Saturdays drop from 1 to 0.5 each
});

test('a missed Saturday the roster covers still costs a whole day', () => {
  const r = run({
    saturdayHalfDay: true,
    shiftAssignments: [{ from_date: '2026-08-01', to_date: '2026-08-01' }],
  });
  assert.equal(r.absentDays, 7.5);
});

// ─── resigned employees ────────────────────────────────────────────────────────
// The company report keeps a leaver on the roster for a month they worked, so the walk has
// to stop on their last day — otherwise the rest of the month reads as absence they owe.

const resigned = (on: string) =>
  ({ ...BASE.user, date_of_resign: on } as unknown as AppUser);

test('the absent walk stops on the last day, inclusive', () => {
  const r = run({ user: resigned('2026-08-05') });
  assert.equal(r.absentDays, 4);      // 1,3,4,5 August; the 5th still counts, the 6th on does not
});

test('a resignation before the month leaves no absent days at all', () => {
  const r = run({ user: resigned('2026-07-31') });
  assert.equal(r.absentDays, 0);
});

test('a resignation after the walk end changes nothing', () => {
  const r = run({ user: resigned('2026-09-30') });
  assert.equal(r.absentDays, 8);      // same as the no-resignation case
});

test('days actually worked before leaving still count', () => {
  const r = run({
    user: resigned('2026-08-05'),
    attendance: [att('2026-08-03'), att('2026-08-04')],
  });
  assert.equal(r.workingDays, 2);
  assert.equal(r.absentDays, 2);      // 1 and 5 August
});

test('the last day is carried onto the row so the sheet can name the leaver', () => {
  assert.equal(run({ user: resigned('2026-08-05') }).dateOfResign, '2026-08-05');
  assert.equal(run({}).dateOfResign, null);
});
