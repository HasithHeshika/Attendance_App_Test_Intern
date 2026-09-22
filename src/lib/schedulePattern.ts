// Weekly recurring shift patterns (Southern Lanka) — pure date logic, no Firestore.
// A SchedulePattern is one employee's "work shift X on these weekdays, week after week".
// The engine MATERIALISES it into ordinary schedule_assignments docs on a rolling horizon
// (see schedulePatternService.materializePattern) — every existing read path keeps working
// unchanged because it still just reads schedule_assignments.
//
// Weekday numbering matches the rest of the app (AppUser special leaves, utils.ts):
//   0 = Sunday … 6 = Saturday  — i.e. Date.prototype.getDay().
// Stored as number[], NOT ['mon','tue',…] strings — consistent with `recurring_weekday`
// elsewhere, sorts naturally, and compares directly against getDay() with no lookup.

export interface WeekdayMeta {
  value: number;   // 0=Sun … 6=Sat
  key: string;     // 'mon' — for anywhere a string form is genuinely needed
  short: string;   // 'M' — the toggle-button glyph
  label: string;   // 'Monday'
}

// Monday-first display order (the "M T W T F S S" the picker renders); `value` still 0=Sun.
export const WEEKDAYS: WeekdayMeta[] = [
  { value: 1, key: 'mon', short: 'M', label: 'Monday' },
  { value: 2, key: 'tue', short: 'T', label: 'Tuesday' },
  { value: 3, key: 'wed', short: 'W', label: 'Wednesday' },
  { value: 4, key: 'thu', short: 'T', label: 'Thursday' },
  { value: 5, key: 'fri', short: 'F', label: 'Friday' },
  { value: 6, key: 'sat', short: 'S', label: 'Saturday' },
  { value: 0, key: 'sun', short: 'S', label: 'Sunday' },
];

export const MON_FRI = [1, 2, 3, 4, 5];

// getDay() for a 'yyyy-mm-dd' string, parsed as a LOCAL calendar date (not `new Date(str)`,
// which is UTC and can land on the wrong day). Same parse the rest of utils.ts uses.
export function weekdayOf(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}

// 'yyyy-mm-dd' plus N days (N may be negative), staying on the local calendar.
export function addDaysStr(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

export interface WeekdayPattern {
  weekdays: number[];            // subset of 0..6; [] means the pattern produces nothing
  effective_from: string;       // 'yyyy-mm-dd', inclusive
  effective_to: string | null;  // 'yyyy-mm-dd', inclusive, or null = open-ended
}

// Every 'yyyy-mm-dd' in [rangeStart, rangeEnd] (both inclusive) that
//   · falls inside the pattern's own effective window, AND
//   · lands on a selected weekday.
// The caller picks rangeEnd — for materialisation that's the rolling horizon
// (e.g. today + HORIZON_WEEKS). Clamps to the pattern window internally, so it's safe to
// pass any range. Returns [] for an empty weekday set or an inverted range.
export function expandPattern(p: WeekdayPattern, rangeStart: string, rangeEnd: string): string[] {
  const set = new Set(p.weekdays);
  if (set.size === 0) return [];
  const start = rangeStart > p.effective_from ? rangeStart : p.effective_from;
  const end = p.effective_to && p.effective_to < rangeEnd ? p.effective_to : rangeEnd;
  const out: string[] = [];
  for (let d = start; d <= end; d = addDaysStr(d, 1)) {
    if (set.has(weekdayOf(d))) out.push(d);
  }
  return out;
}

// The horizon a pattern is kept materialised to: today + this many weeks. The weekly
// extend job re-runs expandPattern against a fresh horizon each time.
export const HORIZON_WEEKS = 8;

export function horizonEnd(fromDateStr: string, weeks = HORIZON_WEEKS): string {
  return addDaysStr(fromDateStr, weeks * 7);
}

// ─── Materialisation diff ────────────────────────────────────────────────────
// The pure core of schedulePatternService.materializePattern — given what the pattern
// SHOULD cover and what schedule_assignments rows already exist for it, decide the minimal
// set of writes. Kept here (no Firestore) so every rule can be pinned in a unit test.

export interface MaterializeRow {
  date: string;           // 'yyyy-mm-dd'
  is_deleted?: boolean;   // a tombstone — a deliberately-removed occurrence of this series
}

export interface MaterializeDiff {
  toCreate: string[];     // dates that need a fresh assignment doc
  toTombstone: string[];  // dates whose existing LIVE row must be soft-deleted
}

// Rules:
//   · Only dates >= `today` are ever considered — past rows are immutable history.
//   · A wanted date with NO row at all      → create.
//   · A wanted date with a LIVE row         → leave it.
//   · A wanted date with only a TOMBSTONE   → skip (someone removed that occurrence by hand;
//                                             the engine must not resurrect it).
//   · A LIVE row on a date no longer wanted → tombstone (weekday dropped, series shortened,
//                                             or pattern deactivated so `wanted` is []).
// Rows for other patterns / manual assignments never reach here — the caller queries by
// pattern_id, and a manual doc simply has no pattern_id.
export function diffMaterialization(
  wanted: string[],
  existing: MaterializeRow[],
  today: string,
): MaterializeDiff {
  const liveByDate = new Set<string>();
  const anyByDate = new Set<string>();
  for (const r of existing) {
    if (r.date < today) continue;
    anyByDate.add(r.date);
    if (!r.is_deleted) liveByDate.add(r.date);
  }
  const wantedSet = new Set(wanted.filter((d) => d >= today));

  return {
    toCreate: [...wantedSet].filter((d) => !anyByDate.has(d)).sort(),
    toTombstone: [...liveByDate].filter((d) => !wantedSet.has(d)).sort(),
  };
}

// ─── Eligibility reconciliation ──────────────────────────────────────────────
// Whether a recurring pattern is no longer valid and must be deactivated + cleared forward.
// The rule, given the current state of its owner:
//   · owner gone (inactive / offboarded / deleted)          → EVERY pattern is void
//   · owner still an effective HOD or a designated exec      → nothing is void
//   · owner is neither                                       → void the day-off patterns and
//     the RESTRICTED-shift patterns; an ordinary shift pattern (regular shift, regular
//     employee) is kept — losing HOD status doesn't stop you working normal shifts.
// Pure so the service and the weekly cron share one definition; both feed it the three flags.
export function patternIsVoid(
  pattern: { is_day_off?: boolean },
  ownerGone: boolean,
  ownerRestrictedEligible: boolean,
  patternShiftIsRestricted: boolean,
): boolean {
  if (ownerGone) return true;
  if (ownerRestrictedEligible) return false;
  return !!pattern.is_day_off || patternShiftIsRestricted;
}

// Human label for a weekday set — "Mon–Fri", "Every day", "Sat & Sun", else a short list.
export function describeWeekdays(weekdays: number[]): string {
  const s = new Set(weekdays);
  if (s.size === 0) return 'No days selected';
  if (s.size === 7) return 'Every day';
  if (s.size === 5 && MON_FRI.every((d) => s.has(d))) return 'Mon–Fri';
  if (s.size === 2 && s.has(0) && s.has(6)) return 'Sat & Sun';
  return WEEKDAYS.filter((w) => s.has(w.value)).map((w) => w.label.slice(0, 3)).join(', ');
}
