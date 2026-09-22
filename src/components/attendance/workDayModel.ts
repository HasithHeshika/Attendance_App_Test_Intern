/**
 * The attendance calendar's model of a working day — pure, no React, no Firebase.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  THE WEEK IS AN ARGUMENT NOW, NOT A CONSTANT.
 *
 *  `expectedHours(date, expectation)` takes a `WorkExpectation` — an employee's
 *  configured week, resolved role → location → company → built-in default by
 *  `src/lib/workPatterns.ts`. Every downstream fact (the day mark, the "short
 *  day" test, the half-circle gauge, the month fold) reads it from there.
 *
 *  Callers that pass nothing get DEFAULT_EXPECTATION, which reproduces the old
 *  hardcoded week EXACTLY — Mon–Fri 8h, Sat 4h. That is deliberate: a tenant with
 *  no `work_patterns` rows sees precisely what it saw before, so shipping this
 *  changed nobody's numbers on the day it landed.
 *
 *  One caveat worth knowing before you "fix" it: the old code returned 8h for
 *  SUNDAY (`getDay() === 6 ? 4 : 8`), even though this header used to claim Sunday
 *  was a rest day. DEFAULT_DAYS reproduces the CODE, not that claim. Making Sunday
 *  rest by default is a real behaviour change for anyone who has ever worked one.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// Relative, not the `@/` alias: npm test runs plain `node --test` over the compiled output in
// .test-out, where tsconfig path aliases are not resolved. An alias here silently fails the
// WHOLE test file at load time rather than failing one assertion.
import { patternExpectation, type WorkExpectation } from '../../lib/workPatterns';

/** A full weekday's expected hours. */
export const FULL_DAY_HOURS = 8;
/** Saturday is worked as a half day — the gauge draws it as a literal half circle. */
export const SATURDAY_HOURS = 4;
/**
 * Real punch data almost never lands exactly on the expected hours, so without a grace band
 * "an ordinary day" would be an empty category and every single day would render as an
 * exception — which is the failure this design exists to avoid. Half an hour either side of
 * expected still counts as a normal day; the printed figure carries the real number regardless.
 */
export const HOURS_GRACE = 0.5;

/**
 * The employee's resolved week. `patternExpectation()` with no patterns reproduces the
 * hardcoded Mon–Fri 8h / Sat 4h week exactly, which is what makes threading this through a
 * no-op until a `work_patterns` row actually exists.
 */
export const DEFAULT_EXPECTATION: WorkExpectation = patternExpectation();

/**
 * Hours this date is expected to produce.
 *
 * The TODO at the top of this file, done: the week is now an argument. Callers that pass
 * nothing keep the built-in default, so nothing changed for anyone on the day this landed.
 */
export function expectedHours(date: Date, expectation: WorkExpectation = DEFAULT_EXPECTATION): number {
  return expectation.hoursFor(date);
}

/**
 * Whether this day's gauge is drawn as a half circle — i.e. the day is worth LESS than a full
 * day. Keyed on the expectation rather than on `getDay() === 6`, so a Wednesday half-day draws
 * the same half circle a Saturday does.
 */
export function isHalfDay(date: Date, expectation: WorkExpectation = DEFAULT_EXPECTATION): boolean {
  return expectation.isPartial(date);
}

/** A day the resolved week expects no work on at all. Distinct from "worked nothing". */
export function isRestDay(date: Date, expectation: WorkExpectation = DEFAULT_EXPECTATION): boolean {
  return expectation.isRest(date);
}

// ─── The one gauge model ──────────────────────────────────────────────────────
// `kind` is what the day IS; `fraction` is how much of its gauge is filled; `half` is whether
// that gauge is a semicircle. Nothing else about a day's hours is encoded anywhere, which is
// what stops one fact being drawn twice.
export type DayMarkKind =
  | 'none'    // nothing recorded — no gauge at all
  | 'empty'   // worked, but zero completed hours (checked in, never checked out)
  | 'rest'    // worked on a day the pattern expects nothing from — a rest day
  | 'short'   // worked, and under the expected hours by more than the grace band
  | 'full'    // worked the expected hours (± the grace band)
  | 'over';   // worked past the expected hours by more than the grace band

