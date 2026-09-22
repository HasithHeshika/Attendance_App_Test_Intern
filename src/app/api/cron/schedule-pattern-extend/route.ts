import { NextRequest, NextResponse } from 'next/server';
import { adminDbsForRequest } from '@/lib/firebaseAdmin';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import {
  expandPattern, diffMaterialization, horizonEnd, patternIsVoid, HORIZON_WEEKS,
} from '@/lib/schedulePattern';
import { shiftIsRestricted, isRecurringDayOffEligible } from '@/lib/shiftAccess';
import { secretEquals } from '@/lib/timingSafe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Weekly extend job for recurring shift patterns (Southern Lanka).
 *
 * Every active schedule_pattern is materialised into ordinary schedule_assignments docs only
 * ~HORIZON_WEEKS ahead (see src/services/schedulePatternService.ts). This job walks the
 * horizon forward: for every active pattern whose `materialized_through` has slipped behind
 * the fresh horizon it re-runs the exact same diff — create the newly-in-range dates,
 * tombstone anything no longer wanted — using the SAME pure helpers the client service uses
 * (@/lib/schedulePattern), just over the Admin SDK.
 *
 * It also RECONCILES eligibility on the same pass: any active pattern whose owner has been
 * deactivated/offboarded, or has lost HOD status without being a designated exec, is set
 * is_active:false and its future rows (shift or day-off) are tombstoned. See patternIsVoid.
 *
 * Triggered weekly by netlify/functions/schedule-pattern-extend.mjs (?tenant=all). The route
 * is southernlanka-scoped and fully idempotent — a missed or doubled run is harmless:
 *   · past dates are never touched (diffMaterialization drops date < today);
 *   · a hand-removed occurrence leaves a tombstone the diff respects;
 *   · rows without a pattern_id (manual assignments) are never in scope.
 *
 * Auth: shared secret in `Authorization: Bearer <CRON_SECRET>` (or `?key=`).
 */

const BATCH_LIMIT = 450; // headroom under Firestore's 500-writes-per-batch cap

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed if unconfigured
  const header = req.headers.get('authorization') ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const key = bearer || req.nextUrl.searchParams.get('key') || '';
  return secretEquals(key, secret);
}

// 'YYYY-MM-DD' for "today" in Asia/Colombo — patterns and assignments are keyed on Colombo
// calendar dates, and Netlify servers run in UTC.
function colomboDateStr(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Colombo' }).format(d);
}

// date 'yyyy-mm-dd' → its Poya/Public/Mercantile class, from holiday_settings/{year}.
// Mirrors holidayService.getHolidayTypesForRange, Admin-SDK side. Unclassified dates
// (common this far out) come back absent → the assignment stores holiday_type: null and a
// later re-materialise / manual edit fills it in.
async function holidayTypesForRange(
  db: Firestore, from: string, to: string,
): Promise<Map<string, 'poya' | 'public' | 'mercantile'>> {
  const map = new Map<string, 'poya' | 'public' | 'mercantile'>();
  const y0 = Number(from.slice(0, 4));
  const y1 = Number(to.slice(0, 4));
  if (!Number.isFinite(y0) || !Number.isFinite(y1) || y1 < y0) return map;
  for (let y = y0; y <= y1; y++) {
    const snap = await db.collection('holiday_settings').doc(String(y)).get();
    if (!snap.exists) continue;
    const data = snap.data() ?? {};
    const types = (data.types && typeof data.types === 'object') ? data.types as Record<string, 'poya' | 'public' | 'mercantile'> : {};
    for (const d of Array.isArray(data.dates) ? data.dates as string[] : []) {
      map.set(d, types[d] ?? 'public');
    }
  }
  return map;
}

type PatternRow = { id: string; [k: string]: unknown };

