import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closureRuns, dayPhase, type ClosureMarker } from '../chamaryClosures';

const off = (over: Partial<ClosureMarker> & { date: string }): ClosureMarker => ({
  chamary_id: 'ch1', chamary_name: 'Ranna Chamary', meal: 'lunch', reason: '', ...over,
});

test('consecutive days with the same meals fold into one run', () => {
  const runs = closureRuns([
    off({ date: '2026-09-08' }), off({ date: '2026-09-09' }), off({ date: '2026-09-10' }),
  ], '2026-09-01');
  assert.equal(runs.length, 1);
  assert.deepEqual(
    [runs[0].from, runs[0].to, runs[0].days, runs[0].meals],
    ['2026-09-08', '2026-09-10', 3, ['lunch']],
  );
});

test('a gap in the dates starts a new run', () => {
  const runs = closureRuns([
    off({ date: '2026-09-08' }), off({ date: '2026-09-09' }), off({ date: '2026-09-11' }),
  ], '2026-09-01');
  assert.deepEqual(runs.map(r => [r.from, r.to, r.days]), [
    ['2026-09-08', '2026-09-09', 2],
    ['2026-09-11', '2026-09-11', 1],
  ]);
});

// The one that matters: reopening a merged run would reopen a meal nobody closed.
test('a change in the meal set breaks the run', () => {
  const runs = closureRuns([
    off({ date: '2026-09-08', meal: 'lunch' }), off({ date: '2026-09-08', meal: 'dinner' }),
    off({ date: '2026-09-09', meal: 'lunch' }), off({ date: '2026-09-09', meal: 'dinner' }),
    off({ date: '2026-09-10', meal: 'dinner' }),
  ], '2026-09-01');
  assert.deepEqual(runs.map(r => [r.from, r.to, r.meals]), [
    ['2026-09-08', '2026-09-09', ['lunch', 'dinner']],
    ['2026-09-10', '2026-09-10', ['dinner']],
  ]);
});

test('meals are listed in serving order however they arrive', () => {
  const runs = closureRuns([
    off({ date: '2026-09-08', meal: 'dinner' }),
    off({ date: '2026-09-08', meal: 'breakfast' }),
    off({ date: '2026-09-08', meal: 'lunch' }),
  ], '2026-09-01');
  assert.deepEqual(runs[0].meals, ['breakfast', 'lunch', 'dinner']);
});

test('days before the cut-off are dropped, and each kitchen runs on its own', () => {
  const runs = closureRuns([
    off({ date: '2026-08-30' }),
    off({ date: '2026-09-08' }),
    off({ date: '2026-09-08', chamary_id: 'ch2', chamary_name: 'Colombo' }),
    off({ date: '2026-09-09', chamary_id: 'ch2', chamary_name: 'Colombo' }),
  ], '2026-09-01');
  assert.deepEqual(runs.map(r => [r.chamaryName, r.from, r.to]), [
    ['Colombo', '2026-09-08', '2026-09-09'],
    ['Ranna Chamary', '2026-09-08', '2026-09-08'],
  ]);
});

test('a marker written before meal types existed reads as lunch', () => {
  const runs = closureRuns([off({ date: '2026-09-08', meal: undefined })], '2026-09-01');
  assert.deepEqual(runs[0].meals, ['lunch']);
});

test('a run crossing a month boundary stays one run', () => {
  const runs = closureRuns([
    off({ date: '2026-09-29' }), off({ date: '2026-09-30' }), off({ date: '2026-10-01' }),
  ], '2026-09-01');
  assert.equal(runs.length, 1);
  assert.deepEqual([runs[0].from, runs[0].to, runs[0].days], ['2026-09-29', '2026-10-01', 3]);
});

test('the first reason given for a run is the one it carries', () => {
  const runs = closureRuns([
    off({ date: '2026-09-08', reason: '' }),
    off({ date: '2026-09-09', reason: 'Cook on leave' }),
  ], '2026-09-01');
  assert.equal(runs[0].reason, 'Cook on leave');
});

test('nothing to show is an empty list, not a throw', () => {
  assert.deepEqual(closureRuns([], '2026-09-01'), []);
  assert.deepEqual(closureRuns([off({ date: '2026-08-01' })], '2026-09-01'), []);
});

test('a day is past, today or still ahead', () => {
  assert.equal(dayPhase('2026-09-04', '2026-09-05'), 'past');
  assert.equal(dayPhase('2026-09-05', '2026-09-05'), 'today');
  assert.equal(dayPhase('2026-09-06', '2026-09-05'), 'future');
});