export interface DayMark {
  kind: DayMarkKind;
  fraction: number;  // 0–1 of this day's gauge sweep
  half: boolean;     // Saturday: the sweep is a half circle, not a full one
}

/**
 * The single source of truth for a day's mark. `worked` comes from the calendar modifier, so a
 * day the backend reported as worked still gets a gauge (an empty one) when it has no hours —
 * without it, a missing-checkout day would look like a day nobody came in.
 */
export function dayMark(
  hours: number | undefined,
  date: Date,
  worked: boolean,
  expectation: WorkExpectation = DEFAULT_EXPECTATION,
): DayMark {
  const expected = expectedHours(date, expectation);
  const raw = Number(hours);
  const h = Number.isFinite(raw) && raw > 0 ? raw : 0;
  const half = isHalfDay(date, expectation);

  if (h <= 0) return { kind: worked ? 'empty' : 'none', fraction: 0, half };

  // A rest day expects nothing, so `h / expected` would be Infinity. It gets its OWN mark
  // rather than borrowing 'over': "you worked more than expected" and "you worked on a day you
  // were not expected to work at all" are different facts, and only the second is worth an
  // approver's attention. Drawn as a diamond rather than the round bead — shape, because
  // --success, --primary and --brand all resolve to the same azure in this app.
  if (expected <= 0) return { kind: 'rest', fraction: 1, half };
  // Beyond the expectation the gauge is simply complete — a long day does NOT draw a second
  // lap. "How much" is a number, and numbers belong in the figure under the date and in the
  // month summary, not in a ring somebody has to measure by eye.
  const fraction = Math.min(1, h / expected);
  if (h > expected + HOURS_GRACE) return { kind: 'over',  fraction: 1, half };
  if (h < expected - HOURS_GRACE) return { kind: 'short', fraction, half };
  return { kind: 'full', fraction: 1, half };
}

// appStore owns TRANSLATIONS and is not editable from here, so these three per-day notes are
// English-only until keys exist for them. All three also appear in the hover tooltip.
// NOT "Overtime", anywhere a person can read it. The company pays nothing for hours past the
// expectation, and calling them overtime states a payroll entitlement that does not exist.
// "Extra hours" is the wording used for this everywhere in the calendar — the per-day note, the
// legend tick and the month summary tile — and the figure is unchanged; only the word went.
export const EXTRA_HOURS_NOTE = 'Extra hours';
export const SHORT_DAY_NOTE = 'Short day';
export const NO_HOURS_NOTE = 'No hours recorded';
// Stated as a fact, not a judgement: working a rest day is not an error, and on a tenant with
// holidayPayMultipliers off it carries no pay implication either. It is simply worth seeing.
export const REST_DAY_WORKED_NOTE = 'Worked on a rest day';

/**
 * The hours half of a day's description, in one place, so the hover tooltip and the cell's
 * screen-reader note cannot drift apart from each other or from what the gauge draws.
 */
export function markNotes(
  mark: DayMark,
  hours: number,
  worked: boolean,
  labels: { halfDay: string; workedDay: string; loggedHours: string },
): string[] {
  const notes: string[] = [];
  if (mark.half) notes.push(labels.halfDay);
  if (worked) notes.push(labels.workedDay);
  if (hours > 0) notes.push(`${labels.loggedHours}: ${formatHours(hours)}`);
  if (mark.kind === 'rest') notes.push(REST_DAY_WORKED_NOTE);
  else if (mark.kind === 'over') notes.push(EXTRA_HOURS_NOTE);
  else if (mark.kind === 'short') notes.push(SHORT_DAY_NOTE);
  else if (mark.kind === 'empty') notes.push(NO_HOURS_NOTE);
  return notes;
}

// ─── Dates ────────────────────────────────────────────────────────────────────

/**
 * Calendar-grid key. Deliberately not localDateString(), which re-projects into Asia/Colombo
 * and can shift a grid day by one for a browser in another zone.
 */
export function dayKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Same calendar day, on the browser's own clock — the grid's notion of a day (see dayKey). */
export function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Same calendar month, on the browser's own clock. */
export function isSameMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

// ─── Numbers ──────────────────────────────────────────────────────────────────

