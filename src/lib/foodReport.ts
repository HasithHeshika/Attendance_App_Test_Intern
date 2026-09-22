// The monthly food deduction for one chamary — how its approved food spend turns into money off
// each person's salary.
//
// Pure, free of React and Firestore so the arithmetic behind a salary deduction can be unit
// tested without a Firestore stub (see src/lib/__tests__/foodReport.test.ts).

import { mealOf } from './meals';
import type { LunchRequest } from './types';

export interface FoodReportRow {
  epf_number:    string;
  employee_name: string;
  company_name:  string;
  breakfast:     number;
  lunch:         number;
  dinner:        number;
  total:         number;
  served:        number;
  noShows:       number;
  deduction:     number;
}

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Splits the chamary's approved food spend EQUALLY across every booking it took that month,
 * whatever meal each one was: one booking is one share, so a breakfast costs the same as a
 * dinner. Meal types are counted separately for the report's columns only — never weighted.
 *
 * A booking nobody turned up for still counts toward the split: the food was cooked for them.
 * `served` feeds the no-show column and nothing else.
 *
 * `bookings` must be EVERY booking the chamary took that month — filtering them (by company,
 * say) before this point inflates the per-meal cost for everyone left in.
 */
export function computeChamaryFoodReport(opts: {
  bookings:      LunchRequest[];
  approvedSpend: number;
}): { rows: FoodReportRow[]; totalMeals: number; perMealCost: number } {
  const { bookings, approvedSpend } = opts;

  const byEpf = new Map<string, FoodReportRow>();
  for (const b of bookings) {
    let row = byEpf.get(b.epf_number);
    if (!row) {
      row = {
        epf_number: b.epf_number, employee_name: b.employee_name, company_name: b.company_name,
        breakfast: 0, lunch: 0, dinner: 0, total: 0, served: 0, noShows: 0, deduction: 0,
      };
      byEpf.set(b.epf_number, row);
    }
    row[mealOf(b.meal)] += 1;
    row.total += 1;
    if (b.served === true) row.served += 1;
    else row.noShows += 1;
  }

  const totalMeals  = bookings.length;
  const perMealCost = totalMeals ? approvedSpend / totalMeals : 0;

  const rows = Array.from(byEpf.values())
    .map(r => ({ ...r, deduction: round2(perMealCost * r.total) }))
    .sort((a, b) => a.employee_name.localeCompare(b.employee_name));

  return { rows, totalMeals, perMealCost };
}

/** How many CLOSED months back to look for a settled rate. A chamary idle in September should
 *  still show August's rate; three months covers a seasonal shutdown without reaching back to a
 *  price nobody would recognise. */
export const INDICATIVE_LOOKBACK_MONTHS = 3;

export interface IndicativeRate {
  ratePerMeal: number | null;
  basisMonth:  string | null;
  basisMeals:  number;
}

/**
 * What a meal is likely to cost this month, taken from the last CLOSED month that actually had
 * meals — never from the running month.
 *
 * A running month's rate is not merely imprecise, it is inflated by construction: a chamary's bill
 * arrives in bulk on day 2 while the meals accrue daily, so `approvedSpend / totalMeals` reads
 * Rs 2000 on day 2 and settles near Rs 150 by month end. Showing that to staff would alarm them
 * over a number that is wrong.
 *
 * `closedMonths` must be NEWEST FIRST and must contain closed months only — the first one with at
 * least one booking wins. A month with no bookings means the site was shut or nobody ate, not that
 * meals were free, so it is skipped rather than counted as a zero. When none qualify the rate is
 * null: a brand-new chamary has no settled price yet and the provisional one must NOT stand in for
 * it. `month` is carried through untouched, so pass whatever label the caller wants to show.
 */
export function indicativeMealRate(
  closedMonths: Array<{ month: string; bookings: LunchRequest[]; approvedSpend: number }>,
): IndicativeRate {
  for (const m of closedMonths) {
    if (!m.bookings.length) continue;
    // Through computeChamaryFoodReport, not a fresh division, so the settled rate keeps the one
    // rule that matters here: every booking is one share, served or not.
    const { totalMeals, perMealCost } = computeChamaryFoodReport({
      bookings: m.bookings, approvedSpend: m.approvedSpend,
    });
    return { ratePerMeal: round2(perMealCost), basisMonth: m.month, basisMeals: totalMeals };
  }
  return { ratePerMeal: null, basisMonth: null, basisMeals: 0 };
}
