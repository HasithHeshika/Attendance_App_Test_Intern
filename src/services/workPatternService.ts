import {
  collection, doc, getDocs, addDoc, updateDoc, deleteDoc, query, orderBy, Timestamp,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import type { WorkPattern } from '@/lib/workPatterns';
import type { HolidayWorkPolicy } from '@/lib/holidayWorkPolicy';

/**
 * Reads and writes the two working-time collections.
 *
 * They live in one service because nothing ever needs one without the other: describing a day
 * takes both the week shape (is this a working day, and worth how many hours?) and the premium
 * policy (it was a rest day and they worked it — at what rate?). Splitting them would mean two
 * caches, two loading states and two chances to render a half-answered day.
 *
 * The pure resolvers are in `src/lib/workPatterns.ts` and `src/lib/holidayWorkPolicy.ts`; this
 * file only fetches and persists. No decision about what a day is worth is made here.
 *
 * Caching follows shiftDefinitionService: module scope, a TTL, in-flight coalescing, and an
 * explicit invalidate on every write. Patterns change a few times a year and are read on every
 * calendar render for 300+ people, so re-fetching per mount would be the wrong trade.
 */

const PATTERNS_COL = 'work_patterns';
const POLICIES_COL = 'holiday_work_policies';

const TTL_MS = 10 * 60 * 1000;

// ─── Work patterns ────────────────────────────────────────────────────────────

let _patternsCache: WorkPattern[] | null = null;
let _patternsCachedAt = 0;
let _patternsInflight: Promise<WorkPattern[]> | null = null;

export function invalidateWorkPatternsCache(): void {
  _patternsCache = null;
  _patternsCachedAt = 0;
  _patternsInflight = null;
}

/** Coerce a stored `days` map to numeric weekday keys, dropping anything unusable. */
function normaliseDays(raw: unknown): WorkPattern['days'] {
  const out: WorkPattern['days'] = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const day = Number(k);
    const hours = Number(v);
    if (!Number.isInteger(day) || day < 0 || day > 6) continue;
    if (!Number.isFinite(hours) || hours < 0) continue;
    out[day as keyof WorkPattern['days']] = hours;
  }
  return out;
}

/**
 * Every pattern, including inactive and future-dated ones.
 *
 * Deliberately unfiltered: `resolvePattern` needs the whole history to answer "what applied in
 * March", and a `where('is_active','==',true)` query would also silently drop any document
 * written before that field existed — the same trap `getShiftDefinitions` documents.
 */
export async function getWorkPatterns(force = false): Promise<WorkPattern[]> {
  if (!force && _patternsCache && Date.now() - _patternsCachedAt < TTL_MS) return _patternsCache;
  if (!force && _patternsInflight) return _patternsInflight;
  _patternsInflight = (async () => {
    const snap = await getDocs(query(collection(db, PATTERNS_COL), orderBy('effective_from')));
    const rows = snap.docs.map(d => {
      const raw = d.data() as Partial<WorkPattern>;
      return {
        id: d.id,
        name: String(raw.name ?? ''),
        company_id: String(raw.company_id ?? ''),
        scope: (raw.scope ?? 'company') as WorkPattern['scope'],
        scope_id: String(raw.scope_id ?? ''),
        // Firestore returns object keys as strings; the resolver indexes by numeric weekday.
        days: normaliseDays(raw.days),
        is_shift: raw.is_shift === true,
        effective_from: String(raw.effective_from ?? ''),
        // Absent means active: documents predating the flag must not vanish.
        is_active: raw.is_active !== false,
      } satisfies WorkPattern;
    });
    _patternsCache = rows;
    _patternsCachedAt = Date.now();
    return rows;
  })();
  try { return await _patternsInflight; } finally { _patternsInflight = null; }
}

export type WorkPatternDraft = Omit<WorkPattern, 'id'>;

export async function createWorkPattern(draft: WorkPatternDraft): Promise<string> {
  const ref = await addDoc(collection(db, PATTERNS_COL), {
    ...draft,
    created_at: Timestamp.now(),
    updated_at: Timestamp.now(),
  });
  invalidateWorkPatternsCache();
  return ref.id;
}

export async function updateWorkPattern(id: string, patch: Partial<WorkPatternDraft>): Promise<void> {
  await updateDoc(doc(db, PATTERNS_COL, id), { ...patch, updated_at: Timestamp.now() });
  invalidateWorkPatternsCache();
}

/**
 * Retire a pattern without destroying history.
 *
 * Preferred over deletion: a report for a closed month must still resolve the pattern that
 * applied then, and a deleted row would silently re-answer those months with whatever is left.
 */
export async function deactivateWorkPattern(id: string): Promise<void> {
  await updateWorkPattern(id, { is_active: false });
}

/** Hard delete. Only for a row created by mistake that has never governed a real day. */
export async function deleteWorkPattern(id: string): Promise<void> {
  await deleteDoc(doc(db, PATTERNS_COL, id));
  invalidateWorkPatternsCache();
}

// ─── Holiday / rest-day pay policies ──────────────────────────────────────────

let _policiesCache: HolidayWorkPolicy[] | null = null;
let _policiesCachedAt = 0;
let _policiesInflight: Promise<HolidayWorkPolicy[]> | null = null;

export function invalidateHolidayWorkPoliciesCache(): void {
  _policiesCache = null;
  _policiesCachedAt = 0;
  _policiesInflight = null;
}

export async function getHolidayWorkPolicies(force = false): Promise<HolidayWorkPolicy[]> {
  if (!force && _policiesCache && Date.now() - _policiesCachedAt < TTL_MS) return _policiesCache;
  if (!force && _policiesInflight) return _policiesInflight;
  _policiesInflight = (async () => {
    const snap = await getDocs(query(collection(db, POLICIES_COL), orderBy('effective_from')));
    const rows = snap.docs.map(d => {
      const raw = d.data() as Partial<HolidayWorkPolicy>;
      return {
        id: d.id,
        company_id: String(raw.company_id ?? ''),
        kind: (raw.kind ?? 'public') as HolidayWorkPolicy['kind'],
        // Left as-is even when nonsense: holidayWorkMultiplier refuses anything under 1 or
        // non-finite and falls through, which is a safer place for that judgement than here.
        multiplier: Number(raw.multiplier),
        effective_from: String(raw.effective_from ?? ''),
        is_active: raw.is_active !== false,
      } satisfies HolidayWorkPolicy;
    });
    _policiesCache = rows;
    _policiesCachedAt = Date.now();
    return rows;
  })();
  try { return await _policiesInflight; } finally { _policiesInflight = null; }
}

export type HolidayWorkPolicyDraft = Omit<HolidayWorkPolicy, 'id'>;

export async function createHolidayWorkPolicy(draft: HolidayWorkPolicyDraft): Promise<string> {
  const ref = await addDoc(collection(db, POLICIES_COL), {
    ...draft,
    created_at: Timestamp.now(),
    updated_at: Timestamp.now(),
  });
  invalidateHolidayWorkPoliciesCache();
  return ref.id;
}

export async function updateHolidayWorkPolicy(
  id: string,
  patch: Partial<HolidayWorkPolicyDraft>,
): Promise<void> {
  await updateDoc(doc(db, POLICIES_COL, id), { ...patch, updated_at: Timestamp.now() });
  invalidateHolidayWorkPoliciesCache();
}

export async function deleteHolidayWorkPolicy(id: string): Promise<void> {
  await deleteDoc(doc(db, POLICIES_COL, id));
  invalidateHolidayWorkPoliciesCache();
}
