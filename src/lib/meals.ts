// Meal slots — which of breakfast / lunch / dinner is bookable right now, and until when.
//
// Pure, dependency-free and side-effect-free so the slot rules can be unit tested without a
// clock or a Firestore stub (see src/lib/__tests__/meals.test.ts). Every function that needs
// "now" takes it as an argument; only `currentMealSlot()` reads the real clock.

export const MEAL_TYPES = ['breakfast', 'lunch', 'dinner'] as const;
export type MealType = (typeof MEAL_TYPES)[number];

/** Display order + labels. Kept here (not in a component) so report columns, the booking UI and
 *  the responsible person's list all order meals identically. */
export const MEAL_ORDER: Record<MealType, number> = { breakfast: 0, lunch: 1, dinner: 2 };

export const DAY_MINUTES = 24 * 60;

/**
 * A chamary's ordering windows, as minutes since midnight on the app clock. Two boundaries, not
 * three ranges, on purpose: the day is a partition, so
 *
 *   breakfast  00:00        → lunch_from
 *   lunch      lunch_from   → dinner_from
 *   dinner     dinner_from  → 24:00
 *
 * — exactly one meal is orderable at any moment, and there is no way for an admin to leave a
 * gap nobody can order in, or an overlap where two meals are open at once.
 *
 * Set per chamary in Working Places (Chamary.slots), because a site that serves dinner at 6pm
 * and one that stops taking lunch names at 10am are both real. Absent means the defaults below.
 */
export interface MealSlots {
  /** Breakfast closes / lunch opens. */
  lunch_from:  number;
  /** Lunch closes / dinner opens. */
  dinner_from: number;
}

/** What a chamary with no `slots` of its own uses — and what a new one starts at.
 *  Lunch names are taken until noon, which is what the kitchens actually work to. */
export const DEFAULT_MEAL_SLOTS: MealSlots = { lunch_from: 8 * 60, dinner_from: 12 * 60 };

const clampMinute = (n: unknown, fallback: number): number =>
  typeof n === 'number' && Number.isFinite(n)
    ? Math.min(DAY_MINUTES, Math.max(0, Math.round(n)))
    : fallback;

/** Normalise whatever is stored on a chamary into usable boundaries. Read `Chamary.slots`
 *  through this, never raw: a document written before slots existed has none, and a dinner that
 *  starts before lunch would otherwise give lunch a negative window and swallow it whole. */
export function mealSlots(raw?: Partial<MealSlots> | null): MealSlots {
  const lunch_from  = clampMinute(raw?.lunch_from,  DEFAULT_MEAL_SLOTS.lunch_from);
  const dinner_from = clampMinute(raw?.dinner_from, DEFAULT_MEAL_SLOTS.dinner_from);
  return { lunch_from, dinner_from: Math.max(lunch_from, dinner_from) };
}

/**
 * The app's clock. Deliberately the same zone `localDateString()` files records under
 * (src/lib/utils.ts) — for every real user this IS their device's local time, and pinning both
 * to one zone stops a device with a mis-set timezone from booking, say, tomorrow's breakfast
 * against today's date.
 */
const APP_TZ = 'Asia/Colombo';

/** Minutes since midnight on the app clock. Exported for tests; prefer `currentMealSlot()`. */
export function appMinutes(now: Date = new Date()): number {
  const hhmm = new Intl.DateTimeFormat('en-GB', {
    timeZone: APP_TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(now);
  const [h, m] = hhmm.split(':').map(Number);
  // Some ICU builds render midnight as "24:00" under hour12:false — fold it back to 0 rather
  // than letting a whole hour of the night report as dinner-of-tomorrow.
  return (h % 24) * 60 + (m || 0);
}

/** Which meal the given minute-of-day falls in. Never null — every minute maps to one meal. */
export function mealSlotAtMinute(minute: number, slots?: Partial<MealSlots> | null): MealType {
  const s = mealSlots(slots);
  if (minute < s.lunch_from)  return 'breakfast';
  if (minute < s.dinner_from) return 'lunch';
  return 'dinner';
}

/** The meal bookable right now at a chamary with these slots. */
export function currentMealSlot(slots?: Partial<MealSlots> | null, now: Date = new Date()): MealType {
  return mealSlotAtMinute(appMinutes(now), slots);
}

/** The window `meal` can be ordered in, in minutes since midnight. `to` is exclusive. */
export function mealWindow(meal: MealType, slots?: Partial<MealSlots> | null): { from: number; to: number } {
  const s = mealSlots(slots);
  if (meal === 'breakfast') return { from: 0, to: s.lunch_from };
  if (meal === 'lunch')     return { from: s.lunch_from, to: s.dinner_from };
  return { from: s.dinner_from, to: DAY_MINUTES };
}

/** Is `meal` orderable at `minute`? A zero-length window (both boundaries on the same time) is
 *  never open — that is how an admin says "we don't take names for that meal by the clock". */
export function mealOpenAt(meal: MealType, minute: number, slots?: Partial<MealSlots> | null): boolean {
  const w = mealWindow(meal, slots);
  return minute >= w.from && minute < w.to;
}

/** "12:00 PM". Minute-of-day → what a person reads on a clock. */
export function formatMealTime(minute: number): string {
  const m   = ((Math.round(minute) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  const h24 = Math.floor(m / 60);
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m % 60).padStart(2, '0')} ${h24 < 12 ? 'AM' : 'PM'}`;
}

/** Minute-of-day ⇄ the "HH:MM" an `<input type="time">` speaks. */
export function minutesToTimeInput(minute: number): string {
  const m = Math.min(DAY_MINUTES - 1, Math.max(0, Math.round(minute)));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
export function timeInputToMinutes(value: string, fallback: number): number {
  const [h, m] = (value ?? '').split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return fallback;
  return Math.min(DAY_MINUTES, Math.max(0, h * 60 + m));
}

/** One meal's window as an admin reads it back: "8:00 AM – 12:00 PM". */
export function mealWindowLabel(meal: MealType, slots?: Partial<MealSlots> | null): string {
  const { from, to } = mealWindow(meal, slots);
  if (from >= to) return 'closed';
  if (meal === 'breakfast') return `until ${formatMealTime(to)}`;
  if (meal === 'dinner')    return `from ${formatMealTime(from)}`;
  return `${formatMealTime(from)} – ${formatMealTime(to)}`;
}

/** What a chamary serves. An absent/empty `meals` means lunch only — every chamary that existed
 *  before meal types were added served exactly lunch, so this keeps them working untouched. */
export function chamaryMeals(meals: MealType[] | undefined | null): MealType[] {
  const list = (meals ?? []).filter((m): m is MealType => (MEAL_TYPES as readonly string[]).includes(m));
  return list.length ? [...list].sort((a, b) => MEAL_ORDER[a] - MEAL_ORDER[b]) : ['lunch'];
}

/** A record written before meal types existed has no `meal` field and is a lunch booking. */
export function mealOf(meal: MealType | undefined | null): MealType {
  return meal && (MEAL_TYPES as readonly string[]).includes(meal) ? meal : 'lunch';
}

export const MEAL_LABEL: Record<MealType, string> = {
  breakfast: 'Breakfast',
  lunch:     'Lunch',
  dinner:    'Dinner',
};