/** Trailing ".0" trimmed, so a clean eight-hour day reads "8" and not "8.0". */
export function formatHours(h: number): string { return String(Number(h.toFixed(1))); }

/**
 * The hours figure printed under a date, or null when there is nothing to print.
 *
 * Returns null — never "0" — for a day with no hours recorded: zero is a claim (somebody was
 * here and did nothing), and "unknown" is what the calendar actually knows. Same formatHours()
 * the tooltip and the screen-reader note run the number through, so the printed figure and the
 * spoken one cannot come out different. The unit is one character on purpose: at 10px in a
 * ~42px column, "hrs" would take half the width the figure needs, and a bare "7.5" under a
 * date reads like a second date.
 */
export function hoursCaption(hours: number): string | null {
  return hours > 0 ? `${formatHours(hours)}h` : null;
}

// ─── Month fold ───────────────────────────────────────────────────────────────

export interface MonthStats {
  totalHours: number;
  daysWorked: number;
  /** Hours past what those days were expected to produce. Never called "overtime" — see above. */
  extraHours: number;
  shortDays: number;
  holidays: number;
  leave: number;
  missingCheckouts: number;
}

/**
 * Reading your own month is mostly four questions ("did I do the hours, how many days, how much
 * did I put in past that, did anything go wrong?") and none of them can be answered by counting
 * ~20 identical circles by eye. This is a pure fold over state the calendar already holds — no
 * network call.
 *
 * The per-month fetch replaces workedDays/workedHours/leaveDays/missingCheckoutDays wholesale,
 * but holidays accumulate across every year navigated to, so EVERY list is filtered to `month`
 * here rather than trusted to be scoped. Only sums and counts — no averages — so an empty month
 * yields zeros, never NaN.
 *
 * `extraHours` and `shortDays` are the two figures that depend on the hardcoded work pattern
 * at the top of this file; they move with `expectedHours()` and nothing else.
 */
export function summariseMonth(input: {
  month: Date;
  workedDays: Date[];
  workedHours: Record<string, number>;
  leaveDays: Date[];
  holidayDays: Date[];
  companyHolidayDays: Date[];
  missingCheckoutDays: Date[];
}, expectation: WorkExpectation = DEFAULT_EXPECTATION): MonthStats {
  const yr = input.month.getFullYear();
  const mo = input.month.getMonth();
  const inMonth = (d: Date) => d.getFullYear() === yr && d.getMonth() === mo;

  // Deduped by date key: a duplicated entry in workedDays must not count as two days.
  const worked = new Map<string, Date>();
  input.workedDays.forEach(d => { if (inMonth(d)) worked.set(dayKey(d), d); });

  let totalHours = 0;
  let extraHours = 0;
  let shortDays = 0;
  worked.forEach((date, key) => {
    const raw = Number(input.workedHours[key]);
    const h = Number.isFinite(raw) && raw > 0 ? raw : 0;
    totalHours += h;
    const mark = dayMark(h, date, true, expectation);
    // A rest day's hours are ALL beyond expectation (the expectation is zero), so they count
    // as extra in full. Kept separate from 'over' so the two can diverge later without this
    // fold quietly changing meaning.
    if (mark.kind === 'rest') extraHours += h;
    else if (mark.kind === 'over') extraHours += h - expectedHours(date, expectation);
    else if (mark.kind === 'short') shortDays += 1;
  });

  // A date can be both a public holiday and on the company's accepted list — count it once.
  const holidays = new Set<string>();
  input.holidayDays.forEach(d => { if (inMonth(d)) holidays.add(dayKey(d)); });
  input.companyHolidayDays.forEach(d => { if (inMonth(d)) holidays.add(dayKey(d)); });
  const leave = new Set<string>();
  input.leaveDays.forEach(d => { if (inMonth(d)) leave.add(dayKey(d)); });
  const missing = new Set<string>();
  input.missingCheckoutDays.forEach(d => { if (inMonth(d)) missing.add(dayKey(d)); });

  return {
    totalHours,
    daysWorked: worked.size,
    extraHours,
    shortDays,
    holidays: holidays.size,
    leave: leave.size,
    missingCheckouts: missing.size,
  };
}
