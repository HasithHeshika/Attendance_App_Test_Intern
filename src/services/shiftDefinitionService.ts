import {
  collection, doc, getDocs, addDoc, updateDoc, onSnapshot,
  query, orderBy, Timestamp,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import type { Shift } from '@/lib/types';
import { isShiftInUse } from '@/services/scheduleAssignmentService';

// Southern Lanka (carecode.org) tenant only — see the tenant branch on
// src/app/(pages)/shifts/page.tsx. Not used by any other tenant.
const COL = 'shift_definitions';

// Shift definitions change rarely but the list is read on every page load — cache at module
// scope with a short TTL + in-flight coalescing, invalidated on writes. Same pattern as
// departmentService.getDepartments.
const SHIFT_DEFS_TTL_MS = 10 * 60 * 1000;
let _shiftDefsCache: Shift[] | null = null;
let _shiftDefsCachedAt = 0;
let _shiftDefsInflight: Promise<Shift[]> | null = null;

export function invalidateShiftDefinitionsCache(): void {
  _shiftDefsCache = null;
  _shiftDefsCachedAt = 0;
  _shiftDefsInflight = null;
}

// Excludes soft-deleted shifts (see deleteShiftDefinition below). Filtered client-side rather
// than with a `where('is_deleted', '==', false)` query — an equality filter on a field drops
// any doc that doesn't have that field set at all, which would've hidden every shift that
// predates this flag.
export async function getShiftDefinitions(force = false): Promise<Shift[]> {
  if (!force && _shiftDefsCache && Date.now() - _shiftDefsCachedAt < SHIFT_DEFS_TTL_MS) return _shiftDefsCache;
  if (!force && _shiftDefsInflight) return _shiftDefsInflight;
  _shiftDefsInflight = (async () => {
    const snap = await getDocs(query(collection(db, COL), orderBy('name')));
    const shifts = snap.docs
      .map(d => ({ id: d.id, ...d.data() } as Shift))
      .filter(d => !d.is_deleted);
    _shiftDefsCache = shifts;
    _shiftDefsCachedAt = Date.now();
    return shifts;
  })();
  try { return await _shiftDefsInflight; } finally { _shiftDefsInflight = null; }
}

// Real-time counterpart to getShiftDefinitions above — the whole collection is small
// reference data (Shift Creation / the Schedule page's shift picker), so this listens on it
// unfiltered. force=true bypasses the TTL cache on every fire so a listener never re-serves
// stale data that an admin's own create/update/delete already invalidated a moment earlier.
// Fires once immediately with current data, then again on every create/update/delete —
// callers MUST invoke the returned unsubscribe on unmount.
export function subscribeShiftDefinitions(cb: (shifts: Shift[]) => void): () => void {
  const emit = () => { getShiftDefinitions(true).then(cb).catch(() => { /* keep last-known list */ }); };
  emit();
  return onSnapshot(
    collection(db, COL),
    emit,
    (err) => console.warn('subscribeShiftDefinitions failed:', err?.message ?? err),
  );
}

export type ShiftDefinitionInput = Omit<Shift, 'id' | 'is_deleted' | 'deleted_at' | 'created_at'>;

export async function createShiftDefinition(input: ShiftDefinitionInput): Promise<string> {
  const ref = await addDoc(collection(db, COL), {
    ...input,
    is_deleted: false,
    created_at: Timestamp.now(),
  });
  invalidateShiftDefinitionsCache();
  return ref.id;
}

export async function updateShiftDefinition(
  id: string,
  patch: Partial<ShiftDefinitionInput>,
): Promise<void> {
  await updateDoc(doc(db, COL, id), patch);
  invalidateShiftDefinitionsCache();
}

// Usage guard + soft delete — NEVER removes the Firestore doc. Refuses outright (throws) when
// the shift is still referenced by a live schedule assignment, so a roster entry can never
// silently point at a shift that no longer exists. Otherwise sets is_deleted (and deleted_at
// for an audit trail) so getShiftDefinitions() filters it out; the record itself stays
// recoverable straight from the database if it was deleted by mistake.
export async function deleteShiftDefinition(id: string): Promise<void> {
  if (await isShiftInUse(id)) {
    throw new Error('Cannot delete: this shift is actively assigned in existing rosters. Remove those assignments first.');
  }
  await updateDoc(doc(db, COL, id), { is_deleted: true, deleted_at: Timestamp.now() });
  invalidateShiftDefinitionsCache();
}
