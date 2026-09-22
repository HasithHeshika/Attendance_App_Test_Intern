/**
 * Which days someone works, and how many hours each is worth.
 *
 * Pure — no React, no Firestore, no Date.now(). Everything it needs is an argument, which is
 * what makes it testable and what lets the calendar, the monthly report and the payroll
 * summary all answer the question the same way instead of three slightly different ways.
 *
 * Implements Part A of
 * `docs/superpowers/specs/2026-09-01-working-patterns-and-holiday-work-design.md`.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────────────────
 * `src/components/attendance/workDayModel.ts` hardcodes one company's week. For anyone who
 * rests on a day other than Sunday, works six days, or works shifts, their gauge, their
 * "short day" flag and their whole month summary are wrong today.
 *
 * ── The Sunday discrepancy — read this before changing DEFAULT_DAYS ──────────────────────
 * workDayModel's header comment says "Mon–Fri = 8h, Sat = 4h, Sun = rest", but its code is
 * `date.getDay() === 6 ? SATURDAY_HOURS : FULL_DAY_HOURS` — which returns 8 for SUNDAY, not 0.
 * The comment and the shipped behaviour disagree, and the behaviour is what people's reports
 * were built on. DEFAULT_DAYS therefore reproduces the CODE (Sunday = 8), so introducing this
 * module changes nothing for a tenant with no patterns configured. Making Sunday a rest day by
 * default is a real behaviour change for anyone who has ever worked one, and belongs in its own
 * decision with its own migration — not smuggled in here as a "fix" to a comment.
 */

/** Sunday = 0 … Saturday = 6, matching `Date.prototype.getDay`. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type PatternScope = 'company' | 'location' | 'role';

/**
 * One configured week shape. Mirrors the `work_patterns` Firestore document, minus the
 * timestamps — this module must never import firebase, so the service layer owns those.
 */
export interface WorkPattern {
  id: string;
  name: string;
  company_id: string;
  scope: PatternScope;
  /**
   * '' for a company-scoped pattern, a working place NAME for a location, and for a role the
   * role NAME — `AppUser.role` is a display-name string and is the only foreign key to a role
   * anywhere in this codebase.
   */
  scope_id: string;
  /** Expected hours per weekday. `0` means a REST DAY; a half day is simply fewer hours. */
  days: Partial<Record<Weekday, number>>;
  /**
   * Shift workers have no fixed weekday shape — their expectation comes from the roster for
   * the specific date instead of `days`.
   */
  is_shift: boolean;
  /** YYYY-MM-DD. Required: patterns change and history must stay correct. */
  effective_from: string;
  is_active: boolean;
}

/** Who a pattern is being resolved for. Every field is optional — absent simply cannot match. */
export interface PatternSubject {
  company_id?: string | null;
  /**
   * The employee's working place NAME, for a location-scoped pattern.
   *
   * A name, not an id, because that is the only thing available where it is needed:
   * `WorkingScheduleRecord.working_place` stores the place name, and the calendar resolves a
   * person's place through that record. Same shape as `role` for the same reason.
   */
  working_place?: string | null;
  /** The employee's role NAME, for a role-scoped pattern. */
  role?: string | null;
}

/**
 * The built-in week, used when no pattern matches. Reproduces today's shipped behaviour
 * exactly — see the Sunday note in the module header before touching it.
 */
export const DEFAULT_DAYS: Record<Weekday, number> = { 0: 8, 1: 8, 2: 8, 3: 8, 4: 8, 5: 8, 6: 4 };

/** A full day, for deciding whether a day is "worth less than a full one". */
export const FULL_DAY_HOURS = 8;

/** Most specific wins. Index order is the precedence order. */
const SCOPE_PRECEDENCE: readonly PatternScope[] = ['role', 'location', 'company'];

/**
 * `YYYY-MM-DD` for a Date in LOCAL time.
 *
 * Deliberately not `toISOString().slice(0,10)`: that converts to UTC first, so for anywhere
 * east of Greenwich — Asia/Colombo included — an evening date silently becomes the next day and
 * an `effective_from` comparison flips a day early. The same trap `dayKey` avoids elsewhere.
 */
export function localDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Does this pattern target this person at all? */
function appliesTo(pattern: WorkPattern, subject: PatternSubject): boolean {
  // A pattern belongs to a company. An empty company_id on the pattern means "any", which is
  // what a single-company tenant will produce.
  if (pattern.company_id && subject.company_id && pattern.company_id !== subject.company_id) {
    return false;
  }
  if (pattern.scope === 'company') return true;
  if (pattern.scope === 'location') {
    const place = (subject.working_place ?? '').trim().toLowerCase();
    return !!place && (pattern.scope_id ?? '').trim().toLowerCase() === place;
  }
  // Role names are compared case-insensitively and trimmed: they are typed by admins in one
  // place and selected in another, and "Technician " losing its pattern to a stray space is
  // not a distinction anyone intended to make.
  const a = (pattern.scope_id ?? '').trim().toLowerCase();
  const b = (subject.role ?? '').trim().toLowerCase();
  return !!a && a === b;
}

