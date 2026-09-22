import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  billMoment, dayBounds, filterBillsByDate, sortBillsByDate,
} from '../suspenseBillSort';

const at = (y: number, m: number, d: number, h = 9) => ({ seconds: Math.floor(new Date(y, m - 1, d, h).getTime() / 1000) });
// A fortnight of receipts handed in on one day — the case the two dates exist to tell apart.
const batch = [
  { id: 'a', bill_date: at(2026, 9, 1),  created_at: at(2026, 9, 14, 16) },
  { id: 'b', bill_date: at(2026, 9, 12), created_at: at(2026, 9, 14, 16) },
  { id: 'c', bill_date: at(2026, 9, 7),  created_at: at(2026, 9, 14, 16) },
  { id: 'd', bill_date: at(2026, 9, 20), created_at: at(2026, 9, 21, 10) },
];

test('a bill counts at whichever of its two dates is being asked about', () => {
  const b = { bill_date: at(2026, 9, 1), created_at: at(2026, 9, 14) };
  assert.equal(billMoment(b, 'bill'), new Date(2026, 8, 1, 9).getTime());
  assert.equal(billMoment(b, 'submitted'), new Date(2026, 8, 14, 9).getTime());
});

test('a bill with no bill date falls back to when it arrived, but only for the bill field', () => {
  const b = { created_at: at(2026, 9, 14) };
  assert.equal(billMoment(b, 'bill'), new Date(2026, 8, 14, 9).getTime());
  assert.equal(billMoment(b, 'submitted'), new Date(2026, 8, 14, 9).getTime());
  assert.equal(billMoment({}, 'bill'), 0);
});

test('a single-day filter keeps that whole day at both ends', () => {
  // The bug this guards: comparing against `new Date("2026-09-12")` is midnight UTC, which
  // drops a bill dated 09:00 local on the same day.
  const one = filterBillsByDate(batch, 'bill', { from: '2026-09-12', to: '2026-09-12' });
  assert.deepEqual(one.map(b => b.id), ['b']);
  const bounds = dayBounds('2026-09-12')!;
  assert.equal(new Date(bounds.from).getDate(), 12);
  assert.equal(new Date(bounds.to).getDate(), 12);
});

test('the same range answers differently for bill date and submitted date', () => {
  const r = { from: '2026-09-14', to: '2026-09-14' };
  // Nothing was SPENT on the 14th…
  assert.deepEqual(filterBillsByDate(batch, 'bill', r).map(b => b.id), []);
  // …but three receipts were handed in that day.
  assert.deepEqual(filterBillsByDate(batch, 'submitted', r).map(b => b.id), ['a', 'b', 'c']);
});

test('a half-filled range narrows one end instead of returning nothing', () => {
  assert.deepEqual(filterBillsByDate(batch, 'bill', { from: '2026-09-10' }).map(b => b.id), ['b', 'd']);
  assert.deepEqual(filterBillsByDate(batch, 'bill', { to: '2026-09-07' }).map(b => b.id), ['a', 'c']);
  // Blank or unparseable bounds are simply not applied.
  assert.equal(filterBillsByDate(batch, 'bill', {}).length, 4);
  assert.equal(filterBillsByDate(batch, 'bill', { from: 'not a date' }).length, 4);
  assert.equal(dayBounds(''), null);
});

test('sorting is newest first by default and can be flipped', () => {
  assert.deepEqual(sortBillsByDate(batch, 'bill').map(b => b.id), ['d', 'b', 'c', 'a']);
  assert.deepEqual(sortBillsByDate(batch, 'bill', 'asc').map(b => b.id), ['a', 'c', 'b', 'd']);
});

test('bills sharing a submit moment keep their original order, so the list does not reshuffle', () => {
  // a, b and c were all handed in at the same second; only d is separate.
  assert.deepEqual(sortBillsByDate(batch, 'submitted').map(b => b.id), ['d', 'a', 'b', 'c']);
  assert.deepEqual(sortBillsByDate(batch, 'submitted', 'asc').map(b => b.id), ['a', 'b', 'c', 'd']);
  // And sorting never mutates the caller's array.
  const copy = [...batch];
  sortBillsByDate(batch, 'bill');
  assert.deepEqual(batch.map(b => b.id), copy.map(b => b.id));
});
