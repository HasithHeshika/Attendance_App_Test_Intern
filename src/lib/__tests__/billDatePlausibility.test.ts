import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BILL_DATE_MAX_AGE_DAYS, billDateMs, checkBillDate, isPlausibleExtractedBillDate,
  readAmbiguousBillDate, billDateWarning,
} from '../billDatePlausibility';

// A fixed "now" so these never drift: 21 September 2026, local midday.
const NOW = new Date(2026, 8, 21, 12).getTime();
const DAY = 24 * 60 * 60 * 1000;

// ─── the bug that was actually happening ──────────────────────────────────────

test('"26/8/8" on a receipt is 8 Aug 2026, not 26 Aug 2008', () => {
  // The reported failure verbatim: read day-first it is 26 August 2008, which is a perfectly
  // real calendar date — so only plausibility can reject it.
  assert.equal(readAmbiguousBillDate(26, 8, 8, NOW), '2026-08-08');
  assert.equal(checkBillDate('2008-08-26', NOW), 'too-old');
});

test('the ordinary day-first short form still reads day-first', () => {
  assert.equal(readAmbiguousBillDate(12, 9, 26, NOW), '2026-09-12');   // 12 Sept 2026
  assert.equal(readAmbiguousBillDate(8, 9, 26, NOW), '2026-09-08');    // 8 Sept 2026
  // 26 Sept 2008 is the year-first reading and is absurd, so day-first survives alone.
  assert.equal(readAmbiguousBillDate(26, 9, 8, NOW), '2026-09-08');
});

test('a four-digit year is read as written, whichever end it sits on', () => {
  assert.equal(readAmbiguousBillDate(2026, 9, 12, NOW), '2026-09-12');
  assert.equal(readAmbiguousBillDate(12, 9, 2026, NOW), '2026-09-12');
});

test('when day-first and year-first are BOTH plausible, day-first wins', () => {
  // 9/8/26 -> day-first 9 Aug 2026 (plausible) and year-first 26 Aug 2009 (absurd).
  assert.equal(readAmbiguousBillDate(9, 8, 26, NOW), '2026-08-09');
  // A true tie can only happen when the first and last numbers match — and then both readings
  // land on the SAME day anyway, so the preference order never actually decides anything real.
  assert.equal(readAmbiguousBillDate(26, 8, 26, NOW), '2026-08-26');
});

test('an ambiguous date whose only readings are in the future yields nothing', () => {
  // 26/9/26 is 26 Sept 2026 either way, five days after "now" — a receipt nobody holds yet.
  assert.equal(readAmbiguousBillDate(26, 9, 26, NOW), null);
});

test('no reading that could be this bill means no date at all', () => {
  // Every ordering lands years away — better to leave it blank than guess a year.
  assert.equal(readAmbiguousBillDate(15, 9, 7, NOW), null);   // 2007/2015 either way
  assert.equal(readAmbiguousBillDate(99, 99, 99, NOW), null); // not a date in any order
});

// ─── the window ───────────────────────────────────────────────────────────────

test('a bill cannot be dated in the future', () => {
  assert.equal(checkBillDate('2026-09-22', NOW), 'ok');        // tomorrow — clock/timezone grace
  assert.equal(checkBillDate('2026-09-25', NOW), 'future');
  assert.equal(checkBillDate('2028-09-16', NOW), 'future');    // the row already in production
});

test('a late receipt is fine; a wrong year is not', () => {
  const daysAgo = (n: number) => {
    const d = new Date(NOW - n * DAY);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  assert.equal(checkBillDate(daysAgo(40), NOW), 'ok');          // the largest genuine gap observed
  assert.equal(checkBillDate(daysAgo(BILL_DATE_MAX_AGE_DAYS - 1), NOW), 'ok');
  assert.equal(checkBillDate(daysAgo(BILL_DATE_MAX_AGE_DAYS + 1), NOW), 'too-old');
  // Every one of the live wrong-year rows is at least a full year out, well past the window.
  for (const bad of ['2024-09-11', '2020-09-16', '2023-09-02', '2016-09-25', '2007-09-04']) {
    assert.equal(checkBillDate(bad, NOW), 'too-old', bad);
    assert.equal(isPlausibleExtractedBillDate(bad, NOW), false, bad);
  }
});

test('a date that is not a real day is rejected, and local midnight is used', () => {
  assert.equal(billDateMs('2026-02-30'), null);
  assert.equal(billDateMs('not-a-date'), null);
  assert.equal(checkBillDate('2026-02-30', NOW), 'malformed');
  // Local, not UTC — mixing the two shifts a bill by a day everywhere else in the app.
  assert.equal(new Date(billDateMs('2026-09-12') as number).getDate(), 12);
});

// ─── what a person gets told ──────────────────────────────────────────────────

test('a typed future date is blocked; an old one only warns', () => {
  assert.equal(billDateWarning('2026-09-12', NOW), null);
  assert.equal(billDateWarning('2028-09-16', NOW)?.level, 'block');
  const old = billDateWarning('2020-09-16', NOW);
  // Warn, not block: a genuinely late receipt is ordinary and must not be refused over a typo.
  assert.equal(old?.level, 'warn');
  assert.match(old?.message ?? '', /check the year/i);
});
