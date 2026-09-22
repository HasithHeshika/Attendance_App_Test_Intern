// A chamary's closed stretches, and which side of today a date falls on.
//
// Pure and dependency-light (only ./meals, itself pure) so the grouping a "Reopen" button acts
// on can be unit tested — see src/lib/__tests__/chamaryClosures.test.ts. Lives here rather than
// beside the component because the app's tested logic all sits in src/lib and reaches its
// neighbours by relative import; the component file re-exports these so call sites are unchanged.

import { MEAL_ORDER, mealOf, type MealType } from './meals';

/** 'YYYY-MM-DD' as a local Date — never `new Date(iso)`, which reads a bare date as UTC and
 *  can land on the day before. */
function toDate(date: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

/** Which side of `today` a date falls on. The three phases read differently everywhere: an
 *  unticked booking is a no-show only once the day is over — before that it is simply not
 *  collected yet, and on a future day there is nothing to collect at all. */
export type DayPhase = 'past' | 'today' | 'future';
export function dayPhase(date: string, today: string): DayPhase {
  if (date < today) return 'past';
  if (date > today) return 'future';
  return 'today';
}

/** "8–14 Sep", "28 Aug – 3 Sep", "8 Sep" — a closed stretch as a person would say it.
 *  Through Intl's own range formatter rather than gluing two dates together: it is the only
 *  thing that knows whether the month goes before or after the day in the reader's locale, and
 *  it collapses "Sep 8 – Sep 14" to "Sep 8 – 14" by itself. */
export function prettyDateRange(from: string, to: string): string {
  const fmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
  const a = toDate(from);
  const b = toDate(to);
  if (from === to) return fmt.format(a);
  return typeof fmt.formatRange === 'function'
    ? fmt.formatRange(a, b)
    : `${fmt.format(a)} – ${fmt.format(b)}`;
}

const nextDay = (date: string): string => {
  const d = toDate(date);
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** One off-day marker, narrowed to what a run needs — so this file stays free of Firestore
 *  types and can be tested with plain objects. */
export interface ClosureMarker {
  chamary_id:    string;
  chamary_name?: string;
  date:          string;
  meal?:         MealType | null;
  reason?:       string;
}

/** A stretch of consecutive days one chamary is closed for the same set of meals. */
export interface ClosureRun {
  chamaryId:   string;
  chamaryName: string;
  from:        string;
  to:          string;
  days:        number;
  meals:       MealType[];
  reason:      string;
}

/**
 * Group per-day off-day markers into the runs a person actually thinks in ("closed 8–14 Sep"),
 * dropping anything before `fromDate` — the page only offers to reopen days still ahead.
 *
 * A run breaks on a gap in the dates OR on a change in which meals are off, because "lunch and
 * dinner off Mon–Wed, dinner only on Thu" is two different closures and reopening them together
 * would silently reopen a lunch nobody closed. Pure — no clock, no Firestore.
 */
export function closureRuns(offdays: ClosureMarker[], fromDate: string): ClosureRun[] {
  // chamary → date → what is off that day
  const byChamary = new Map<string, { name: string; days: Map<string, { meals: Set<MealType>; reason: string }> }>();
  for (const o of offdays) {
    if (!o || !o.chamary_id || !o.date || o.date < fromDate) continue;
    let entry = byChamary.get(o.chamary_id);
    if (!entry) { entry = { name: o.chamary_name || '', days: new Map() }; byChamary.set(o.chamary_id, entry); }
    if (!entry.name && o.chamary_name) entry.name = o.chamary_name;
    let day = entry.days.get(o.date);
    if (!day) { day = { meals: new Set(), reason: '' }; entry.days.set(o.date, day); }
    day.meals.add(mealOf(o.meal));
    if (!day.reason && o.reason) day.reason = o.reason;
  }

  const runs: ClosureRun[] = [];
  for (const [chamaryId, entry] of byChamary) {
    const dates = [...entry.days.keys()].sort();
    let cur: ClosureRun | null = null;
    let curKey = '';
    for (const date of dates) {
      const day   = entry.days.get(date)!;
      const meals = [...day.meals].sort((a, b) => MEAL_ORDER[a] - MEAL_ORDER[b]);
      const key   = meals.join(',');
      if (cur && key === curKey && date === nextDay(cur.to)) {
        cur.to = date;
        cur.days += 1;
        if (!cur.reason && day.reason) cur.reason = day.reason;
        continue;
      }
      cur = { chamaryId, chamaryName: entry.name, from: date, to: date, days: 1, meals, reason: day.reason };
      curKey = key;
      runs.push(cur);
    }
  }
  return runs.sort((a, b) => a.from.localeCompare(b.from) || a.chamaryName.localeCompare(b.chamaryName));
}
