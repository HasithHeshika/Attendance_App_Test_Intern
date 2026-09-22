// Which meal bookings should be recorded as collected WITHOUT anyone ticking them.
//
// The kitchen cooks from the booking list. Everyone on that list normally eats, so making an
// operator tick sixty names to say "yes, the sixty people I cooked for ate" is work that will not
// get done — and it wasn't: production had 2 of 63 bookings ticked, which the food report reads
// as sixty-one no-shows. The default is inverted here. Once a meal is over, every booking nobody
// said anything about is recorded as served, and the operator's job shrinks to marking the
// exceptions.
//
// Pure and Firestore-free — the rules that decide who gets a served flag written against their
// name must be testable without a clock or a database (see src/lib/__tests__/mealAutoServe.test.ts).
// The write itself is markMealsAutoServed() in src/services/mealService.ts.

import { mealOf, mealWindow, type MealSlots, type MealType } from './meals';
import type { LunchRequest, ChamaryMealOffday } from './types';

/** One booking to flip. Enough to address the document, and nothing else. */
export interface AutoServeTarget {
  epf_number: string;
  date:       string;    // YYYY-MM-DD
  meal:       MealType;
  chamary_id: string;
}

/**
 * A ceiling on one run, so opening a long-dormant month cannot fire thousands of writes from a
 * browser. Whatever is left over is picked up by the next run — the whole operation is
 * idempotent, so being cut short is never wrong, only unfinished.
 */
export const AUTO_SERVE_MAX_PER_RUN = 1000;

export interface AutoServeInput {
  bookings:  LunchRequest[];
  /** Days the kitchen was closed. A booking left behind for a closed meal is never auto-served. */
  offdays:   ChamaryMealOffday[];
  /** Today on the app clock (YYYY-MM-DD) — see localDateString(). */
  today:     string;
  /** Minutes since midnight on the app clock — see appMinutes(). */
  nowMinute: number;
  /** That chamary's ordering windows, or null/undefined for the defaults. */
  slotsFor:  (chamaryId: string) => Partial<MealSlots> | null | undefined;
  /**
   * Only these chamaries may be settled. A kitchen whose closure list could not be read is left
   * out: an unread off-day is indistinguishable from no off-day, and guessing wrong serves a meal
   * that was never cooked. Omit to allow every chamary in `bookings`.
   */
  chamaries?: readonly string[];
  max?:      number;
}

/**
 * Is `meal` on `date` finished, so that a booking nobody touched can be taken as collected?
 *
 * A day still ahead: never. A day already gone: always. TODAY: only once that meal's ordering
 * window has closed — the point the kitchen stops taking names and starts cooking. Dinner's
 * window runs to midnight, so dinner is never auto-served on its own day; it is settled the
 * following morning, which is the conservative answer anyway.
 *
 * SETTLING TODAY HAS A CONSEQUENCE ELSEWHERE. An employee may only cancel their own booking while
 * it is today's and untouched (`canCancelOutright` on /food, `frozenReason` in MyLunchCount), so
 * a lunch that serves itself at noon can no longer be cancelled at 11pm. That is intended — the
 * kitchen has already cooked from that list and the booking is a share of the bill — but it is a
 * real change to what an employee can do, and it is what the `date < today` line below buys back
 * if it is ever decided the wrong way: return false for `date === today` and nothing is settled
 * before midnight.
 */
export function mealClosed(
  date: string, meal: MealType, today: string, nowMinute: number,
  slots?: Partial<MealSlots> | null,
): boolean {
  if (!date || !today) return false;
  if (date > today) return false;
  if (date < today) return true;
  return nowMinute >= mealWindow(meal, slots).to;
}

/** Stable identity of a booking — one record per person per meal per day. */
export const autoServeKey = (t: { epf_number: string; date: string; meal: MealType }): string =>
  `${t.epf_number}__${t.date}__${mealOf(t.meal)}`;

export interface AutoServePlan {
  /** Bookings to record as collected, capped at `max`. */
  targets: AutoServeTarget[];
  /** How many qualified but did not fit under the cap — 0 unless a very large month. */
  deferred: number;
  /** Bookings a person explicitly marked as not collected. Left alone, counted so the UI can
   *  say how many exceptions the operator has recorded. */
  noShows: number;
}

/**
 * The bookings that should be flipped to served, and nothing more.
 *
 * A booking is skipped when it is ALREADY served (re-running writes nothing — this is what makes
 * the operation idempotent), when a person marked it a no-show (an explicit decision outranks a
 * default, always), when the kitchen was closed for that meal, when the meal is not over yet, and
 * when its chamary is not in `chamaries` (a caller that could not read that kitchen's closures).
 */
export function planAutoServe(input: AutoServeInput): AutoServePlan {
  const max = input.max ?? AUTO_SERVE_MAX_PER_RUN;
  const allowed = input.chamaries ? new Set(input.chamaries) : null;

  const closed = new Set<string>();
  for (const o of input.offdays) {
    if (o?.chamary_id && o.date) closed.add(`${o.chamary_id}__${o.date}__${mealOf(o.meal)}`);
  }

  const targets: AutoServeTarget[] = [];
  const seen = new Set<string>();
  let deferred = 0;
  let noShows  = 0;

  for (const b of input.bookings) {
    if (!b || !b.epf_number || !b.date || !b.chamary_id) continue;
    const meal = mealOf(b.meal);
    const key  = autoServeKey({ epf_number: b.epf_number, date: b.date, meal });
    if (seen.has(key)) continue;          // the same booking returned by two chamary reads
    seen.add(key);

    if (b.no_show === true) { noShows += 1; continue; }
    // After the no-show tally on purpose: a kitchen we may not settle is still a kitchen whose
    // recorded exceptions are real, and the UI counts them.
    if (allowed && !allowed.has(b.chamary_id)) continue;
    if (b.served === true) continue;
    if (closed.has(`${b.chamary_id}__${b.date}__${meal}`)) continue;
    if (!mealClosed(b.date, meal, input.today, input.nowMinute, input.slotsFor(b.chamary_id))) continue;

    if (targets.length >= max) { deferred += 1; continue; }
    targets.push({ epf_number: b.epf_number, date: b.date, meal, chamary_id: b.chamary_id });
  }

  return { targets, deferred, noShows };
}
