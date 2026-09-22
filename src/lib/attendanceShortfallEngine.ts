// Attendance Cutoff & Shift Engine — pure functions, no Firestore, no React. Computes Late
// Arrival / Early Departure minutes for one employee's one day, strictly against that day's
// SCHEDULED shift(s) (src/app/(pages)/schedule/page.tsx's ScheduleAssignment), never a fixed
// company-wide cutoff.
//
// Consecutive / back-to-back shifts — an employee assigned two or more ScheduleAssignment rows
// on the same date where the NEXT shift's start is EXACTLY the previous shift's end (0-minute
// gap) — are merged into ONE block: the FIRST shift's scheduled start is the check-in anchor,
// the LAST shift's scheduled end is the check-out anchor. A missing mid-shift check-out/
// check-in punch inside such a merged block is never penalized.
//
// Same-date shifts that are NOT contiguous (e.g. Morning 07:00-13:00 and Night 19:00-07:00,
// with a real gap in between) are deliberately kept as SEPARATE blocks — mergeShiftBlocks()
// returns one ShiftBlock per contiguous run, not one block per day. The gap between them is
// never counted as working time or merged into a single anchor: each block is checked against
// its own actual check-in/check-out independently (see the Attendance View page, which pairs
// each block with its own attendance session in chronological order).
//
// 0-minute grace period: any actual check-in after a block's scheduled start counts as late,
// any actual check-out before its scheduled end counts as an early departure — no buffer.

import type { ScheduleAssignment } from '@/lib/types';

// One constituent shift inside a ShiftBlock, with its OWN scheduled window preserved (in the
// same "minutes since the block's date's midnight" units as the block itself, so a shift
// after midnight still compares/sorts correctly). A block with one merged shift has exactly
// one entry here; a genuinely merged block (2+ back-to-back shifts) has one entry per shift,
// in chronological order — this is what lets a UI itemize a merged sequence shift-by-shift
// instead of only ever seeing the block's collapsed overall start/end.
export interface ConstituentShift {
  name: string;
  scheduledStartMin: number;
  scheduledEndMin: number;
}

export interface ShiftBlock {
  date: string; // 'YYYY-MM-DD' — the calendar date the merged assignments share
  scheduledStartMin: number; // minutes since that date's LOCAL (Asia/Colombo) midnight
  scheduledEndMin: number;   // may exceed 1440 when the block runs past midnight
  shiftNames: string[]; // >1 entry only when 2+ shifts were truly back-to-back (0 gap)
  shifts: ConstituentShift[]; // same length/order as shiftNames — each shift's OWN window
}

export interface DayShortfall {
  lateMinutes: number;
  earlyDepartureMinutes: number;
}