// Shift pattern → schedule_assignments (mirrors schedulePatternService.materializeShiftRows).
async function extendShiftPattern(
  db: Firestore, p: PatternRow, wanted: string[], today: string,
): Promise<{ created: number; removed: number }> {
  const rowsSnap = await db.collection('schedule_assignments').where('pattern_id', '==', p.id).get();
  const rows = rowsSnap.docs.map((d) => ({ id: d.id, date: String(d.data().date ?? ''), is_deleted: !!d.data().is_deleted }));
  const { toCreate, toTombstone } = diffMaterialization(wanted, rows.map((x) => ({ date: x.date, is_deleted: x.is_deleted })), today);
  if (!toCreate.length && !toTombstone.length) return { created: 0, removed: 0 };

  const holidays = toCreate.length
    ? await holidayTypesForRange(db, toCreate[0], toCreate[toCreate.length - 1])
    : new Map<string, 'poya' | 'public' | 'mercantile'>();
  const liveByDate = new Map(rows.filter((x) => !x.is_deleted).map((x) => [x.date, x.id]));
  const writes: Array<{ kind: 'create'; date: string } | { kind: 'tombstone'; id: string }> = [
    ...toCreate.map((date) => ({ kind: 'create' as const, date })),
    ...toTombstone.map((date) => ({ kind: 'tombstone' as const, id: liveByDate.get(date)! })),
  ];
  for (let i = 0; i < writes.length; i += BATCH_LIMIT) {
    const batch = db.batch();
    for (const w of writes.slice(i, i + BATCH_LIMIT)) {
      if (w.kind === 'create') {
        batch.set(db.collection('schedule_assignments').doc(), {
          department_id:    p.department_id ?? '',
          department_name:  p.department_name ?? '',
          epf_number:       p.epf_number ?? '',
          employee_name:    p.employee_name ?? '',
          date:             w.date,
          shift_id:         p.shift_id ?? '',
          shift_name:       p.shift_name ?? '',
          start_time:       p.start_time ?? '',
          end_time:         p.end_time ?? '',
          holiday_type:     holidays.get(w.date) ?? null,
          assigned_by:      p.created_by ?? '',
          assigned_by_name: 'Recurring pattern',
          pattern_id:       p.id,
          is_deleted:       false,
          created_at:       FieldValue.serverTimestamp(),
        });
      } else {
        batch.update(db.collection('schedule_assignments').doc(w.id), { is_deleted: true, deleted_at: FieldValue.serverTimestamp() });
      }
    }
    await batch.commit();
  }
  return { created: toCreate.length, removed: toTombstone.length };
}

// Day-off pattern → day_offs (mirrors schedulePatternService.materializeDayOffRows): query
// the employee's whole day_offs set, diff against this pattern's own rows, and never create
// on — or tombstone — a date that carries a live manual/imported day off.
async function extendDayOffPattern(
  db: Firestore, p: PatternRow, wanted: string[], today: string,
): Promise<{ created: number; removed: number }> {
  const snap = await db.collection('day_offs').where('epf_number', '==', String(p.epf_number ?? '')).get();
  const all = snap.docs.map((d) => ({ id: d.id, date: String(d.data().date ?? ''), is_deleted: !!d.data().is_deleted, pattern_id: (d.data().pattern_id ?? null) as string | null }));
  const mine = all.filter((x) => x.pattern_id === p.id);
  const foreignLiveDates = new Set(all.filter((x) => x.pattern_id !== p.id && !x.is_deleted).map((x) => x.date));

  const { toCreate, toTombstone } = diffMaterialization(wanted, mine.map((x) => ({ date: x.date, is_deleted: x.is_deleted })), today);
  const createDates = toCreate.filter((d) => !foreignLiveDates.has(d));
  if (!createDates.length && !toTombstone.length) return { created: 0, removed: 0 };

  const liveByDate = new Map(mine.filter((x) => !x.is_deleted).map((x) => [x.date, x.id]));
  const writes: Array<{ kind: 'create'; date: string } | { kind: 'tombstone'; id: string }> = [
    ...createDates.map((date) => ({ kind: 'create' as const, date })),
    ...toTombstone.map((date) => ({ kind: 'tombstone' as const, id: liveByDate.get(date)! })),
  ];
  for (let i = 0; i < writes.length; i += BATCH_LIMIT) {
    const batch = db.batch();
    for (const w of writes.slice(i, i + BATCH_LIMIT)) {
      if (w.kind === 'create') {
        batch.set(db.collection('day_offs').doc(), {
          epf_number:    String(p.epf_number ?? ''),
          employee_name: (p.employee_name as string) || String(p.epf_number ?? ''),
          date:          w.date,
          reason:        '',
          source:        'pattern',
          pattern_id:    p.id,
          created_by:    p.created_by ?? '',
          created_at:    FieldValue.serverTimestamp(),
          is_deleted:    false,
        });
      } else {
        batch.update(db.collection('day_offs').doc(w.id), { is_deleted: true, deleted_at: FieldValue.serverTimestamp() });
      }
    }
    await batch.commit();
  }
  return { created: createDates.length, removed: toTombstone.length };
}

