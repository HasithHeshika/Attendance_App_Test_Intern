'use client';
import { useState, useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import Portal from '@/components/Portal';
import { ShieldCheck, Plus, X, Save, RefreshCw, Users, Workflow, GitBranch, Crown, CheckCircle2, PowerOff, Table2, Network, Search, Globe, KeyRound } from 'lucide-react';
import toast from 'react-hot-toast';
import { useUserCapabilities, useRoles } from '@/store/rolesStore';
import { useT } from '@/store/appStore';
import { tenant } from '@/lib/firebase';
import {
  createRole, updateRole, deleteRole, seedDefaultRolesIfEmpty, migrateLegacyUserRoles, findDuplicateRole,
  ensureSuperAdminRole,
} from '@/services/roleService';
import { getActiveSuperAdmins, type SuperAdminEntry } from '@/services/userService';
import { useAuthStore } from '@/store/authStore';
import { useIsPlatformAdmin } from '@/components/usePlatformAdmin';
import { auth } from '@/lib/firebase';
import {
  CAPABILITY_KEYS, CAPABILITY_LABELS, ELEVATED_CAPABILITY_KEYS, EMPTY_CAPS,
  TRAINEE_CAPABILITY_KEYS, traineeDefaults,
  descendantRoleIdsOf, ROLE_CATEGORY_OPTIONS, roleCategory,
  type Role, type RoleCapabilities, type RoleCategory,
} from '@/lib/permissions';
import { Badge } from '@/components/ui/badge';
import dynamic from 'next/dynamic';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { StatCard } from '@/components/ui/stat-card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeaderSkeleton, SkeletonCard, Skeleton, StatCardsSkeleton, FormSkeleton } from '@/components/ui/Skeleton';
import { PageTransition, Reveal, Stagger, StaggerItem } from '@/components/ui/motion';
// Plain hierarchy table alternative to the flow chart — cheap enough to load eagerly (no heavy deps).
import RoleTable from '@/components/RoleTable';
import SearchableSelect from '@/components/SearchableSelect';
import ConfirmModal from '@/components/ConfirmModal';
import InlineError from '@/components/InlineError';

// reactflow is heavy (~the largest dep on this admin-only screen) and only ever
// renders here. Load it lazily so it never weighs on any other route's bundle;
// ssr:false because the graph is client-only. Placeholder matches its h-[72vh].
const RoleFlow = dynamic(() => import('@/components/RoleFlow'), {
  ssr: false,
  loading: () => <Skeleton className="h-[72vh] w-full rounded-2xl" />,
});

type FormState = RoleCapabilities & {
  name: string; is_active: boolean; parent_id: string | null; category: RoleCategory; trainee: RoleCapabilities;
};

// Southern Lanka (carecode.org) only. `tenant` is resolved from the hostname (or the
// NEXT_PUBLIC_FIRESTORE_DB_ID fallback for localhost/preview) by src/lib/firebase.ts. This
// page itself stays live for every tenant (it also drives the permission/approval-hierarchy
// registry) — only the Category picker (Technician/Executive/Top Management) is gated for this
// tenant — see the !isSouthernlanka guard around it below, and the matching guard in
// handleSave that keeps handleSave from ever persisting an explicit override for it. Roles
// carry no department scoping of their own for any tenant — that lives entirely on the user
// profile (AppUser.department / hod_department_ids, see users/page.tsx).
const isSouthernlanka = tenant.id === 'southernlanka';

const emptyForm: FormState = {
  ...EMPTY_CAPS, name: '', is_active: true, parent_id: null, category: 'technician',
  trainee: traineeDefaults(EMPTY_CAPS),
  // can_approve_leads/can_approve_suspense are hidden for southernlanka (see
  // HIDDEN_FOR_SOUTHERNLANKA below) — force them off here rather than inheriting EMPTY_CAPS'
  // defaults (has_tasks/can_approve_leads default true there), since this tenant has no
  // toggle to correct any of them back.
  ...(isSouthernlanka ? {
    has_tasks: false, can_view_team_tasks: false, can_assign_tasks: false,
    can_approve_technicians: false, can_approve_leads: false, can_approve_suspense: false,
  } : {}),
};

const childrenOf = (parentId: string | null, items: Role[]) =>
  items
    .filter(r => (r.parent_id ?? null) === parentId)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

function RolesAdminContent() {
  const caps = useUserCapabilities();
  const { roles, loaded, reload } = useRoles();
  const t = useT();
  const CAP_T: Record<string, { label: string; desc: string }> = {
    is_employee: { label: t.capEmployee, desc: t.capEmployeeDesc },
    has_attendance: { label: t.capOwnAttendance, desc: t.capOwnAttendanceDesc },
    has_tasks: { label: t.capDailyTasks, desc: t.capDailyTasksDesc },
    can_view_team_tasks: { label: t.capTeamTasks, desc: t.capTeamTasksDesc },
    multi_session: { label: t.capSessionMode, desc: t.capSessionModeDesc },
    can_approve: { label: t.capApprove, desc: t.capApproveDesc },
    can_approve_leads: { label: t.capApproveLeads, desc: t.capApproveLeadsDesc },
    can_approve_leaves: { label: t.capApproveLeaves, desc: t.capApproveLeavesDesc },
    can_approve_technicians: { label: t.capApproveTechnicians, desc: t.capApproveTechniciansDesc },
    can_report: { label: t.capReports, desc: t.capReportsDesc },
    can_manage_shifts: { label: t.capManageShifts, desc: t.capManageShiftsDesc },
    can_manage_leaves: { label: t.capManageLeaves, desc: t.capManageLeavesDesc },
    can_view_users: { label: t.capViewUsers, desc: t.capViewUsersDesc },
    can_manage_users: { label: t.capManageUsers, desc: t.capManageUsersDesc },
    is_system_admin: { label: t.capSystemAdmin, desc: t.capSystemAdminDesc },
    // Southern Lanka only — not yet translated, CAP_T lookup misses and CAPABILITY_LABELS'
    // English text is used instead (same fallback as e.g. can_lead_team, can_assign_tasks).
  };
  // Southern Lanka shows granular Departments/Company/Schedules toggles instead of the
  // task- and shift-management ones that don't apply there (Tasks and Shifts are dead for
  // this tenant — see useSidebarNav.ts). Every other tenant keeps seeing exactly the matrix
  // it always has — the new keys are appended to CAPABILITY_KEYS but filtered out for them.
  const SOUTHERNLANKA_ONLY_CAPS = new Set<keyof RoleCapabilities>([
    'can_view_departments', 'can_manage_departments',
    'can_view_company', 'can_manage_company',
    'can_manage_all_companies',
    'can_view_schedules', 'can_manage_schedules',
    'is_department_head',
    'can_apply_restricted_leaves',
    'can_approve_ot',
    'can_declare_day_offs',
  ]);
  const HIDDEN_FOR_SOUTHERNLANKA = new Set<keyof RoleCapabilities>([
    'has_tasks', 'can_view_team_tasks', 'can_assign_tasks',
    'can_approve_technicians', 'can_lead_team',
    'can_manage_shifts', 'can_manage_working_schedules',
    'can_approve_leads', 'can_approve_suspense',
  ]);
  // Elevated capabilities (System Admin, Super Admin) are pulled OUT of the ordinary matrix and
  // rendered in their own block below — they are not "one more permission", and a row of
  // identical toggles is exactly how a person ticks the most powerful switch in the app by
  // accident. Everything else keeps the tenant filtering it always had.
  const visibleCapabilityKeys = CAPABILITY_KEYS.filter(k =>
    !ELEVATED_CAPABILITY_KEYS.includes(k) &&
    (isSouthernlanka ? !HIDDEN_FOR_SOUTHERNLANKA.has(k) : !SOUTHERNLANKA_ONLY_CAPS.has(k))
  );
  const CAT_T: Record<string, { label: string; desc: string }> = {
    technician: { label: t.catTechnician, desc: t.catTechnicianDesc },
    executive: { label: t.catExecutive, desc: t.catExecutiveDesc },
    top_management: { label: t.catTopManagement, desc: t.catTopManagementDesc },
  };
  // Every string this feature adds is a short English fallback: TRANSLATIONS in appStore is
  // owned elsewhere right now, so `si`/`ta` parity can't be added in this change. Listed in the
  // handover so they can be lifted into TRANSLATIONS in one pass.
  const me = useAuthStore(s => s.user);
  // Presentation only — the same claim the sidebar reads. Used here to decide whether to ASK
  // the platform API who is on the platform list; the API is what actually answers.
  const isPlatformAdmin = useIsPlatformAdmin();
  const [superAdmins,  setSuperAdmins]  = useState<SuperAdminEntry[] | null>(null);
  // Lower-cased emails on the platform_admins list, or null when we couldn't/didn't ask.
  const [platformEmails, setPlatformEmails] = useState<Set<string> | null>(null);
  // Ticking Super Admin asks first; un-ticking never does.
  const [confirmSuperAdmin, setConfirmSuperAdmin] = useState(false);
  // Saving a Super Admin role onto YOUR OWN role is a separate, second confirmation.
  const [confirmSelfGrant, setConfirmSelfGrant] = useState(false);
  const [items,    setItems]    = useState<Role[]>(roles);
  const [showForm, setShowForm] = useState(false);
  const [editId,   setEditId]   = useState<string | null>(null);
  const [form,     setForm]     = useState<FormState>(emptyForm);
  const [saving,   setSaving]   = useState(false);
  const [busy,     setBusy]     = useState(false);
  // Surface the "name required" error only after a save attempt (a dupe name still
  // shows live — the user has clearly typed something by then).
  const [triedSave, setTriedSave] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Role | null>(null);
  const [confirmMigrate, setConfirmMigrate] = useState(false);
  // Southern Lanka only — a plain hierarchy table as a simpler alternative to the drag-and-drop
  // flow chart (see the Table View button below). Every other tenant keeps the graph only.
  const [viewMode, setViewMode] = useState<'graph' | 'table'>('graph');
  // Table-view-only search (by role name) — the graph keeps every role visible always, since
  // filtering its nodes would break the hierarchy lines to a filtered-out role's children.
  const [roleSearch, setRoleSearch] = useState('');

  // Keep a local copy of the registry (optimistic re-parenting updates this immediately).
  useEffect(() => { setItems(roles); }, [roles]);

  // Who currently holds Super Admin in THIS system. Re-resolved whenever the registry changes,
  // because ticking the capability onto a role silently promotes everyone already holding it.
  useEffect(() => {
    if (!caps.is_system_admin) return;
    let alive = true;
    getActiveSuperAdmins()
      .then(list => { if (alive) setSuperAdmins(list); })
      .catch(() => { if (alive) setSuperAdmins([]); });
    return () => { alive = false; };
  }, [roles, caps.is_system_admin]);

  // Only a platform admin may see the platform list, and only the API can say who is on it —
  // a 404 here IS the answer for everyone else, so the failure path stays silent.
  useEffect(() => {
    if (!isPlatformAdmin) { setPlatformEmails(null); return; }
    let alive = true;
    (async () => {
      try {
        const token = await auth.currentUser?.getIdToken();
        if (!token) return;
        const res = await fetch('/api/platform/admins', { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) return;
        const body = await res.json() as { admins?: { email: string; disabled?: boolean }[] };
        if (!alive) return;
        setPlatformEmails(new Set(
          (body.admins ?? []).filter(a => !a.disabled).map(a => a.email.toLowerCase()),
        ));
      } catch { /* presentation only — the column just stays absent */ }
    })();
    return () => { alive = false; };
  }, [isPlatformAdmin]);

  // Drag a connection in the graph (parent → child) to change who approves a role.
  // A null parent moves the role to the top of the tree.
  const handleReparent = async (childId: string, parentId: string | null) => {
    const child = items.find(r => r.id === childId);
    if (!child || (child.parent_id ?? null) === parentId) return;
    // Protected Top-Tier Roles (General Manager / HR Executive / HR Assistant) pin the
    // Southern Lanka escalation ladder hardcoded in apiCompat.ts — re-parenting one via
    // drag-and-drop is a critical structural edit, blocked the same as renaming it.
    if (child.is_protected) { toast.error(`"${child.name}" is a protected role — its position can't be changed.`); return; }
    setItems(prev => prev.map(r => (r.id === childId ? { ...r, parent_id: parentId } : r))); // optimistic
    try {
      await updateRole(childId, { parent_id: parentId });
      const parentName = parentId ? items.find(r => r.id === parentId)?.name : null;
      toast.success(parentName ? t.nowReportsTo.replace('{a}', child.name).replace('{b}', parentName) : t.movedToTop.replace('{a}', child.name));
      await reload();
    } catch { toast.error(t.failedMoveRole); await reload(); }
  };

  const openCreate = () => { setForm(emptyForm); setEditId(null); setTriedSave(false); setShowForm(true); };
  const openEdit   = (r: Role) => {
    setTriedSave(false);
    setForm({
      name: r.name, is_active: r.is_active !== false, parent_id: r.parent_id ?? null,
      category: r.category ?? roleCategory(r.name, roles),
      is_employee: r.is_employee, has_attendance: r.has_attendance,
      // has_tasks/can_view_team_tasks/can_assign_tasks/can_approve_technicians below are all
      // hidden for southernlanka — loaded as a hard false there regardless of what's stored
      // (same reasoning as can_approve_leads/can_approve_suspense above: their normal fallback
      // defaults from a related capability, e.g. has_attendance/can_approve, which is often
      // true, so an admin editing an unrelated field and saving could silently re-write a
      // stale/defaulted true back onto the doc for a toggle they can't even see).
      has_tasks: isSouthernlanka ? false : (r.has_tasks ?? r.has_attendance),
      can_view_team_tasks: isSouthernlanka ? false : (r.can_view_team_tasks ?? r.can_approve),
      can_assign_tasks: isSouthernlanka ? false : (r.can_assign_tasks ?? (r.can_view_team_tasks ?? r.can_approve)),
      multi_session: !!r.multi_session,
      can_approve: r.can_approve,
      // Hidden for southernlanka — load as a hard false regardless of what's stored, instead
      // of the normal "absent → true" (can_approve_leads) / "absent → false"
      // (can_approve_suspense) fallback, so an admin editing an unrelated field on the role
      // and saving can never silently re-write a stale/defaulted true back onto the doc.
      can_approve_leads: isSouthernlanka ? false : r.can_approve_leads !== false,
      can_approve_leaves: r.can_approve_leaves !== false,
      // Southern Lanka only (SOUTHERNLANKA_ONLY_CAPS) — opt-in, absent on older docs.
      can_apply_restricted_leaves: r.can_apply_restricted_leaves ?? false,
      can_approve_suspense: isSouthernlanka ? false : (r.can_approve_suspense ?? false),
      // Southern Lanka only (SOUTHERNLANKA_ONLY_CAPS) — opt-in, absent on older docs.
      can_approve_ot: r.can_approve_ot ?? false,
      can_approve_technicians: isSouthernlanka ? false : (r.can_approve_technicians ?? r.can_approve),
      can_lead_team: r.can_lead_team ?? false,
      can_send_notifications: r.can_send_notifications ?? false,
      can_report: r.can_report, can_manage_shifts: !!r.can_manage_shifts,
      can_manage_working_schedules: !!r.can_manage_working_schedules,
      can_manage_leaves: r.can_manage_leaves,
      can_view_users: r.can_view_users ?? false,
      can_manage_users: r.can_manage_users,
      // Southern Lanka only — absent on older docs, default to the can_manage_users/
      // can_view_users equivalent (same fallback resolveCapabilities() applies at runtime).
      can_view_departments: r.can_view_departments ?? (r.can_manage_users || !!r.can_view_users),
      can_manage_departments: r.can_manage_departments ?? r.can_manage_users,
      can_view_company: r.can_view_company ?? (r.can_manage_users || !!r.can_view_users),
      can_manage_company: r.can_manage_company ?? r.can_manage_users,
      // Southern Lanka only (SOUTHERNLANKA_ONLY_CAPS) — opt-in, absent on older docs.
      can_manage_all_companies: r.can_manage_all_companies ?? false,
      can_view_schedules: r.can_view_schedules ?? (r.can_manage_users || !!r.can_view_users),
      can_manage_schedules: r.can_manage_schedules ?? r.can_manage_users,
      // Southern Lanka only (SOUTHERNLANKA_ONLY_CAPS) — opt-in, absent on older docs.
      can_declare_day_offs: r.can_declare_day_offs ?? false,
      is_department_head: r.is_department_head ?? false,
      can_view_attendance: r.can_view_attendance ?? false,
      can_view_payroll: r.can_view_payroll ?? false,
      can_manage_payroll_config: r.can_manage_payroll_config ?? false,
      can_manage_pay_profiles: r.can_manage_pay_profiles ?? false,
      can_view_own_payslip: r.can_view_own_payslip !== false,
      can_generate_payroll: r.can_generate_payroll ?? false,
      can_review_payroll: r.can_review_payroll ?? false,
      can_finalize_payroll: r.can_finalize_payroll ?? false,
      is_system_admin: r.is_system_admin,
      // Opt-in, absent on every role doc written before this capability existed.
      is_super_admin: r.is_super_admin ?? false,
      can_view_biometric_enrollment: r.can_view_biometric_enrollment ?? false,
      trainee: r.trainee ?? traineeDefaults(r),
    });
    setEditId(r.id);
    setShowForm(true);
  };

  // `skipSelfGrantConfirm` is set only by the confirmation dialog's own Confirm button, so the
  // second gate below can never be bypassed by anything else calling handleSave.
  const handleSave = async (skipSelfGrantConfirm = false) => {
    setTriedSave(true);
    if (!form.name.trim()) { toast.error(t.enterRoleName); return; }
    // Role names stay globally unique — one doc per job title, no department scoping of its own.
    const dupe = findDuplicateRole(items, form.name, editId);
    if (dupe) { toast.error(`"${form.name.trim()}" already exists.`); return; }
    // Handing yourself the most powerful role in the app, in the same click that grants it, is
    // the one path nobody else reviews. Editing YOUR OWN role to carry Super Admin therefore
    // asks a second time, naming what it does. (Creating a role can't be self-assignment —
    // AppUser.role still points at the old one until someone changes it on the Users page.)
    const editingMyOwnRole = !!editingRole && !!me?.role && editingRole.name === me.role;
    if (!skipSelfGrantConfirm && form.is_super_admin && editingMyOwnRole) {
      setConfirmSelfGrant(true);
      return;
    }
    // Southern Lanka never shows the category picker (see isSouthernlanka above), so never send
    // an explicit override for it — leave roleCategory()'s tree-based fallback in charge, same as
    // before this field existed.
    const { category: _category, ...formRest } = form;
    const payload = {
      ...(isSouthernlanka ? formRest : form),
      // Fully retire the legacy department fields on every save, so a doc never carries stale
      // department scoping from before Roles were decoupled from Department entirely.
      department_ids:   [],
      department_names: [],
      department_id:   null,
      department_name: null,
      // Defensive — the Name/Reports To fields are already disabled for a protected role (see
      // editingProtected above), but re-assert it here too: never let a critical structural
      // edit through even if that client-side guard is ever bypassed.
      ...(editingProtected && editingRole
        ? { name: editingRole.name, parent_id: editingRole.parent_id ?? null }
        : {}),
    };
    setSaving(true);
    try {
      if (editId) {
        await updateRole(editId, payload);
        toast.success(t.roleUpdated);
      } else {
        const nextOrder = items.reduce((m, r) => Math.max(m, r.sort_order ?? 0), 0) + 10;
        await createRole({ ...payload, sort_order: nextOrder });
        toast.success(t.roleCreated);
      }
      setShowForm(false);
      await reload();
    } catch (e) { console.error(e); toast.error(t.failedSaveRole); }
    finally { setSaving(false); }
  };

  const toggleActive = async (r: Role) => {
    try {
      await updateRole(r.id, { is_active: !r.is_active });
      toast.success(r.is_active ? t.deactivatedWord : t.activatedWord);
      await reload();
    } catch { toast.error(t.failedGeneric); }
  };

  // Guard here (protected / has children), then open the confirm dialog.
  const requestDelete = (r: Role) => {
    if (r.is_protected) { toast.error(t.builtinRoleNoDelete); return; }
    if (childrenOf(r.id, items).length > 0) { toast.error(t.reparentChildrenFirst); return; }
    setConfirmDelete(r);
  };

  const handleDelete = async (r: Role) => {
    setBusy(true);
    try {
      await deleteRole(r.id);
      toast.success(t.roleDeleted);
      await reload();
    } catch { toast.error(t.failedDelete); }
    finally { setBusy(false); }
  };

  const handleSeed = async () => {
    setBusy(true);
    try {
      const n = await seedDefaultRolesIfEmpty();
      toast.success(n > 0 ? t.defaultRolesAdded.replace('{n}', String(n)) : t.defaultsPresent);
      await reload();
    } catch { toast.error(t.failedInitRoles); }
    finally { setBusy(false); }
  };

  // Explicit, idempotent creation of the seeded Super Admin role — never fired by a load path.
  const handleCreateSuperAdminRole = async () => {
    setBusy(true);
    try {
      const r = await ensureSuperAdminRole();
      toast.success(r.created
        ? `"${r.name}" role created. Assign it on the Users page.`
        : `"${r.name}" already carries Super Admin.`);
      await reload();
    } catch (e) { console.error(e); toast.error('Could not create the Super Admin role.'); }
    finally { setBusy(false); }
  };

  const handleMigrate = async () => {
    setBusy(true);
    try {
      const n = await migrateLegacyUserRoles();
      toast.success(n > 0 ? t.usersRemapped.replace('{n}', String(n)) : t.noLegacyRoles);
    } catch { toast.error(t.migrationFailed); }
    finally { setBusy(false); }
  };

  if (caps && !caps.is_system_admin) {
    return (
      <PageTransition className="space-y-6">
        <PageHeader title={t.rolesTitle} icon={ShieldCheck} />
        <Card className="p-0">
          <EmptyState
            icon={ShieldCheck}
            title={t.sysAdminRequired}
            description={t.noRolesPermission}
          />
        </Card>
      </PageTransition>
    );
  }
  if (!loaded) {
    return (
      <div className="space-y-6">
        <PageHeaderSkeleton />
        <StatCardsSkeleton />
        <SkeletonCard className="space-y-4">
          <Skeleton className="h-4 w-72" />
          <Skeleton className="h-[420px] w-full rounded-lg" />
        </SkeletonCard>
      </div>
    );
  }

  // Parent dropdown options: any role except self and its own descendants (no cycles).
  const blockedIds = new Set<string>();
  if (editId) {
    blockedIds.add(editId);
    descendantRoleIdsOf(editId, items).forEach(id => blockedIds.add(id));
  }
  const parentOptions = items.filter(r => !blockedIds.has(r.id));

  // Protected Top-Tier Roles (General Manager / HR Executive / HR Assistant) — see is_protected.
  // Their Name and Reports To are locked in the edit form (critical structural edits: renaming
  // or re-parenting either would silently break the hardcoded Southern Lanka escalation ladder
  // in apiCompat.ts, which identifies these three by exact name). Capabilities, Category and
  // Active status stay editable — only identity + hierarchy position are frozen.
  const editingRole = editId ? items.find(r => r.id === editId) : null;
  const editingProtected = !!editingRole?.is_protected;

  // Live form validation — a protected role's name is locked, so it can never be
  // invalid; otherwise the name is required and must stay globally unique.
  const roleNameTrimmed = form.name.trim();
  const roleNameDupe = !editingProtected && !!roleNameTrimmed && !!findDuplicateRole(items, form.name, editId);
  const roleNameError = editingProtected
    ? ''
    : !roleNameTrimmed
      ? t.enterRoleName
      : roleNameDupe
        ? `"${roleNameTrimmed}" already exists.`
        : '';
  const saveDisabled = saving || !!roleNameError;

  // KPI summary derived from the local registry (decorative tones: primary / brand / success;
  // destructive reserved for the genuinely-inactive count).
  const approverCount = items.filter(r => r.can_approve).length;
  const topTierCount = items.filter(r => !r.parent_id || !items.some(x => x.id === r.parent_id)).length;
  const inactiveCount = items.filter(r => r.is_active === false).length;

  // Table view only (see roleSearch above) — case-insensitive match on role name.
  const roleSearchTrimmed = roleSearch.trim().toLowerCase();
  const tableItems = roleSearchTrimmed
    ? items.filter(r => r.name.toLowerCase().includes(roleSearchTrimmed))
    : items;

  return (
    <PageTransition className="space-y-6">
      <PageHeader
        title={t.rolesTitle}
        description={t.rolesDescTemplate.replace('{n}', String(roles.length))}
        icon={ShieldCheck}
        actions={
          <>
            {/* Southern Lanka's role set is managed entirely through this page (department-scoped
                roles, no legacy `role` string on users), so remapping/seeding the generic default
                set doesn't apply here — hidden for this tenant only. */}
            {!isSouthernlanka && (
              <>
                <Button variant="outline" onClick={() => setConfirmMigrate(true)} disabled={busy}>
                  <Users className="w-4 h-4" />{t.remapLegacy}
                </Button>
                <Button variant="outline" onClick={handleSeed} disabled={busy}>
                  <RefreshCw className="w-4 h-4" />{t.initializeDefaults}
                </Button>
              </>
            )}
            {/* Only while this system has no super-admin role at all — the seeded role is
                created on request, never by a page load. */}
            {loaded && !items.some(r => r.is_super_admin) && (
              <Button variant="outline" onClick={handleCreateSuperAdminRole} disabled={busy}>
                <Globe className="w-4 h-4" />Create Super Admin role
              </Button>
            )}
            <Button onClick={openCreate}>
              <Plus className="w-4 h-4" />{t.addRole}
            </Button>
          </>
        }
      />

      {items.length > 0 && (
        <Stagger className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StaggerItem>
            <StatCard label={t.totalRoles} value={items.length} icon={ShieldCheck} tone="primary"
              hint={t.definedInRegistry} />
          </StaggerItem>
          <StaggerItem>
            <StatCard label={t.approverRoles} value={approverCount} icon={CheckCircle2} tone="success"
              hint={t.canApproveOthers} />
          </StaggerItem>
          <StaggerItem>
            <StatCard label={t.topTier} value={topTierCount} icon={Crown} tone="brand"
              hint={t.rootsHierarchy} />
          </StaggerItem>
          <StaggerItem>
            <StatCard label={t.inactiveWord} value={inactiveCount} icon={PowerOff}
              tone={inactiveCount > 0 ? 'destructive' : 'muted'} hint={t.deactivatedRoles} />
          </StaggerItem>
        </Stagger>
      )}

      {items.length === 0 ? (
        <Reveal>
          <Card className="p-0">
            <EmptyState
              icon={ShieldCheck}
              title={t.noRolesYet}
              description={t.noRolesDesc}
              action={
                !isSouthernlanka ? (
                  <Button variant="outline" onClick={handleSeed} disabled={busy}>
                    <RefreshCw className="w-4 h-4" />{t.initializeDefaults}
                  </Button>
                ) : (
                  <Button onClick={openCreate}>
                    <Plus className="w-4 h-4" />{t.addRole}
                  </Button>
                )
              }
            />
          </Card>
        </Reveal>
      ) : (
        <Reveal delay={0.05}>
          <Card className="overflow-hidden">
            <CardHeader className="flex-row items-start gap-3 space-y-0">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
                <GitBranch className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <CardTitle>{t.approvalHierarchy}</CardTitle>
                <CardDescription className="flex items-start gap-1.5">
                  <Workflow className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                  {viewMode === 'graph' ? t.hierarchyHint : 'Reporting order, top to bottom. Switch to the graph to drag-and-drop reassign a role’s approver.'}
                </CardDescription>
              </div>
              {/* Southern Lanka only — a plain table is easier to scan/manage than the graph
                  once a tenant has many department-scoped roles. Other tenants keep the graph. */}
              {isSouthernlanka && (
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-shrink-0"
                  onClick={() => setViewMode(m => (m === 'graph' ? 'table' : 'graph'))}
                >
                  {viewMode === 'graph'
                    ? <><Table2 className="w-4 h-4" />Table View</>
                    : <><Network className="w-4 h-4" />Graph View</>}
                </Button>
              )}
            </CardHeader>
            {/* Table view only — search by role name. The graph always shows every role (see
                tableItems above), so the box only renders where it actually does something. */}
            {viewMode === 'table' && (
              <div className="px-3 pt-2 pb-1">
                <div className="relative max-w-xs">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                  <Input
                    value={roleSearch}
                    onChange={(e) => setRoleSearch(e.target.value)}
                    placeholder="Search roles…"
                    className="pl-8 h-9 text-xs w-full"
                  />
                </div>
              </div>
            )}
            <div className="px-3 pb-3">
              {viewMode === 'table' ? (
                tableItems.length === 0 ? (
                  <EmptyState
                    icon={Search}
                    title="No matching roles"
                    description={`No role name matches "${roleSearch.trim()}".`}
                    action={
                      <Button variant="outline" size="sm" onClick={() => setRoleSearch('')}>
                        Clear search
                      </Button>
                    }
                  />
                ) : (
                  <RoleTable
                    roles={tableItems}
                    onEdit={openEdit}
                    onToggle={toggleActive}
                    onDelete={requestDelete}
                  />
                )
              ) : (
                <RoleFlow
                  roles={items}
                  onEdit={openEdit}
                  onToggle={toggleActive}
                  onDelete={requestDelete}
                  onReparent={handleReparent}
                />
              )}
            </div>
          </Card>
        </Reveal>
      )}

      {/* ── Super Admins in this system ──────────────────────────────────────────────────
          The honest picture of the boundary: who reaches every system, and (only if the viewer
          can already see the platform list) which of them can also configure the platform. The
          two are separate grants, and this is where that stops being folklore. */}
      <Reveal delay={0.08}>
        <Card>
          <CardHeader className="flex-row items-start gap-3 space-y-0">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
              <Globe className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <CardTitle>Super Admins</CardTitle>
              <CardDescription>
                Full access in this system and in every other organisation their account exists in.
                Platform configuration is a separate grant — a platform administrator adds it by email.
              </CardDescription>
            </div>
          </CardHeader>
          <div className="px-3 pb-3">
            {superAdmins === null ? (
              <div className="space-y-2 px-1">
                <Skeleton className="h-11 w-full rounded-lg" />
                <Skeleton className="h-11 w-full rounded-lg" />
              </div>
            ) : superAdmins.length === 0 ? (
              <p className="px-3 py-4 text-sm text-muted-foreground">
                Nobody in this system holds Super Admin. Every administrator here is a System
                Admin — full access to this system only.
              </p>
            ) : (
              <ul className="divide-y divide-border rounded-lg border border-border overflow-hidden">
                {superAdmins.map(({ user, grantedBy }) => {
                  const email = (user.email ?? '').toLowerCase();
                  const onPlatformList = platformEmails ? platformEmails.has(email) : null;
                  return (
                    <li key={user.epf_number} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-foreground">{user.display_name}</div>
                        <div className="truncate text-[11px] text-muted-foreground">
                          {user.epf_number}{user.email ? ` · ${user.email}` : ''}
                        </div>
                      </div>
                      {/* Where the grant lives decides where it has to be revoked. */}
                      <Badge variant={grantedBy === 'user_flag' ? 'warning' : 'destructive'}>
                        {grantedBy === 'user_flag'
                          ? 'Per-user grant'
                          : grantedBy === 'both'
                            ? `Role: ${user.role} + per-user`
                            : `Role: ${user.role}`}
                      </Badge>
                      {/* Absent entirely unless the viewer can already read the platform list —
                          it is not this page's job to tell anyone else that list exists. */}
                      {onPlatformList !== null && (
                        <Badge variant={onPlatformList ? 'brand' : 'muted'}>
                          {onPlatformList ? 'Platform config' : 'No platform config'}
                        </Badge>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="px-1 pt-2.5 text-[11px] leading-snug text-muted-foreground">
              A role grant is removed here; a per-user grant is removed on the Users page.
              Neither one grants platform configuration.
            </p>
          </div>
        </Card>
      </Reveal>

      {/* Portalled to <body>: a `fixed inset-0` overlay nested inside PageTransition (whose
          enter animation leaves an active transform in place) gets its containing block
          hijacked to PageTransition's own box instead of the viewport. */}
      <Portal>
      <AnimatePresence>
        {showForm && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <motion.div initial={{ scale: 0.95 }} animate={{ scale: 1 }} exit={{ scale: 0.95 }}
              className="w-full max-w-2xl bg-card border border-border rounded-xl shadow-card p-6 space-y-4 max-h-[90vh] overflow-y-auto">
              <div className="flex items-center justify-between">
                <div className="text-base font-semibold text-foreground">{editId ? t.editRole : t.newRole}</div>
                <Button variant="ghost" size="icon-sm" onClick={() => setShowForm(false)}><X className="w-4 h-4" /></Button>
              </div>

              {!loaded ? (
                <FormSkeleton fields={6} className="!p-0 !shadow-none !bg-transparent" />
              ) : (
              <>
              <div>
                <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">{t.nameWord} <span className="text-destructive">*</span></Label>
                <Input type="text" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder={t.egRoleName} disabled={editingProtected}
                  aria-invalid={(triedSave || roleNameDupe) && !!roleNameError} />
                {editingProtected ? (
                  <p className="text-[11px] text-muted-foreground mt-1">
                    Protected role — name is locked (see the Southern Lanka escalation ladder).
                  </p>
                ) : (
                  (triedSave || roleNameDupe) && <InlineError>{roleNameError}</InlineError>
                )}
              </div>

              <div>
                <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">{t.reportsToLabel}</Label>
                <SearchableSelect
                  value={form.parent_id ?? ''}
                  onChange={val => setForm(f => ({ ...f, parent_id: val || null }))}
                  placeholder={t.noneTopTree}
                  emptyLabel={t.noMatchesFound}
                  disabled={editingProtected}
                  options={[
                    { value: '', label: t.noneTopTree },
                    ...parentOptions.map(r => ({ value: r.id, label: r.name })),
                  ]}
                />
                <p className="text-[11px] text-muted-foreground mt-1">
                  {editingProtected ? 'Protected role — hierarchy position is locked.' : t.reportsToHint}
                </p>
              </div>

              {/* Category (Technician/Executive/Top Management) is hidden entirely for Southern
                  Lanka (carecode.org) — see isSouthernlanka above. Its category keeps auto-deriving
                  from the role tree (roleCategory's fallback) since handleSave never sends an
                  explicit override for this tenant. */}
              {!isSouthernlanka && (
                <div>
                  <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">{t.categoryLabel}</Label>
                  <div className="grid grid-cols-3 gap-2">
                    {ROLE_CATEGORY_OPTIONS.map(o => (
                      <button key={o.value} type="button"
                        onClick={() => setForm(f => ({ ...f, category: o.value }))}
                        className={`px-2 py-2 rounded-md text-xs font-semibold border transition-colors ${
                          form.category === o.value
                            ? 'bg-primary/10 border-primary/20 text-primary'
                            : 'bg-card border-border text-muted-foreground hover:text-foreground hover:bg-accent'}`}>
                        {CAT_T[o.value]?.label ?? o.label}
                      </button>
                    ))}
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-1">{CAT_T[form.category]?.desc ?? ROLE_CATEGORY_OPTIONS.find(o => o.value === form.category)?.desc}</p>
                </div>
              )}

              {/* Permissions matrix — one row per capability, a column each for the
                  Permanent and (employee roles only) Trainee variant of the role. */}
              <div className="space-y-2.5">
                <div className="flex items-end justify-between gap-3">
                  <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{t.permissionsLabel}</div>
                  <div className="flex items-center gap-3 pr-3 text-[11px] font-semibold uppercase tracking-wider">
                    <span className="w-20 text-center text-muted-foreground whitespace-nowrap">{t.permanentWord}</span>
                    {form.is_employee && <span className="w-20 text-center text-brand whitespace-nowrap">{t.traineeWord}</span>}
                  </div>
                </div>
                {form.is_employee && (
                  <p className="text-[11px] text-muted-foreground leading-snug">{t.traineeAccessHintA} <span className="text-brand">{t.traineeWord}</span>{t.traineeAccessHintB}</p>
                )}
                <div className="divide-y divide-border rounded-lg border border-border overflow-hidden">
                  {visibleCapabilityKeys.map(key => {
                    const traineeable = TRAINEE_CAPABILITY_KEYS.includes(key);
                    return (
                      <div key={key} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-start sm:gap-3">
                        <div className="min-w-0 flex-1">
                          <span className="text-sm text-foreground">{CAP_T[key]?.label ?? CAPABILITY_LABELS[key].label}</span>
                          <p className="text-[11px] text-muted-foreground leading-snug">{CAP_T[key]?.desc ?? CAPABILITY_LABELS[key].desc}</p>
                        </div>
                        {/* Toggle(s) on their own line on mobile instead of squeezed beside the
                            label — two fixed 80px columns (Permanent + Trainee) left the label
                            so little width on a narrow phone that long capability names like
                            "Can Assign/Apply Restricted Leaves" wrapped unreadably cramped. */}
                        <div className="flex items-center gap-3 sm:contents">
                          {/* Permanent */}
                          <div className="w-20 flex justify-center pt-0.5">
                            <div role="switch" aria-checked={!!form[key]} onClick={() => setForm(f => ({ ...f, [key]: !f[key] }))}
                              className={`relative w-10 h-6 rounded-full transition-colors flex-shrink-0 cursor-pointer ${form[key] ? (key === 'is_system_admin' ? 'bg-destructive' : 'bg-primary') : 'bg-muted'}`}>
                              <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${form[key] ? 'left-5' : 'left-1'}`} />
                            </div>
                          </div>
                          {/* Trainee (only for employee roles; some caps have no trainee variant) */}
                          {form.is_employee && (
                            <div className="w-20 flex justify-center pt-0.5">
                              {traineeable ? (
                                <div role="switch" aria-checked={!!form.trainee[key]} onClick={() => setForm(f => ({ ...f, trainee: { ...f.trainee, [key]: !f.trainee[key] } }))}
                                  className={`relative w-10 h-6 rounded-full transition-colors flex-shrink-0 cursor-pointer ${form.trainee[key] ? 'bg-brand' : 'bg-muted'}`}>
                                  <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${form.trainee[key] ? 'left-5' : 'left-1'}`} />
                                </div>
                              ) : (
                                <span className="text-muted-foreground/40 text-sm select-none" title={t.permanentWord}>—</span>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* ── Elevated access ───────────────────────────────────────────────────────
                    Deliberately outside the matrix above, and deliberately last. These two are
                    not "more permissions"; they are the two levels of admin. Super Admin sits
                    below System Admin with a visible boundary between them, because it is the
                    one that leaves this system. */}
                <div className="rounded-lg border border-destructive/30 bg-destructive/[0.04] overflow-hidden">
                  <div className="flex items-center gap-2 border-b border-destructive/20 px-3 py-2">
                    <KeyRound className="h-3.5 w-3.5 text-destructive" />
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-destructive">
                      Elevated access
                    </span>
                  </div>
                  {ELEVATED_CAPABILITY_KEYS.map(key => (
                    <div key={key} className="flex flex-col gap-2 border-b border-destructive/15 px-3 py-3 last:border-b-0 sm:flex-row sm:items-start sm:gap-3">
                      <div className="min-w-0 flex-1">
                        <span className="text-sm font-medium text-foreground">
                          {CAP_T[key]?.label ?? CAPABILITY_LABELS[key].label}
                        </span>
                        <p className="text-[11px] text-muted-foreground leading-snug">
                          {CAP_T[key]?.desc ?? CAPABILITY_LABELS[key].desc}
                        </p>
                      </div>
                      <div className="w-20 flex justify-center pt-0.5">
                        <div
                          role="switch"
                          aria-checked={!!form[key]}
                          aria-label={CAPABILITY_LABELS[key].label}
                          onClick={() => {
                            // Turning Super Admin ON asks first; turning it off is immediate,
                            // and a confirmation on the way out would only slow a revocation down.
                            if (key === 'is_super_admin' && !form.is_super_admin) { setConfirmSuperAdmin(true); return; }
                            setForm(f => ({ ...f, [key]: !f[key] }));
                          }}
                          className={`relative w-10 h-6 rounded-full transition-colors flex-shrink-0 cursor-pointer ${form[key] ? 'bg-destructive' : 'bg-muted'}`}>
                          <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${form[key] ? 'left-5' : 'left-1'}`} />
                        </div>
                      </div>
                    </div>
                  ))}
                  {form.is_super_admin && (
                    <p className="border-t border-destructive/20 bg-destructive/[0.06] px-3 py-2 text-[11px] leading-snug text-muted-foreground">
                      Anyone holding this role gets full access here <span className="font-medium text-foreground">and in every other organisation their account exists in</span> — their
                      account is copied into each one. It does <span className="font-medium text-foreground">not</span> grant platform
                      configuration; a platform administrator adds that by email.
                    </p>
                  )}
                </div>

                <label className="flex items-center gap-3 cursor-pointer pt-1">
                  <div onClick={() => setForm(f => ({ ...f, is_active: !f.is_active }))}
                    className={`relative w-10 h-6 rounded-full transition-colors flex-shrink-0 ${form.is_active ? 'bg-success' : 'bg-muted'}`}>
                    <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${form.is_active ? 'left-5' : 'left-1'}`} />
                  </div>
                  <span className="text-sm text-muted-foreground">{t.statusActive}</span>
                </label>
              </div>

              <div className="flex gap-3 pt-2">
                <Button variant="outline" className="flex-1" onClick={() => setShowForm(false)}>{t.cancel}</Button>
                <Button className="flex-1" onClick={() => handleSave()} disabled={saveDisabled}>
                  <Save className="w-4 h-4" />{saving ? t.saving : t.save}
                </Button>
              </div>
              </>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      </Portal>

      <ConfirmModal
        open={!!confirmDelete}
        onOpenChange={() => setConfirmDelete(null)}
        variant="danger"
        title={t.deleteWord}
        description={confirmDelete ? t.deleteRoleConfirm.replace('{name}', confirmDelete.name) : undefined}
        confirmText={t.deleteWord}
        busy={busy}
        onConfirm={async () => {
          if (confirmDelete) await handleDelete(confirmDelete);
          setConfirmDelete(null);
        }}
      />

      <ConfirmModal
        open={confirmSuperAdmin}
        onOpenChange={() => setConfirmSuperAdmin(false)}
        variant="danger"
        title="Give this role Super Admin?"
        description={
          <>
            Everyone with this role gets full access in this system <strong>and in every other
            organisation their account exists in</strong> — their account is copied into each
            one, so a change here reaches far past this screen. It does not grant platform
            configuration: a platform administrator still has to add them by email.
          </>
        }
        confirmText="Turn on Super Admin"
        onConfirm={() => {
          setForm(f => ({ ...f, is_super_admin: true }));
          setConfirmSuperAdmin(false);
        }}
      />

      <ConfirmModal
        open={confirmSelfGrant}
        onOpenChange={() => setConfirmSelfGrant(false)}
        variant="danger"
        title="This is your own role"
        description={
          <>
            You are saving Super Admin onto <strong>{editingRole?.name}</strong>, the role your
            own account holds. Nobody else reviews this. Save it anyway?
          </>
        }
        confirmText="Save anyway"
        busy={saving}
        onConfirm={async () => {
          setConfirmSelfGrant(false);
          await handleSave(true);
        }}
      />

      <ConfirmModal
        open={confirmMigrate}
        onOpenChange={() => setConfirmMigrate(false)}
        variant="warning"
        title="Remap legacy roles"
        description={t.remapLegacyConfirm}
        confirmText="Continue"
        busy={busy}
        onConfirm={async () => {
          setConfirmMigrate(false);
          await handleMigrate();
        }}
      />
    </PageTransition>
  );
}

export default function RolesPage() {
  return <RolesAdminContent />;
}
