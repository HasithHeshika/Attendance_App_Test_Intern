import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRosterCoverageGaps, type RosterCoverageInput } from '../rosterCoverage';

function baseInput(over: Partial<RosterCoverageInput> = {}): RosterCoverageInput {
  return {
    employees: [{ epf_number: 'E1', display_name: 'Amaya' }],
    attendanceDatesByEpf: new Map(),
    coveredDatesByEpf: new Map(),
    ...over,
  };
}

test('an attendance date with no schedule_assignment and no day_off is a gap', () => {
  const gaps = computeRosterCoverageGaps(baseInput({
    attendanceDatesByEpf: new Map([['E1', new Set(['2026-09-10'])]]),
  }));
  assert.deepEqual(gaps, [{ employeeId: 'E1', employeeName: 'Amaya', date: '2026-09-10', reason: 'MISSING_SHIFT_ASSIGNMENT' }]);
});

test('a schedule_assignments row for that date clears the gap', () => {
  const gaps = computeRosterCoverageGaps(baseInput({
    attendanceDatesByEpf: new Map([['E1', new Set(['2026-09-10'])]]),
    coveredDatesByEpf: new Map([['E1', new Set(['2026-09-10'])]]),
  }));
  assert.deepEqual(gaps, []);
});

test('a declared day_off for that date also clears the gap — a rest day is still a roster decision', () => {
  // day_offs and schedule_assignments are merged into the same coveredDatesByEpf set by the
  // caller (findRosterCoverageGaps), so from this function's point of view they're indistinguishable —
  // this test just documents that the union, however it was built, suppresses the gap.
  const gaps = computeRosterCoverageGaps(baseInput({
    attendanceDatesByEpf: new Map([['E1', new Set(['2026-09-13'])]]),
    coveredDatesByEpf: new Map([['E1', new Set(['2026-09-13'])]]),
  }));
  assert.deepEqual(gaps, []);
});

test('no attendance at all means no gap, regardless of roster coverage', () => {
  const gaps = computeRosterCoverageGaps(baseInput({
    coveredDatesByEpf: new Map([['E1', new Set(['2026-09-10'])]]),
  }));
  assert.deepEqual(gaps, []);
});

test('an employee absent from both maps entirely produces no gap', () => {
  const gaps = computeRosterCoverageGaps(baseInput());
  assert.deepEqual(gaps, []);
});

test('multiple uncovered dates for the same employee are each listed, sorted by date', () => {
  const gaps = computeRosterCoverageGaps(baseInput({
    attendanceDatesByEpf: new Map([['E1', new Set(['2026-09-12', '2026-09-05'])]]),
  }));
  assert.deepEqual(gaps.map(g => g.date), ['2026-09-05', '2026-09-12']);
});

test('gaps across employees on the same date are sorted by employee name', () => {
  const gaps = computeRosterCoverageGaps({
    employees: [{ epf_number: 'E2', display_name: 'Zara' }, { epf_number: 'E1', display_name: 'Amaya' }],
    attendanceDatesByEpf: new Map([['E1', new Set(['2026-09-10'])], ['E2', new Set(['2026-09-10'])]]),
    coveredDatesByEpf: new Map(),
  });
  assert.deepEqual(gaps.map(g => g.employeeName), ['Amaya', 'Zara']);
});
