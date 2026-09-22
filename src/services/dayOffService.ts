import {
  collection, doc, getDocs, addDoc, updateDoc, writeBatch,
  query, where, Timestamp, type QuerySnapshot, type DocumentData,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import type { DayOff } from '@/lib/types';

// Southern Lanka (carecode.org) tenant only — declared employee Day Offs, overlaid on the
// Schedule grid (src/app/(pages)/schedule/page.tsx). Not used by any other tenant. Soft-delete
// convention, same as schedule_assignments: "remove" sets is_deleted; reads filter it out.
const COL = 'day_offs';

function mapRows(snap: QuerySnapshot<DocumentData>): DayOff[] {
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() } as DayOff & { is_deleted?: boolean }))
    .filter((r) => !r.is_deleted);
}

// Day Offs whose `date` falls within [fromDate, toDate] (inclusive, 'yyyy-MM-dd'). A
// single-field range query — no composite index needed.
export async function getDayOffsForRange(fromDate: string, toDate: string): Promise<DayOff[]> {
  if (!fromDate || !toDate) return [];
  const snap = await getDocs(query(
    collection(db, COL),
    where('date', '>=', fromDate),
    where('date', '<=', toDate),
  ));
  return mapRows(snap).sort(
    (a, b) => a.date.localeCompare(b.date) || a.employee_name.localeCompare(b.employee_name),
  );
}

// Every still-declared day off for one employee.
export async function getDayOffsForEmployee(epfNumber: string): Promise<DayOff[]> {
  if (!epfNumber) return [];
  const snap = await getDocs(query(collection(db, COL), where('epf_number', '==', String(epfNumber))));
  return mapRows(snap).sort((a, b) => a.date.localeCompare(b.date));
}

export interface DayOffInput {
  epf_number: string;
  employee_name: string;
  date: string;               // 'yyyy-MM-dd'
  reason?: string;
  source?: 'excel' | 'manual';
}

function docBody(input: DayOffInput, createdBy: string, now: Timestamp) {
  return {
    epf_number:    String(input.epf_number),
    employee_name: input.employee_name || String(input.epf_number),
    date:          input.date,
    reason:        input.reason?.trim() || '',
    source:        input.source ?? 'manual',
    created_by:    createdBy,
    created_at:    now,
    is_deleted:    false,
  };
}

// One declared day off. Returns the new doc id, or null when this (employee, date) is already
// declared (idempotent — re-declaring the same day is a no-op).
export async function createDayOff(input: DayOffInput, createdBy: string): Promise<string | null> {
  const existing = await getDayOffsForEmployee(input.epf_number);
  if (existing.some((r) => r.date === input.date)) return null;
  const ref = await addDoc(collection(db, COL), docBody(input, createdBy, Timestamp.now()));
  return ref.id;
}

// Bulk declare (Excel import). Skips any (employee, date) already declared — the return value
// reports how many rows were written vs. skipped as duplicates.
export async function bulkCreateDayOffs(
  inputs: DayOffInput[], createdBy: string,
): Promise<{ created: number; skipped: number }> {
  if (!inputs.length) return { created: 0, skipped: 0 };

  // Existing (employee, date) pairs across the date span of this batch — a single-field range
  // query keeps the read bounded to the relevant window rather than the whole collection.
  const dates = inputs.map((i) => i.date).filter(Boolean).sort();
  const existing = dates.length
    ? await getDayOffsForRange(dates[0], dates[dates.length - 1])
    : [];
  const seen = new Set(existing.map((r) => `${r.epf_number}|${r.date}`));

  const fresh: DayOffInput[] = [];
  let skipped = 0;
  for (const inp of inputs) {
    const key = `${String(inp.epf_number)}|${inp.date}`;
    if (seen.has(key)) { skipped++; continue; }
    seen.add(key); // also de-dupes within the incoming batch
    fresh.push(inp);
  }

  const now = Timestamp.now();
  // Firestore caps a batch at 500 ops — chunk, same convention as roleService/notificationService.
  for (let i = 0; i < fresh.length; i += 450) {
    const batch = writeBatch(db);
    for (const inp of fresh.slice(i, i + 450)) {
      batch.set(doc(collection(db, COL)), docBody({ ...inp, source: inp.source ?? 'excel' }, createdBy, now));
    }
    await batch.commit();
  }
  return { created: fresh.length, skipped };
}

// Soft-delete one declared day off.
export async function removeDayOff(id: string): Promise<void> {
  await updateDoc(doc(db, COL, id), { is_deleted: true, deleted_at: Timestamp.now() });
}
