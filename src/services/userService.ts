import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  Timestamp,
  arrayUnion,
  arrayRemove,
  runTransaction,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import type { AppUser, SpecialLeave } from '@/lib/types';
import { getRoles } from '@/services/roleService';
import { isSuperAdminUser, resolveCapabilitiesByName, roleCan } from '@/lib/permissions';
import {
  BOOTSTRAP_ADMIN_EMAILS,
  bootstrapAdminEpf,
  isBootstrapAdminEmail,
} from '@/lib/bootstrapAdmins';

const COL = 'users';

// Drop the apiCompat employees-in-scope cache after a user write (created/deactivated
// or role/company changed → approval scope changes). Dynamic import avoids a static
// circular dependency (apiCompat imports from this module). Fire-and-forget.
function invalidateScopeCaches(): void {
  import('@/services/apiCompat')
    .then((m) => m.invalidateScopeCache?.())
    .catch(() => {});
}

// ─── Bootstrap super-admin ─────────────────────────────────────────────────────
// Hardcoded emails that are always allowed in as System Admin, even with no user record
// yet. These are the break-glass accounts; NO other email is auto-created. The list and its
// predicate live in @/lib/bootstrapAdmins (pure) so the Node routes, which must never load
// the client Firebase SDK this module pulls in, can share the same copy.
export { BOOTSTRAP_ADMIN_EMAILS, isBootstrapAdminEmail };

// Returns a System Admin profile for the bootstrap email (existing one if present,
// otherwise a freshly created/synthesized one). Returns null for any other email.
export async function bootstrapAdminProfile(
  uid: string,
  email: string | null | undefined,
): Promise<AppUser | null> {
  if (!isBootstrapAdminEmail(email)) return null;
  const addr = email!.toLowerCase().trim();

  // Reuse an existing record if one is already there.
  const existing = await getUserByEmail(addr);
  if (existing) {
    // Make sure it stays an active System Admin and is linked to this uid.
    if (
      existing.role !== 'System Admin' ||
      existing.is_active === false ||
      existing.uid !== uid
    ) {
      try {
        await updateUser(existing.epf_number, {
          role: 'System Admin',
          is_active: true,
          uid,
        });
      } catch {
        /* best effort */
      }
    }
    return { ...existing, uid, role: 'System Admin', is_active: true };
  }

  const now = Timestamp.now();
  // Each break-glass account gets its OWN doc id — a shared one would have the second
  // account's sign-in overwrite the first's uid and email, and the first's next sign-in
  // overwrite it straight back. Non-null: isBootstrapAdminEmail(addr) passed above.
  const epf = bootstrapAdminEpf(addr)!;
  const profile: AppUser = {
    uid,
    epf_number: epf,
    email: addr,
    first_name: 'System',
    last_name: 'Admin',
    display_name: 'System Admin',
    name_tokens: ['system', 'admin', 'system admin'],
    role: 'System Admin',
    designation: 'System Administrator',
    department: '',
    company_id: '',
    company_name: '',
    employee_type: 'Permanent',
    supervisor_epf: null,
    phone_personal: '',
    phone_office: '',
    phone_emergency: '',
    address: '',
    nic: '',
    date_of_birth: null,
    date_of_join: null,
    date_of_resign: null,
    insurance: false,
    blood_type: '',
    b_card_status: false,
    avatar_url: null,
    fcm_token: null,
    is_active: true,
    created_at: now,
    updated_at: now,
  };
  // Best-effort persist so it shows in Users and survives future logins; if rules
  // block the write, the in-memory profile still lets the admin sign in.
  try {
    await setDoc(doc(db, COL, epfDocId(epf)), profile);
  } catch {
    /* in-memory bootstrap */
  }
  return profile;
}

