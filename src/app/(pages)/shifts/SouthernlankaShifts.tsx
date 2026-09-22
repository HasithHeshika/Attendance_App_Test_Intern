'use client';
import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  CalendarRange,
  Plus,
  Edit2,
  Trash2,
  ToggleLeft,
  ToggleRight,
  CheckCircle2,
  Loader2,
  Clock,
  Building,
  Search,
  ArrowLeft,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useUserCapabilities, useRoles } from '@/store/rolesStore';
import { useCompanyContext } from '@/store/companyContextStore';
import { useAuthStore } from '@/store/authStore';
import { useT } from '@/store/appStore';
import {
  getShiftDefinitions,
  subscribeShiftDefinitions,
  createShiftDefinition,
  updateShiftDefinition,
  deleteShiftDefinition,
  type ShiftDefinitionInput,
} from '@/services/shiftDefinitionService';
import { getDepartments } from '@/services/departmentService';
import { getAllUsers } from '@/services/userService';
import { resolveCapabilitiesByName } from '@/lib/permissions';
import Select from '@/components/Select';
import SearchableSelect from '@/components/SearchableSelect';
import ConfirmModal from '@/components/ConfirmModal';
import InlineError from '@/components/InlineError';
import TimePicker from '@/components/TimePicker';
import Pagination from '@/components/Pagination';
import type { Shift, Department, AppUser } from '@/lib/types';
import { shiftDepartmentIds, shiftDepartmentNames } from '@/lib/types';
import { HOD_ELIGIBLE_ROLE, shiftIsRestricted, shiftIsGlobal } from '@/lib/shiftAccess';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardTitle, CardContent } from '@/components/ui/card';
import { StatCard } from '@/components/ui/stat-card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { EmptyState } from '@/components/ui/empty-state';
import {
  PageHeaderSkeleton,
  StatCardsSkeleton,
  TableSkeleton,
} from '@/components/ui/Skeleton';
import {
  PageTransition,
  Reveal,
  Stagger,
  StaggerItem,
} from '@/components/ui/motion';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';

function timeRange(start: string, end: string): string {
  if (!start && !end) return '—';
  return `${start || '—'} – ${end || '—'}`;
}

const empty = {
  name: '',
  department_ids: [] as string[],
  start_time: '',
  end_time: '',
  is_active: true,
  eligible_roles: [] as string[],
  eligible_user_epfs: [] as string[],
};
type FormState = typeof empty;