/**
 * The pattern that governs this person on this date, or null when none does.
 *
 * Resolution is role → location → company, and within a scope the newest `effective_from`
 * that is on or before the date wins. A pattern dated in the future is ignored, which is what
 * lets an admin schedule a change without rewriting the month they are standing in.
 *
 * Exported because the admin editor needs to show which pattern a person would actually get
 * before anything is saved — a company-scoped pattern has a wide blast radius.
 */
export function resolvePattern(
  date: Date,
  patterns: readonly WorkPattern[],
  subject: PatternSubject = {},
): WorkPattern | null {
  const key = localDateKey(date);
  for (const scope of SCOPE_PRECEDENCE) {
    let best: WorkPattern | null = null;
    for (const p of patterns) {
      if (!p.is_active) continue;
      if (p.scope !== scope) continue;
      if (!p.effective_from || p.effective_from > key) continue;   // not in force yet
      if (!appliesTo(p, subject)) continue;
      // Ties on effective_from are broken by id so the answer is stable rather than dependent
      // on Firestore's iteration order — an unstable answer here makes a report irreproducible.
      if (!best
        || p.effective_from > best.effective_from
        || (p.effective_from === best.effective_from && p.id > best.id)) {
        best = p;
      }
    }
    if (best) return best;
  }
  return null;
}

/**
 * Hours this date is expected to produce for this person.
 *
 * `shiftHoursForDate` comes from `schedule_assignments` and is consulted only for a pattern
 * marked `is_shift`. A shift worker with NO assignment for the date returns 0 — no expectation
 * rather than a short day, because filling the calendar with false exceptions for every
 * unrostered day is worse than saying nothing.
 */
export function expectedHoursFor(
  date: Date,
  patterns: readonly WorkPattern[],
  subject: PatternSubject = {},
  shiftHoursForDate?: number | null,
): number {
  const pattern = resolvePattern(date, patterns, subject);
  if (!pattern) return DEFAULT_DAYS[date.getDay() as Weekday];
  if (pattern.is_shift) {
    return typeof shiftHoursForDate === 'number' ? Math.max(0, shiftHoursForDate) : 0;
  }
  const hours = pattern.days[date.getDay() as Weekday];
  // A weekday the pattern simply does not mention is a rest day. Requiring all seven to be
  // spelled out would make a five-day week tedious to configure and easy to get wrong.
  return typeof hours === 'number' && hours > 0 ? hours : 0;
}

/**
 * Is this a rest day — a day the pattern expects no work at all?
 *
 * Distinct from "worked nothing". The calendar needs its own mark for it, currently keyed to
 * Sunday by a hardcoded modifier.
 */
export function isRestDay(
  date: Date,
  patterns: readonly WorkPattern[],
  subject: PatternSubject = {},
  shiftHoursForDate?: number | null,
): boolean {
  return expectedHoursFor(date, patterns, subject, shiftHoursForDate) === 0;
}

/**
 * Is this day worth LESS than a full day — the half-circle gauge.
 *
 * Keyed on the expectation, not on `getDay() === 6`, so a Wednesday half-day draws the same
 * half circle a Saturday does. That is the whole point of the change.
 */
export function isPartialDay(
  date: Date,
  patterns: readonly WorkPattern[],
  subject: PatternSubject = {},
  shiftHoursForDate?: number | null,
): boolean {
  const hours = expectedHoursFor(date, patterns, subject, shiftHoursForDate);
  return hours > 0 && hours < FULL_DAY_HOURS;
}

/**
 * One employee's resolved week, as an object the calendar can hold.
 *
 * The calendar asks about a date hundreds of times per render and has no business knowing about
 * scopes, effective dates or rosters. Binding the patterns and the subject once and handing
 * over three questions keeps `workDayModel` exactly as ignorant of all that as it is today —
 * which is what lets the wiring change nothing until a pattern actually exists.
 */
export interface WorkExpectation {
  hoursFor(date: Date): number;
  isRest(date: Date): boolean;
  isPartial(date: Date): boolean;
}

/**
 * Bind patterns to a person. Called with no arguments it IS the built-in default, so
 * `patternExpectation()` reproduces the hardcoded week the calendar ships with today.
 *
 * `shiftHoursFor` is a lookup rather than a value because a shift worker's expectation differs
 * per date; pass the roster's hours for that date, or null where nothing is assigned.
 */
export function patternExpectation(
  patterns: readonly WorkPattern[] = [],
  subject: PatternSubject = {},
  shiftHoursFor?: (date: Date) => number | null,
): WorkExpectation {
  const hoursFor = (date: Date) =>
    expectedHoursFor(date, patterns, subject, shiftHoursFor ? shiftHoursFor(date) : undefined);
  return {
    hoursFor,
    isRest: (date: Date) => hoursFor(date) === 0,
    isPartial: (date: Date) => {
      const h = hoursFor(date);
      return h > 0 && h < FULL_DAY_HOURS;
    },
  };
}
