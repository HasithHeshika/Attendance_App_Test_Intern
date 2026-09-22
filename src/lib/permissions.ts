// Type-only: erased at compile time, so this module stays safe to import from Node/Admin-SDK
// server routes (src/lib/authClaims.ts) without pulling in the client Firebase SDK.
import type { Timestamp } from 'firebase/firestore';

// ─── Capability model ──────────────────────────────────────────────────────────
// Roles are data-driven (stored in the `roles` Firestore collection) and gate
// behaviour through capability flags rather than hard-coded role names. This lets
// admins add/edit roles from the UI without any code change.

export interface RoleCapabilities {
  is_employee:       boolean;  // has an employee profile (attendance, leaves, supervisor)
  has_attendance:    boolean;  // own check-in/out + attendance records
  has_tasks:         boolean;  // own daily task / workload log (Tasks tab)
  can_view_team_tasks: boolean; // view team members' daily tasks (read-only Team view)
  can_assign_tasks:  boolean;  // assign upcoming tasks to team members (Assign Task action on the Team view)
  multi_session:     boolean;  // can record multiple check-in/out sessions per day
  can_approve:       boolean;  // approve team attendance; assignable as supervisor
  can_approve_leads: boolean;  // may approve subordinate roles that are themselves approvers
  can_approve_leaves: boolean; // approve team leave requests (separate from attendance)
  // Southern Lanka (carecode.org) tenant only — see the isSouthernlanka gate on
  // src/app/(pages)/roles/page.tsx. Lets HR/Admin holders assign a RESTRICTED leave type
  // (leave_types.allow_direct_apply === false — hidden from the normal "+ Apply Leave"
  // dropdown) directly onto any employee from the Leave Management page. System Admin always
  // has it (withSystemAdminOverrides). Opt-in (default false) on every other role/tenant.
  can_apply_restricted_leaves: boolean;
  can_approve_suspense: boolean; // approve/reject suspense credit requests & expense submissions
  // Southern Lanka (carecode.org) tenant only — approve/reject employee overtime requests
  // (see src/services/otRequestService.ts). Routed like leave: HODs whose departments cover
  // the applicant, plus the role tree above them. Opt-in (default false) on every role;
  // System Admin always has it (withSystemAdminOverrides). Payroll-tenant capability.
  can_approve_ot: boolean;
  can_approve_technicians: boolean; // may pick AND approve technician-category employees (+ cascade a team leader's team)
  can_lead_team:     boolean;  // may pick technicians onto their OWN team without approving (pick-only team leader)
  can_send_notifications: boolean; // may compose & send notifications to all users or selected users
  can_report:        boolean;  // view reports
  can_manage_shifts: boolean;  // allocate overnight-shift periods to employees
  can_manage_working_schedules: boolean; // assign future per-day working places to technicians (CSV)
  can_manage_leaves: boolean;  // leave-type / special-leave admin
  can_view_users:    boolean;  // read-only user directory + summary/daily downloads (no add/edit)
  can_manage_users:  boolean;  // user / company / outstation admin
  // Southern Lanka (carecode.org) tenant only — see the isSouthernlanka gate on
  // src/app/(pages)/roles/page.tsx. Split out of can_manage_users/can_view_users so a role can be
  // granted Departments, Company or Schedules access independently instead of only via the
  // blanket user-management capability. Absent on older role docs — resolveCapabilities()
  // defaults each to its can_manage_users/can_view_users equivalent so nothing regresses.
  can_view_departments:   boolean; // read-only Departments page
  can_manage_departments: boolean; // add/edit/delete/toggle departments & sub-departments
  can_view_company:       boolean; // read-only Companies page
  can_manage_company:     boolean; // create/edit companies, manage their supervisors
  // Southern Lanka (carecode.org) tenant only. Lets a role use the Global Company Selector in
  // the Top Navbar to switch its working context across every company under this tenant. Without
  // it, that switcher is hidden and the user's context is always locked to their own
  // AppUser.company_id (see useCompanyContext in src/store/companyContextStore.ts). Opt-in
  // (default false); System Admin always has it (withSystemAdminOverrides).
  can_manage_all_companies: boolean;
  can_view_schedules:     boolean; // read-only Schedule grid
  can_manage_schedules:   boolean; // assign/remove shift assignments on the Schedule grid
  // Southern Lanka (carecode.org) tenant only — declare / bulk-import (Excel) and manage
  // employee Day Offs, rendered as a distinct overlay on the Schedule grid. Also granted, as a
  // fallback, to any Head-of-Department role that actually has departments assigned to the
  // user (AppUser.hod_department_ids non-empty) — see the guard on the Schedule page.
  can_declare_day_offs:   boolean;
  // Southern Lanka (carecode.org) tenant only — marks the standalone Head of Department (HOD)
  // role. A user holding a role with this on picks one or more departments on the Users page
  // (AppUser.hod_department_ids) and manages leave approvals + shift rosters for exactly those
  // departments — see southernlankaApprovers/getLeaveRequests in apiCompat.ts. This is a
  // per-USER assignment (gated by role, but stored on the user) — Role itself carries no
  // department scoping of its own any more.
  is_department_head: boolean;
  // View the admin-facing Attendance View page (everyone's attendance, not just your own) —
  // separate from has_attendance (own check-in/out). Payroll tenant only: gated by BOTH this
  // capability and tenant.features.payroll, matching the rest of the payroll module.
  can_view_attendance: boolean;
  can_view_payroll:  boolean;  // view payroll configuration & pay profiles (read-only). Payroll tenant only.
  can_manage_payroll_config: boolean; // create/edit payroll policies, components, pay groups. Payroll tenant only.
  can_manage_pay_profiles:   boolean; // create/edit employee pay profiles (effective-dated salary). Payroll tenant only.
  // View one's OWN finalized payslips (My Payslips) — same risk class as has_attendance/
  // has_tasks (own data), not the "manage payroll" module, so it defaults true wherever
  // those do. Payroll tenant only.
  can_view_own_payslip: boolean;
  // Maker/checker/lock separation for a payroll run — deliberately three separate
  // capabilities rather than reusing can_manage_pay_profiles. Payroll tenant only.
  can_generate_payroll: boolean; // fetch attendance + generate/recalculate a run's results
  can_review_payroll:   boolean; // mark a generated run reviewed
  can_finalize_payroll: boolean; // lock a reviewed run — makes payslips visible to employees; gates bank export
  // View the Biometric Enrollment Status page (/biometric-enrollment) — who has registered a
  // fingerprint/Face ID on the HF-X05 terminals vs who hasn't. Not tenant-restricted in the
  // matrix (same precedent as can_view_payroll): the page itself is gated by the
  // biometricEnrollment tenant flag, so this stays inert wherever that's off.
  can_view_biometric_enrollment: boolean;
  is_system_admin:   boolean;  // full access (DB editor, Roles mgmt) — implies all above
  // ── The top of the ROLE ladder. Read the three-level model in CLAUDE.md (Tenancy) first. ──
  // Implies is_system_admin (resolveCapabilities/resolveUserCapabilities force it on), so a
  // holder has full access in THIS system. It also makes them eligible for the cross-database
  // mirror: superAdminSync copies every active super admin into every OTHER tenant database, so
  // the same person signs in on any domain and is a full admin there too.
  //
  // What it deliberately does NOT grant: platform configuration (/platform — which domains
  // exist, which database each talks to, which modules each org gets). That authority lives
  // ONLY in the `platform_admins` collection of the `tenants` registry database and is verified
  // server-side by verifyPlatformCaller (src/lib/platformAdmins.ts). It has to stay there:
  // roles are edited INSIDE a tenant, so if this flag granted platform access, anyone who can
  // edit roles in one organisation could tick a box and own every other organisation in the
  // deployment. A platform admin still has to add the person by email.
  is_super_admin:    boolean;
}