function toMin(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** Groups every ScheduleAssignment row sharing ONE employee's ONE date into contiguous
 *  runs — pass it only same-date, same-employee rows (the caller groups by epf+date first).
 *  Sorted by start time; a run continues to the next assignment ONLY when that assignment's
 *  start lands exactly where the running block currently ends (checked modulo 24h, so a block
 *  already past midnight still matches correctly) — anything else (a real gap, however short)
 *  closes the current block and starts a new one. Returns [] for an empty list (no shift
 *  scheduled that day). A shift whose end is at/before its own start is treated as crossing
 *  midnight (matches the Schedule page's own timeRangesOverlap() convention exactly). */
export function mergeShiftBlocks(assignmentsForOneDay: ScheduleAssignment[]): ShiftBlock[] {
  if (assignmentsForOneDay.length === 0) return [];
  const sorted = [...assignmentsForOneDay].sort((a, b) => toMin(a.start_time) - toMin(b.start_time));

  const blocks: ShiftBlock[] = [];
  let blockDate = sorted[0].date;
  let blockStart = toMin(sorted[0].start_time);
  let blockEnd = blockStart;
  let blockShiftNames: string[] = [];
  let blockShifts: ConstituentShift[] = [];

  const openBlock = (a: ScheduleAssignment) => {
    const s = toMin(a.start_time);
    let e = toMin(a.end_time);
    if (e <= s) e += 24 * 60;
    blockDate = a.date; blockStart = s; blockEnd = e; blockShiftNames = [a.shift_name];
    blockShifts = [{ name: a.shift_name, scheduledStartMin: s, scheduledEndMin: e }];
  };
  openBlock(sorted[0]);

  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i];
    const s = toMin(a.start_time);
    let e = toMin(a.end_time);
    if (e <= s) e += 24 * 60;
    const gap = ((s - blockEnd) % (24 * 60) + 24 * 60) % (24 * 60);
    if (gap === 0) {
      // Truly back-to-back (0 gap) — extend the running block instead of starting a new one.
      // This shift's own window, relative to the SAME block-date reference, may itself need
      // the 24h wrap applied again (e.g. a 3rd shift starting after the block has already
      // crossed midnight) — recompute s/e relative to blockEnd so ConstituentShift stays in
      // the same growing-minutes-since-midnight units as the block itself.
      const relStart = blockEnd;
      const relEnd = blockEnd + (e - s);
      blockShifts.push({ name: a.shift_name, scheduledStartMin: relStart, scheduledEndMin: relEnd });
      blockEnd = relEnd;
      blockShiftNames.push(a.shift_name);
    } else {
      blocks.push({ date: blockDate, scheduledStartMin: blockStart, scheduledEndMin: blockEnd, shiftNames: blockShiftNames, shifts: blockShifts });
      openBlock(a);
    }
  }
  blocks.push({ date: blockDate, scheduledStartMin: blockStart, scheduledEndMin: blockEnd, shiftNames: blockShiftNames, shifts: blockShifts });
  return blocks;
}

// Sri Lanka is a fixed UTC+5:30 offset year-round (no DST) — safe to hardcode, matches every
// other local-time computation in this app (see localDateString's 'Asia/Colombo' anchor).
const SRI_LANKA_UTC_OFFSET = '+05:30';

/** How many minutes `instant` falls after LOCAL midnight of `dateStr` — may exceed 1440 when
 *  `instant` actually lands on a later calendar day (an overnight checkout), which is exactly
 *  what lets it compare directly against a ShiftBlock's own >1440 scheduledEndMin. */
export function localMinutesSinceMidnight(instant: Date, dateStr: string): number {
  const baseMidnightUtcMs = new Date(`${dateStr}T00:00:00${SRI_LANKA_UTC_OFFSET}`).getTime();
  return (instant.getTime() - baseMidnightUtcMs) / 60000;
}

export interface MatchableSession {
  checkIn: Date | null;
  checkOut: Date | null;
}

/** Pairs each ShiftBlock with the attendance session whose actual punch times best fit its
 *  scheduled window, instead of assuming sessions[i] lines up with blocks[i] by array position.
 *  Index pairing silently drifts the moment a shift is retroactively attached to a day whose
 *  punch already existed unscheduled (or a shift is added/removed after the fact) — the counts
 *  of blocks and sessions no longer agree, and a block ends up scored against the wrong punch,
 *  or none at all, while the punch that actually belongs to it is dropped.
 *
 *  Greedy nearest-fit, one block at a time in chronological order (both mergeShiftBlocks and
 *  sessionsOf already return their inputs sorted that way): each block claims whichever
 *  remaining session's [check-in, check-out] window overlaps its own [scheduledStartMin,
 *  scheduledEndMin] the most (computed in the block's own date's local minutes, so an overnight
 *  block still compares correctly) — or, when nothing overlaps outright, whichever is closest.
 *  A block left with no session to claim gets null, same as an index miss used to produce. */
