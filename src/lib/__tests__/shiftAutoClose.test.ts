import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  colomboWallClockMs, scheduledShiftEndMs, pickAssignmentForOpenSession, isPastGrace,
  autoCloseGapHours, isDuplicatePunch, nextDateStr, SCHEDULED_END_GRACE_MINUTES,
  isOverlong, deriveReviewReason, reviewSeverityHours, computeShiftSegments,
  MAX_PLAUSIBLE_SHIFT_HOURS, pickOpenSessionToClose, CHECKOUT_LOOKBACK_HOURS,
  type ShiftWindow, type OpenSessionRef,
} from '../shiftAutoClose';

const HOUR = 3_600_000;
const MIN = 60_000;
const toMs = colomboWallClockMs;

test('colomboWallClockMs: a wall-clock HH:MM resolves at the fixed +05:30 offset', () => {
  assert.equal(colomboWallClockMs('2026-09-01', '18:00'), Date.parse('2026-09-01T18:00:00+05:30'));
  assert.equal(colomboWallClockMs('2026-09-01', '6:05'), Date.parse('2026-09-01T06:05:00+05:30'));
});

test('nextDateStr: rolls the calendar day, including month/year ends', () => {
  assert.equal(nextDateStr('2026-09-01'), '2026-09-02');
  assert.equal(nextDateStr('2026-09-30'), '2026-10-01');
  assert.equal(nextDateStr('2026-12-31'), '2027-01-01');
});

test('scheduledShiftEndMs: a day shift ends the same day', () => {
  const w: ShiftWindow = { date: '2026-09-01', start_time: '06:00', end_time: '18:00' };
  assert.equal(scheduledShiftEndMs(w, toMs), toMs('2026-09-01', '18:00'));
});

test('scheduledShiftEndMs: an overnight shift (end <= start) ends the next day', () => {
  const w: ShiftWindow = { date: '2026-09-01', start_time: '18:00', end_time: '06:00' };
  assert.equal(scheduledShiftEndMs(w, toMs), toMs('2026-09-02', '06:00'));
});

test('pickAssignmentForOpenSession: prefers the window that contains the check-in', () => {
  const rows: ShiftWindow[] = [
    { date: '2026-09-01', start_time: '06:00', end_time: '14:00' },
    { date: '2026-09-01', start_time: '14:00', end_time: '22:00' },
  ];
  const inMs = toMs('2026-09-01', '15:30');
  assert.equal(pickAssignmentForOpenSession(rows, inMs, toMs)?.start_time, '14:00');
});

test('pickAssignmentForOpenSession: falls back to the latest start at/before the check-in', () => {
  const rows: ShiftWindow[] = [
    { date: '2026-09-01', start_time: '06:00', end_time: '10:00' },
    { date: '2026-09-01', start_time: '22:00', end_time: '23:00' },
  ];
  // 12:00 is inside neither window; the 06:00 shift is the latest that started before it.
  assert.equal(pickAssignmentForOpenSession(rows, toMs('2026-09-01', '12:00'), toMs)?.start_time, '06:00');
});

test('pickAssignmentForOpenSession: no rows → null (caller then skips auto-close)', () => {
  assert.equal(pickAssignmentForOpenSession([], toMs('2026-09-01', '12:00'), toMs), null);
  assert.equal(pickAssignmentForOpenSession(null, 123, toMs), null);
});

test('isPastGrace: false inside the grace window, true once it is exceeded', () => {
  const end = toMs('2026-09-01', '18:00');
  const checkIn = toMs('2026-09-01', '06:00');
  const grace = SCHEDULED_END_GRACE_MINUTES * MIN;
  assert.equal(isPastGrace(checkIn, end, end + grace - MIN), false);
  assert.equal(isPastGrace(checkIn, end, end + grace + MIN), true);
});

test('isPastGrace: a check-in after the scheduled end cannot belong to that shift', () => {
  const end = toMs('2026-09-01', '18:00');
  assert.equal(isPastGrace(end + HOUR, end, end + 10 * HOUR), false);
});

test('isPastGrace: unknown scheduled end is never past grace', () => {
  assert.equal(isPastGrace(1, null, Date.now()), false);
});

test('autoCloseGapHours: rounds to the nearest half hour and clamps to [0, 24]', () => {
  const end = toMs('2026-09-01', '18:00');
  assert.equal(autoCloseGapHours(end, end + 12 * HOUR), 12);
  assert.equal(autoCloseGapHours(end, end + 2 * HOUR + 40 * MIN), 2.5);
  assert.equal(autoCloseGapHours(end, end - HOUR), 0);       // ref before end
  assert.equal(autoCloseGapHours(end, end + 100 * HOUR), 24); // clamp
});