export const CAPABILITY_KEYS: (keyof RoleCapabilities)[] = [
  'is_employee',
  'has_attendance',
  'has_tasks',
  'can_view_team_tasks',
  'can_assign_tasks',
  'multi_session',
  'can_approve',
  'can_approve_leads',
  'can_approve_leaves',
  'can_apply_restricted_leaves',
  'can_approve_suspense',
  'can_approve_ot',
  'can_approve_technicians',
  'can_lead_team',
  'can_send_notifications',
  'can_report',
  'can_manage_shifts',
  'can_manage_working_schedules',
  'can_manage_leaves',
  'can_view_users',
  'can_manage_users',
  'can_view_departments',
  'can_manage_departments',
  'can_view_company',
  'can_manage_company',
  'can_manage_all_companies',
  'can_view_schedules',
  'can_manage_schedules',
  'can_declare_day_offs',
  'is_department_head',
  'can_view_attendance',
  'can_view_payroll',
  'can_manage_payroll_config',
  'can_manage_pay_profiles',
  'can_view_own_payslip',
  'can_generate_payroll',
  'can_review_payroll',
  'can_finalize_payroll',
  'can_view_biometric_enrollment',
  'is_system_admin',
  'is_super_admin',
];

// The Roles page renders these APART from the ordinary permission matrix (they are not
// "one more toggle"), most powerful last. Anything listed here is excluded from the matrix
// there, so adding a key to this set is all it takes to promote it.
export const ELEVATED_CAPABILITY_KEYS: (keyof RoleCapabilities)[] = [
  'is_system_admin',
  'is_super_admin',
];

// Human-readable labels for the Roles admin UI toggles
export const CAPABILITY_LABELS: Record<keyof RoleCapabilities, { label: string; desc: string }> = {
  is_employee:       { label: 'Employee',         desc: 'Has an employee profile (company, supervisor, leaves)' },
  has_attendance:    { label: 'Own attendance',   desc: 'Can check in / out and has attendance records' },
  has_tasks:         { label: 'Daily tasks',      desc: 'Can log a daily task / workload sheet (shows the Tasks tab). Off → no Tasks tab.' },
  can_view_team_tasks: { label: 'Team tasks',     desc: 'Can view team members’ daily tasks (read-only Team view on the Tasks page).' },
  can_assign_tasks:  { label: 'Assign tasks',     desc: 'Can assign upcoming tasks to team members (Assign Task action on the Team view of the Tasks page).' },
  multi_session:     { label: 'Session mode',     desc: 'Can record multiple work sessions (check-in/out) in a single day' },
  can_approve:       { label: 'Approve',          desc: 'Approves team attendance & leaves; can be a supervisor' },
  can_approve_leads: { label: 'Approve leads',     desc: 'May approve subordinate roles that are themselves approvers. Off → approves only non-approver staff (e.g. a Team Leader approves only Technicians).' },
  can_approve_leaves:{ label: 'Approve leaves',    desc: 'Can approve team leave requests of lower levels. Off → no Team Requests tab on Leaves.' },
  can_apply_restricted_leaves: { label: 'Can Assign/Apply Restricted Leaves', desc: 'Can assign a restricted leave type (one that users can’t apply for themselves) directly onto any employee from the Leave Management page. Southern Lanka tenant only.' },
  can_approve_suspense: { label: 'Approve suspense', desc: 'Approve / reject suspense credit requests and expense submissions, and see the org-wide suspense approvals queue.' },
  can_approve_ot:    { label: 'Approve overtime',  desc: 'Approve / reject employee overtime requests for the departments and roles below this one. Southern Lanka tenant only.' },
  can_approve_technicians: { label: 'Approve technicians', desc: 'Can pick AND approve technician-category employees, and approve a team leader’s whole team at once. Off → this role can’t approve technicians.' },
  can_lead_team:     { label: 'Lead a team',      desc: 'Can pick technicians onto their own team, but cannot approve them — an approver above still approves the team. Independent of “Approve technicians”.' },
  can_send_notifications: { label: 'Send notifications', desc: 'Can compose and send notifications from the bell — to everyone (broadcast) or to selected users.' },
  can_report:        { label: 'Reports',          desc: 'Can view reports' },
  can_manage_shifts: { label: 'Manage shifts',    desc: 'Allocate overnight-shift periods to team members' },
  can_manage_working_schedules: { label: 'Manage working schedules', desc: 'Assign future per-day working places to technician-category employees (CSV upload).' },
  can_manage_leaves: { label: 'Manage leaves',    desc: 'Manage leave types and special leaves' },
  can_view_users:    { label: 'View users',       desc: 'View the user directory and download user summary & daily reports — read-only (cannot add or edit)' },
  can_manage_users:  { label: 'Manage users',     desc: 'Manage users, companies and outstation locations' },
  can_view_departments:   { label: 'View departments',   desc: 'View the Departments page — read-only (cannot add, edit or delete)' },
  can_manage_departments: { label: 'Manage departments', desc: 'Add, edit, delete and activate/deactivate departments & sub-departments' },
  can_view_company:       { label: 'View company',       desc: 'View the Companies page — read-only (cannot add, edit or manage supervisors)' },
  can_manage_company:     { label: 'Manage company',     desc: 'Create and edit companies, and manage their supervisors' },
  can_manage_all_companies: { label: 'Switch companies', desc: 'Use the Global Company Selector in the Top Navbar to work across every company under this tenant, instead of being locked to your own company. Southern Lanka tenant only.' },
  can_view_schedules:     { label: 'View schedules',     desc: 'View the Schedule grid — read-only (cannot assign or remove shifts)' },
  can_manage_schedules:   { label: 'Manage schedules',   desc: 'Assign and remove shift assignments on the Schedule grid' },
  can_declare_day_offs:   { label: 'Declare day offs',    desc: 'Declare, bulk-import (Excel) and manage employee Day Offs shown on the Schedule grid. A Head of Department with assigned departments also gets this automatically. Southern Lanka tenant only.' },
  is_department_head: { label: 'Head of Department', desc: 'Standalone HOD role — pick departments per user on the Users page; manages leave approvals and shift rosters for exactly those departments.' },
  can_view_attendance: { label: 'View Attendance List', desc: 'View the admin Attendance View page — everyone’s attendance for a chosen month, not just your own. Southern Lanka tenant only.' },
  can_view_payroll:  { label: 'View payroll',     desc: 'View payroll policies, components, pay groups and employee pay profiles — read-only. Southern Lanka tenant only.' },
  can_manage_payroll_config: { label: 'Manage payroll config', desc: 'Create/edit payroll policies, payroll components and pay groups. Southern Lanka tenant only.' },
  can_manage_pay_profiles:   { label: 'Manage pay profiles',   desc: 'Create/edit employee pay profiles (basic salary, recurring components, effective dates). Southern Lanka tenant only.' },
  can_view_own_payslip: { label: 'View own payslips', desc: 'See "My Payslips" — preview and download PDF snapshots of your OWN finalized payslips. Southern Lanka tenant only.' },
  can_generate_payroll: { label: 'Generate payroll',  desc: 'Fetch attendance for a period and generate/recalculate a payroll run’s results. Southern Lanka tenant only.' },
  can_review_payroll:   { label: 'Review payroll',    desc: 'Mark a generated payroll run as reviewed. Southern Lanka tenant only.' },
  can_finalize_payroll: { label: 'Finalize payroll',  desc: 'Lock a reviewed payroll run — makes payslips visible to employees and unlocks the bank-transfer export. Southern Lanka tenant only.' },
  can_view_biometric_enrollment: { label: 'View biometric enrollment', desc: 'View the Biometric Enrollment Status page — who has registered a fingerprint or Face ID on the attendance terminals, and who hasn’t.' },
  is_system_admin:   { label: 'System Admin',     desc: 'Full access — database editor and role management (implies everything). Limited to THIS system.' },
  is_super_admin:    { label: 'Super Admin',      desc: 'Full access in every system this account exists in — the account is mirrored into every organisation’s database — and eligibility for platform configuration, which a platform administrator still has to grant by email. Implies System Admin.' },
};