// Hand-typed/imported EPF numbers occasionally pick up stray whitespace (e.g. "SLH/E 378"
// instead of "SLH/E378") — since EPF format never intentionally contains spaces, this strips
// ALL whitespace (not just leading/trailing) so "SLH/E 378" and "SLH/E378" collapse to the
// same value/doc id instead of silently becoming two different user records. Always use this
// (directly or via epfDocId) before storing or comparing an epf_number.
export function normalizeEpf(epf: string): string {
  return epf.replace(/\s+/g, '');
}

// Employee Number (the separate company employee no. — see AppUser.employee_number) gets the
// exact same accidental-whitespace treatment as EPF above: hand-typed entries and bulk-import
// spreadsheet cells (Users Add/Edit and /users/bulk-add both funnel through createUser/
// updateUser below) can pick up stray whitespace (e.g. "EMPAV 00009" vs "EMPAV00009"), which
// would otherwise let what's really the same Employee No slip past uniqueness checks as two
// "different" values. Always stored normalized; comparisons against it should normalize too.
export function normalizeEmployeeNumber(employeeNumber: string): string {
  return employeeNumber.replace(/\s+/g, '');
}

// EPF numbers like "EMPAV/00009" contain "/" which Firestore interprets as
// a path separator. They are stored with the "/" encoded as "%2F".
// Always use this when constructing doc refs by EPF.
export function epfDocId(epf: string): string {
  const clean = normalizeEpf(epf);
  return clean.includes('/') ? clean.replace(/\//g, '%2F') : clean;
}

export function buildNameTokens(first: string, last: string): string[] {
  const f = first.toLowerCase().trim();
  const l = last.toLowerCase().trim();
  const full = `${f} ${l}`;
  const tokens = new Set<string>();
  tokens.add(f);
  tokens.add(l);
  tokens.add(full);
  // add partial prefixes for type-ahead feel
  for (let i = 1; i <= f.length; i++) tokens.add(f.slice(0, i));
  for (let i = 1; i <= l.length; i++) tokens.add(l.slice(0, i));
  for (let i = 1; i <= full.length; i++) tokens.add(full.slice(0, i));
  return Array.from(tokens).filter((t) => t.length >= 2);
}

export async function getUserByUid(uid: string): Promise<AppUser | null> {
  // Primary: look up by uid field
  const q = query(collection(db, COL), where('uid', '==', uid));
  const snap = await getDocs(q);
  if (!snap.empty) {
    return {
      id: snap.docs[0].id,
      ...snap.docs[0].data(),
    } as unknown as AppUser;
  }

  // Fallback: look up by email (handles migrated users where uid wasn't set yet)
  // We get the email from Firebase Auth by checking the current user
  const { auth } = await import('@/lib/firebase');
  const fbUser = auth.currentUser;
  if (!fbUser?.email) return null;

  const emailQ = query(collection(db, COL), where('email', '==', fbUser.email));
  const emailSnap = await getDocs(emailQ);
  if (emailSnap.empty) return null;

  // Auto-patch the uid so future lookups use the fast path
  const found = emailSnap.docs[0];
  try {
    const { updateDoc, doc } = await import('firebase/firestore');
    await updateDoc(doc(db, COL, found.id), { uid });
  } catch {
    /* non-critical */
  }

  return { id: found.id, ...found.data() } as unknown as AppUser;
}

export async function getUserByEmail(email: string): Promise<AppUser | null> {
  const q = query(
    collection(db, COL),
    where('email', '==', email.toLowerCase().trim()),
  );
  const snap = await getDocs(q);
  if (snap.empty) return null;
  return { id: snap.docs[0].id, ...snap.docs[0].data() } as unknown as AppUser;
}

export async function getUserByEpf(epf: string): Promise<AppUser | null> {
  const ref = doc(db, COL, epfDocId(epf));
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;
  return snap.data() as AppUser;
}

// Generic single-field uniqueness lookup — used by the bulk import review screen (see
// /users/bulk-add) to re-verify a row's EPF/Employee No/NIC/Email/Contact Number against the
// database itself (debounced there) as the admin edits it, rather than only trusting the
// `getAllUsers` snapshot taken when that page loaded. Returns the first matching user, if any.
export async function findUserByField(
  field: 'epf_number' | 'employee_number' | 'nic' | 'email' | 'phone_personal',
  value: string,
): Promise<AppUser | null> {
  const v = value.trim();
  if (!v) return null;
  const q = query(
    collection(db, COL),
    where(field, '==', field === 'email' ? v.toLowerCase() : v),
  );
  const snap = await getDocs(q);
  if (snap.empty) return null;
  return snap.docs[0].data() as AppUser;
}

// `includeInactive` also returns deactivated / not-yet-approved accounts (e.g. pending
// self-registrations — see `/register`). Defaults to false so every existing caller
// (assignment pickers, reports, suspense, etc.) keeps only seeing active staff.
export async function getAllUsers(
  companyId?: string,
  includeInactive = false,
): Promise<AppUser[]> {
  const clauses = [
    ...(companyId ? [where('company_id', '==', companyId)] : []),
    ...(includeInactive ? [] : [where('is_active', '==', true)]),
  ];
  const q = query(collection(db, COL), ...clauses);
  const snap = await getDocs(q);
  return snap.docs
    .map((d) => d.data() as AppUser)
    .sort((a, b) => a.display_name.localeCompare(b.display_name));
}

// Active users who are actual EMPLOYEES — their role carries `is_employee` (has an attendance/
// leave profile). Excludes system/admin accounts like System Admin. Used by staff pickers
// (bill split, suspense report, opening a suspense account) that should never list non-employees.
export async function getAllEmployees(companyId?: string): Promise<AppUser[]> {
  const [users, roles] = await Promise.all([
    getAllUsers(companyId),
    getRoles(),
  ]);
  return users.filter((u) => roleCan(u.role, 'is_employee', roles));
}

export async function getSupervisors(
  companyId: string,
  search?: string,
): Promise<AppUser[]> {
  // Supervisors are users whose role can approve. Roles are data-driven, so resolve
  // the approver role set from the registry and filter in memory.
  const roles = await getRoles();
  const q = query(
    collection(db, COL),
    where('company_id', '==', companyId),
    where('is_active', '==', true),
  );
  const snap = await getDocs(q);
  let users = snap.docs
    .map((d) => d.data() as AppUser)
    .filter((u) => roleCan(u.role, 'can_approve', roles));

  if (search && search.trim().length >= 2) {
    const term = search.toLowerCase().trim();
    users = users.filter(
      (u) =>
        u.name_tokens?.some((t) => t.includes(term)) ||
        u.epf_number.includes(term),
    );
  }
  return users.sort((a, b) => a.display_name.localeCompare(b.display_name));
}

// Every OTHER active System-Admin-capability user (cross-company — System Admin isn't
// scoped to one). Roles are data-driven, so resolve via roleCan(..., 'is_system_admin')
// the same way getSupervisors resolves 'can_approve' — this also covers the legacy
// 'Admin' role name for free via LEGACY_ROLE_ALIASES in permissions.ts.
export async function getActiveSystemAdmins(
  excludeEpf?: string,
): Promise<AppUser[]> {
  const roles = await getRoles();
  const q = query(collection(db, COL), where('is_active', '==', true));
  const snap = await getDocs(q);
  return snap.docs
    .map((d) => d.data() as AppUser)
    .filter(
      (u) =>
        u.epf_number !== excludeEpf &&
        roleCan(u.role, 'is_system_admin', roles),
    );
}

/**
 * Every active SUPER admin of THIS system — the people who are mirrored into every tenant
 * database (see src/lib/superAdminSync.ts). Two ways to hold it, and `grantedBy` says which,
 * because they are revoked in different places: a role-based grant is removed on the Roles
 * page, a per-user one on the Users page.
 *
 * This is a tenant-local list. It says nothing about who can configure the platform — that is
 * the platform_admins list in the tenants registry database.
 */
export interface SuperAdminEntry {
  user: AppUser;
  grantedBy: 'role' | 'user_flag' | 'both';
}

export async function getActiveSuperAdmins(): Promise<SuperAdminEntry[]> {
  const [roles, users] = await Promise.all([
    getRoles(),
    getAllUsers(undefined, false),   // active accounts only
  ]);
  return users
    .filter(u => isSuperAdminUser({ role: u.role, employee_type: u.employee_type, is_super_admin: u.is_super_admin }, roles))
    .map(user => {
      // Resolved WITH employee_type: a trainee of a super-admin role does not inherit it
      // (is_super_admin has no trainee variant), so the label must agree with the filter above.
      const byRole = resolveCapabilitiesByName(user.role, roles, user.employee_type).is_super_admin;
      const byFlag = user.is_super_admin === true;
      return { user, grantedBy: (byRole && byFlag ? 'both' : byRole ? 'role' : 'user_flag') as SuperAdminEntry['grantedBy'] };
    });
}

// Thrown when a create would land on an EPF that is already taken. Callers catch
// this to show "employee already exists" instead of a generic save failure.
export class DuplicateEpfError extends Error {
  readonly code = 'epf/already-exists';
  constructor(
    public readonly epf: string,
    public readonly existing: AppUser | null = null,
  ) {
    super(`An employee with EPF ${epf} already exists`);
    this.name = 'DuplicateEpfError';
  }
}

// Cheap pre-flight duplicate check. Reads the doc by id, so it also sees
// deactivated/resigned employees, which the getAllUsers() list filters out.
export async function epfExists(epf: string): Promise<AppUser | null> {
  if (!epf?.trim()) return null;
  return getUserByEpf(epf.trim());
}

export async function createUser(
  data: Omit<AppUser, 'created_at' | 'updated_at'>,
): Promise<void> {
  const now = Timestamp.now();
  const nameTokens = buildNameTokens(data.first_name, data.last_name);
  const epf = normalizeEpf(data.epf_number);
  if (!epf) throw new Error('EPF number is required');
  // Optional field — normalize only when actually provided (see normalizeEmployeeNumber).
  const employeeNumber =
    typeof data.employee_number === 'string'
      ? normalizeEmployeeNumber(data.employee_number)
      : data.employee_number;
  const ref = doc(db, COL, epfDocId(epf));
  // The doc id IS the EPF, so a plain setDoc would silently overwrite an existing
  // employee. Do the existence check inside a transaction so two concurrent creates
  // with the same EPF can't both pass it.
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists()) throw new DuplicateEpfError(epf, snap.data() as AppUser);
    tx.set(ref, {
      ...data,
      epf_number: epf,
      employee_number: employeeNumber,
      name_tokens: nameTokens,
      display_name: `${data.first_name} ${data.last_name}`,
      created_at: now,
      updated_at: now,
    });
  });
  invalidateScopeCaches();
}

