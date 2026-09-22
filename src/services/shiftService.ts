import {
  collection, doc, getDocs, addDoc, updateDoc, deleteDoc, query, where, Timestamp,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import type { ShiftAssignment } from '@/lib/types';

const COL = 'shift_assignments';

export async function getShiftAssignments(companyId?: string): Promise<ShiftAssignment[]> {
  const q = companyId
    ? query(collection(db, COL), where('company_id', '==', companyId))
    : query(collection(db, COL));
  const snap = await getDocs(q);
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() } as ShiftAssignment))
    .sort((a, b) => (b.from_date ?? '').localeCompare(a.from_date ?? ''));
}

// ─── Per-employee shift-assignment cache ────────────────────────────────────────
// isShiftDayOn / isShiftWorkerOn (behind getMyTodayAttendance and TodayCheckInOut) resolve
// shift status for BOTH today and yesterday on every attendance load, each re-querying an
// employee's assignments — identical data fetched twice per load. Cache per EPF at module
// scope with a short TTL + in-flight coalescing, invalidated on any assignment write.
const SHIFT_TTL_MS = 5 * 60 * 1000;
const _shiftCache = new Map<string, { value: ShiftAssignment[]; at: number }>();
const _shiftInflight = new Map<string, Promise<ShiftAssignment[]>>();

export function invalidateShiftAssignmentsCache(): void {
  _shiftCache.clear();
  _shiftInflight.clear();
}

export async function getShiftAssignmentsForEpf(epf: string): Promise<ShiftAssignment[]> {
  const key = String(epf);
  const hit = _shiftCache.get(key);
  if (hit && Date.now() - hit.at < SHIFT_TTL_MS) return hit.value;
  const inflight = _shiftInflight.get(key);
  if (inflight) return inflight;

  const p = (async () => {
    const snap = await getDocs(query(collection(db, COL), where('epf_number', '==', key)));
    const list = snap.docs.map(d => ({ id: d.id, ...d.data() } as ShiftAssignment));
    _shiftCache.set(key, { value: list, at: Date.now() });
    return list;
  })();
  _shiftInflight.set(key, p);
  try { return await p; } finally { _shiftInflight.delete(key); }
}

export async function createShiftAssignment(
  data: Omit<ShiftAssignment, 'id' | 'created_at' | 'updated_at'>,
): Promise<string> {
  const now = Timestamp.now();
  const ref = await addDoc(collection(db, COL), { ...data, created_at: now, updated_at: now });
  invalidateShiftAssignmentsCache();
  return ref.id;
}

export async function updateShiftAssignment(id: string, data: Partial<ShiftAssignment>): Promise<void> {
  await updateDoc(doc(db, COL, id), { ...data, updated_at: Timestamp.now() } as Record<string, unknown>);
  invalidateShiftAssignmentsCache();
}

export async function deleteShiftAssignment(id: string): Promise<void> {
  await deleteDoc(doc(db, COL, id));
  invalidateShiftAssignmentsCache();
}

// True if the employee has any shift assignment covering `date` (YYYY-MM-DD).
export async function isShiftActiveOn(epf: string, date: string): Promise<boolean> {
  const assignments = await getShiftAssignmentsForEpf(epf);
  return assignments.some(a => a.from_date <= date && date <= a.to_date);
}