// Capability keys configurable for a trainee variant (employee + non-admin always).
export const TRAINEE_CAPABILITY_KEYS: (keyof RoleCapabilities)[] = CAPABILITY_KEYS.filter(
  k => k !== 'is_employee' && !ELEVATED_CAPABILITY_KEYS.includes(k),
);

// ─── Role (Firestore doc) ───────────────────────────────────────────────────────
export interface Role extends RoleCapabilities {
  id:          string;   // slug (doc id), e.g. "team_leader"
  name:        string;   // display name + the value stored on user.role, e.g. "Team Leader"
  // Attendance category — drives picking, food allowances and self-approval (see
  // roleCategory). Optional for back-compat: when unset it's derived from the tree/caps.
  category?:   RoleCategory;
  parent_id?:  string | null; // id of the parent (approver) role; null/undefined = top of tree
  // Roles are intentionally decoupled from Department entirely — a role is just a job title +
  // capability set + place in the approval tree. Department scoping lives ONLY on the user
  // profile now: AppUser.department (home department) and AppUser.hod_department_ids (which
  // departments a Head of Department manages) — see src/lib/types.ts. A role doc from before
  // this change may still carry legacy department_ids/department_names/department_id/
  // department_name fields in Firestore; they're inert leftover data the app never reads.
  // Separate access set applied when the user's employee_type is "Trainee" (employee
  // roles only; non-employee roles have no trainee variant).
  trainee?:    RoleCapabilities;
  sort_order:  number;
  is_active:   boolean;
  is_protected?: boolean; // built-in roles that can't be deleted
  created_at?: Timestamp;
  updated_at?: Timestamp;
}

// ─── Role hierarchy helpers ─────────────────────────────────────────────────────
// The role tree drives approvals: a user's parent role is their approver tier.
type RoleNode = { id: string; name: string; parent_id?: string | null };

function byName(roleName: string | undefined, roles: RoleNode[] | undefined): RoleNode | undefined {
  if (!roleName) return undefined;
  return roles?.find(r => r.name === roleName);
}

// Display name of a role's parent (the tier that approves it), or null at the top.
export function roleParentName(roleName: string | undefined, roles: RoleNode[] | undefined): string | null {
  const r = byName(roleName, roles);
  if (!r?.parent_id) return null;
  return roles?.find(x => x.id === r.parent_id)?.name ?? null;
}

// Names of the roles directly below `roleName` (i.e. the roles it approves).
export function childRoleNamesOf(roleName: string | undefined, roles: RoleNode[] | undefined): string[] {
  const r = byName(roleName, roles);
  if (!r) return [];
  return (roles ?? []).filter(x => x.parent_id === r.id).map(x => x.name);
}

// Names of EVERY role below `roleName` (all tiers down the tree). An approver can
// approve anyone in any tier beneath them.
export function descendantRoleNamesOf(roleName: string | undefined, roles: RoleNode[] | undefined): string[] {
  const r = byName(roleName, roles);
  if (!r) return [];
  const ids = descendantRoleIdsOf(r.id, roles);
  return (roles ?? []).filter(x => ids.has(x.id)).map(x => x.name);
}

