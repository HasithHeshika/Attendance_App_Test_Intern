import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toDisplayTime } from '../overviewData';

test('toDisplayTime handles null and undefined safely', () => {
  assert.equal(toDisplayTime(null), null);
  assert.equal(toDisplayTime(undefined), null);
});

test('toDisplayTime formats Firestore Timestamp objects ({seconds})', () => {
  // 2026-08-27 08:30:00 UTC
  const ts = { seconds: 1787819400 }; // 08:30 in UTC or local
  const formatted = toDisplayTime(ts);
  assert.ok(formatted !== null);
  assert.match(formatted, /^(0[1-9]|1[0-2]):[0-5][0-9] (AM|PM)$/);
});

test('toDisplayTime formats Date instances', () => {
  const date = new Date(2026, 7, 27, 8, 45, 0);
  assert.equal(toDisplayTime(date), '08:45 AM');
  const afternoon = new Date(2026, 7, 27, 17, 15, 0);
  assert.equal(toDisplayTime(afternoon), '05:15 PM');
});

test('toDisplayTime formats string times', () => {
  const res = toDisplayTime('09:15');
  assert.ok(res !== null);
  assert.match(res, /09:15/);
});
