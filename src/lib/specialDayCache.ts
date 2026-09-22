// Device-side cache for AI-generated special day greeting messages.
//
// When an admin saves a special day (new or edited), the app generates AI message variants
// for EN/SI/TA and stores them here. On delivery the renderer picks a variant locally
// without a server call, keeping the greeting fast even when offline and reducing cron load.
//
// Cache key: `sdmsg:{tenantDbId}:{dayId}:{version}` — the version portion changes whenever
// the day is edited, which automatically invalidates old entries without an explicit purge.
//
// This is best-effort: if localStorage is full/unavailable or generation fails, the caller
// falls back to the pool copy or the hand-written message.

import { draftSpecialDayGreeting } from '@/services/greetingMessagesService';
import type { SpecialDay } from '@/lib/greetings';

export interface CachedDayMessages {
  day_id: string;
  day_version: string;           // fingerprint — invalidates stale entries after an edit
  variants_en: string[];
  variants_si: string[];
  variants_ta: string[];
  generated_at: string;          // ISO timestamp for diagnostics
}

// Fingerprint from the day's content — changes whenever the day is edited.
function versionOf(day: SpecialDay): string {
  const key = [day.title, day.message ?? '', day.title_si ?? '', day.message_si ?? '',
    day.title_ta ?? '', day.message_ta ?? '', day.date ?? '', day.calendar_name ?? ''].join('|');
  let h = 5381;
  for (let i = 0; i < key.length; i++) {
    h = ((h << 5) + h) + key.charCodeAt(i);
    h |= 0;
  }
  return (h >>> 0).toString(36);
}

function storageKey(tenantDbId: string, dayId: string, version: string): string {
  return `sdmsg:${tenantDbId}:${dayId}:${version}`;
}

/** Remove all cached entries for a day (any version). Called before writing a new version. */
export function invalidateSpecialDayCache(tenantDbId: string, dayId: string): void {
  try {
    const prefix = `sdmsg:${tenantDbId}:${dayId}:`;
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) toRemove.push(k);
    }
    toRemove.forEach(k => localStorage.removeItem(k));
  } catch {
    // localStorage unavailable (SSR, privacy mode) — silent
  }
}

/** Read cached messages for a day. Returns null on cache miss or version mismatch. */
export function getSpecialDayCachedMessages(
  tenantDbId: string,
  dayId: string,
  day: SpecialDay,
): CachedDayMessages | null {
  try {
    const version = versionOf(day);
    const raw = localStorage.getItem(storageKey(tenantDbId, dayId, version));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedDayMessages;
    if (parsed.day_version !== version) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Pick a stable variant for a given recipient EPF.
 * The same EPF always picks the same variant, which feels intentional rather than random.
 */
export function pickVariant(variants: string[], epf: string): string {
  if (!variants.length) return '';
  if (variants.length === 1) return variants[0];
  let h = 0;
  for (let i = 0; i < epf.length; i++) {
    h = ((h << 5) + h) + epf.charCodeAt(i);
    h |= 0;
  }
  return variants[(h >>> 0) % variants.length];
}

/**
 * Generate AI variants for a special day and cache them in localStorage.
 *
 * Fire-and-forget after saving a special day. Errors are swallowed — the greeting
 * still goes out from the pool or the hand-written message if this fails.
 */
export async function cacheSpecialDayMessages(
  day: SpecialDay,
  tenantDbId: string,
): Promise<void> {
  if (typeof window === 'undefined') return;
  const title = (day.title ?? day.calendar_name ?? '').trim();
  if (!title) return;

  try {
    const res = await draftSpecialDayGreeting({
      special_title: title,
      draft_all: true,
    });

    const variants_en = res.drafts?.en ? [res.drafts.en] : [];
    const variants_si = res.drafts?.si ? [res.drafts.si] : [];
    const variants_ta = res.drafts?.ta ? [res.drafts.ta] : [];

    if (!variants_en.length) return;

    const version = versionOf(day);
    invalidateSpecialDayCache(tenantDbId, day.id);

    const payload: CachedDayMessages = {
      day_id: day.id,
      day_version: version,
      variants_en,
      variants_si,
      variants_ta,
      generated_at: new Date().toISOString(),
    };

    try {
      localStorage.setItem(storageKey(tenantDbId, day.id, version), JSON.stringify(payload));
    } catch {
      // QuotaExceededError — silently skip; pool copy is the fallback
    }
  } catch {
    // Network error, AI budget exceeded, etc. — no cache written
  }
}