// Names of every role above `roleName` up the parent chain (its potential approvers).
export function ancestorRoleNamesOf(roleName: string | undefined, roles: RoleNode[] | undefined): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  let cur = byName(roleName, roles);
  while (cur?.parent_id) {
    if (seen.has(cur.id)) break;       // cycle guard
    seen.add(cur.id);
    const parent = roles?.find(x => x.id === cur!.parent_id);
    if (!parent) break;
    names.push(parent.name);
    cur = parent;
  }
  return names;
}

// Ids of every role below `roleId` (used to forbid creating a cycle when re-parenting).
export function descendantRoleIdsOf(roleId: string, roles: RoleNode[] | undefined): Set<string> {
  const out = new Set<string>();
  const walk = (id: string) => {
    (roles ?? []).filter(r => r.parent_id === id).forEach(r => {
      if (!out.has(r.id)) { out.add(r.id); walk(r.id); }
    });
  };
  walk(roleId);
  return out;
}

// Sensible default trainee access for a role: an employee with attendance (and the
// role's session mode) but no approval/management rights. Admins tune it per role.
export function traineeDefaults(roleCaps: RoleCapabilities): RoleCapabilities {
  return {
    is_employee:       true,
    has_attendance:    true,
    has_tasks:         true,
    can_view_team_tasks: false,
    can_assign_tasks:  false,
    multi_session:     !!roleCaps.multi_session,
    can_approve:       false,
    can_approve_leads: false,
    can_approve_leaves: false,
    can_apply_restricted_leaves: false,
    can_approve_suspense: false,
    can_approve_ot:    false,
    can_approve_technicians: false,
    can_lead_team:     false,
    can_send_notifications: false,
    can_report:        false,
    can_manage_shifts: false,
    can_manage_working_schedules: false,
    can_manage_leaves: false,
    can_view_users:    false,
    can_manage_users:  false,
    can_view_departments:   false,
    can_manage_departments: false,
    can_view_company:       false,
    can_manage_company:     false,
    can_manage_all_companies: false,
    can_view_schedules:     false,
    can_manage_schedules:   false,
    can_declare_day_offs:   false,
    is_department_head: false,
    can_view_attendance: false,
    can_view_payroll:  false,
    can_manage_payroll_config: false,
    can_manage_pay_profiles:   false,
    can_view_own_payslip: true, // own-data cap, same precedent as has_attendance/has_tasks above
    can_generate_payroll: false,
    can_review_payroll:   false,
    can_finalize_payroll: false,
    can_view_biometric_enrollment: false,
    is_system_admin:   false,
    is_super_admin:    false,
  };
}

// ─── Capability resolution ──────────────────────────────────────────────────────
// A System Admin implicitly has every management capability. Employee-ness and
// attendance still follow the role's own flags (System Admin is a non-employee).
// When `employeeType` is "Trainee" and the role is an employee role, the role's
// separate `trainee` access set is used instead.
export function resolveCapabilities(
  role: Role | RoleCapabilities | undefined | null,
  employeeType?: string,
): RoleCapabilities {
  if (!role) return { ...FALLBACK_CAPS };
  const isTrainee = !!employeeType && employeeType.toLowerCase() === 'trainee';
  const traineeSet = (role as Role).trainee;
  // Non-employee roles (System Admin) never use a trainee variant.
  const src: RoleCapabilities = (isTrainee && role.is_employee)
    ? (traineeSet ?? traineeDefaults(role))
    : role;

  // Existing role docs may predate these flags; when a field is absent, default it
  // to a sensible existing capability so nothing disappears until an admin tunes it.
  const hasTasksRaw    = (src as { has_tasks?: boolean }).has_tasks;
  const viewTeamRaw    = (src as { can_view_team_tasks?: boolean }).can_view_team_tasks;
  const assignTasksRaw = (src as { can_assign_tasks?: boolean }).can_assign_tasks;
  const approveTechRaw = (src as { can_approve_technicians?: boolean }).can_approve_technicians;

  const viewTeamTasks = viewTeamRaw === undefined ? !!src.can_approve : !!viewTeamRaw;
  const base: RoleCapabilities = {
    is_employee:       !!src.is_employee,
    has_attendance:    !!src.has_attendance,
    has_tasks:         hasTasksRaw === undefined ? !!src.has_attendance : !!hasTasksRaw,
    can_view_team_tasks: viewTeamTasks,
    // Existing role docs predate this flag — default it to whatever they already had
    // for team-task visibility so a supervisor doesn't silently lose the ability.
    can_assign_tasks:  assignTasksRaw === undefined ? viewTeamTasks : !!assignTasksRaw,
    multi_session:     !!src.multi_session,
    can_approve:       !!src.can_approve,
    // Default true (only restrictive when explicitly disabled) so existing roles
    // keep approving normally until an admin turns it off.
    can_approve_leads:  src.can_approve_leads  !== false,
    can_approve_leaves: src.can_approve_leaves !== false,
    // Opt-in (default false) — Southern Lanka HR/Admin restricted-leave assignment.
    can_apply_restricted_leaves: !!src.can_apply_restricted_leaves,
    // Opt-in (default false) so existing roles don't silently gain suspense approval.
    can_approve_suspense: !!src.can_approve_suspense,
    // Opt-in (default false) — new Southern Lanka overtime-approval capability.
    can_approve_ot:    !!src.can_approve_ot,
    can_approve_technicians: approveTechRaw === undefined ? !!src.can_approve : !!approveTechRaw,
    can_lead_team:     !!src.can_lead_team,   // opt-in: off unless explicitly enabled
    can_send_notifications: !!src.can_send_notifications,   // opt-in
    can_report:        !!src.can_report,
    can_manage_shifts: !!src.can_manage_shifts,
    can_manage_working_schedules: !!src.can_manage_working_schedules,
    can_manage_leaves: !!src.can_manage_leaves,
    can_view_users:    !!src.can_view_users,
    can_manage_users:  !!src.can_manage_users,
    // Southern Lanka only (see the interface comment above). Absent on role docs written
    // before these fields existed — default each to its can_manage_users/can_view_users
    // equivalent so an existing admin/viewer role doesn't lose Departments/Company/Schedules
    // access the moment this ships; an admin can then tune it per role from here on.
    can_view_departments:   (src as { can_view_departments?: boolean }).can_view_departments   === undefined ? (!!src.can_manage_users || !!src.can_view_users) : !!src.can_view_departments,
    can_manage_departments: (src as { can_manage_departments?: boolean }).can_manage_departments === undefined ? !!src.can_manage_users : !!src.can_manage_departments,
    can_view_company:       (src as { can_view_company?: boolean }).can_view_company   === undefined ? (!!src.can_manage_users || !!src.can_view_users) : !!src.can_view_company,
    can_manage_company:     (src as { can_manage_company?: boolean }).can_manage_company === undefined ? !!src.can_manage_users : !!src.can_manage_company,
    // Opt-in (default false) — new capability; no legacy role doc should silently gain
    // multi-company access.
    can_manage_all_companies: !!src.can_manage_all_companies,
    can_view_schedules:     (src as { can_view_schedules?: boolean }).can_view_schedules   === undefined ? (!!src.can_manage_users || !!src.can_view_users) : !!src.can_view_schedules,
    can_manage_schedules:   (src as { can_manage_schedules?: boolean }).can_manage_schedules === undefined ? !!src.can_manage_users : !!src.can_manage_schedules,
    // Opt-in (default false) — new capability; the HOD fallback lives on the Schedule page.
    can_declare_day_offs:   !!src.can_declare_day_offs,
    // Opt-in (default false) — absent on every role doc until an admin ticks it on the HOD role.
    is_department_head: !!src.is_department_head,
    // Opt-in (default false) — a new admin capability, same precedent as can_view_payroll below.
    can_view_attendance: !!src.can_view_attendance,
    // Opt-in (default false) so existing roles don't silently gain payroll access.
    can_view_payroll:  !!src.can_view_payroll,
    can_manage_payroll_config: !!src.can_manage_payroll_config,
    can_manage_pay_profiles:   !!src.can_manage_pay_profiles,
    // Own-data cap — default true (absent on a role doc reads as true), same precedent as
    // has_attendance/has_tasks, not the opt-in "manage payroll" precedent above.
    can_view_own_payslip: (src as { can_view_own_payslip?: boolean }).can_view_own_payslip !== false,
    can_generate_payroll: !!src.can_generate_payroll,
    can_review_payroll:   !!src.can_review_payroll,
    can_finalize_payroll: !!src.can_finalize_payroll,
    // Opt-in (default false) — same precedent as can_declare_day_offs above.
    can_view_biometric_enrollment: !!src.can_view_biometric_enrollment,
    is_system_admin:   !!src.is_system_admin,
    // Opt-in (default false) — absent on every role doc written before this capability existed.
    is_super_admin:    !!src.is_super_admin,
  };
  // Super Admin IMPLIES System Admin: a role carrying it resolves to exactly the same
  // full-access set, with is_super_admin left true on top (withSystemAdminOverrides spreads
  // `caps` first, so the flag survives).
  return (base.is_system_admin || base.is_super_admin) ? withSystemAdminOverrides(base) : base;
}

