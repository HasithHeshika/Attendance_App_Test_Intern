// Small formatting helpers shared by the /chamary page and its pieces. Kept out of the
// components so the calendar cell, the KPI hint and the day panel header all spell a per-meal
// breakdown the same way ("B 3 · L 12"), and so a date prints identically wherever it appears.

import { MEAL_LABEL, MEAL_ORDER, chamaryMeals, type MealType } from '@/lib/meals';
// The closure grouping and the day-phase rule are pure and unit-tested in src/lib; they are
// re-exported here so every chamary component keeps importing them from one place.
export {
  dayPhase, prettyDateRange, closureRuns,
  type DayPhase, type ClosureMarker, type ClosureRun,
} from '@/lib/chamaryClosures';
import type { MealCounts } from '@/lib/chamaryMonth';
import type { ChamaryWithPlace } from '@/services/workingPlaceService';

/** "B" / "L" / "D" — the initials the calendar has room for. Always the English label's first
 *  letter so a cell reads the same in every language; the full, translated name sits in the
 *  legend, the pills and the table headers. */
export const mealInitial = (m: MealType) => MEAL_LABEL[m].charAt(0);

/** "B 3 · L 12" for the meals that actually have a count; '' when nothing was booked. */
export function breakdownText(byMeal: MealCounts, served: MealType[]): string {
  return served.filter(m => byMeal[m] > 0).map(m => `${mealInitial(m)} ${byMeal[m]}`).join(' · ');
}

/** The meals at least one chamary in scope serves, in display order — the columns and pills the
 *  page shows. A lunch-only canteen must never grow breakfast and dinner columns. */
export function servedMeals(chamaries: ChamaryWithPlace[]): MealType[] {
  const set = new Set<MealType>();
  for (const c of chamaries) for (const m of chamaryMeals(c.meals)) set.add(m);
  return [...set].sort((a, b) => MEAL_ORDER[a] - MEAL_ORDER[b]);
}

function toDate(date: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** "Tuesday, 3 September" — the day panel header and the calendar cell's accessible name. */
export function prettyDate(date: string): string {
  return toDate(date).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

/** "Tue 3 Sep" — where a full weekday would not fit (a KPI label, the busiest-day line). */
export function prettyDateShort(date: string): string {
  return toDate(date).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