test('isDuplicatePunch: true only for a forward gap inside the window', () => {
  const t = Date.parse('2026-09-01T06:00:00+05:30');
  assert.equal(isDuplicatePunch(t, t + 20_000), true);
  assert.equal(isDuplicatePunch(t, t + 60_000), false);
  assert.equal(isDuplicatePunch(t, t - 20_000), false); // out-of-order
  assert.equal(isDuplicatePunch(null, t), false);        // first punch ever
});

// ─── Hybrid model: overlong / review classification / retro segments ──────────────────────

test('isOverlong: true at/after the MAX_PLAUSIBLE_SHIFT_HOURS boundary', () => {
  const inMs = toMs('2026-09-01', '06:00');
  assert.equal(isOverlong(inMs, inMs + (MAX_PLAUSIBLE_SHIFT_HOURS - 0.5) * HOUR), false);
  assert.equal(isOverlong(inMs, inMs + MAX_PLAUSIBLE_SHIFT_HOURS * HOUR), true);
  assert.equal(isOverlong(inMs, inMs + 36 * HOUR), true);
  assert.equal(isOverlong(NaN, inMs), false);
});

test('deriveReviewReason: roster-relative, plain overlong, and missing-mid-punch tiers', () => {
  assert.equal(deriveReviewReason({ actualHrs: 21, scheduledHrs: null }), 'overlong');
  assert.equal(deriveReviewReason({ actualHrs: 16, scheduledHrs: 12 }), 'overlong_vs_roster');
  assert.equal(deriveReviewReason({ actualHrs: 12.5, scheduledHrs: 12 }), 'overlong'); // within +1h → not roster-flagged
  assert.equal(deriveReviewReason({ actualHrs: 31, scheduledHrs: 12 }), 'missing_mid_punch');
  assert.equal(deriveReviewReason({ actualHrs: 30, scheduledHrs: null }), 'missing_mid_punch');
});

test('reviewSeverityHours: hours over the roster, else over the plausible ceiling', () => {
  assert.equal(reviewSeverityHours(20, 12), 8);
  assert.equal(reviewSeverityHours(24, null), 24 - MAX_PLAUSIBLE_SHIFT_HOURS);
  assert.equal(reviewSeverityHours(10, 12), 0); // never negative
});

test('computeShiftSegments: a session exactly matching one window is all scheduled', () => {
  const w: ShiftWindow & { id: string } = { id: 'a1', date: '2026-09-01', start_time: '06:00', end_time: '18:00' };
  const segs = computeShiftSegments({
    startMs: toMs('2026-09-01', '06:00'), endMs: toMs('2026-09-01', '18:00'),
    windows: [w], toMs,
  });
  assert.equal(segs.length, 1);
  assert.equal(segs[0].bucket, 'scheduled');
  assert.equal(segs[0].roster_assignment_id, 'a1');
  assert.equal(segs[0].hours, 12);
});

test('computeShiftSegments: hours beyond the rostered window become ot_unverified', () => {
  const w: ShiftWindow & { id: string } = { id: 'a1', date: '2026-09-01', start_time: '06:00', end_time: '18:00' };
  const startMs = toMs('2026-09-01', '06:00');
  const endMs = toMs('2026-09-02', '06:00'); // 24h — worked 12h past the shift
  const segs = computeShiftSegments({ startMs, endMs, windows: [w], toMs });
  assert.deepEqual(segs.map(s => s.bucket), ['scheduled', 'ot_unverified']);
  assert.equal(segs[0].hours, 12);
  assert.equal(segs[1].hours, 12);
  assert.equal(segs[1].roster_assignment_id, null);
});

test('computeShiftSegments: two back-to-back windows fill chronologically', () => {
  const startMs = toMs('2026-09-01', '06:00');
  const endMs = toMs('2026-09-01', '22:00'); // 16h across two 8h shifts, then nothing extra
  const segs = computeShiftSegments({
    startMs, endMs, toMs,
    windows: [
      { id: 'm', date: '2026-09-01', start_time: '06:00', end_time: '14:00' },
      { id: 'n', date: '2026-09-01', start_time: '14:00', end_time: '22:00' },
    ],
  });
  assert.deepEqual(segs.map(s => [s.bucket, s.roster_assignment_id, s.hours]), [
    ['scheduled', 'm', 8],
    ['scheduled', 'n', 8],
  ]);
});

test('computeShiftSegments: no roster windows → the whole span is ot_unverified', () => {
  const startMs = toMs('2026-09-01', '06:00');
  const endMs = toMs('2026-09-02', '18:00'); // 36h, no roster
  const segs = computeShiftSegments({ startMs, endMs, windows: [], toMs });
  assert.equal(segs.length, 1);
  assert.equal(segs[0].bucket, 'ot_unverified');
  assert.equal(segs[0].hours, 36);
});