// Every management capability, forced true — shared by resolveCapabilities' own
// is_system_admin / is_super_admin branch above and resolveUserCapabilities' per-user
// is_super_admin override below, so every path grants EXACTLY the same full-access set.
function withSystemAdminOverrides(caps: RoleCapabilities): RoleCapabilities {
  return {
    ...caps,
    is_system_admin:   true,
    can_approve:        true,
    can_approve_leads:  true,
    can_approve_leaves: true,
    can_apply_restricted_leaves: true,
    can_approve_suspense: true,
    can_approve_ot:    true,
    can_approve_technicians: true,
    can_lead_team:     true,
    can_send_notifications: true,
    can_view_team_tasks: true,
    can_assign_tasks:  true,
    can_report:        true,
    can_manage_shifts: true,
    can_manage_working_schedules: true,
    can_manage_leaves: true,
    can_view_users:    true,
    can_manage_users:  true,
    can_view_departments:   true,
    can_manage_departments: true,
    can_view_company:       true,
    can_manage_company:     true,
    can_manage_all_companies: true,
    can_view_schedules:     true,
    can_manage_schedules:   true,
    can_declare_day_offs:   true,
    can_view_attendance: true,
    can_view_payroll:  true,
    can_manage_payroll_config: true,
    can_manage_pay_profiles:   true,
    can_view_own_payslip: true,
    can_generate_payroll: true,
    can_review_payroll:   true,
    can_finalize_payroll: true,
    can_view_biometric_enrollment: true,
  };
}

/** The minimum of an AppUser this module needs to decide what someone can do. */
export interface CapabilitySubject {
  role?:           string;
  employee_type?:  string;
  /** Per-user override, independent of the assigned Role — see AppUser.is_super_admin. */
  is_super_admin?: boolean;
  is_active?:      boolean;
}

// Resolve a USER's capabilities — like resolveCapabilitiesByName, but also honours the
// per-user `is_super_admin` override (see AppUser.is_super_admin) that promotes the person
// regardless of their assigned Role. Use this instead of resolveCapabilitiesByName wherever a
// caller/approver/viewer's own AppUser doc (not just their role name) is already in hand.
//
// Super admin is "role says so OR the user flag says so", and either way it implies System
// Admin — the two routes to it must land on the SAME capability set, or a role-based super
// admin would quietly be weaker than a flag-based one.
export function resolveUserCapabilities(
  user: CapabilitySubject | null | undefined,
  roles: Role[] | undefined,
): RoleCapabilities {
  const base = resolveCapabilitiesByName(user?.role, roles, user?.employee_type);
  if (!user?.is_super_admin) return base;   // role-carried super admin is already resolved
  return withSystemAdminOverrides({ ...base, is_super_admin: true });
}

/**
 * Is this person a super admin — full access in every system this account exists in?
 *
 * The ONE definition, so the UI, the user directory and the cross-database mirror can never
 * disagree about who gets copied into every tenant database. True when the per-user flag is
 * set OR the person's role carries the is_super_admin capability.
 *
 * Says nothing about platform configuration: that is the platform_admins list in the tenants
 * registry database (src/lib/platformAdmins.ts), and no role can grant it.
 */
export function isSuperAdminUser(
  user: CapabilitySubject | null | undefined,
  roles: Role[] | undefined,
): boolean {
  if (!user) return false;
  return resolveUserCapabilities(user, roles).is_super_admin;
}

/**
 * Super admin AND still an active account. A deactivated account keeps its Firebase Auth
 * login, so "active" is the difference between a revoked admin and a live one — the mirror
 * sync uses this, never isSuperAdminUser alone.
 */
