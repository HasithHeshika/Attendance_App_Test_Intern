// Pure calendar arithmetic for the On Leave view — who is away on which day, and how a month is
// laid out. No firebase, no React, no clock: the component, the service and the tests all import
// this, so "which days does this leave cover" is answered in exactly one place.
//
// Dates are the app's 'YYYY-MM-DD' strings throughout, and they are compared as STRINGS. Never
// Date.parse a bare date string to compare it: '2026-09-05' parses as UTC midnight, which is the
// 5th at 05:30 in Asia/Colombo but the 4th at 19:00 in New York, and a leave silently moves a day.
// The one place a Date is unavoidable is working out which weekday a month starts on, and that
// goes through utcDate() below, which pins the whole calculation to UTC on both ends.

/** A leave, reduced to the two things this module needs. */
export interface DayRange {
  from_date: string;
  to_date: string;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export function isYmd(v: unknown): v is string {
  return typeof v === 'string' && YMD.test(v);
}

/**
 * A Date pinned to UTC midnight for a 'YYYY-MM-DD'. Used ONLY for weekday and month arithmetic,
 * never for comparing two dates — string comparison already does that correctly and cheaply.
 */
function utcDate(ymd: string): Date {
  return new Date(`${ymd}T00:00:00Z`);
}

/** 'YYYY-MM-DD' for a UTC-pinned Date. */
function ymdOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The day after `ymd`. Month and year roll over; leap days are the platform's problem, not ours. */
export function nextDay(ymd: string): string {
  const d = utcDate(ymd);
  d.setUTCDate(d.getUTCDate() + 1);
  return ymdOf(d);
}

/** `months` calendar months from a 'YYYY-MM' key — negative goes back. */
export function addMonthKey(monthKey: string, months: number): string {
  const [y, m] = monthKey.split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return monthKey;
  // Month is 0-indexed here, so (m - 1 + months) can go negative or past 11 and Date normalises
  // both — which is exactly what makes December → January and January → December work.
  const d = new Date(Date.UTC(y, m - 1 + months, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The 'YYYY-MM' a date falls in. */
export function monthKeyOf(ymd: string): string {
  return ymd.slice(0, 7);
}

/** First and last day of a month, inclusive — the window one range read has to cover. */
export function monthBounds(monthKey: string): { from: string; to: string } {
  const [y, m] = monthKey.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  // Day 0 of the NEXT month is the last day of this one, which is how February gets 29 in a leap
  // year without this module knowing what a leap year is.
  const last = new Date(Date.UTC(y, m, 0));
  return { from: ymdOf(first), to: ymdOf(last) };
}

/**
 * Every day a leave covers, inclusive of both ends, clamped to [windowFrom, windowTo].
 *
 * Inclusive is the whole point: a leave from Monday to Friday is five days off, not four. The
 * clamp is what lets a leave that started last month still light up its days in this one.
 * A backwards or malformed range yields nothing rather than looping forever.
 */
export function daysCovered(leave: DayRange, windowFrom: string, windowTo: string): string[] {
  const from = String(leave?.from_date ?? '').slice(0, 10);
  const to = String(leave?.to_date ?? '').slice(0, 10);
  if (!isYmd(from) || !isYmd(to) || to < from) return [];
  if (!isYmd(windowFrom) || !isYmd(windowTo) || windowTo < windowFrom) return [];

  const start = from < windowFrom ? windowFrom : from;
  const end = to > windowTo ? windowTo : to;
  if (end < start) return [];

  const out: string[] = [];
  for (let d = start; d <= end; d = nextDay(d)) out.push(d);
  return out;
}

/** Does a leave touch the window at all? The overlap test the range read itself uses. */
export function overlapsWindow(leave: DayRange, windowFrom: string, windowTo: string): boolean {
  const from = String(leave?.from_date ?? '').slice(0, 10);
  const to = String(leave?.to_date ?? '').slice(0, 10);
  if (!isYmd(from) || !isYmd(to) || to < from) return false;
  return from <= windowTo && to >= windowFrom;
}

/**
 * Leaves grouped by the day they cover — one entry per day, and a leave spanning a week appears
 * under all seven of its days. That duplication is deliberate: the calendar asks "who is away on
 * the 9th", and answering it by re-scanning every leave per cell is how a month grid gets slow.
 */
export function groupByDay<T extends DayRange>(
  leaves: T[], windowFrom: string, windowTo: string,
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const leave of leaves ?? []) {
    for (const day of daysCovered(leave, windowFrom, windowTo)) {
      const list = out.get(day);
      if (list) list.push(leave); else out.set(day, [leave]);
    }
  }
  return out;
}

/** One cell of a month grid. */
export interface CalendarCell {
  date: string;
  /** False for the leading and trailing days that belong to the neighbouring months. */
  inMonth: boolean;
  /** 0 = Sunday, matching Date.getUTCDay() and the app's Sunday-is-rest convention. */
  weekday: number;
}

/**
 * A month as a grid of whole weeks, Sunday-first, padded with the neighbouring months' days so
 * every row has seven cells.
 *
 * The padding days are real dates rather than blanks — a leave running from 30 August into
 * September should still show on that leading row, and a cell that knows its own date can say so.
 * Callers dim them via `inMonth`.
 */
export function monthGrid(monthKey: string): CalendarCell[] {
  const { from, to } = monthBounds(monthKey);
  const firstWeekday = utcDate(from).getUTCDay();

  const cells: CalendarCell[] = [];
  // Walk back to the Sunday on or before the 1st.
  let cursor = from;
  for (let i = 0; i < firstWeekday; i++) {
    const d = utcDate(cursor);
    d.setUTCDate(d.getUTCDate() - 1);
    cursor = ymdOf(d);
  }
  // Six rows covers every possible month (a 31-day month starting on Saturday needs exactly six);
  // a month that finishes in five gets its sixth row trimmed below, so the grid never carries a
  // whole row belonging to another month.
  for (let i = 0; i < 42; i++) {
    cells.push({ date: cursor, inMonth: cursor >= from && cursor <= to, weekday: utcDate(cursor).getUTCDay() });
    cursor = nextDay(cursor);
  }
  const lastUsed = cells.reduce((acc, c, i) => (c.inMonth ? i : acc), 0);
  const rows = Math.ceil((lastUsed + 1) / 7);
  return cells.slice(0, rows * 7);
}

/**
 * How busy a day is, as a step from 0-3, for shading a cell.
 *
 * Steps rather than a raw count because the count is already printed in the cell — the shade is
 * for scanning a month at arm's length, and four levels is as many as anyone can tell apart.
 * `busiest` is the month's own maximum, so a team where three away is a crisis reads the same as
 * one where thirty is: the scale is relative to what this month actually looks like.
 */
export function densityStep(count: number, busiest: number): 0 | 1 | 2 | 3 {
  if (count <= 0 || busiest <= 0) return 0;
  const ratio = count / busiest;
  if (ratio > 0.66) return 3;
  if (ratio > 0.33) return 2;
  return 1;
}