test('computeShiftSegments: overlapping windows are absorbed left-to-right, no double count', () => {
  const startMs = toMs('2026-09-01', '06:00');
  const endMs = toMs('2026-09-01', '20:00'); // 14h
  const segs = computeShiftSegments({
    startMs, endMs, toMs,
    windows: [
      { id: 'a', date: '2026-09-01', start_time: '06:00', end_time: '16:00' },
      { id: 'b', date: '2026-09-01', start_time: '12:00', end_time: '20:00' }, // overlaps a by 4h
    ],
  });
  const total = segs.reduce((s, x) => s + x.hours, 0);
  assert.equal(total, 14); // Σ === span, no double-count
  assert.equal(segs.every(s => s.bucket === 'scheduled'), true);
});

// ─── Checkout-matching across day-documents ────────────────────────────────────────────────

test('pickOpenSessionToClose: a single candidate within the window is chosen', () => {
  const now = toMs('2026-09-03', '10:00');
  const candidates: OpenSessionRef[] = [{ dayKey: 'today', sessionIndex: 0, checkInMs: now - 2 * HOUR }];
  assert.deepEqual(pickOpenSessionToClose(candidates, now), candidates[0]);
});

test('pickOpenSessionToClose: picks the MOST RECENT check-in among several candidates', () => {
  const now = toMs('2026-09-03', '10:00');
  const candidates: OpenSessionRef[] = [
    { dayKey: 'prev2', sessionIndex: 0, checkInMs: now - 30 * HOUR },
    { dayKey: 'prev', sessionIndex: 1, checkInMs: now - 10 * HOUR }, // most recent
    { dayKey: 'today', sessionIndex: 0, checkInMs: now - 20 * HOUR },
  ];
  assert.deepEqual(pickOpenSessionToClose(candidates, now), candidates[1]);
});

test('pickOpenSessionToClose: a same-day candidate always wins over an older day, since its check-in is always the larger ms value', () => {
  const now = toMs('2026-09-03', '02:00'); // just after midnight
  const candidates: OpenSessionRef[] = [
    { dayKey: 'prev', sessionIndex: 0, checkInMs: toMs('2026-09-02', '20:00') },
    { dayKey: 'today', sessionIndex: 0, checkInMs: toMs('2026-09-03', '00:30') }, // opened minutes ago
  ];
  assert.equal(pickOpenSessionToClose(candidates, now)?.dayKey, 'today');
});

test('pickOpenSessionToClose: excludes anything older than the lookback window', () => {
  const now = toMs('2026-09-03', '10:00');
  const tooOld: OpenSessionRef = { dayKey: 'prev2', sessionIndex: 0, checkInMs: now - (CHECKOUT_LOOKBACK_HOURS + 1) * HOUR };
  const withinWindow: OpenSessionRef = { dayKey: 'prev', sessionIndex: 0, checkInMs: now - (CHECKOUT_LOOKBACK_HOURS - 1) * HOUR };
  assert.deepEqual(pickOpenSessionToClose([tooOld], now), null);
  assert.deepEqual(pickOpenSessionToClose([tooOld, withinWindow], now), withinWindow);
});

test('pickOpenSessionToClose: exactly at the lookback boundary is still included (<=, not <)', () => {
  const now = toMs('2026-09-03', '10:00');
  const atBoundary: OpenSessionRef = { dayKey: 'prev2', sessionIndex: 0, checkInMs: now - CHECKOUT_LOOKBACK_HOURS * HOUR };
  assert.deepEqual(pickOpenSessionToClose([atBoundary], now), atBoundary);
});

test('pickOpenSessionToClose: no candidates at all → null', () => {
  assert.equal(pickOpenSessionToClose([], toMs('2026-09-03', '10:00')), null);
});

test('pickOpenSessionToClose: a custom lookbackHours overrides the CHECKOUT_LOOKBACK_HOURS default', () => {
  const now = toMs('2026-09-03', '10:00');
  const candidate: OpenSessionRef = { dayKey: 'today', sessionIndex: 0, checkInMs: now - 5 * HOUR };
  assert.equal(pickOpenSessionToClose([candidate], now, 4), null);   // 5h ago, 4h window → excluded
  assert.deepEqual(pickOpenSessionToClose([candidate], now, 6), candidate); // 6h window → included
});

test('computeShiftSegments: Σ hours always equals the raw span (overnight window)', () => {
  const startMs = toMs('2026-09-01', '18:00');
  const endMs = toMs('2026-09-03', '02:00'); // 32h spanning an overnight window + extra
  const segs = computeShiftSegments({
    startMs, endMs, toMs,
    windows: [{ id: 'x', date: '2026-09-01', start_time: '18:00', end_time: '06:00' }], // overnight → ends 09-02 06:00
  });
  const total = segs.reduce((s, x) => s + x.hours, 0);
  assert.equal(Math.round(total), 32);
  assert.deepEqual(segs.map(s => s.bucket), ['scheduled', 'ot_unverified']);
  assert.equal(segs[0].hours, 12);
  assert.equal(segs[1].hours, 20);
});
