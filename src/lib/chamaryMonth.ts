// A chamary's month at a glance — bookings per day and per meal, who ate how often, and the
// days the kitchen was closed. Pure and Firestore-free so the numbers the responsible person
// runs a kitchen by can be unit tested (see src/lib/__tests__/chamaryMonth.test.ts).

import { mealOf, MEAL_TYPES, MEAL_ORDER, type MealType } from './meals';
import type { LunchRequest, ChamaryMealOffday } from './types';

const pad2 = (n: number) => String(n).padStart(2, '0');

export const monthPrefix = (year: number, month: number) => `${year}-${pad2(month)}`;
export const daysInMonth = (year: number, month: number) => new Date(year, month, 0).getDate();
export const dayKey = (year: number, month: number, day: number) => `${monthPrefix(year, month)}-${pad2(day)}`;

export type MealCounts = Record<MealType, number>;
const zeroMeals = (): MealCounts => ({ breakfast: 0, lunch: 0, dinner: 0 });

export interface ChamaryDay {
  date:      string;
  day:       number;
  total:     number;
  byMeal:    MealCounts;
  served:    number;
  /** Meals marked "not cooking" that day, in display order. */
  off:       MealType[];
  offReason: Partial<Record<MealType, string>>;
  /** Distinct chamaries with a booking that day. */
  chamaries: number;
}

export interface ChamaryPersonRow {
  epf:          string;
  name:         string;
  company_name: string;
  byMeal:       MealCounts;
  total:        number;
  served:       number;
  /** Past bookings never ticked as collected. Today's and later ones are not no-shows yet. */
  noShows:      number;
  /** Distinct days this person ate on. */
  days:         number;
  chamaries:    string[];
}

export interface ChamaryMonthView {
  year:   number;
  month:  number;
  days:   ChamaryDay[];               // every calendar day of the month, in order
  byDate: Record<string, ChamaryDay>;
  people: ChamaryPersonRow[];         // most meals first, then name
  totals: {
    meals:      number;
    byMeal:     MealCounts;
    served:     number;
    noShows:    number;
    people:     number;
    offDays:    number;               // calendar days with at least one meal not cooked
    offMeals:   number;               // (day, meal) pairs not cooked
    activeDays: number;               // days with at least one booking
    busiest:    { date: string; total: number } | null;
  };
}

/**
 * `bookings` and `offdays` may reach beyond the month — only rows dated inside it are used.
 * `today` (YYYY-MM-DD) decides which unticked bookings already count as no-shows; leave it out
 * to treat every unticked booking as one (a closed month, say).
 */
export function buildChamaryMonth(opts: {
  bookings: LunchRequest[];
  offdays:  ChamaryMealOffday[];
  year:     number;
  month:    number;
  today?:   string;
}): ChamaryMonthView {
  const { year, month, today } = opts;
  const prefix = monthPrefix(year, month);
  const n = daysInMonth(year, month);

  const byDate: Record<string, ChamaryDay> = {};
  const days: ChamaryDay[] = [];
  const chamariesByDay = new Map<string, Set<string>>();
  for (let d = 1; d <= n; d++) {
    const date = dayKey(year, month, d);
    const row: ChamaryDay = { date, day: d, total: 0, byMeal: zeroMeals(), served: 0, off: [], offReason: {}, chamaries: 0 };
    byDate[date] = row;
    days.push(row);
    chamariesByDay.set(date, new Set());
  }

  const people = new Map<string, ChamaryPersonRow>();
  const personDays = new Map<string, Set<string>>();
  const seen = new Set<string>();
  const totals = { meals: 0, byMeal: zeroMeals(), served: 0, noShows: 0 };

  for (const b of opts.bookings) {
    if (!b || !b.date || !b.date.startsWith(prefix)) continue;
    const meal = mealOf(b.meal);
    const key  = `${b.epf_number}__${b.date}__${meal}`;
    if (seen.has(key)) continue;           // the same booking returned by two chamary reads
    seen.add(key);

    const day = byDate[b.date];
    if (!day) continue;
    const isPast = today ? b.date < today : true;
    const served = b.served === true;

    day.total += 1;
    day.byMeal[meal] += 1;
    if (served) day.served += 1;
    chamariesByDay.get(b.date)?.add(b.chamary_id);

    let p = people.get(b.epf_number);
    if (!p) {
      p = { epf: b.epf_number, name: b.employee_name || b.epf_number, company_name: b.company_name ?? '',
            byMeal: zeroMeals(), total: 0, served: 0, noShows: 0, days: 0, chamaries: [] };
      people.set(b.epf_number, p);
      personDays.set(b.epf_number, new Set());
    }
    p.total += 1;
    p.byMeal[meal] += 1;
    if (served) p.served += 1;
    else if (isPast) p.noShows += 1;
    if (b.chamary_name && !p.chamaries.includes(b.chamary_name)) p.chamaries.push(b.chamary_name);
    personDays.get(b.epf_number)!.add(b.date);

    totals.meals += 1;
    totals.byMeal[meal] += 1;
    if (served) totals.served += 1;
    else if (isPast) totals.noShows += 1;
  }

  const seenOff = new Set<string>();
  let offMeals = 0;
  for (const o of opts.offdays) {
    if (!o || !o.date || !o.date.startsWith(prefix)) continue;
    const meal = mealOf(o.meal);
    const key  = `${o.chamary_id}__${o.date}__${meal}`;
    if (seenOff.has(key)) continue;
    seenOff.add(key);
    const day = byDate[o.date];
    if (!day) continue;
    if (!day.off.includes(meal)) {
      day.off.push(meal);
      day.off.sort((a, b) => MEAL_ORDER[a] - MEAL_ORDER[b]);
    }
    if (o.reason && !day.offReason[meal]) day.offReason[meal] = o.reason;
    offMeals += 1;
  }

  for (const [date, set] of chamariesByDay) byDate[date].chamaries = set.size;
  for (const [epf, set] of personDays) people.get(epf)!.days = set.size;

  const rows = [...people.values()].sort((a, b) => (b.total - a.total) || a.name.localeCompare(b.name));
  let busiest: ChamaryMonthView['totals']['busiest'] = null;
  for (const d of days) if (d.total > 0 && (!busiest || d.total > busiest.total)) busiest = { date: d.date, total: d.total };

  return {
    year, month, days, byDate, people: rows,
    totals: {
      ...totals,
      people:     rows.length,
      offDays:    days.filter(d => d.off.length > 0).length,
      offMeals,
      activeDays: days.filter(d => d.total > 0).length,
      busiest,
    },
  };
}

/** Meals a chamary serves, but only the ones a day has anything to say about — for a compact
 *  per-day breakdown that skips meals nobody booked and the kitchen never closed. */
export function mealsWithActivity(day: ChamaryDay, served: MealType[] = [...MEAL_TYPES]): MealType[] {
  return served.filter(m => day.byMeal[m] > 0 || day.off.includes(m));
}
