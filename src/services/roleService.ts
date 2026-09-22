import {
  collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, query, where, writeBatch, Timestamp,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import type { Role } from '@/lib/permissions';
import { DEFAULT_ROLES, SUPER_ADMIN_ROLE_ID, traineeDefaults } from '@/lib/permissions';

const COL = 'roles';

function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

// Role names stay globally unique — one doc per job title, with no department scoping of its
// own (see Role in src/lib/permissions.ts; department scoping lives entirely on the user
// profile now). True when `name` is already used by another role. Case/whitespace insensitive.
// `excludeId` lets an edit compare against every role but itself.
export function findDuplicateRole(roles: Role[], name: string, excludeId?: string | null): Role | null {
  const norm = name.trim().toLowerCase();
  return roles.find(r => r.id !== excludeId && r.name.trim().toLowerCase() === norm) ?? null;
}

// ─── Roles cache ────────────────────────────────────────────────────────────────
// Roles rarely change but are needed by almost every apiCompat call (approval
// routing, supervisor resolution, capability checks). Reading the whole collection
// per call multiplied Firestore reads massively. Cache the list at module scope with
// a short TTL (bounds multi-tab staleness) and explicit invalidation on every write.
const ROLES_TTL_MS = 5 * 60 * 1000;
let _rolesCache: Role[] | null = null;
let _rolesCachedAt = 0;
let _rolesInflight: Promise<Role[]> | null = null;

export function invalidateRolesCache(): void {
  _rolesCache = null;
  _rolesCachedAt = 0;
  _rolesInflight = null;
}

// The role tree drives apiCompat's employees-in-scope resolution (descendant roles), so
// a role write must also drop that cache. Dynamic import avoids a static circular
// dependency (apiCompat imports getRoles from here). Fire-and-forget.
function invalidateDependentCaches(): void {
  invalidateRolesCache();
  import('@/services/apiCompat').then(m => m.invalidateScopeCache?.()).catch(() => {});
}

export async function getRoles(force = false): Promise<Role[]> {
  const fresh = _rolesCache && Date.now() - _rolesCachedAt < ROLES_TTL_MS;
  if (!force && fresh) return _rolesCache!;
  // Coalesce concurrent callers (a page load fires many in parallel) into one read.
  if (!force && _rolesInflight) return _rolesInflight;

  _rolesInflight = (async () => {
    const snap  = await getDocs(collection(db, COL));
    const roles = snap.docs
      .map(d => ({ id: d.id, ...d.data() } as Role))
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name));
    _rolesCache    = roles;
    _rolesCachedAt = Date.now();
    return roles;
  })();
  try {
    return await _rolesInflight;
  } finally {
    _rolesInflight = null;
  }
}

export async function getActiveRoles(): Promise<Role[]> {
  return (await getRoles()).filter(r => r.is_active !== false);
}

export async function getRoleByName(name: string): Promise<Role | null> {
  const roles = await getRoles();
  return roles.find(r => r.name === name) ?? null;
}

export async function createRole(data: Omit<Role, 'id' | 'created_at' | 'updated_at'> & { id?: string }): Promise<string> {
  const id  = data.id || slugify(data.name);
  const now = Timestamp.now();
  const { id: _ignore, ...rest } = data;
  await setDoc(doc(db, COL, id), { ...rest, created_at: now, updated_at: now });
  invalidateDependentCaches();
  return id;
}

// Role is referenced by NAME everywhere (AppUser.role IS the foreign key — there's no
// role_id) — approval routing, the fixed escalation ladder, and capability resolution all
// key off that string directly. Renaming a role therefore can't be fixed with a dynamic
// display-time lookup the way an id-referenced entity can; the only correct fix is to
// cascade the rename onto every user still holding the OLD name, in the same write. Without
// this, a renamed role would silently strand its users on FALLBACK_CAPS (near-zero
// capabilities) the instant no role doc matches their stored .role string any more.
async function cascadeRoleRename(oldName: string, newName: string): Promise<number> {
  const snap = await getDocs(query(collection(db, 'users'), where('role', '==', oldName)));
  if (snap.empty) return 0;
  const now = Timestamp.now();
  let updated = 0;
  // Chunked batches (Firestore caps a batch at 500 ops) — same chunking convention as
  // markManyReadRemote in notificationService.ts.
  for (let i = 0; i < snap.docs.length; i += 400) {
    const batch = writeBatch(db);
    snap.docs.slice(i, i + 400).forEach(d => {
      batch.update(d.ref, { role: newName, updated_at: now });
      updated++;
    });
    await batch.commit();
  }
  return updated;
}

export async function updateRole(id: string, data: Partial<Role>): Promise<void> {
  const trimmedName = typeof data.name === 'string' ? data.name.trim() : undefined;
  // Read the CURRENT name first (only when the caller is actually touching `name`) so the
  // cascade below always compares against the true old value, not a stale in-memory copy.
  let oldName: string | undefined;
  if (trimmedName) {
    const before = await getDoc(doc(db, COL, id));
    oldName = before.exists() ? (before.data() as Role).name : undefined;
  }
  await updateDoc(doc(db, COL, id), {
    ...data,
    ...(trimmedName ? { name: trimmedName } : {}),
    updated_at: Timestamp.now(),
  } as Record<string, unknown>);
  invalidateDependentCaches();
  if (trimmedName && oldName && trimmedName !== oldName) {
    await cascadeRoleRename(oldName, trimmedName);
    invalidateDependentCaches(); // covers the users snapshot cache the cascade just wrote through
  }
}