async function run(db: Firestore) {
  const today = colomboDateStr(new Date());
  const target = horizonEnd(today, HORIZON_WEEKS);

  const snap = await db.collection('schedule_patterns').where('is_active', '==', true).get();
  const patterns = (snap.docs.map((d) => ({ id: d.id, ...d.data() })) as PatternRow[])
    .filter((p) => !p.is_deleted);

  // Pre-load each owner + the restricted-shift set once, for the eligibility check below.
  const epfDocId = (e: string) => (e.includes('/') ? e.replace(/\//g, '%2F') : e);
  const epfs = [...new Set(patterns.map((p) => String(p.epf_number ?? '')))].filter(Boolean);
  const userByEpf = new Map<string, Record<string, unknown> | null>();
  await Promise.all(epfs.map(async (epf) => {
    const u = await db.collection('users').doc(epfDocId(epf)).get();
    userByEpf.set(epf, u.exists ? (u.data() as Record<string, unknown>) : null);
  }));
  const shiftsSnap = await db.collection('shift_definitions').get();
  const restrictedShifts: Array<{ id: string; [k: string]: unknown }> = [];
  const restrictedShiftIds = new Set<string>();
  for (const d of shiftsSnap.docs) {
    const s = { id: d.id, ...d.data() } as { id: string; [k: string]: unknown };
    if (!s.is_deleted && shiftIsRestricted(s as never)) { restrictedShifts.push(s); restrictedShiftIds.add(d.id); }
  }

  let created = 0, removed = 0, extended = 0, deactivated = 0;

  for (const p of patterns) {
    const user = userByEpf.get(String(p.epf_number ?? '')) ?? null;
    const ownerGone = !user || user.is_active === false;
    const restrictedEligible = isRecurringDayOffEligible(user as never, restrictedShifts as never);

    // Eligibility gone → deactivate + clear forward (wanted = [] tombstones every future row).
    if (patternIsVoid({ is_day_off: !!p.is_day_off }, ownerGone, restrictedEligible, restrictedShiftIds.has(String(p.shift_id ?? '')))) {
      await db.collection('schedule_patterns').doc(p.id).update({
        is_active: false, materialized_through: null, updated_at: FieldValue.serverTimestamp(),
      });
      const r = p.is_day_off ? await extendDayOffPattern(db, p, [], today) : await extendShiftPattern(db, p, [], today);
      removed += r.removed;
      deactivated += 1;
      continue;
    }

    // Still eligible — extend only if the horizon has slipped.
    if (String(p.materialized_through ?? '') >= target) continue;

    const weekdays = Array.isArray(p.weekdays) ? (p.weekdays as number[]) : [];
    const effectiveFrom = String(p.effective_from ?? today);
    const effectiveTo = (p.effective_to as string | null) ?? null;
    const rangeStart = effectiveFrom > today ? effectiveFrom : today;
    const wanted = expandPattern({ weekdays, effective_from: effectiveFrom, effective_to: effectiveTo }, rangeStart, target);
    const r = p.is_day_off
      ? await extendDayOffPattern(db, p, wanted, today)
      : await extendShiftPattern(db, p, wanted, today);
    created += r.created;
    removed += r.removed;
    extended += 1;

    await db.collection('schedule_patterns').doc(p.id).update({
      materialized_through: target,
      updated_at: FieldValue.serverTimestamp(),
    });
  }

  return { date: today, horizon: target, scanned: snap.size, extended, deactivated, created, removed };
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const tenants = [];
    for (const { tenant, db } of adminDbsForRequest(req)) {
      if (tenant.id !== 'southernlanka') continue; // recurring patterns are a southernlanka feature
      tenants.push({ tenant: tenant.id, ...(await run(db)) });
    }
    return NextResponse.json({ success: true, tenants });
  } catch (e) {
    console.error('[cron/schedule-pattern-extend]', e);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

// Many cron/uptime pingers only issue GETs.
export async function GET(req: NextRequest) {
  return POST(req);
}
