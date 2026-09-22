// Formatting and lookup helpers shared by the /food page and its pieces.
//
// Kept out of the components so a meal's colour, a booking's identity and a date step are
// spelled the same way in the calendar cell, the day panel and the change dialog. The month
// MODEL is not here on purpose: /food folds a person's own bookings through
// `buildChamaryMonth` (src/lib/chamaryMonth.ts), the same pure, unit-tested reducer the
// chamary page uses, so "meals", "collected" and "no-shows" mean exactly one thing app-wide.

import { MEAL_ORDER, mealOf, type MealType } from '@/lib/meals';
import type { LunchRequest } from '@/lib/types';

/** How one meal type is tinted. Hue carries the MEAL, never the state — `--success`,
 *  `--primary` and `--brand` are all the same azure in this app, so collected / missed /
 *  booked are told apart by fill, border style and weight instead (see MealChip). */
export interface MealAccent {
  /** Readable in both themes on a card or on `fill`. */
  text: string;
  /** Faint wash behind a collected chip. */
  fill: string;
  /** Outline for a chip that is booked but not collected. */
  ring: string;
  /** Solid dot, for legends and list rows. */
  dot: string;
}

export const MEAL_ACCENT: Record<MealType, MealAccent> = {
  breakfast: {
    text: 'text-amber-700 dark:text-amber-300',
    fill: 'bg-amber-500/20',
    ring: 'border-amber-500/50',
    dot:  'bg-amber-500',
  },
  lunch: {
    text: 'text-orange-700 dark:text-orange-300',
    fill: 'bg-orange-500/20',
    ring: 'border-orange-500/50',
    dot:  'bg-orange-500',
  },
  dinner: {
    text: 'text-indigo-700 dark:text-indigo-300',
    fill: 'bg-indigo-500/20',
    ring: 'border-indigo-500/50',
    dot:  'bg-indigo-500',
  },
};

/** Where a booking sits relative to the meal being collected. `booked` is a day still ahead —
 *  nothing has gone wrong, it simply has not happened yet — while `missed` is a past booking
 *  nobody ticked. They must not look alike; the person is charged for both. */
export type BookingState = 'collected' | 'missed' | 'booked';

export function bookingState(row: LunchRequest, today: string): BookingState {
  if (row.served === true) return 'collected';
  return row.date < today ? 'missed' : 'booked';
}

/** Bookings for one day in the order they are eaten, then by chamary so two lunches at two
 *  canteens keep a stable position between renders. */
export function sortMeals(rows: LunchRequest[]): LunchRequest[] {
  return [...rows].sort((a, b) =>
    (MEAL_ORDER[mealOf(a.meal)] - MEAL_ORDER[mealOf(b.meal)]) ||
    a.chamary_name.localeCompare(b.chamary_name));
}

/** One booking's identity for React keys and "which row is busy" — through `mealOf`, because a
 *  record written before meal types existed has no `meal` field and would otherwise key on the
 *  string "undefined" and collide with every other legacy row that day. */
export const bookingKey = (row: LunchRequest) =>
  `${row.date}__${mealOf(row.meal)}__${row.chamary_id}`;

/** Group a month's bookings by day. */
export function groupByDate(rows: LunchRequest[]): Record<string, LunchRequest[]> {
  const map: Record<string, LunchRequest[]> = {};
  for (const r of rows) (map[r.date] ??= []).push(r);
  return map;
}

/** The meals this person actually books, in display order — so a lunch-only eater never sees
 *  breakfast and dinner columns they have no use for. */
export function mealsPresent(rows: LunchRequest[]): MealType[] {
  const set = new Set<MealType>();
  for (const r of rows) set.add(mealOf(r.meal));
  return [...set].sort((a, b) => MEAL_ORDER[a] - MEAL_ORDER[b]);
}

/** 'YYYY-MM-DD' moved by whole days, on the local calendar (so it steps over month ends and
 *  DST without going through UTC). */
export function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

/** 'YYYY-MM' for a date string. */
export const monthKeyOf = (date: string) => date.slice(0, 7);
