import {
  collection, doc, getDocs, setDoc, deleteDoc, query, where, Timestamp,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { epfDocId } from '@/services/userService';

// Per-employee working-place schedule, EFFECTIVE-FROM a date. An entry { epf, from_date,
// working_place } means "from from_date onward this is the technician's working place, until a
// later from_date overrides it". The working place for any given day is the entry with the
// greatest from_date on-or-before that day. Drives the check-out outstation reference.
const COL = 'working_schedules';

export interface WorkingScheduleRecord {
  id:            string;     // `${epfDocId(epf)}_${from_date}`
  epf_number:    string;
  employee_name: string;
  from_date:     string;     // YYYY-MM-DD — the place applies from this date onward
  working_place: string;     // working place NAME (matches working_places.name)
  site_number:   string | null;
  company_id:    string;
  company_name:  string;
  assigned_by:   string;
  assigned_by_name: string;
  created_at?:   Timestamp;
  updated_at?:   Timestamp;
}

export interface WorkingScheduleInput {
  epf_number:    string;
  employee_name?: string;
  from_date:     string;
  working_place: string;
  site_number?:  string | null;
  company_id?:   string;
  company_name?: string;
}

function scheduleId(epf: string, fromDate: string): string {
  return `${epfDocId(epf)}_${fromDate}`;
}

// Map a doc to a record. Back-compat: older entries stored the date in a `date` field (the
// per-exact-day model) instead of `from_date` — fall back to it so they still resolve.
function toRecord(id: string, data: any): WorkingScheduleRecord {
  return { id, ...data, from_date: data.from_date ?? data.date ?? '' } as WorkingScheduleRecord;
}

// ─── Per-employee schedule cache ────────────────────────────────────────────────
// getScheduleForDate resolves an employee's effective working place for a day, and the
// attendance / check-out flows call it repeatedly for the same employee within one load
// (today + yesterday shift resolution, the OutstationBadge, TodayCheckInOut). Each call
// re-read the whole employee's schedule history. Cache per EPF at module scope with a short
// TTL + in-flight coalescing, invalidated on any schedule write.
const SCHED_TTL_MS = 5 * 60 * 1000;
const _schedCache = new Map<string, { value: WorkingScheduleRecord[]; at: number }>();
const _schedInflight = new Map<string, Promise<WorkingScheduleRecord[]>>();

export function invalidateWorkingSchedulesCache(): void {
  _schedCache.clear();
  _schedInflight.clear();
}

// All effective-from entries for an employee, sorted by from_date ascending.
export async function listSchedulesForEmployee(epf: string): Promise<WorkingScheduleRecord[]> {
  const key = String(epf);
  const hit = _schedCache.get(key);
  if (hit && Date.now() - hit.at < SCHED_TTL_MS) return hit.value;
  const inflight = _schedInflight.get(key);
  if (inflight) return inflight;

  const p = (async () => {
    const snap = await getDocs(query(collection(db, COL), where('epf_number', '==', key)));
    const list = snap.docs
      .map(d => toRecord(d.id, d.data()))
      .filter(r => r.from_date)
      .sort((a, b) => a.from_date.localeCompare(b.from_date));
    _schedCache.set(key, { value: list, at: Date.now() });
    return list;
  })();
  _schedInflight.set(key, p);
  try { return await p; } finally { _schedInflight.delete(key); }
}

// The working place effective on `date`: the entry with the greatest from_date <= date, or null.
export async function getScheduleForDate(epf: string, date: string): Promise<WorkingScheduleRecord | null> {
  const all = await listSchedulesForEmployee(epf);
  let best: WorkingScheduleRecord | null = null;
  for (const r of all) {
    if (r.from_date <= date && (!best || r.from_date > best.from_date)) best = r;
  }
  return best;
}

// The most recent entry overall (used to pre-fill the sample with the current place).
export async function getLatestSchedule(epf: string): Promise<WorkingScheduleRecord | null> {
  const all = await listSchedulesForEmployee(epf);
  return all.length ? all[all.length - 1] : null;
}

// One read of the whole collection → the entry EFFECTIVE on `date` per employee (greatest
// from_date on-or-before `date`). Used to list each technician's current working place and to
// pre-fill the sample, without N per-employee queries.
export async function getEffectiveScheduleMap(date: string): Promise<Record<string, WorkingScheduleRecord>> {
  const snap = await getDocs(collection(db, COL));
  const map: Record<string, WorkingScheduleRecord> = {};
  snap.docs.forEach(d => {
    const r = toRecord(d.id, d.data());
    if (!r.from_date || r.from_date > date) return; // missing date or not yet effective on `date`
    const cur = map[r.epf_number];
    if (!cur || r.from_date > cur.from_date) map[r.epf_number] = r;
  });
  return map;
}

// Remove a single effective-from entry (used when editing changes its From date — the old
// entry is deleted and a new one created so the entry moves instead of duplicating).
export async function deleteSchedule(epf: string, fromDate: string): Promise<void> {
  await deleteDoc(doc(db, COL, scheduleId(epf, fromDate)));
  invalidateWorkingSchedulesCache();
}

// Upsert effective-from assignments. Idempotent per (epf, from_date) — re-uploading the same
// from_date overwrites it; different from_dates accumulate. Existing entries for employees NOT
// in the upload are left untouched (so they keep their previous schedule). Returns the count.
export async function upsertWorkingSchedules(
  records: WorkingScheduleInput[],
  assignedBy: string,
  assignedByName: string,
): Promise<number> {
  const now = Timestamp.now();
  let count = 0;
  for (const r of records) {
    if (!r.epf_number || !r.from_date || !r.working_place) continue;
    await setDoc(doc(db, COL, scheduleId(r.epf_number, r.from_date)), {
      epf_number:    r.epf_number,
      employee_name: r.employee_name ?? r.epf_number,
      from_date:     r.from_date,
      working_place: r.working_place,
      site_number:   r.site_number ?? null,
      company_id:    r.company_id ?? '',
      company_name:  r.company_name ?? '',
      assigned_by:   assignedBy,
      assigned_by_name: assignedByName,
      updated_at:    now,
      created_at:    now,
    }, { merge: true });
    count++;
  }
  invalidateWorkingSchedulesCache();
  return count;
}
