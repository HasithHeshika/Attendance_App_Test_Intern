import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  excludedLeaveTypeNames,
  excludedTakenRows,
  isExcludedTypeName,
  roundHalfDay,
} from '../leaveQuotaScope';

// ─── Which types are entitlements ─────────────────────────────────────────────

test('a type is excluded only when the flag is literally true', () => {
  const names = excludedLeaveTypeNames([
    { name: 'Medical Leaves', excluded_from_quota: true },
    { name: 'Annual Leaves',  excluded_from_quota: false },
    { name: 'Casual Leaves' }, // flag absent — the overwhelmingly common case
  ]);
  assert.deepEqual([...names], ['Medical Leaves']);
});

test('a truthy-but-not-true flag does not exclude a type', () => {
  // These arrive off Firestore, where a field can be a string, a number or null. Excluding a
  // type wipes its quota from every balance in the app, so only an explicit `true` may do it.
  const names = excludedLeaveTypeNames([
    { name: 'A', excluded_from_quota: 'true' },
    { name: 'B', excluded_from_quota: 1 },
    { name: 'C', excluded_from_quota: null },
    { name: 'D', excluded_from_quota: undefined },
  ]);
  assert.equal(names.size, 0);
});

test('an inactive type is never listed, flag or no flag', () => {
  // It has no rows to classify and no card to appear on; listing it would print "0 taken" for
  // something the organisation has retired.
  const names = excludedLeaveTypeNames([
    { name: 'Retired Medical', excluded_from_quota: true, is_active: false },
    { name: 'Medical Leaves',  excluded_from_quota: true, is_active: true },
    { name: 'Legacy Medical',  excluded_from_quota: true }, // is_active absent = still active
  ]);
  assert.deepEqual([...names].sort(), ['Legacy Medical', 'Medical Leaves']);
});

test('an unnamed type is dropped rather than matched as the empty string', () => {
  // Names are the key a leave record is matched on. An empty key would swallow every leave
  // whose leave_type_name is missing and quietly exclude them from the quota.
  const names = excludedLeaveTypeNames([
    { excluded_from_quota: true },
    { name: '',    excluded_from_quota: true },
    { name: '   ', excluded_from_quota: true },
    { name: null,  excluded_from_quota: true },
  ]);
  assert.equal(names.size, 0);
});

test('names are trimmed so a stray space in the config still matches leave records', () => {
  const names = excludedLeaveTypeNames([{ name: '  Medical Leaves  ', excluded_from_quota: true }]);
  assert.ok(names.has('Medical Leaves'));
});

test('an empty type list yields no exclusions', () => {
  assert.equal(excludedLeaveTypeNames([]).size, 0);
});

// ─── Matching a leave record to a type ────────────────────────────────────────

test('a leave record matches its excluded type by name', () => {
  const excluded = new Set(['Medical Leaves']);
  assert.equal(isExcludedTypeName(excluded, 'Medical Leaves'), true);
  assert.equal(isExcludedTypeName(excluded, 'Annual Leaves'), false);
});

test('a stray space on the leave record still matches', () => {
  // A leave doc carries the type name snapshotted when it was applied for. Without the trim
  // those days land in NEITHER tally — not the quota (the type's row is filtered out by its
  // flag, not its name) and not the taken count — so they would simply vanish.
  const excluded = excludedLeaveTypeNames([{ name: 'Medical Leaves', excluded_from_quota: true }]);
  assert.equal(isExcludedTypeName(excluded, '  Medical Leaves '), true);
});

test('a missing or empty type name never matches', () => {
  const excluded = new Set(['Medical Leaves']);
  for (const bad of [undefined, null, '', '   ']) {
    assert.equal(isExcludedTypeName(excluded, bad), false, `expected false for ${JSON.stringify(bad)}`);
  }
});

test('matching stays case-sensitive, as leave-type names are stored', () => {
  // Names are unique case-insensitively in the admin form, so a differing case here means a
  // genuinely different string, not the same type — and silently folding them would let a
  // renamed type quietly stop drawing quota.
  assert.equal(isExcludedTypeName(new Set(['Medical Leaves']), 'medical leaves'), false);
});

test('with nothing excluded — every tenant by default — no record matches', () => {
  assert.equal(isExcludedTypeName(new Set(), 'Medical Leaves'), false);
});

// ─── The days-taken rows ──────────────────────────────────────────────────────

test('every excluded type is listed, including one with no days taken', () => {
  // "Medical Leaves · 0 taken" is an answer. A row that appears only once somebody falls ill
  // would read as a leave type that had just been invented.
  const rows = excludedTakenRows(new Set(['Medical Leaves', 'Injury Leaves']), { 'Medical Leaves': 3 });
  assert.deepEqual(rows, [
    { leave_type: 'Injury Leaves',  type: 'Injury Leaves',  taken: 0 },
    { leave_type: 'Medical Leaves', type: 'Medical Leaves', taken: 3 },
  ]);
});

test('rows are sorted by name, not by Firestore document order', () => {
  const rows = excludedTakenRows(new Set(['Zed', 'Alpha', 'Medical']), {});
  assert.deepEqual(rows.map(r => r.leave_type), ['Alpha', 'Medical', 'Zed']);
});

test('each row carries both key names, so a caller can read either', () => {
  const [row] = excludedTakenRows(new Set(['Medical Leaves']), { 'Medical Leaves': 1.5 });
  assert.equal(row.leave_type, row.type);
});

test('half days survive; anything finer rounds to the nearest half', () => {
  const rows = excludedTakenRows(new Set(['A', 'B', 'C']), { A: 2.5, B: 2.26, C: 2.2 });
  assert.deepEqual(rows.map(r => r.taken), [2.5, 2.5, 2]);
});

test('a tally for a type that is not excluded never becomes a row', () => {
  // Guards the direction of the lookup: the excluded SET decides what is listed, not the tally.
  // Reversing it would publish every leave type as a taken-only row and erase the whole quota.
  const rows = excludedTakenRows(new Set(['Medical Leaves']), { 'Annual Leaves': 7, 'Medical Leaves': 1 });
  assert.deepEqual(rows, [{ leave_type: 'Medical Leaves', type: 'Medical Leaves', taken: 1 }]);
});

test('no excluded types means no rows at all — the default for every tenant', () => {
  assert.deepEqual(excludedTakenRows(new Set(), { 'Annual Leaves': 4 }), []);
});

// ─── Rounding ─────────────────────────────────────────────────────────────────

test('roundHalfDay lands on 0 rather than NaN for unusable input', () => {
  // A NaN reaching UsageMeter computes a NaN percentage and draws an empty bar — a person with
  // days in hand sees a spent gauge.
  for (const bad of [undefined, null, '', 'abc', {}, NaN]) {
    assert.equal(roundHalfDay(bad), 0, `expected 0 for ${String(bad)}`);
  }
});

test('roundHalfDay reads a numeric string, which is how Firestore sometimes stores a count', () => {
  assert.equal(roundHalfDay('3.5'), 3.5);
});