export function isActiveSuperAdminUser(
  user: CapabilitySubject | null | undefined,
  roles: Role[] | undefined,
): boolean {
  if (user?.is_active !== true) return false;
  return isSuperAdminUser(user, roles);
}

// Used when a user's role can't be found in the registry yet — treat as a basic
// field employee (attendance + leaves, no approvals, no admin).
export const FALLBACK_CAPS: RoleCapabilities = {
  is_employee:       true,
  has_attendance:    true,
  has_tasks:         true,
  can_view_team_tasks: false,
  can_assign_tasks:  false,
  multi_session:     false,
  can_approve:       false,
  can_approve_leads: true,
  can_approve_leaves: true,
  can_apply_restricted_leaves: false,
  can_approve_suspense: false,
  can_approve_ot:    false,
  can_approve_technicians: false,
  can_lead_team:     false,
  can_send_notifications: false,
  can_report:        false,
  can_manage_shifts: false,
  can_manage_working_schedules: false,
  can_manage_leaves: false,
  can_view_users:    false,
  can_manage_users:  false,
  can_view_departments:   false,
  can_manage_departments: false,
  can_view_company:       false,
  can_manage_company:     false,
  can_manage_all_companies: false,
  can_view_schedules:     false,
  can_manage_schedules:   false,
  can_declare_day_offs:   false,
  is_department_head: false,
  can_view_attendance: false,
  can_view_payroll:  false,
  can_manage_payroll_config: false,
  can_manage_pay_profiles:   false,
  can_view_own_payslip: true,
  can_generate_payroll: false,
  can_review_payroll:   false,
  can_finalize_payroll: false,
  can_view_biometric_enrollment: false,
  is_system_admin:   false,
  is_super_admin:    false,
};

// Legacy role names map onto their new equivalents so existing users keep working
// before the one-time migration runs. (Keep in sync with roleService LEGACY_ROLE_MAP.)
export const LEGACY_ROLE_ALIASES: Record<string, string> = {
  'Admin':          'System Admin',
  'Top Management': 'COO',
};

// Resolve a role *by name* into its capabilities.
// Resolution order, so an admin can never be locked out by an incomplete registry:
//   1. the live registry (by exact name, then legacy alias)
//   2. the built-in DEFAULT_ROLES (by exact name, then legacy alias) — guarantees
//      System Admin / the standard roles always resolve even if not yet seeded
//   3. unknown role → basic employee fallback
export function resolveCapabilitiesByName(
  roleName: string | undefined,
  roles: Role[] | undefined,
  employeeType?: string,
): RoleCapabilities {
  if (!roleName) return { ...FALLBACK_CAPS };
  const aliased = LEGACY_ROLE_ALIASES[roleName] ?? roleName;

  const find = (list: Array<RoleCapabilities & { name: string }> | undefined) =>
    list?.find(r => r.name === roleName) ?? list?.find(r => r.name === aliased);

  const match = (find(roles) ?? find(DEFAULT_ROLES)) as Role | undefined;
  return match ? resolveCapabilities(match, employeeType) : { ...FALLBACK_CAPS };
}

// "Executive" tier = management roles — everyone except non-approver staff (Technician)
// and first-line leads (Team Leader). Equivalent to: approves, and approves other
// approvers too. Used to bucket approvals into Staff vs Executives.
export function isExecutiveRole(roleName: string | undefined, roles: Role[] | undefined): boolean {
  const caps = resolveCapabilitiesByName(roleName, roles);
  return caps.can_approve && caps.can_approve_leads;
}

// The three legacy attendance categories, derived from the role tree + capabilities:
//   • top_management — a root role with no approver above it (e.g. COO). Self-approves
//     its own attendance; no food allowance; not pickable.
//   • executive      — approves other approvers (can_approve && can_approve_leads) and
//     reports upward. No food allowance; not pickable; approved on the Approvals page.
//   • technician     — reports upward and is NOT an approve-leads role (Technician,
//     Team Leader). Pickable by others, and the only category with food allowances.
export type RoleCategory = 'technician' | 'executive' | 'top_management';

export const ROLE_CATEGORY_OPTIONS: { value: RoleCategory; label: string; desc: string }[] = [
  { value: 'technician',     label: 'Technician',      desc: 'Pickable by others and eligible for food allowances (e.g. Technician, Team Leader).' },
  { value: 'executive',      label: 'Executive',       desc: 'Approved on the Approvals page. No food allowance; not pickable.' },
  { value: 'top_management', label: 'Top Management',  desc: 'Self-approves their own attendance. No food allowance; not pickable (e.g. COO).' },
];

export function categoryLabel(c: RoleCategory): string {
  return ROLE_CATEGORY_OPTIONS.find(o => o.value === c)?.label ?? c;
}

/** Does something scoped by role category (e.g. a Chamary's `categories`) serve this category?
 *  Absent/empty means EVERYONE — every chamary that existed before per-category chamaries were
 *  introduced served whoever was already eligible, so the absent case has to keep meaning that. */
export function categoryAllowed(categories: RoleCategory[] | undefined | null, category: RoleCategory): boolean {
  return !categories || categories.length === 0 || categories.includes(category);
}

// Resolve a role's attendance category: an explicitly set `category` wins; otherwise it's
// derived from the tree/capabilities so legacy roles (and any not yet categorised) still work.
export function roleCategory(roleName: string | undefined, roles: Role[] | undefined): RoleCategory {
  const r = roles?.find(x => x.name === roleName);
  if (r?.category) return r.category;
  if (roleParentName(roleName, roles) === null) return 'top_management';
  if (isExecutiveRole(roleName, roles)) return 'executive';
  return 'technician';
}

// Technician category = pickable + food-allowance eligible.
export function isTechnicianRole(roleName: string | undefined, roles: Role[] | undefined): boolean {
  return roleCategory(roleName, roles) === 'technician';
}

// Who may PICK technician-category members: an EMPLOYEE approver that is NOT itself in the
// technician category — i.e. an executive or top-management employee. Technicians and team
// leaders are pickable subjects, never pickers. System Admin is the super-admin and can do
// everything (including pick), even though it isn't an attendance-recording employee role.
// Who may PICK technicians onto a team AT ALL — either a pick-only team leader (`can_lead_team`,
// which includes technician-category roles like Team Leader) or a full approver
// (`can_approve_technicians`). System Admin can do everything.
export function canPickTechnicians(roleName: string | undefined, roles: Role[] | undefined): boolean {
  const caps = resolveCapabilitiesByName(roleName, roles);
  if (caps.is_system_admin) return true;
  return !!caps.is_employee && (!!caps.can_lead_team || !!caps.can_approve_technicians);
}

