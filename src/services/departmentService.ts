import {
  collection, doc, getDocs, addDoc, updateDoc, writeBatch,
  query, orderBy, where, Timestamp,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import type { Department } from '@/lib/types';
import { shiftDepartmentIds, shiftDepartmentNames } from '@/lib/types';
import { getShiftDefinitions, invalidateShiftDefinitionsCache } from '@/services/shiftDefinitionService';
import { isDepartmentInUse as isDepartmentInSchedules } from '@/services/scheduleAssignmentService';

// Southern Lanka (carecode.org) tenant only — see the isSouthernlanka gate on
// src/app/(pages)/departments/page.tsx. Not used by any other tenant.
const COL = 'departments';

// Departments change rarely but the list is read on every page load — cache at module
// scope with a short TTL + in-flight coalescing, invalidated on writes. Same pattern as
// companyService.getCompanies.
const DEPARTMENTS_TTL_MS = 10 * 60 * 1000;
let _departmentsCache: Department[] | null = null;
let _departmentsCachedAt = 0;
let _departmentsInflight: Promise<Department[]> | null = null;

export function invalidateDepartmentsCache(): void {
  _departmentsCache = null;
  _departmentsCachedAt = 0;
  _departmentsInflight = null;
}

// Excludes soft-deleted departments (see deleteDepartment below). Filtered client-side
// rather than with a `where('is_deleted', '==', false)` query — a not-equal/equal filter
// on a field would silently drop any doc that doesn't have that field set at all, which
// would've hidden every department that predates this flag.
export async function getDepartments(force = false): Promise<Department[]> {
  if (!force && _departmentsCache && Date.now() - _departmentsCachedAt < DEPARTMENTS_TTL_MS) return _departmentsCache;
  if (!force && _departmentsInflight) return _departmentsInflight;
  _departmentsInflight = (async () => {
    const snap = await getDocs(query(collection(db, COL), orderBy('name')));
    const departments = snap.docs
      .map(d => ({ id: d.id, ...d.data() } as Department))
      .filter(d => !d.is_deleted);
    _departmentsCache = departments;
    _departmentsCachedAt = Date.now();
    return departments;
  })();
  try { return await _departmentsInflight; } finally { _departmentsInflight = null; }
}

export async function createDepartment(
  name: string, companyId: string, companyName: string,
  parentId: string | null = null, parentName: string | null = null,
): Promise<string> {
  const ref = await addDoc(collection(db, COL), {
    name,
    company_id:   companyId,
    company_name: companyName,
    parent_id:    parentId,
    parent_name:  parentName,
    is_active:    true,
    is_deleted:   false,
    created_at:   Timestamp.now(),
  });
  invalidateDepartmentsCache();
  return ref.id;
}

// Department is referenced in two ways: an id (Shift.department_ids, HOD's own
// hod_department_ids) alongside a denormalized name snapshot, AND, for an employee's home
// department (AppUser.department), by NAME ONLY — there's no department_id on AppUser at
// all. The name-only case can't be fixed by a dynamic display-time lookup (nothing to look
// up FROM), so a rename cascades onto every AppUser/Shift/HOD name snapshot in the same
// write here. Historical, potentially large collections that DO carry the id (schedule
// rosters, leave-adjacent records) are deliberately left alone — those resolve the live name
// dynamically at render time instead (see the Schedule/Roster/Approvals views), which is far
// cheaper than rewriting every historical document on every rename.
async function cascadeDepartmentRename(id: string, oldName: string, newName: string): Promise<void> {
  const now = Timestamp.now();

  // 1. AppUser.department — every employee (active or not) whose home department is this one.
  const homeSnap = await getDocs(query(collection(db, 'users'), where('department', '==', oldName)));
  for (let i = 0; i < homeSnap.docs.length; i += 400) {
    const batch = writeBatch(db);
    homeSnap.docs.slice(i, i + 400).forEach((d) => batch.update(d.ref, { department: newName, updated_at: now }));
    await batch.commit();
  }

  // 2. AppUser.hod_department_names[] — the id stays put; only the parallel name entry moves.
  const hodSnap = await getDocs(query(collection(db, 'users'), where('hod_department_ids', 'array-contains', id)));
  for (let i = 0; i < hodSnap.docs.length; i += 400) {
    const batch = writeBatch(db);
    hodSnap.docs.slice(i, i + 400).forEach((d) => {
      const data = d.data();
      const ids = Array.isArray(data.hod_department_ids) ? (data.hod_department_ids as string[]) : [];
      const names = Array.isArray(data.hod_department_names) ? [...(data.hod_department_names as string[])] : ids.map(() => '');
      const idx = ids.indexOf(id);
      if (idx >= 0 && idx < names.length) {
        names[idx] = newName;
        batch.update(d.ref, { hod_department_names: names, updated_at: now });
      }
    });
    await batch.commit();
  }

  // 3. Shift.department_names[] — small, current-state collection, same parallel-array fix.
  const shifts = await getShiftDefinitions(true);
  for (const s of shifts) {
    const ids = shiftDepartmentIds(s);
    const idx = ids.indexOf(id);
    if (idx < 0) continue;
    const names = [...shiftDepartmentNames(s)];
    names[idx] = newName;
    await updateDoc(doc(db, 'shift_definitions', s.id), { department_names: names });
  }
  invalidateShiftDefinitionsCache();
  // The users writes above bypassed apiCompat's own users-snapshot/scope cache — drop it too,
  // so approval/schedule views don't serve a stale department name for up to its TTL. Dynamic
  // import avoids a static circular dependency (apiCompat imports from departmentService).
  import('@/services/apiCompat').then((m) => m.invalidateScopeCache?.()).catch(() => {});
}

export async function updateDepartment(
  id: string,
  patch: Partial<Pick<Department, 'name' | 'company_id' | 'company_name' | 'is_active' | 'parent_id' | 'parent_name'>>,
): Promise<void> {
  const trimmedName = typeof patch.name === 'string' ? patch.name.trim() : undefined;
  let oldName: string | undefined;
  if (trimmedName) {
    const existing = (await getDepartments(true)).find((d) => d.id === id);
    oldName = existing?.name;
  }
  await updateDoc(doc(db, COL, id), trimmedName ? { ...patch, name: trimmedName } : patch);
  invalidateDepartmentsCache();
  if (trimmedName && oldName && trimmedName !== oldName) {
    await cascadeDepartmentRename(id, oldName, trimmedName);
  }
}

// Checked by deleteDepartment before it's allowed to proceed — "actively referenced" means:
//   • a live (non-deleted) shift definition still offered under this department;
//   • a live (non-deleted) schedule assignment (roster entry) in this department;
//   • an active employee whose home Department is this one;
//   • an active employee holding it as one of their managed hod_department_ids.
// Attendance records and leave/edit requests aren't checked directly — neither stores a
// department reference of its own (see AppUser.department on the employee instead); the
// active-employee check above already covers "does anyone currently depend on this
// department existing".
export async function departmentUsageReason(id: string, name: string): Promise<string | null> {
  const shifts = await getShiftDefinitions();
  if (shifts.some((s) => shiftDepartmentIds(s).includes(id))) return 'shift definitions';

  if (await isDepartmentInSchedules(id)) return 'schedule rosters';

  const [homeSnap, hodSnap] = await Promise.all([
    getDocs(query(collection(db, 'users'), where('department', '==', name))),
    getDocs(query(collection(db, 'users'), where('hod_department_ids', 'array-contains', id))),
  ]);
  if (homeSnap.docs.some((d) => d.data().is_active !== false)) return 'active employees';
  if (hodSnap.docs.some((d) => d.data().is_active !== false)) return 'Head of Department assignments';

  return null;
}

// Usage guard + soft delete — NEVER removes the Firestore doc. Refuses outright (throws) when
// departmentUsageReason() finds it still in active use, so nothing (a shift, a roster, an
// employee) can be left pointing at a department that no longer exists. Otherwise sets
// is_deleted (and deleted_at for an audit trail) so getDepartments() filters it out; the
// record itself stays recoverable straight from the database if it was deleted by mistake.
export async function deleteDepartment(id: string, name: string): Promise<void> {
  const reason = await departmentUsageReason(id, name);
  if (reason) {
    throw new Error(`Cannot delete: this department is actively referenced in ${reason}. Remove or reassign those first.`);
  }
  await updateDoc(doc(db, COL, id), { is_deleted: true, deleted_at: Timestamp.now() });
  invalidateDepartmentsCache();
}
