import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_CAPS, isSuperAdminUser, isActiveSuperAdminUser, resolveCapabilities,
  resolveUserCapabilities, CAPABILITY_KEYS, DEFAULT_ROLES, SUPER_ADMIN_ROLE_NAME,
  type Role, type RoleCapabilities,
} from '../permissions';

// A minimal registry. Roles are matched by NAME (AppUser.role is the foreign key), so these
// stand in for whatever an admin has actually defined in a given tenant.
const role = (name: string, caps: Partial<RoleCapabilities>): Role => ({
  id: name.toLowerCase().replace(/\s+/g, '_'),
  name,
  parent_id: null,
  sort_order: 10,
  is_active: true,
  ...EMPTY_CAPS,
  ...caps,
});

const TECHNICIAN  = role('Technician',   { is_employee: true, has_attendance: true });
const SYS_ADMIN   = role('System Admin', { is_employee: false, is_system_admin: true });
const SUPER_ADMIN = role('Super Admin',  { is_employee: false, is_system_admin: true, is_super_admin: true });
// The capability is what counts, not the name — an admin may rename the role or tick the
// capability onto a role of their own.
const OWNER       = role('Owner',        { is_employee: true, is_super_admin: true });
const ROLES: Role[] = [TECHNICIAN, SYS_ADMIN, SUPER_ADMIN, OWNER];

test('is_super_admin implies is_system_admin — a role carrying it resolves to full access', () => {
  const caps = resolveCapabilities(SUPER_ADMIN);
  assert.equal(caps.is_super_admin, true);
  assert.equal(caps.is_system_admin, true);
  assert.equal(caps.can_manage_users, true);
  assert.equal(caps.can_finalize_payroll, true);
});

test('a super-admin role that does NOT tick System Admin still resolves to the full System Admin set', () => {
  const implied = resolveCapabilities(role('Implied', { is_super_admin: true, is_system_admin: false }));
  const explicit = resolveCapabilities(SYS_ADMIN);
  // Same overrides, plus the flag — a role-based super admin is never weaker than a plain
  // System Admin, whichever way the two toggles were left.
  for (const key of CAPABILITY_KEYS) {
    if (key === 'is_super_admin' || key === 'is_employee' || key === 'has_attendance' || key === 'has_tasks' || key === 'multi_session' || key === 'is_department_head') continue;
    assert.equal(implied[key], explicit[key], `capability ${key} differs`);
  }
  assert.equal(implied.is_system_admin, true);
  assert.equal(implied.is_super_admin, true);
});

test('the per-user flag and the role capability land on the SAME capability set', () => {
  const byFlag = resolveUserCapabilities({ role: 'Technician', is_super_admin: true }, ROLES);
  const byRole = resolveUserCapabilities({ role: 'Owner' }, ROLES);
  assert.deepEqual(byFlag, byRole);
  assert.equal(byFlag.is_super_admin, true);
  assert.equal(byFlag.is_system_admin, true);
});

test('System Admin is NOT a super admin — full access in one system only', () => {
  const caps = resolveUserCapabilities({ role: 'System Admin' }, ROLES);
  assert.equal(caps.is_system_admin, true);
  assert.equal(caps.is_super_admin, false);
  assert.equal(isSuperAdminUser({ role: 'System Admin' }, ROLES), false);
});

test('isSuperAdminUser: per-user flag OR role capability, and nothing else', () => {
  assert.equal(isSuperAdminUser({ role: 'Technician' }, ROLES), false);
  assert.equal(isSuperAdminUser({ role: 'Technician', is_super_admin: true }, ROLES), true);
  assert.equal(isSuperAdminUser({ role: 'Super Admin' }, ROLES), true);
  assert.equal(isSuperAdminUser({ role: 'Owner' }, ROLES), true);
  assert.equal(isSuperAdminUser(null, ROLES), false);
  assert.equal(isSuperAdminUser(undefined, ROLES), false);
});

test('isSuperAdminUser: an unknown role name falls back to a basic employee, not to admin', () => {
  // The mirror writes docs into databases whose roles collection may not hold this role at
  // all. Falling back to anything privileged there would be a cross-tenant escalation.
  assert.equal(isSuperAdminUser({ role: 'Ward Clerk' }, ROLES), false);
  assert.equal(isSuperAdminUser({ role: 'Ward Clerk' }, []), false);
  assert.equal(isSuperAdminUser({ role: undefined }, ROLES), false);
  // ...but the per-user flag still travels with the doc, which is what makes a mirror work.
  assert.equal(isSuperAdminUser({ role: 'Ward Clerk', is_super_admin: true }, []), true);
});

test('isSuperAdminUser: a trainee of a super-admin employee role is not promoted by the trainee set', () => {
  // is_super_admin has no trainee variant (TRAINEE_CAPABILITY_KEYS excludes it), so the
  // trainee access set decides — and traineeDefaults never grants it.
  assert.equal(isSuperAdminUser({ role: 'Owner', employee_type: 'Trainee' }, ROLES), false);
  // The per-user flag is a deliberate act by an admin and outranks the trainee set.
  assert.equal(isSuperAdminUser({ role: 'Owner', employee_type: 'Trainee', is_super_admin: true }, ROLES), true);
});

test('isActiveSuperAdminUser: a deactivated account is never mirrored, however it was granted', () => {
  assert.equal(isActiveSuperAdminUser({ role: 'Super Admin', is_active: true }, ROLES), true);
  assert.equal(isActiveSuperAdminUser({ role: 'Super Admin', is_active: false }, ROLES), false);
  // Absent is_active reads as not-active: the mirror must never act on a doc that does not
  // positively say the account is live.
  assert.equal(isActiveSuperAdminUser({ role: 'Super Admin' }, ROLES), false);
  assert.equal(isActiveSuperAdminUser({ role: 'Technician', is_super_admin: true, is_active: true }, ROLES), true);
  assert.equal(isActiveSuperAdminUser({ role: 'Technician', is_super_admin: true, is_active: false }, ROLES), false);
});

test('the seeded Super Admin role carries the capability; the seeded System Admin role does not', () => {
  const seededSuper = DEFAULT_ROLES.find(r => r.name === SUPER_ADMIN_ROLE_NAME);
  const seededSystem = DEFAULT_ROLES.find(r => r.name === 'System Admin');
  assert.ok(seededSuper, 'Super Admin must be in DEFAULT_ROLES');
  assert.equal(seededSuper!.is_super_admin, true);
  assert.equal(seededSuper!.is_system_admin, true);
  assert.equal(seededSuper!.is_protected, true);
  assert.ok(seededSystem);
  assert.equal(seededSystem!.is_super_admin, false);
});

test('every capability key has a resolved value — a new key can never silently read undefined', () => {
  const caps = resolveUserCapabilities({ role: 'Super Admin' }, ROLES);
  for (const key of CAPABILITY_KEYS) {
    assert.equal(typeof caps[key], 'boolean', `capability ${key} is not a boolean`);
  }
});