// Who may APPROVE technician attendance (and cascade-approve a team leader's whole team).
// Pick-only team leaders (can_lead_team without can_approve_technicians) return false here:
// they can form a team but an approver above them still approves it.
export function canApproveTechnicians(roleName: string | undefined, roles: Role[] | undefined): boolean {
  const caps = resolveCapabilitiesByName(roleName, roles);
  if (caps.is_system_admin) return true;
  return !!caps.is_employee && !!caps.can_approve_technicians;
}

// Predicate factory: given a picker, returns whether they may CLAIM a specific technician-category
// target onto their team. Non-technician targets are never pickable.
//   • System admins & full technician-approvers (can_approve_technicians) → pick ANY technician.
//   • A pick-only team leader (can_lead_team) → picks only technicians that cannot THEMSELVES lead
//     a team. This is resolved with the TARGET's employee_type, so a *trainee* "Team Leader" (who
//     can't lead a team) IS pickable by a permanent Team Leader, even though the role name matches.
//   • Anyone else → picks nobody.
export function makeTechnicianPickPredicate(
  pickerRole: string | undefined,
  roles: Role[] | undefined,
): (targetRole: string | undefined, targetEmployeeType?: string) => boolean {
  const picker = resolveCapabilitiesByName(pickerRole, roles);
  const unrestricted = picker.is_system_admin || picker.can_approve_technicians;
  const isLeader = picker.can_lead_team;
  return (targetRole, targetEmployeeType) => {
    if (roleCategory(targetRole, roles) !== 'technician') return false;
    if (unrestricted) return true;
    if (!isLeader) return false;
    return !resolveCapabilitiesByName(targetRole, roles, targetEmployeeType).can_lead_team;
  };
}

// Roles on the "upper lines" of a given role in the tree: every ancestor AND the siblings
// of each ancestor (parent, parent's siblings, grandparent, grandparent's siblings, … up to
// the roots). Used for pick visibility — a checked-in technician is visible to every role on
// these lines above them. Excludes the role's own tier (peers).
export function rolesAboveLine(roleName: string | undefined, roles: Role[] | undefined): Set<string> {
  const out = new Set<string>();
  if (!roleName || !roles?.length) return out;
  const byId = new Map(roles.map(r => [r.id, r]));
  let cur: Role | undefined = roles.find(r => r.name === roleName);
  const seen = new Set<string>();
  while (cur?.parent_id) {
    const anc = byId.get(cur.parent_id);            // an ancestor (one level up)
    if (!anc || seen.has(anc.id)) break;
    seen.add(anc.id);
    const sibParent = anc.parent_id ?? null;        // ancestor + its siblings share this parent
    roles.forEach(r => { if ((r.parent_id ?? null) === sibParent) out.add(r.name); });
    cur = anc;
  }
  return out;
}

// Convenience single-capability check against a registry.
export function roleCan(
  roleName: string | undefined,
  cap: keyof RoleCapabilities,
  roles: Role[] | undefined,
): boolean {
  return resolveCapabilitiesByName(roleName, roles)[cap];
}

// ─── Default / seed roles ───────────────────────────────────────────────────────
// can_approve defaults true for every role except Technician (mirrors the previous
// `role !== 'Technician'` approver rule). Management capabilities are seeded only on
// HR and System Admin; everything else can be tuned later from the Roles admin page.
type SeedRole = Omit<Role, 'created_at' | 'updated_at'>;

// The seeded role that carries is_super_admin. Only the DEFAULT_ROLES entry and the Roles
// page's "create it" affordance reference this name — nothing in the app gates on it. Gate on
// the CAPABILITY (caps.is_super_admin), never on the role name: an admin may rename the role,
// or tick the capability onto a differently-named one.
export const SUPER_ADMIN_ROLE_NAME = 'Super Admin';
export const SUPER_ADMIN_ROLE_ID   = 'super_admin';

const employee = (
  id: string,
  name: string,
  sort_order: number,
  parent_id: string | null,
  extra: Partial<RoleCapabilities> = {},
  is_protected = false,
): SeedRole => {
  const caps: RoleCapabilities = {
    is_employee:       true,
    has_attendance:    true,
    has_tasks:         true,
    can_view_team_tasks: true,
    can_assign_tasks:  true,
    multi_session:     false,
    can_approve:       true,
    can_approve_leads: true,
    can_approve_leaves: true,
    can_apply_restricted_leaves: false,
    can_approve_suspense: false,
    can_approve_ot:    false,
    can_approve_technicians: true,
    can_lead_team:     false,
    can_send_notifications: false,
    can_report:        false,
    can_manage_shifts: false,
    can_manage_working_schedules: false,
    can_manage_leaves: false,
    can_view_users:    false,
    can_manage_users:  false,
    can_view_departments:   false,
    can_manage_departments: false,
    can_view_company:       false,
    can_manage_company:     false,
    can_manage_all_companies: false,
    can_view_schedules:     false,
    can_manage_schedules:   false,
    can_declare_day_offs:   false,
    is_department_head: false,
    can_view_attendance: false,
    can_view_payroll:  false,
    can_manage_payroll_config: false,
    can_manage_pay_profiles:   false,
    can_view_own_payslip: true,
    can_generate_payroll: false,
    can_review_payroll:   false,
    can_finalize_payroll: false,
    can_view_biometric_enrollment: false,
    is_system_admin:   false,
    is_super_admin:    false,
    ...extra,
  };
  // Default category from the tree/caps: root → top management, approve-leads → executive,
  // otherwise → technician (matches Technician & Team Leader). Admins can override per role.
  const category: RoleCategory = parent_id === null ? 'top_management'
    : (caps.can_approve && caps.can_approve_leads) ? 'executive'
    : 'technician';
  return { id, name, category, parent_id, sort_order, is_active: true, is_protected, ...caps, trainee: traineeDefaults(caps) };
};

