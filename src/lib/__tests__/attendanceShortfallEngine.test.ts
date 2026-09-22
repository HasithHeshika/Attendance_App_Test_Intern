import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeShiftBlocks, computeShortfallForDay, matchSessionsToBlocks, computeCheckOutOverrunMinutes,
  type MatchableSession,
} from '../attendanceShortfallEngine';
import type { ScheduleAssignment } from '../types';

function assignment(over: Partial<ScheduleAssignment>): ScheduleAssignment {
  return {
    id: 'a1', department_id: 'd1', department_name: 'Dept', epf_number: 'E1', employee_name: 'Emp',
    date: '2026-09-01', shift_id: 's1', shift_name: 'Shift', start_time: '07:00', end_time: '13:00',
    assigned_by: 'admin', assigned_by_name: 'Admin',
    ...over,
  } as ScheduleAssignment;
}

function at(dateStr: string, hhmm: string): Date {
  return new Date(`${dateStr}T${hhmm}:00+05:30`);
}

test('matchSessionsToBlocks: single block, single session — pairs directly', () => {
  const blocks = mergeShiftBlocks([assignment({ start_time: '07:00', end_time: '13:00' })]);
  const sessions: MatchableSession[] = [{ checkIn: at('2026-09-01', '07:05'), checkOut: at('2026-09-01', '13:10') }];
  const matched = matchSessionsToBlocks(blocks, sessions);
  assert.equal(matched.length, 1);
  assert.equal(matched[0], sessions[0]);
});

test('matchSessionsToBlocks: retroactive two-shift assignment with one pre-existing punch — matches the session to the block it actually overlaps, not by index', () => {
  // A punch already existed with no shift attached (07:00–22:00). Two non-contiguous shifts
  // are retroactively assigned afterwards: Morning 07:00-13:00 and Evening 15:00-21:00.
  const blocks = mergeShiftBlocks([
    assignment({ start_time: '07:00', end_time: '13:00', shift_name: 'Morning' }),
    assignment({ start_time: '15:00', end_time: '21:00', shift_name: 'Evening' }),
  ]);
  assert.equal(blocks.length, 2);
  const onlySession: MatchableSession = { checkIn: at('2026-09-01', '07:00'), checkOut: at('2026-09-01', '22:00') };
  const matched = matchSessionsToBlocks(blocks, [onlySession]);
  // The single real punch overlaps the FIRST block (Morning) — it should never be silently
  // dropped onto the second block just because array order says so, and the second block
  // should end up with nothing left to claim.
  assert.equal(matched[0], onlySession);
  assert.equal(matched[1], null);
});

test('matchSessionsToBlocks: two blocks, two sessions out of index order — matches by time window, not position', () => {
  const blocks = mergeShiftBlocks([
    assignment({ start_time: '07:00', end_time: '13:00', shift_name: 'Morning' }),
    assignment({ start_time: '19:00', end_time: '23:00', shift_name: 'Night' }),
  ]);
  const morningSession: MatchableSession = { checkIn: at('2026-09-01', '07:10'), checkOut: at('2026-09-01', '13:05') };
  const nightSession: MatchableSession = { checkIn: at('2026-09-01', '19:20'), checkOut: at('2026-09-01', '23:30') };
  // Sessions passed out of chronological order relative to blocks.
  const matched = matchSessionsToBlocks(blocks, [nightSession, morningSession]);
  assert.equal(matched[0], morningSession);
  assert.equal(matched[1], nightSession);
});

test('computeCheckOutOverrunMinutes: checkout past the last block\'s scheduled end is flagged', () => {
  const blocks = mergeShiftBlocks([assignment({ start_time: '07:00', end_time: '13:00' })]);
  const overrun = computeCheckOutOverrunMinutes(blocks, at('2026-09-01', '15:30'));
  assert.equal(overrun, 150);
});

test('computeCheckOutOverrunMinutes: checkout before or at the scheduled end is 0', () => {
  const blocks = mergeShiftBlocks([assignment({ start_time: '07:00', end_time: '13:00' })]);
  assert.equal(computeCheckOutOverrunMinutes(blocks, at('2026-09-01', '12:59')), 0);
  assert.equal(computeCheckOutOverrunMinutes(blocks, at('2026-09-01', '13:00')), 0);
});

test('computeCheckOutOverrunMinutes: no blocks or no checkout is 0', () => {
  assert.equal(computeCheckOutOverrunMinutes([], at('2026-09-01', '20:00')), 0);
  const blocks = mergeShiftBlocks([assignment({ start_time: '07:00', end_time: '13:00' })]);
  assert.equal(computeCheckOutOverrunMinutes(blocks, null), 0);
});

test('computeCheckOutOverrunMinutes: multiple blocks — measured against the LAST block only', () => {
  const blocks = mergeShiftBlocks([
    assignment({ start_time: '07:00', end_time: '13:00', shift_name: 'Morning' }),
    assignment({ start_time: '15:00', end_time: '21:00', shift_name: 'Evening' }),
  ]);
  // Past the first block's end, but well inside the second block — no overrun.
  assert.equal(computeCheckOutOverrunMinutes(blocks, at('2026-09-01', '18:00')), 0);
  // Past the second (last) block's end.
  assert.equal(computeCheckOutOverrunMinutes(blocks, at('2026-09-01', '22:00')), 60);
});

test('computeShortfallForDay still floors earlyDepartureMinutes at 0 for a checkout that runs past the block end (not a shortfall)', () => {
  const blocks = mergeShiftBlocks([assignment({ start_time: '07:00', end_time: '13:00' })]);
  const { earlyDepartureMinutes } = computeShortfallForDay(blocks[0], at('2026-09-01', '07:00'), at('2026-09-01', '15:00'));
  assert.equal(earlyDepartureMinutes, 0);
});
