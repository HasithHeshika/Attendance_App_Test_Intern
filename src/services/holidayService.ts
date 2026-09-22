import { doc, getDoc, setDoc, Timestamp } from 'firebase/firestore';
import { db } from '@/lib/firebase';

// ─── Company-accepted holidays ────────────────────────────────────────────────
// The public-holiday API (Calendarific, country=LK) returns EVERY national holiday,
// but a company only observes a curated subset. This service stores the org-wide
// accepted list — one document per year — used by the reports to exclude accepted
// holidays from ABSENT-day counts. Managed from the Reports page "Manage holidays"
// dialog. Org-wide (not per-company) by product decision.

const COL = 'holiday_settings';

// The three staffing buckets the roster/schedule feature classifies a holiday date into (see
// ShiftDayKey / ShiftStaffRequirement in lib/types.ts and buildScheduleDays on
// src/app/(pages)/roster/schedule/page.tsx, which use a date's type INSTEAD of its plain
// weekday once it's marked a holiday — a date isn't both). Poya is a monthly full-moon public
// holiday (auto-detected from the public-holiday feed, see PublicHoliday.is_poya below);
// Mercantile is never in that feed — it's a private-sector-only observance the org marks by
// hand, same as any other custom date.
export type HolidayType = 'poya' | 'public' | 'mercantile';

// A company-specific holiday the org added by hand (not in the public-holiday feed).
export interface CustomHoliday {
  date: string;   // yyyy-MM-dd
  name: string;
  type?: HolidayType; // defaults to 'public' when unset (entries saved before this existed)
}

export interface HolidaySettingsDoc {
  dates:       string[];         // ALL accepted holidays (public + custom) as 'yyyy-MM-dd' — the report reads this
  // Per-date Poya/Public/Mercantile classification for every entry in `dates` — the roster
  // schedule reads this. Optional/possibly-missing-per-date because it postdates `dates`;
  // treat any accepted date with no entry here as 'public'.
  types?:      Record<string, HolidayType>;
  custom?:     CustomHoliday[];  // custom-added holidays (kept for names + display in the manager)
  updated_at?: Timestamp;
  updated_by?: string;           // epf_number of the admin who last saved
}

// A public holiday as surfaced to the manager UI (mapped from the Calendarific shape).
export interface PublicHoliday {
  date:    string;   // yyyy-MM-dd
  name:    string;
  is_poya: boolean;  // full-moon Poya day (name/type heuristic)
}

/** Accepted holidays for a year → Set of 'yyyy-MM-dd'. Empty when none configured. */
export async function getAcceptedHolidays(year: number): Promise<Set<string>> {
  const list = await getAcceptedHolidayList(year);
  return new Set(list);
}

/** Accepted holidays for a year as a sorted array (for the manager UI). */
export async function getAcceptedHolidayList(year: number): Promise<string[]> {
  const { dates } = await getHolidaySettings(year);
  return dates;
}

/** Full saved settings for a year: the accepted dates + any custom (hand-added) holidays. */
export async function getHolidaySettings(
  year: number,
): Promise<{ dates: string[]; custom: CustomHoliday[]; types: Record<string, HolidayType> }> {
  try {
    const snap = await getDoc(doc(db, COL, String(year)));
    if (!snap.exists()) return { dates: [], custom: [], types: {} };
    const data = snap.data() as HolidaySettingsDoc;
    return {
      dates:  Array.isArray(data.dates) ? [...data.dates].sort() : [],
      custom: Array.isArray(data.custom)
        ? data.custom.filter(c => c && typeof c.date === 'string')
        : [],
      types: data.types && typeof data.types === 'object' ? data.types : {},
    };
  } catch {
    return { dates: [], custom: [], types: {} };
  }
}

/** Persist the org-wide accepted-holiday list (public + custom), and their Poya/Public/
 *  Mercantile classification, for a year. */
export async function setAcceptedHolidays(
  year: number,
  dates: string[],
  custom: CustomHoliday[],
  types: Record<string, HolidayType>,
  updatedBy: string,
): Promise<void> {
  const clean = Array.from(new Set(dates.filter(Boolean))).sort();
  // Keep only custom entries whose date is actually accepted, deduped by date.
  const seen = new Set<string>();
  const cleanCustom = custom.filter(c => {
    if (!c?.date || !clean.includes(c.date) || seen.has(c.date)) return false;
    seen.add(c.date);
    return true;
  });
  // Only keep type entries for dates actually accepted this save — no point carrying a
  // classification for a holiday that's since been un-accepted.
  const cleanTypes: Record<string, HolidayType> = {};
  for (const d of clean) if (types[d]) cleanTypes[d] = types[d];
  await setDoc(doc(db, COL, String(year)), {
    dates:      clean,
    custom:     cleanCustom,
    types:      cleanTypes,
    updated_at: Timestamp.now(),
    updated_by: updatedBy,
  } satisfies HolidaySettingsDoc);
}

// Every accepted holiday date across the year(s) a schedule range spans, mapped to its
// Poya/Public/Mercantile type — see buildScheduleDays on
// src/app/(pages)/roster/schedule/page.tsx, which uses this INSTEAD of a date's plain weekday
// once it's in this map. Dates missing an explicit type (saved before this existed) default to
// 'public'. Ranges that cross a year boundary (e.g. Dec 20 → Jan 10) fetch both years' docs.
export async function getHolidayTypesForRange(
  fromDate: string, toDate: string,
): Promise<Map<string, HolidayType>> {
  const fromYear = Number(fromDate.slice(0, 4));
  const toYear = Number(toDate.slice(0, 4));
  const map = new Map<string, HolidayType>();
  if (!Number.isFinite(fromYear) || !Number.isFinite(toYear) || toYear < fromYear) return map;
  const years: number[] = [];
  for (let y = fromYear; y <= toYear; y++) years.push(y);
  const settled = await Promise.all(years.map((y) => getHolidaySettings(y)));
  for (const { dates, types } of settled) {
    for (const d of dates) map.set(d, types[d] ?? 'public');
  }
  return map;
}

// Calendarific v2 nests the list under response.holidays (NOT `holidays`). Older callers
// read `data.holidays` and silently got an empty set — this helper reads the correct path.
interface CalendarificHoliday {
  name?: string;
  primary_type?: string;
  type?: string[];
  date?: { iso?: string; datetime?: { year: number; month: number; day: number } };
}

function isoFrom(h: CalendarificHoliday): string | null {
  const dt = h.date?.datetime;
  if (dt) return `${dt.year}-${String(dt.month).padStart(2, '0')}-${String(dt.day).padStart(2, '0')}`;
  const iso = h.date?.iso;
  return iso ? iso.slice(0, 10) : null;
}

/** Fetch the year's Sri-Lanka public holidays from our API route (deduped by date). */
export async function fetchPublicHolidays(year: number): Promise<PublicHoliday[]> {
  try {
    const res = await fetch(`/api/holidays?year=${year}`);
    if (!res.ok) return [];
    const data = await res.json();
    const raw: CalendarificHoliday[] = data.response?.holidays ?? data.holidays ?? [];
    const byDate = new Map<string, PublicHoliday>();
    raw
      .filter(h => h.primary_type === 'Public Holiday')
      .forEach(h => {
        const date = isoFrom(h);
        if (!date) return;
        const name = h.name ?? '';
        const is_poya = /poya|full moon/i.test(name);
        // First entry wins; keep a Poya flag if any variant marks it.
        const prev = byDate.get(date);
        if (prev) { if (is_poya) prev.is_poya = true; return; }
        byDate.set(date, { date, name, is_poya });
      });
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return [];
  }
}