export function matchSessionsToBlocks<T extends MatchableSession>(
  blocks: ShiftBlock[],
  sessions: T[],
): (T | null)[] {
  const remaining = sessions.map((s) => s);
  const result: (T | null)[] = [];
  for (const block of blocks) {
    if (remaining.length === 0) { result.push(null); continue; }
    let bestIdx = -1;
    let bestFit = -Infinity;
    remaining.forEach((s, idx) => {
      const inMin = s.checkIn ? localMinutesSinceMidnight(s.checkIn, block.date) : null;
      const outMin = s.checkOut ? localMinutesSinceMidnight(s.checkOut, block.date) : null;
      if (inMin === null && outMin === null) return; // no punch at all — never a candidate
      const sessionStart = inMin ?? outMin!;
      const sessionEnd = outMin ?? inMin!;
      // Positive = real overlap (minutes shared with the block's window); negative = the gap
      // between them when there's no overlap at all — either way, higher is a better fit.
      const fit = Math.min(sessionEnd, block.scheduledEndMin) - Math.max(sessionStart, block.scheduledStartMin);
      if (fit > bestFit) { bestFit = fit; bestIdx = idx; }
    });
    if (bestIdx === -1) { result.push(null); continue; }
    result.push(remaining.splice(bestIdx, 1)[0]);
  }
  return result;
}

/** Minutes `checkOut` falls PAST the LAST scheduled block's own scheduledEndMin — 0 when there
 *  are no blocks, no checkout, or the checkout is at/before that block's end. Deliberately
 *  separate from earlyDepartureMinutes above: a checkout after the day's last shift ends is
 *  never a shortfall (computeShortfallForDay already floors that comparison at 0), but it is
 *  still worth surfacing on its own — most often a shift retroactively attached to a punch that
 *  already existed unscheduled, whose actual check-out runs past whatever window the
 *  newly-added shift offers. */
export function computeCheckOutOverrunMinutes(blocks: ShiftBlock[], checkOut: Date | null): number {
  if (blocks.length === 0 || !checkOut) return 0;
  const lastBlock = blocks[blocks.length - 1];
  return Math.max(0, Math.round(localMinutesSinceMidnight(checkOut, lastBlock.date) - lastBlock.scheduledEndMin));
}

/** Called once PER BLOCK (see mergeShiftBlocks — a day may have more than one, when same-day
 *  shifts aren't contiguous), each matched to its own attendance session, never the whole
 *  day's outermost punches. Late Minutes = actual check-in for THIS block − this block's
 *  scheduled start (only if they checked in at all — no check-in is an absence, a separate
 *  concern, not lateness). Early Departure Minutes = this block's scheduled end − actual
 *  check-out for THIS block (only if they checked out at all — a missing checkout is a
 *  data-quality issue, not penalized here since there's no actual time to compare). Both floor
 *  at 0 — arriving early / leaving late never produces a negative "shortfall". No block
 *  (`block` null) → both 0, nothing to compare against. */
export function computeShortfallForDay(
  block: ShiftBlock | null,
  actualCheckIn: Date | null,
  actualCheckOut: Date | null,
): DayShortfall {
  if (!block) return { lateMinutes: 0, earlyDepartureMinutes: 0 };
  const lateMinutes = actualCheckIn
    ? Math.max(0, Math.round(localMinutesSinceMidnight(actualCheckIn, block.date) - block.scheduledStartMin))
    : 0;
  const earlyDepartureMinutes = actualCheckOut
    ? Math.max(0, Math.round(block.scheduledEndMin - localMinutesSinceMidnight(actualCheckOut, block.date)))
    : 0;
  return { lateMinutes, earlyDepartureMinutes };
}

export function formatMinutes(total: number): string {
  if (total <= 0) return '0m';
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** A ShiftBlock's scheduledStartMin/scheduledEndMin as an "HH:MM" clock label — with a
 *  "(+1 day)" suffix when the value runs past the block's own date (an overnight shift, or an
 *  overnight-crossing merged block), so it's never misread as an earlier same-day time. */
export function formatScheduledClock(totalMinutes: number): string {
  const wrapped = ((totalMinutes % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  const clock = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  return totalMinutes >= 1440 ? `${clock} (+1 day)` : clock;
}