export async function deleteRole(id: string): Promise<void> {
  await deleteDoc(doc(db, COL, id));
  invalidateDependentCaches();
}

// Idempotent: create any default role that doesn't already exist (keyed by slug), and
// backfill the default `parent_id` (hierarchy) onto existing default roles that lack one.
// Returns the number of roles created.
export async function seedDefaultRolesIfEmpty(): Promise<number> {
  const existing = await getRoles();
  const existingById = new Map(existing.map(r => [r.id, r]));
  const now = Timestamp.now();
  let created = 0;
  for (const r of DEFAULT_ROLES) {
    const have = existingById.get(r.id);
    if (!have) {
      await setDoc(doc(db, COL, r.id), { ...r, created_at: now, updated_at: now });
      created++;
    } else {
      // Backfill newly-introduced fields on existing default roles that predate them,
      // without clobbering anything the admin has deliberately set.
      const patch: Record<string, unknown> = {};
      if (have.parent_id === undefined) patch.parent_id = r.parent_id ?? null;
      if ((have as { category?: unknown }).category === undefined) patch.category = r.category;
      if ((have as { multi_session?: boolean }).multi_session === undefined) patch.multi_session = r.multi_session;
      if ((have as { can_manage_shifts?: boolean }).can_manage_shifts === undefined) patch.can_manage_shifts = r.can_manage_shifts;
      if ((have as { can_manage_working_schedules?: boolean }).can_manage_working_schedules === undefined) patch.can_manage_working_schedules = r.can_manage_working_schedules;
      if ((have as { can_approve_leads?: boolean }).can_approve_leads === undefined) patch.can_approve_leads = r.can_approve_leads;
      if ((have as { can_approve_leaves?: boolean }).can_approve_leaves === undefined) patch.can_approve_leaves = r.can_approve_leaves;
      // Employee roles get a configurable trainee access set (default: basic employee).
      if (have.is_employee && (have as { trainee?: unknown }).trainee === undefined) patch.trainee = traineeDefaults(have);
      if (Object.keys(patch).length) {
        await updateDoc(doc(db, COL, r.id), { ...patch, updated_at: now });
      }
    }
  }
  invalidateRolesCache();
  return created;
}

/**
 * Create the seeded Super Admin role if this tenant has no role carrying is_super_admin.
 *
 * Same shape as seedDefaultRolesIfEmpty — idempotent, creates only what is missing, and is
 * called ONLY from an explicit button on the Roles page. Deliberately not wired into any load
 * path: the highest-privilege role in the app must appear because a person asked for it, not
 * because a page mounted. Tenants that don't seed the generic default set (Southern Lanka
 * hides "Initialize defaults") still get a way to create it.
 *
 * Returns the id of the role that now carries the capability — the existing one if there
 * already was one, so the caller can say "you already have it" rather than "created".
 */
export async function ensureSuperAdminRole(): Promise<{ id: string; name: string; created: boolean }> {
  const existing = await getRoles(true);
  // Match on the CAPABILITY, not the name: an admin may have renamed it, or ticked
  // is_super_admin onto a role of their own. Either way, one is enough.
  const already = existing.find(r => r.is_super_admin === true);
  if (already) return { id: already.id, name: already.name, created: false };

  const seed = DEFAULT_ROLES.find(r => r.id === SUPER_ADMIN_ROLE_ID);
  if (!seed) throw new Error('No Super Admin role is defined in DEFAULT_ROLES.');
  // The slug may already be taken by a role an admin renamed and stripped the capability
  // from; never overwrite it, take the next free id instead.
  const taken = new Set(existing.map(r => r.id));
  const id = taken.has(seed.id) ? `${seed.id}_role` : seed.id;
  const nextOrder = existing.reduce((m, r) => Math.max(m, r.sort_order ?? 0), 0) + 10;
  const now = Timestamp.now();
  const { id: _seedId, ...rest } = seed;
  await setDoc(doc(db, COL, id), { ...rest, sort_order: nextOrder, created_at: now, updated_at: now });
  invalidateDependentCaches();
  return { id, name: seed.name, created: true };
}

// One-time migration: remap legacy role names on existing user docs to the new set.
// Technician / Executive / HR are unchanged. Returns the number of users updated.
const LEGACY_ROLE_MAP: Record<string, string> = {
  'Admin':          'System Admin',
  'Top Management': 'COO',
};

export async function migrateLegacyUserRoles(): Promise<number> {
  const { collection: col, getDocs: getAll, doc: docRef, updateDoc: update } = await import('firebase/firestore');
  const snap = await getAll(col(db, 'users'));
  let updated = 0;
  for (const d of snap.docs) {
    const role = d.data().role as string | undefined;
    if (role && LEGACY_ROLE_MAP[role]) {
      await update(docRef(db, 'users', d.id), { role: LEGACY_ROLE_MAP[role], updated_at: Timestamp.now() });
      updated++;
    }
  }
  return updated;
}