export async function updateUser(
  epf: string,
  data: Partial<AppUser>,
): Promise<void> {
  const updates: Partial<AppUser> & {
    updated_at: Timestamp;
    name_tokens?: string[];
    display_name?: string;
  } = {
    ...data,
    updated_at: Timestamp.now(),
  };
  // Same accidental-whitespace normalization as createUser above — only when this update
  // actually touches employee_number (a partial update may omit it entirely).
  if (typeof data.employee_number === 'string') {
    updates.employee_number = normalizeEmployeeNumber(data.employee_number);
  }
  if (data.first_name || data.last_name) {
    const existing = await getUserByEpf(epf);
    const first = data.first_name ?? existing?.first_name ?? '';
    const last = data.last_name ?? existing?.last_name ?? '';
    updates.name_tokens = buildNameTokens(first, last);
    updates.display_name = `${first} ${last}`;
  }
  await updateDoc(
    doc(db, COL, epfDocId(epf)),
    updates as Record<string, unknown>,
  );
  invalidateScopeCaches();
}

export async function deactivateUser(epf: string): Promise<void> {
  await updateDoc(doc(db, COL, epfDocId(epf)), {
    is_active: false,
    updated_at: Timestamp.now(),
  });
  invalidateScopeCaches();
}

// Moves a user record from a placeholder EPF (assigned at self-registration — see
// awaiting_epf on AppUser and src/app/api/register/route.ts) to the real Employee No an
// admin assigns at approval. Firestore can't rename a doc id in place, so this reads the
// old doc, writes a new one under the real EPF, then deletes the old one.
//
// ONLY safe for accounts with no dependent history yet — attendance/leave/task/suspense
// records reference epf_number by value and are NOT migrated by this function. That's
// fine for the case it's built for (a brand-new pending registration has no history), but
// this must never be exposed as a general "change anyone's EPF" tool.
export async function reassignEpf(
  oldEpf: string,
  newEpf: string,
): Promise<void> {
  const trimmed = normalizeEpf(newEpf);
  if (!trimmed) throw new Error('Employee No is required');
  if (trimmed === oldEpf) return;

  const oldRef = doc(db, COL, epfDocId(oldEpf));
  const oldSnap = await getDoc(oldRef);
  if (!oldSnap.exists()) throw new Error('User not found');

  const newRef = doc(db, COL, epfDocId(trimmed));
  const newSnap = await getDoc(newRef);
  if (newSnap.exists()) throw new Error('That Employee No is already in use');

  const data = oldSnap.data() as AppUser;
  await setDoc(newRef, {
    ...data,
    epf_number: trimmed,
    awaiting_epf: false,
    updated_at: Timestamp.now(),
  });
  await deleteDoc(oldRef);
  invalidateScopeCaches();
}