function SouthernlankaShiftsContent() {
  const router = useRouter();
  const me = useAuthStore((s) => s.user);
  const caps = useUserCapabilities();
  const { roles } = useRoles();
  // Global Company Selector (Top Navbar, southernlanka only — see companyContextStore.ts).
  // A can_manage_all_companies/is_system_admin holder gets whatever they've picked there
  // ('' = nothing picked yet, i.e. no company filter); everyone else is hard-locked to their
  // own AppUser.company_id by the store itself, with no page-level fallback needed here.
  // `companyInScope`/`companyContextBlocked` below are what actually enforce the fail-closed
  // rule for the department list and eligible-employee fetch further down —
  // effectiveCompanyId === '' is ambiguous on its own (see companyContextStore.ts).
  const {
    companyId: effectiveCompanyId,
    blocked: companyContextBlocked,
    inScope: companyInScope,
  } = useCompanyContext();
  const t = useT();
  // Reached only via the Schedule page's "Manage Shifts" button (gated the same way there),
  // so this uses the same can_manage_schedules capability rather than can_manage_users. A
  // Head-of-Department-capable role never gets blanket access from can_manage_schedules alone
  // — see the matching comment on schedule/page.tsx. A Super Admin/System Admin override
  // (AppUser.is_super_admin / resolveUserCapabilities) always bypasses the HOD exclusion.
  const canManageAll = !!caps.can_manage_schedules && (!!caps.is_system_admin || !caps.is_department_head);
  // Head-of-Department-capable ROLE — not whether departments are assigned yet. An HOD role
  // with zero departments assigned still locks to their (empty) assignment rather than
  // falling through to org-wide access; see the "No departments assigned" empty state below.
  const isHODRole = !!caps.is_department_head;
  const deptLocked = !canManageAll && isHODRole;
  // Restricting a shift (HOD/exec-only) is a heavier action than editing an ordinary shift —
  // it decides who can be rostered org-wide. Gate it on System Admin, which also covers a
  // per-user AppUser.is_super_admin grant (resolveUserCapabilities folds one into the other).
  // Swap this for a dedicated can_manage_restricted_shifts capability if finer control is
  // needed. A non-admin can still edit an already-restricted shift's other fields — the
  // eligibility values just round-trip untouched (see handleSave).
  const canManageRestricted = !!caps.is_system_admin;

  const [shifts, setShifts] = useState<Shift[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(empty);
  const [saving, setSaving] = useState(false);
  // Restricted-eligibility section (see src/lib/shiftAccess.ts). `restricted` is its own
  // flag because "both lists empty" is ambiguous — it is BOTH the off state and the
  // just-enabled, not-yet-filled state.
  const [restricted, setRestricted] = useState(false);
  // Company-scoped candidates for "Also allow these EPF numbers" below — fetched only for a
  // System Admin (the only one who can touch the field; see canManageRestricted) and only
  // once there's a company to scope by, to avoid an org-wide user read for everyone who opens
  // this page. Manual EPF entry (SearchableSelect's onCreate) still works for anyone not in
  // this list, same as before this list existed.
  const [eligibleEmployees, setEligibleEmployees] = useState<AppUser[]>([]);
  // Required-field errors surface only after a save attempt; a dupe name still shows live.
  const [triedSave, setTriedSave] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // The shift pending delete confirmation — drives the in-app confirm modal (replaces the
  // native window.confirm(), which showed the raw deployment URL in its title bar).
  const [deleteTarget, setDeleteTarget] = useState<Shift | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  // Table search (shift name) + department filter — client-side over `shifts` below.
  const [search, setSearch] = useState('');
  const [departmentFilter, setDepartmentFilter] = useState('');

  // Fetched independently (not Promise.all'd) — Promise.all rejects as soon as ONE of them
  // throws, which would leave the other's setState never called (same fix as the departments
  // page).
  const load = async (silent = false) => {
    if (!silent) setLoading(true);
    const results = await Promise.allSettled([getShiftDefinitions(), getDepartments()]);
    if (results[0].status === 'fulfilled') setShifts(results[0].value);
    else {
      console.error(results[0].reason);
      toast.error('Failed to load shifts');
    }
    if (results[1].status === 'fulfilled') setDepartments(results[1].value);
    else {
      console.error(results[1].reason);
      toast.error('Failed to load departments');
    }
    if (!silent) setLoading(false);
  };
  useEffect(() => {
    load();
  }, []);

  // Real-time shift definitions — another admin/HOD creating, editing, activating or deleting
  // a shift shows up in this table instantly, with no manual refresh (see
  // subscribeShiftDefinitions in shiftDefinitionService.ts). Fires once immediately with
  // current data — a harmless redundant overlap with load() above — then again on every write.
  useEffect(() => {
    const unsub = subscribeShiftDefinitions(setShifts);
    return () => unsub();
  }, []);

  // A HOD (not also a full admin) never picks outside their own assignment — resolved from
  // AppUser.hod_department_ids (ids already — no name lookup needed, unlike the old
  // single-department flag) the moment departments have loaded. May be more than one.
  // Deliberately NOT company-filtered — this is also what scopedShifts/handleSave's defensive
  // check use to decide what the HOD may manage at all, which must stay their full assignment
  // regardless of which company is currently selected for the Add Shift form's pickers.
  const myDepartments = useMemo(
    () => (deptLocked ? departments.filter((d) => (me?.hod_department_ids ?? []).includes(d.id)) : []),
    [deptLocked, departments, me?.hod_department_ids],
  );
  const myDepartmentIds = useMemo(() => new Set(myDepartments.map((d) => d.id)), [myDepartments]);
  // effectiveCompanyId (from useCompanyContext() above) scopes the Add Shift form's department
  // + eligible-employee pickers below via companyInScope — the fail-closed rule: a switching
  // admin with no company picked yet sees every company's departments; a locked user with no
  // company assigned (companyContextBlocked) sees none, never every company (see
  // companyContextStore.ts).
  const departmentOptions = useMemo(
    () =>
      departments
        .filter((d) => d.is_active)
        .filter((d) => companyInScope(d.company_id))
        .map((d) => ({ value: d.id, label: d.name })),
    [departments, companyInScope],
  );
  const myDepartmentOptions = useMemo(
    () =>
      myDepartments
        .filter((d) => companyInScope(d.company_id))
        .map((d) => ({ value: d.id, label: d.name })),
    [myDepartments, companyInScope],
  );

  // Candidates for the restricted-eligibility EPF picker below, scoped to effectiveCompanyId.
  // Gated on canManageRestricted since that's the only role allowed to touch this field at
  // all — no point reading every user in a company for someone who can't use the list. Also
  // gated on NOT being companyContextBlocked: passing '' straight to getAllUsers() as
  // `undefined` fetches every company's users unconditionally — correct for a switching admin
  // deliberately browsing all companies, but a real fail-open bug for a locked user whose own
  // company_id is empty. Skip the fetch entirely in that case.
  useEffect(() => {
    if (!canManageRestricted || companyContextBlocked) { setEligibleEmployees([]); return; }
    let cancelled = false;
    getAllUsers(effectiveCompanyId || undefined)
      .then((users) => {
        if (cancelled) return;
        setEligibleEmployees(
          users
            .filter((u) => resolveCapabilitiesByName(u.role, roles).is_employee)
            .sort((a, b) => a.display_name.localeCompare(b.display_name)),
        );
      })
      .catch((e) => console.error(e));
    return () => { cancelled = true; };
  }, [canManageRestricted, companyContextBlocked, effectiveCompanyId, roles]);
  // Already-added EPFs are dropped from the dropdown so it never shows a "duplicate" of a chip
  // that's already on the list; typing one manually still works via SearchableSelect's onCreate.
  const eligibleEmployeeOptions = useMemo(
    () =>
      eligibleEmployees
        .filter((u) => !form.eligible_user_epfs.includes(u.epf_number))
        .map((u) => ({ value: u.epf_number, label: u.display_name, sublabel: u.epf_number })),
    [eligibleEmployees, form.eligible_user_epfs],
  );

  // Genuinely locked to ONE department (the common case, and the old behaviour) vs. picking
  // among several assigned ones — only the former hides the department picker/filter UI
  // entirely; the latter still needs a (restricted) picker, same as a full admin's.
  const singleDeptMode = deptLocked && myDepartments.length <= 1;
  // Everything below reads `scopedShifts`, not the raw fetched `shifts` — for a locked HOD
  // that's their assigned department(s) only, so they can never see/edit another department's
  // shifts.
  const scopedShifts = useMemo(
    () => (deptLocked ? shifts.filter((s) => shiftDepartmentIds(s).some((id) => myDepartmentIds.has(id))) : shifts),
    [shifts, deptLocked, myDepartmentIds],
  );
  const departmentFilterOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const s of scopedShifts) {
      const ids = shiftDepartmentIds(s);
      const names = shiftDepartmentNames(s);
      ids.forEach((id, i) => { if (!seen.has(id)) seen.set(id, names[i] || '—'); });
    }
    return [
      { value: '', label: 'All departments' },
      ...Array.from(seen.entries())
        .map(([value, label]) => ({ value, label }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    ];
  }, [scopedShifts]);

  const visibleShifts = useMemo(
    () => [...scopedShifts].sort((a, b) => (a.start_time || '99:99').localeCompare(b.start_time || '99:99')),
    [scopedShifts],
  );
  const filteredShifts = useMemo(() => {
    const q = search.trim().toLowerCase();
    return visibleShifts.filter((s) => {
      if (q && !s.name.toLowerCase().includes(q)) return false;
      if (departmentFilter && !shiftDepartmentIds(s).includes(departmentFilter)) return false;
      return true;
    });
  }, [visibleShifts, search, departmentFilter]);
  const filtersActive = search.trim() !== '' || departmentFilter !== '';

  // Clamp the current page if a delete, or the search/department filter, leaves it past the end.
  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(filteredShifts.length / pageSize));
    if (page > maxPage) setPage(maxPage);
  }, [filteredShifts.length, pageSize, page]);
  useEffect(() => { setPage(1); }, [search, departmentFilter]);

  const openCreate = () => {
    setForm(deptLocked && myDepartments.length === 1 ? { ...empty, department_ids: [myDepartments[0].id] } : empty);
    setEditId(null);
    setTriedSave(false);
    setRestricted(false);
    setShowForm(true);
  };
  const openEdit = (s: Shift) => {
    setForm({
      name: s.name,
      department_ids: shiftDepartmentIds(s),
      start_time: s.start_time ?? '',
      end_time: s.end_time ?? '',
      is_active: s.is_active,
      eligible_roles: s.eligible_roles ?? [],
      eligible_user_epfs: s.eligible_user_epfs ?? [],
    });
    setEditId(s.id);
    setTriedSave(false);
    setRestricted(shiftIsRestricted(s));
    setShowForm(true);
  };

  // ── Restricted-eligibility field handlers ──────────────────────────────────
  // Every one of these no-ops without canManageRestricted — the controls are also disabled
  // in the UI, this is the belt-and-braces half so state can't be nudged another way.
  const addEpfChip = (raw: string) => {
    if (!canManageRestricted) return;
    const v = raw.trim();
    if (!v) return;
    setForm((f) =>
      f.eligible_user_epfs.includes(v)
        ? f
        : { ...f, eligible_user_epfs: [...f.eligible_user_epfs, v] },
    );
  };
  const removeEpfChip = (v: string) => {
    if (!canManageRestricted) return;
    setForm((f) => ({ ...f, eligible_user_epfs: f.eligible_user_epfs.filter((e) => e !== v) }));
  };
  const toggleHodEligible = () => {
    if (!canManageRestricted) return;
    setForm((f) => ({
      ...f,
      eligible_roles: f.eligible_roles.includes(HOD_ELIGIBLE_ROLE)
        ? f.eligible_roles.filter((r) => r !== HOD_ELIGIBLE_ROLE)
        : [...f.eligible_roles, HOD_ELIGIBLE_ROLE],
    }));
  };
  const toggleRestricted = () => {
    if (!canManageRestricted) return;
    setRestricted((on) => {
      if (on) setForm((f) => ({ ...f, eligible_roles: [], eligible_user_epfs: [] }));
      return !on;
    });
  };

  const handleSave = async () => {
    setTriedSave(true);
    const originalShift = editId ? shifts.find((s) => s.id === editId) : undefined;
    if (!form.name.trim()) {
      toast.error('Enter a shift name');
      return;
    }
    // A restricted (HOD/exec) shift is global — it isn't tied to departments, so the picker
    // is optional there. An ordinary shift still needs at least one. See shiftIsGlobal().
    if (!restricted && form.department_ids.length === 0) {
      toast.error('Select at least one department');
      return;
    }
    if (restricted && !canManageRestricted) {
      toast.error('Only a System Admin can create or change a restricted shift');
      return;
    }
    const selectedDepartments = departments.filter((d) => form.department_ids.includes(d.id));
    if (selectedDepartments.length !== form.department_ids.length) {
      toast.error('One of the selected departments no longer exists — reselect and try again');
      return;
    }
    // Defensive — the department picker is already restricted to the HOD's assigned
    // department(s) (see the form below), but re-assert it here too in case that state ever
    // falls out of sync.
    if (deptLocked && form.department_ids.some((id) => !myDepartmentIds.has(id))) {
      toast.error('You can only manage shifts for your assigned departments');
      return;
    }
    if (!form.start_time) {
      toast.error('Pick a from time');
      return;
    }
    if (!form.end_time) {
      toast.error('Pick a to time');
      return;
    }

    // Trim/dedupe. A restricted shift with nothing on the allow-list would lock everyone
    // out — treat that like a missing required field rather than silently saving an
    // unusable shift.
    const cleanEpfs = Array.from(new Set(
      form.eligible_user_epfs.map((e) => e.trim()).filter(Boolean),
    ));
    if (canManageRestricted && restricted && form.eligible_roles.length === 0 && cleanEpfs.length === 0) {
      toast.error('Add at least one role or EPF for a restricted shift, or turn the restriction off');
      return;
    }

    // Shift names stay unique within any ONE shared department — the same name can be reused
    // across unrelated departments, but never overlap another shift sharing at least one of
    // the departments just selected.
    const nameKey = form.name.trim().toLowerCase();
    const dupe = shifts.find((s) =>
      s.id !== editId
      && s.name.trim().toLowerCase() === nameKey
      && shiftDepartmentIds(s).some((id) => form.department_ids.includes(id)),
    );
    if (dupe) {
      toast.error('A shift with that name already exists in one of the selected departments');
      return;
    }

    const input: ShiftDefinitionInput = {
      name: form.name.trim(),
      department_ids:   selectedDepartments.map((d) => d.id),
      department_names: selectedDepartments.map((d) => d.name),
      // Fully retire the legacy single-department fields on every save, so a doc never
      // carries both shapes at once (see the @deprecated fields on Shift).
      department_id:   null,
      department_name: null,
      start_time: form.start_time,
      end_time: form.end_time,
      is_active: form.is_active,
      // Empty arrays when unrestricted — canUserAccessShift() reads "both empty" as
      // open, Firestore stores [] fine, and it is never undefined (addDoc rejects that).
      // A non-admin editing an already-restricted shift can't touch these — carry the
      // saved values through verbatim so an ordinary edit never strips the restriction.
      ...(canManageRestricted
        ? {
            eligible_roles:     restricted ? form.eligible_roles : [],
            eligible_user_epfs: restricted ? cleanEpfs : [],
          }
        : {
            eligible_roles:     originalShift?.eligible_roles ?? [],
            eligible_user_epfs: originalShift?.eligible_user_epfs ?? [],
          }),
    };

    setSaving(true);
    try {
      if (editId) {
        await updateShiftDefinition(editId, input);
        toast.success('Shift updated');
      } else {
        await createShiftDefinition(input);
        toast.success('Shift created');
      }
      setShowForm(false);
      setForm(empty);
      setTriedSave(false);
      setEditId(null);
      setRestricted(false);
      await load(true);
    } catch (e) {
      console.error(e);
      toast.error(t.failedToSave);
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (s: Shift) => {
    try {
      await updateShiftDefinition(s.id, { is_active: !s.is_active });
      toast.success(s.is_active ? t.deactivatedWord : t.activatedWord);
      await load(true);
    } catch {
      toast.error(t.failedGeneric);
    }
  };

  // Runs once the in-app confirm modal is accepted. Soft delete
  // (shiftDefinitionService.deleteShiftDefinition) — the record is kept, just hidden from
  // this list, so the modal promises removal from view, not destruction.
  const confirmDelete = async () => {
    const s = deleteTarget;
    if (!s) return;
    setDeletingId(s.id);
    try {
      await deleteShiftDefinition(s.id);
      toast.success('Shift removed');
      if (editId === s.id) setShowForm(false);
      setDeleteTarget(null);
      await load(true);
    } catch (e) {
      // deleteShiftDefinition throws a friendly, specific message when the shift is still
      // referenced by a live roster entry — surface that instead of a generic failure.
      toast.error(e instanceof Error ? e.message : t.failedGeneric);
    } finally {
      setDeletingId(null);
    }
  };

  // Fail-closed: not allowed to switch companies AND no company on their own profile — bad
  // data, a not-yet-assigned account, or an admin-type role with no company. Nothing to scope
  // departments/employees by, so show nothing rather than let effectiveCompanyId === '' be
  // silently read as "every company" (see companyContextStore.ts's inScope/blocked).
  if (companyContextBlocked) {
    return (
      <div className="p-10 text-center text-muted-foreground">
        <Building className="w-8 h-8 mx-auto mb-3 opacity-40" />
        <p className="font-medium text-foreground">No assigned company</p>
        <p className="text-sm mt-1">Your account has no company assigned — contact an admin.</p>
      </div>
    );
  }
  // Blocks only someone with neither org-wide manage nor an HOD-capable role — an HOD role
  // with zero departments assigned still gets past this, to the friendlier "no departments
  // assigned to you" empty state below instead of this generic message.
  if (caps && !canManageAll && !isHODRole) {
    return (
      <div className="text-muted-foreground p-10 text-center">
        {t.noAccessSection}
      </div>
    );
  }
  if (loading)
    return (
      <div className="space-y-6">
        <PageHeaderSkeleton />
        <StatCardsSkeleton count={3} />
        <TableSkeleton rows={6} cols={5} />
      </div>
    );
  if (deptLocked && myDepartments.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={Building}
          title="No departments assigned to you"
          description="Contact an admin to assign you as Head of Department for one or more departments."
        />
      </Card>
    );
  }

  const activeCount = scopedShifts.filter((s) => s.is_active).length;
  const departmentsCovered = new Set(scopedShifts.flatMap((s) => shiftDepartmentIds(s))).size;
  const paginated = filteredShifts.slice((page - 1) * pageSize, page * pageSize);

  // Live form validation — mirrors the guards in handleSave so the Save button's
  // disabled state and the inline messages always match a real submit.
  const shiftNameTrimmed = form.name.trim();
  const shiftNameDupe =
    !!shiftNameTrimmed &&
    form.department_ids.length > 0 &&
    shifts.some(
      (s) =>
        s.id !== editId &&
        s.name.trim().toLowerCase() === shiftNameTrimmed.toLowerCase() &&
        shiftDepartmentIds(s).some((id) => form.department_ids.includes(id)),
    );
  const shiftNameError = !shiftNameTrimmed
    ? 'Enter a shift name'
    : shiftNameDupe
      ? 'A shift with that name already exists in one of the selected departments'
      : '';
  // Departments are only required for an ordinary shift — a restricted one is global.
  const shiftDeptError = (!restricted && form.department_ids.length === 0) ? 'Select at least one department' : '';
  const shiftStartError = !form.start_time ? 'Pick a from time' : '';
  const shiftEndError = !form.end_time ? 'Pick a to time' : '';
  const shiftRestrictError =
    canManageRestricted &&
    restricted &&
    form.eligible_roles.length === 0 &&
    form.eligible_user_epfs.length === 0
      ? 'Add at least one role or EPF, or turn the restriction off'
      : '';

  return (
    <PageTransition className="space-y-6">
      <div className="space-y-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push('/schedule')}
          className="-ml-2 text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="w-4 h-4" />
          Schedule
        </Button>
        <PageHeader
          title="Shifts"
          description={
            deptLocked
              ? `${scopedShifts.length} shift${scopedShifts.length === 1 ? '' : 's'} across ${myDepartments.length} department${myDepartments.length === 1 ? '' : 's'}`
              : `${scopedShifts.length} shift${scopedShifts.length === 1 ? '' : 's'} configured`
          }
          icon={CalendarRange}
          actions={
            <Button onClick={openCreate}>
              <Plus className="w-4 h-4" />
              Add Shift
            </Button>
          }
        />
      </div>

      {scopedShifts.length === 0 ? (
        <Reveal>
          <Card>
            <EmptyState
              icon={CalendarRange}
              title="No shifts yet"
              description={
                deptLocked
                  ? `Add the first shift for ${myDepartments.length === 1 ? myDepartments[0].name : 'one of your departments'}.`
                  : 'Add your first shift and assign it to a department.'
              }
              action={
                <Button onClick={openCreate}>
                  <Plus className="w-4 h-4" />
                  Add Shift
                </Button>
              }
            />
          </Card>
        </Reveal>
      ) : (
        <>
          <Stagger className={`grid grid-cols-2 gap-4 ${singleDeptMode ? '' : 'lg:grid-cols-3'}`}>
            <StaggerItem>
              <StatCard
                label="Shifts"
                value={scopedShifts.length}
                icon={CalendarRange}
                tone="primary"
              />
            </StaggerItem>
            <StaggerItem>
              <StatCard
                label={t.statusActive}
                value={activeCount}
                icon={CheckCircle2}
                tone="success"
                hint={
                  scopedShifts.length > activeCount
                    ? `${scopedShifts.length - activeCount} ${t.inactiveLower}`
                    : undefined
                }
              />
            </StaggerItem>
            {/* Meaningless when locked to a single department (always 1) — shown for a full
                admin or a HOD assigned more than one department. */}
            {!singleDeptMode && (
              <StaggerItem>
                <StatCard
                  label="Departments covered"
                  value={departmentsCovered}
                  icon={Building}
                  tone="brand"
                  wrapLabel
                />
              </StaggerItem>
            )}
          </Stagger>

          <Reveal delay={0.05} className="space-y-4">
            {/* Toolbar lives in its OWN card with no overflow-hidden. The department
                filter's dropdown is absolutely-positioned within the Select, and the table
                card's overflow-hidden was clipping it into a cropped, mis-anchored box
                whenever it opened (especially when it flipped to drop upward). */}
            <Card className="flex flex-col items-stretch gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2 flex-shrink-0">
                <CardTitle className="text-sm">All Shifts</CardTitle>
                <Badge variant="muted">{scopedShifts.length} total</Badge>
              </div>
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 w-full sm:w-auto">
                <div className="relative w-full sm:max-w-[220px]">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search shift name…"
                    className="pl-8 h-9 text-xs w-full"
                  />
                </div>
                {/* Only one department in scope for a locked-to-one HOD — nothing to filter. */}
                {!singleDeptMode && (
                  <Select
                    value={departmentFilter}
                    onChange={setDepartmentFilter}
                    options={departmentFilterOptions}
                    placeholder="All departments"
                    searchable
                  />
                )}
              </div>
            </Card>

            <Card className="overflow-hidden">
              <CardContent className="p-0">
                {filteredShifts.length === 0 ? (
                  <EmptyState
                    icon={Search}
                    title="No matches"
                    description="Try a different shift name or department filter."
                    action={
                      filtersActive && (
                        <Button variant="outline" size="sm" onClick={() => { setSearch(''); setDepartmentFilter(''); }}>
                          Clear filters
                        </Button>
                      )
                    }
                  />
                ) : (
                <Table>
                  <TableHeader className="hidden md:table-header-group">
                    <TableRow>
                      <TableHead>Shift Name</TableHead>
                      <TableHead>Department</TableHead>
                      <TableHead>Time</TableHead>
                      <TableHead>{t.statusLabel}</TableHead>
                      <TableHead className="text-right">
                        {t.actionLabel}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paginated.map((s) => (
                      <TableRow
                        key={s.id}
                        className={`flex flex-col md:table-row ${!s.is_active ? 'opacity-60' : ''}`}
                      >
                        <TableCell className="md:align-middle">
                          <div className="flex items-center gap-3 min-w-0">
                            <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                              <Clock className="w-4 h-4 text-primary" />
                            </div>
                            <div className="text-sm font-semibold text-foreground truncate">
                              {s.name}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {shiftDepartmentNames(s).length ? (
                            <div className="flex flex-wrap gap-1">
                              {shiftDepartmentNames(s).map((name) => (
                                <span key={name} className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-warning/15 text-warning border border-warning/30">
                                  {name}
                                </span>
                              ))}
                            </div>
                          ) : shiftIsGlobal(s) ? (
                            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/30">
                              All departments
                            </span>
                          ) : '—'}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {timeRange(s.start_time, s.end_time)}
                        </TableCell>
                        <TableCell>
                          <Badge variant={s.is_active ? 'success' : 'muted'}>
                            {s.is_active ? t.statusActive : t.inactiveWord}
                          </Badge>
                        </TableCell>
                        <TableCell className="md:text-right">
                          <div className="flex items-center gap-2 md:justify-end">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => openEdit(s)}
                              aria-label="Edit shift"
                              title="Edit"
                              className="text-muted-foreground hover:text-primary"
                            >
                              <Edit2 className="w-3.5 h-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => toggleActive(s)}
                              aria-label={
                                s.is_active ? 'Deactivate' : 'Activate'
                              }
                              title={s.is_active ? 'Deactivate' : 'Activate'}
                              className="text-muted-foreground hover:text-foreground"
                            >
                              {s.is_active ? (
                                <ToggleRight className="w-4 h-4" />
                              ) : (
                                <ToggleLeft className="w-4 h-4" />
                              )}
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => setDeleteTarget(s)}
                              disabled={deletingId === s.id}
                              aria-label={t.deleteWord}
                              title="Delete"
                              className="text-muted-foreground hover:text-destructive"
                            >
                              {deletingId === s.id ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <Trash2 className="w-3.5 h-3.5" />
                              )}
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                )}
              </CardContent>
            </Card>
          </Reveal>

          {filteredShifts.length > pageSize && (
            <Pagination
              page={page}
              pageSize={pageSize}
              total={filteredShifts.length}
              onPageChange={setPage}
              onPageSizeChange={setPageSize}
            />
          )}
        </>
      )}

      {/* Delete confirmation — shared <ConfirmModal>, replaces window.confirm(). */}
      <ConfirmModal
        open={!!deleteTarget}
        onOpenChange={() => setDeleteTarget(null)}
        variant="danger"
        title="Remove shift?"
        description={deleteTarget ? `“${deleteTarget.name}” will no longer appear in this list.` : undefined}
        confirmText={t.deleteWord}
        busy={deletingId != null}
        onConfirm={confirmDelete}
      />

      <Dialog open={showForm} onOpenChange={setShowForm}>
        {/* Cap the modal to the viewport and scroll the FORM BODY only — the header and the
            Cancel / Save footer stay pinned and visible. The department list is a chip
            multi-select that can run very tall, which used to push both off-screen at 100%
            zoom with no way to scroll. */}
        <DialogContent className="max-w-md max-h-[calc(100dvh-2rem)] overflow-hidden p-0 gap-0 flex flex-col">
          <DialogHeader className="flex-shrink-0 px-6 pt-6 pb-4">
            <DialogTitle>{editId ? 'Edit Shift' : 'New Shift'}</DialogTitle>
            <DialogDescription className="sr-only">
              Set the shift name, department and time window
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 min-h-0 overflow-y-auto px-6 space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Shift Name <span className="text-destructive">*</span>
              </Label>
              <Input
                type="text"
                value={form.name}
                onChange={(e) =>
                  setForm((f) => ({ ...f, name: e.target.value }))
                }
                placeholder="e.g. Morning Shift"
                aria-invalid={(triedSave || shiftNameDupe) && !!shiftNameError}
              />
              {(triedSave || shiftNameDupe) && <InlineError>{shiftNameError}</InlineError>}
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Departments{' '}
                {restricted
                  ? <span className="font-normal normal-case text-muted-foreground">(optional — applies to all)</span>
                  : <span className="text-destructive">*</span>}
              </Label>
              {restricted && form.department_ids.length === 0 && (
                <p className="text-[11px] text-muted-foreground">
                  Leave empty and this restricted shift is available across every department. Pick some to also confine it.
                </p>
              )}
              {/* Full admin sees every active department (with a Select All); a HOD sees only
                  their own assigned departments (myDepartmentOptions) — never a free org-wide
                  pick. One shift can now be shared by any number of departments at once (see
                  Shift.department_ids), so this is a chip multi-select either way, not a
                  single Select. */}
              {(() => {
                const options = deptLocked ? myDepartmentOptions : departmentOptions;
                const selectedCount = options.filter((o) => form.department_ids.includes(o.value)).length;
                const allSelected = options.length > 0 && selectedCount === options.length;
                return options.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground">
                    {deptLocked
                      ? 'Contact an admin — no departments are assigned to you.'
                      : 'Add a department first, under Departments.'}
                  </p>
                ) : (
                  <>
                    <label className="flex items-center gap-2 cursor-pointer text-xs font-semibold text-foreground">
                      <Checkbox
                        checked={allSelected ? true : (selectedCount > 0 ? 'indeterminate' : false)}
                        onCheckedChange={() =>
                          setForm((f) => ({
                            ...f,
                            department_ids: allSelected ? [] : options.map((o) => o.value),
                          }))
                        }
                      />
                      Select All ({options.length})
                    </label>
                    <div className="flex flex-wrap gap-2">
                      {options.map((o) => {
                        const active = form.department_ids.includes(o.value);
                        return (
                          <button
                            key={o.value}
                            type="button"
                            onClick={() =>
                              setForm((f) => ({
                                ...f,
                                department_ids: active
                                  ? f.department_ids.filter((id) => id !== o.value)
                                  : [...f.department_ids, o.value],
                              }))
                            }
                            className={`px-2.5 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
                              active
                                ? 'bg-primary/10 border-primary/30 text-primary'
                                : 'bg-card border-border text-muted-foreground hover:text-foreground hover:bg-accent'
                            }`}
                          >
                            {o.label}
                          </button>
                        );
                      })}
                    </div>
                  </>
                );
              })()}
              {triedSave && shiftDeptError && <InlineError>{shiftDeptError}</InlineError>}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  From Time <span className="text-destructive">*</span>
                </Label>
                <TimePicker
                  value={form.start_time}
                  onChange={(v) => setForm((f) => ({ ...f, start_time: v }))}
                  placeholder="From time"
                />
                {triedSave && <InlineError>{shiftStartError}</InlineError>}
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  To Time <span className="text-destructive">*</span>
                </Label>
                <TimePicker
                  value={form.end_time}
                  onChange={(v) => setForm((f) => ({ ...f, end_time: v }))}
                  placeholder="To time"
                />
                {triedSave && <InlineError>{shiftEndError}</InlineError>}
              </div>
            </div>

            {/* Restricted eligibility — WHO may be scheduled onto this shift, on top of
                the department scoping above. Off ⇒ open to everyone in the selected
                departments (the default). See src/lib/shiftAccess.ts / canUserAccessShift. */}
            <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">Restrict who can be scheduled</p>
                  <p className="text-[11px] text-muted-foreground">
                    {restricted
                      ? 'Only the Heads of Department and/or EPFs below can be given this shift.'
                      : 'Anyone in the selected departments can be given this shift.'}
                  </p>
                  {!canManageRestricted && (
                    <p className="text-[11px] italic text-muted-foreground mt-0.5">
                      Only a System Admin can {restricted ? 'change this restriction' : 'restrict a shift'}.
                    </p>
                  )}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={toggleRestricted}
                  disabled={!canManageRestricted}
                  title={!canManageRestricted ? 'System Admin only' : undefined}
                  aria-pressed={restricted}
                  aria-label={restricted ? 'Remove restriction' : 'Restrict this shift'}
                >
                  {restricted ? (
                    <ToggleRight className="w-5 h-5 text-primary" />
                  ) : (
                    <ToggleLeft className="w-5 h-5 text-muted-foreground" />
                  )}
                </Button>
              </div>

              {restricted && (
                <div className="space-y-3 pt-1">
                  <label className="flex items-center gap-2 cursor-pointer text-xs font-semibold text-foreground">
                    <Checkbox
                      checked={form.eligible_roles.includes(HOD_ELIGIBLE_ROLE)}
                      onCheckedChange={toggleHodEligible}
                      disabled={!canManageRestricted}
                    />
                    All Heads of Department
                    <span className="font-normal text-muted-foreground">— automatic</span>
                  </label>

                  <div className="space-y-1.5">
                    <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      Also allow these EPF numbers
                    </Label>
                    {/* Search-and-pick from this shift's company (effectiveCompanyId) rather
                        than free typing, so eligibility can't accidentally reach into another
                        company's roster. Typing a name/EPF not in the list still falls back to
                        onCreate, for anyone not yet migrated into the picked company. */}
                    <SearchableSelect
                      value=""
                      onChange={addEpfChip}
                      options={eligibleEmployeeOptions}
                      disabled={!canManageRestricted}
                      placeholder="Search a name or EPF…"
                      emptyLabel={effectiveCompanyId ? 'No matching employees in this company' : 'No matching employees'}
                      onCreate={addEpfChip}
                      createLabel={(q) => `Add EPF "${q}"`}
                    />
                    {form.eligible_user_epfs.length > 0 && (
                      <div className="flex flex-wrap gap-2 pt-1">
                        {form.eligible_user_epfs.map((epf) => (
                          <span
                            key={epf}
                            className="inline-flex items-center gap-1 rounded-full bg-primary/10 border border-primary/30 text-primary text-xs font-semibold px-2 py-1"
                          >
                            {epf}
                            {canManageRestricted && (
                              <button
                                type="button"
                                onClick={() => removeEpfChip(epf)}
                                aria-label={`Remove ${epf}`}
                                className="hover:text-destructive"
                              >
                                ×
                              </button>
                            )}
                          </span>
                        ))}
                      </div>
                    )}
                    <p className="text-[11px] text-muted-foreground">
                      For people who need this shift without a Head-of-Department role — e.g. senior execs.
                    </p>
                    {triedSave && shiftRestrictError && <InlineError>{shiftRestrictError}</InlineError>}
                  </div>
                </div>
              )}
            </div>

            {editId && (
              <label className="flex items-center justify-between gap-3 cursor-pointer rounded-lg border border-border bg-muted/30 px-3 py-2.5">
                <span className="text-sm font-medium text-foreground">
                  {t.statusActive}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() =>
                    setForm((f) => ({ ...f, is_active: !f.is_active }))
                  }
                >
                  {form.is_active ? (
                    <ToggleRight className="w-5 h-5 text-primary" />
                  ) : (
                    <ToggleLeft className="w-5 h-5 text-muted-foreground" />
                  )}
                </Button>
              </label>
            )}
          </div>

          <DialogFooter className="flex-shrink-0 px-6 pb-6 pt-4 border-t border-border">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => setShowForm(false)}
            >
              {t.cancel}
            </Button>
            <Button className="flex-1" onClick={handleSave} disabled={saving}>
              {saving ? t.saving : t.save}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageTransition>
  );
}

export default function SouthernlankaShifts() {
  return <SouthernlankaShiftsContent />;
}