// Default hierarchy (each role's parent is its approver tier; COO/System Admin are roots).
// Office roles default to multi_session (session mode); field roles stay single-session.
export const DEFAULT_ROLES: SeedRole[] = [
  employee('technician',               'Technician',               10, 'team_leader',            { can_approve: false, can_view_team_tasks: false, can_assign_tasks: false }, true),
  employee('team_leader',              'Team Leader',              20, 'site_engineer',           { can_approve_leads: false, can_lead_team: true, can_approve_technicians: false }),
  employee('site_engineer',            'Site Engineer',            30, 'head_operation_engineer', { multi_session: true }),
  employee('procurement_engineer',     'Procurement Engineer',     40, 'head_operation_engineer', { multi_session: true }),
  employee('core_operation_engineer',  'Core Operation Engineer',  50, 'head_operation_engineer', { multi_session: true }),
  employee('head_operation_engineer',  'Head Operation Engineer',  60, 'coo',                     { multi_session: true, can_manage_shifts: true, can_manage_working_schedules: true }),
  employee('hr',                       'HR',                       70, 'coo', { can_report: true, can_manage_leaves: true, can_manage_working_schedules: true, multi_session: true }, true),
  employee('executive',                'Executive',                80, 'coo',                     { multi_session: true }),
  employee('coo',                      'COO',                      90, null,                      { multi_session: true, can_manage_shifts: true, can_manage_working_schedules: true }),
  {
    id: 'system_admin', name: 'System Admin', category: 'top_management', parent_id: null, sort_order: 100, is_active: true, is_protected: true,
    is_employee:       false,
    has_attendance:    false,
    has_tasks:         false,
    can_view_team_tasks: true,
    can_assign_tasks:  true,
    multi_session:     false,
    can_approve:       true,
    can_approve_leads: true,
    can_approve_leaves: true,
    can_apply_restricted_leaves: true,
    can_approve_suspense: true,
    can_approve_ot:    true,
    can_approve_technicians: true,
    can_lead_team:     true,
    can_send_notifications: true,
    can_report:        true,
    can_manage_shifts: true,
    can_manage_working_schedules: true,
    can_manage_leaves: true,
    can_view_users:    true,
    can_manage_users:  true,
    can_view_departments:   true,
    can_manage_departments: true,
    can_view_company:       true,
    can_manage_company:     true,
    can_manage_all_companies: true,
    can_view_schedules:     true,
    can_manage_schedules:   true,
    can_declare_day_offs:   true,
    // Not forced true — HOD is a per-user department assignment (see
    // AppUser.hod_department_ids), not a blanket admin capability. System Admin already
    // reaches everything via can_manage_users/can_manage_schedules without department picks.
    is_department_head: false,
    can_view_attendance: true,
    can_view_payroll:  true,
    can_manage_payroll_config: true,
    can_manage_pay_profiles:   true,
    can_view_own_payslip: true,
    can_generate_payroll: true,
    can_review_payroll:   true,
    can_finalize_payroll: true,
    can_view_biometric_enrollment: true,
    is_system_admin:   true,
    // System Admin is deliberately NOT a super admin: it is full access to ONE system. The
    // separate Super Admin role below is the one that reaches every system.
    is_super_admin:    false,
  },
  // ── Super Admin ───────────────────────────────────────────────────────────────────
  // Same capability set as System Admin plus is_super_admin, which is what makes the account
  // eligible for the cross-database mirror (src/lib/superAdminSync.ts). Seeded, never created
  // silently: seedDefaultRolesIfEmpty only creates roles that are missing, and it runs from an
  // explicit action (the Roles page "Initialize defaults" / "Create the Super Admin role"
  // buttons) or the one-time empty-registry bootstrap in AuthProvider.
  {
    id: 'super_admin', name: SUPER_ADMIN_ROLE_NAME, category: 'top_management', parent_id: null, sort_order: 110, is_active: true, is_protected: true,
    is_employee:       false,
    has_attendance:    false,
    has_tasks:         false,
    can_view_team_tasks: true,
    can_assign_tasks:  true,
    multi_session:     false,
    can_approve:       true,
    can_approve_leads: true,
    can_approve_leaves: true,
    can_apply_restricted_leaves: true,
    can_approve_suspense: true,
    can_approve_ot:    true,
    can_approve_technicians: true,
    can_lead_team:     true,
    can_send_notifications: true,
    can_report:        true,
    can_manage_shifts: true,
    can_manage_working_schedules: true,
    can_manage_leaves: true,
    can_view_users:    true,
    can_manage_users:  true,
    can_view_departments:   true,
    can_manage_departments: true,
    can_view_company:       true,
    can_manage_company:     true,
    can_manage_all_companies: true,
    can_view_schedules:     true,
    can_manage_schedules:   true,
    can_declare_day_offs:   true,
    // Same reasoning as System Admin above — HOD is a per-user department assignment.
    is_department_head: false,
    can_view_attendance: true,
    can_view_payroll:  true,
    can_manage_payroll_config: true,
    can_manage_pay_profiles:   true,
    can_view_own_payslip: true,
    can_generate_payroll: true,
    can_review_payroll:   true,
    can_finalize_payroll: true,
    can_view_biometric_enrollment: true,
    is_system_admin:   true,
    is_super_admin:    true,
  },
];

// Empty capability set for the "create role" form default.
export const EMPTY_CAPS: RoleCapabilities = {
  is_employee:       true,
  has_attendance:    true,
  has_tasks:         true,
  can_view_team_tasks: false,
  can_assign_tasks:  false,
  multi_session:     false,
  can_approve:       false,
  can_approve_leads: true,
  can_approve_leaves: true,
  can_apply_restricted_leaves: false,
  can_approve_suspense: false,
  can_approve_ot:    false,
  can_approve_technicians: false,
  can_lead_team:     false,
  can_send_notifications: false,
  can_report:        false,
  can_manage_shifts: false,
  can_manage_working_schedules: false,
  can_manage_leaves: false,
  can_view_users:    false,
  can_manage_users:  false,
  can_view_departments:   false,
  can_manage_departments: false,
  can_view_company:       false,
  can_manage_company:     false,
  can_manage_all_companies: false,
  can_view_schedules:     false,
  can_manage_schedules:   false,
  can_declare_day_offs:   false,
  is_department_head: false,
  can_view_attendance: false,
  can_view_payroll:  false,
  can_manage_payroll_config: false,
  can_manage_pay_profiles:   false,
  can_view_own_payslip: true,
  can_generate_payroll: false,
  can_review_payroll:   false,
  can_finalize_payroll: false,
  can_view_biometric_enrollment: false,
  is_system_admin:   false,
  is_super_admin:    false,
};