export async function saveUserFcmToken(epf: string, token: string, oldToken?: string | null): Promise<void> {
  // Multi-device: keep every device's token in `fcm_tokens` (arrayUnion dedupes) so a
  // second login no longer kicks the first device off push. `fcm_token` stays as the
  // latest for backwards compatibility; /api/notify reads both and prunes dead ones.
  //
  // `oldToken` is this SAME device's previous token (the caller tracks it in localStorage).
  // When a device's token rotates, the old one is still valid for a transition window — if
  // it's left in `fcm_tokens` it accumulates there, and any push sent while both are live
  // gets delivered to this one device twice. Removing it here (scoped to just this device's
  // prior value, never another device's) keeps the array to one live token per device.
  const ref = doc(db, COL, epfDocId(epf));
  await updateDoc(ref, {
    fcm_token: token,
    fcm_tokens: arrayUnion(token),
    updated_at: Timestamp.now(),
  });
  // Firestore only allows one transform per field per update, so the removal is a second,
  // best-effort call — losing it just leaves a stale token for the existing prune paths to
  // eventually clear, it doesn't reintroduce the duplicate-delivery window on its own.
  if (oldToken && oldToken !== token) {
    await updateDoc(ref, { fcm_tokens: arrayRemove(oldToken) }).catch(() => undefined);
  }
}

// ─── Special Leaves (stored inside the user doc) ───────────────────────────────
export async function addSpecialLeave(
  epf: string,
  leave: Omit<SpecialLeave, 'id' | 'created_at'>,
): Promise<void> {
  const entry: SpecialLeave = {
    ...leave,
    id: `sl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    created_at: new Date().toISOString(),
  };
  await updateDoc(doc(db, COL, epfDocId(epf)), {
    special_leaves: arrayUnion(entry),
    updated_at: Timestamp.now(),
  });
}

export async function removeSpecialLeave(
  epf: string,
  id: string,
): Promise<void> {
  const ref = doc(db, COL, epfDocId(epf));
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const current = (snap.data().special_leaves ?? []) as SpecialLeave[];
  await updateDoc(ref, {
    special_leaves: current.filter((s) => s.id !== id),
    updated_at: Timestamp.now(),
  });
}
