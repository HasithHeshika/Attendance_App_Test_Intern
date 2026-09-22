import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shapeDayPeople, computeStats } from '../overviewData';

// Southern Lanka's shift-based Present/Absent/No-Shift model (see /overview's loadMonth and
// useOverviewDay) is opt-in via the `scheduledEpfs` param. These cases lock in the two things
// that matter most: every other tenant's classification is BYTE-IDENTICAL to before this param
// existed (omitting it), and the new gate behaves exactly as designed when it's supplied.

const emp = (epf: string): any => ({ epf_number: epf, display_name: epf });

test('shapeDayPeople: omitting scheduledEpfs never produces "unscheduled" — pre-existing tenants unaffected', () => {
  const employees = [emp('E1'), emp('E2'), emp('E3')];
  const attendanceByEpf = { E1: { check_in: '08:00' } };
  const leaveEpfs = new Set(['E2']);
  const specialEpfs = new Set<string>();
  const people = shapeDayPeople({ employees, attendanceByEpf, leaveEpfs, specialEpfs });
  const byEpf = Object.fromEntries(people.map(p => [p.epf, p.status]));
  assert.equal(byEpf.E1, 'present');
  assert.equal(byEpf.E2, 'leave');
  assert.equal(byEpf.E3, 'missing');
  assert.ok(people.every(p => p.status !== 'unscheduled'));
});

test('shapeDayPeople: with scheduledEpfs, no shift on file is "unscheduled", not "missing"', () => {
  const employees = [emp('E1'), emp('E2')];
  const people = shapeDayPeople({
    employees, attendanceByEpf: {}, leaveEpfs: new Set(), specialEpfs: new Set(),
    scheduledEpfs: new Set(['E1']), // only E1 has a shift today
  });
  const byEpf = Object.fromEntries(people.map(p => [p.epf, p.status]));
  assert.equal(byEpf.E1, 'missing');      // scheduled, no check-in -> a real absence
  assert.equal(byEpf.E2, 'unscheduled');  // nobody assigned them a shift -> not an absence
});

test('shapeDayPeople: a real check-in always wins, scheduled or not', () => {
  const people = shapeDayPeople({
    employees: [emp('E1')],
    attendanceByEpf: { E1: { check_in: '08:00' } },
    leaveEpfs: new Set(), specialEpfs: new Set(),
    scheduledEpfs: new Set(), // E1 has no shift on file at all
  });
  assert.equal(people[0].status, 'present');
});

test('shapeDayPeople: leave wins over "unscheduled"', () => {
  const people = shapeDayPeople({
    employees: [emp('E1')],
    attendanceByEpf: {},
    leaveEpfs: new Set(['E1']), specialEpfs: new Set(),
    scheduledEpfs: new Set(), // no shift
  });
  assert.equal(people[0].status, 'leave');
});

test('computeStats: total still equals people.length when nobody is unscheduled — the pre-existing formula', () => {
  const people = shapeDayPeople({
    employees: [emp('E1'), emp('E2'), emp('E3')],
    attendanceByEpf: { E1: { check_in: '08:00' } },
    leaveEpfs: new Set(['E2']),
    specialEpfs: new Set(),
  });
  const stats = computeStats(people);
  assert.equal(stats.total, people.length);
  assert.equal(stats.present, 1);
  assert.equal(stats.onLeave, 1);
  assert.equal(stats.missing, 1);
  assert.equal(stats.unscheduled, 0);
});

test('computeStats: total excludes unscheduled people from the "expected to work" pool', () => {
  const employees = [emp('E1'), emp('E2'), emp('E3')];
  const people = shapeDayPeople({
    employees, attendanceByEpf: {}, leaveEpfs: new Set(), specialEpfs: new Set(),
    scheduledEpfs: new Set(['E1']), // only E1 has a shift; E2/E3 don't
  });
  const stats = computeStats(people);
  assert.equal(stats.missing, 1);      // E1
  assert.equal(stats.unscheduled, 2);  // E2, E3
  assert.equal(stats.total, 1);        // present(0) + onLeave(0) + missing(1) — NOT people.length
  assert.notEqual(stats.total, people.length);
});
