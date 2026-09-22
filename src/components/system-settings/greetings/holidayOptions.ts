import { canonName, type HolidayCalendar } from '@/lib/greetings';
import type { CustomHoliday, HolidayType, PublicHoliday } from '@/services/holidayService';

// One year's holiday calendar as a pickable list. The greeting engine only ever stores a
// holiday's NAME (SpecialDay.calendar_name) and looks the date up again each year, so this file
// exists purely for the picker: a name alone is unrecognisable, and "Vesak" means nothing to
// someone choosing between two Poya days in the same month.
export interface HolidayOption {
  /** The name as the calendar spells it. Stored verbatim as `calendar_name`. */
  name: string;
  /** 'YYYY-MM-DD' this year. */
  date: string;
  category: HolidayType;
}

/**
 * The year's holidays, merged the way `resolveSpecialDayDate` resolves them.
 *
 * Two sources, and they disagree: the public feed (Calendarific, every national holiday) and
 * the org's own saved settings (the curated list plus hand-added entries). The org's entries are
 * applied LAST so they win a name collision — the same precedence the settings screen has always
 * used when it built its name→date map, kept here so the list you pick from and the map the
 * engine resolves against can never drift apart.
 *
 * Category, most trustworthy first:
 *   1. `types[date]` — what the org itself classified the date as on the Reports holiday manager.
 *   2. `custom[].type` — the classification saved alongside a hand-added entry.
 *   3. the feed's `is_poya` flag (a name/full-moon heuristic) → 'poya'.
 *   4. 'public' — what holidayService itself treats an unclassified accepted date as.
 * Mercantile is never in the feed, so it can only ever reach step 1 or 2, which is why an org
 * that has not opened the holiday manager sees no Mercantile chip at all.
 */
export function buildHolidayOptions(
  feed: PublicHoliday[],
  own: { custom: CustomHoliday[]; types: Record<string, HolidayType> },
): HolidayOption[] {
  const byName = new Map<string, HolidayOption>();
  const add = (name: string, date: string, category: HolidayType) => {
    const key = canonName(name);
    if (!key || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    byName.set(key, { name: name.trim(), date, category });
  };
  for (const h of feed) add(h.name, h.date, own.types[h.date] ?? (h.is_poya ? 'poya' : 'public'));
  for (const c of own.custom) add(c.name, c.date, own.types[c.date] ?? c.type ?? 'public');
  return [...byName.values()].sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
}

/** The engine's name→date view of the same list, so the picker and the resolver agree. */
export function holidayCalendarOf(year: string, options: HolidayOption[]): HolidayCalendar {
  const byName: Record<string, string> = {};
  for (const o of options) byName[canonName(o.name)] = o.date;
  return { year, byName };
}

/**
 * 'YYYY-MM-DD' as "12 May 2026". Built from the parts, never Date.parse: '2026-05-12' parses as
 * UTC midnight and shows as 11 May anywhere west of Greenwich.
 */
export function formatLongDate(ymd: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return ymd;
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}

/** The same date without its year, for a day that repeats every year anyway. */
export function formatDayMonth(ymd: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return ymd;
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
}

/** Month names for the every-year picker, from the browser's locale rather than a 12-key block. */
export function monthNames(): string[] {
  return Array.from({ length: 12 }, (_, m) => new Date(2024, m, 1).toLocaleDateString(undefined, { month: 'long' }));
}

/** Days in a month of a LEAP year: Feb 29 is a legitimate choice (see monthDayMatches). */
export function daysInMonth(month: number): number {
  return new Date(2024, month, 0).getDate();
}
