import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOGPUP_STATUSES,
  LOGPUP_STATUS_ORDER,
  isLogPupStatus,
  isLogPupDone,
  toAttendanceStatus,
  toLogPupStatus,
} from '../logpupStatus';

test('every LogPup status maps to an Attendance status', () => {
  for (const s of LOGPUP_STATUSES) {
    assert.notEqual(toAttendanceStatus(s), null, `${s} must map`);
  }
  assert.equal(toAttendanceStatus('todo'), 'Pending');
  assert.equal(toAttendanceStatus('in_progress'), 'On Progress');
  assert.equal(toAttendanceStatus('done'), 'Completed');
});

test('the mapping round-trips both ways for all three', () => {
  for (const s of LOGPUP_STATUSES) {
    const here = toAttendanceStatus(s);
    assert.ok(here);
    assert.equal(toLogPupStatus(here), s);
  }
});

// The point of the whole module: our side can hold a status LogPup has no word for, and
// guessing one would write the wrong thing into another system's database.
test('a custom Attendance status throws rather than falling back to todo', () => {
  assert.throws(() => toLogPupStatus('Blocked'), /No LogPup status/);
  assert.throws(() => toLogPupStatus('On Hold'), /No LogPup status/);
  assert.throws(() => toLogPupStatus(''), /No LogPup status/);
});

// A fourth LogPup status would otherwise render as 'Pending' — finished work shown as
// outstanding. Null makes the caller decide instead.
test('an unknown LogPup status maps to null, never to Pending', () => {
  assert.equal(toAttendanceStatus('cancelled'), null);
  assert.equal(toAttendanceStatus('blocked'), null);
  assert.equal(toAttendanceStatus(''), null);
});

test('isLogPupStatus narrows only the three enum members', () => {
  assert.equal(isLogPupStatus('todo'), true);
  assert.equal(isLogPupStatus('done'), true);
  assert.equal(isLogPupStatus('Pending'), false, 'our vocabulary is not theirs');
  assert.equal(isLogPupStatus(null), false);
  assert.equal(isLogPupStatus(undefined), false);
  assert.equal(isLogPupStatus(3), false);
});

test('isLogPupDone is true only for done', () => {
  assert.equal(isLogPupDone('done'), true);
  assert.equal(isLogPupDone('in_progress'), false);
  assert.equal(isLogPupDone('Completed'), false, 'takes LogPup vocabulary, not ours');
});

test('the display order is LogPup board order, not alphabetical', () => {
  assert.deepEqual([...LOGPUP_STATUS_ORDER], ['Pending', 'On Progress', 'Completed']);
});
