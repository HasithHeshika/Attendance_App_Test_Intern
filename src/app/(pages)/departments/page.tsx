'use client';
import { useState, useEffect, useMemo, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Building,
  Building2,
  Plus,
  Edit2,
  Trash2,
  ToggleLeft,
  ToggleRight,
  CheckCircle2,
  Loader2,
  ArrowLeft,
  Network,
  Search,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { tenant } from '@/lib/firebase';
import { useAuthStore } from '@/store/authStore';
import { useUserCapabilities } from '@/store/rolesStore';
import { useCompanyContext } from '@/store/companyContextStore';
import { useT } from '@/store/appStore';
import {
  getDepartments,
  createDepartment,
  updateDepartment,
  deleteDepartment,
} from '@/services/departmentService';
import { getCompanies } from '@/services/companyService';
import ConfirmModal from '@/components/ConfirmModal';
import InlineError from '@/components/InlineError';
import Pagination from '@/components/Pagination';
import type { Department, Company } from '@/lib/types';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { StatCard } from '@/components/ui/stat-card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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

// Gated by its own per-tenant module flag (TenantFeatures in src/lib/tenants.ts) — `tenant`
// is resolved from the hostname (or the NEXT_PUBLIC_FIRESTORE_DB_ID fallback for
// localhost/preview) by src/lib/firebase.ts, so a tenant with the flag off gets this page
// dead on every one of its domains without a separate host check. The sidebar link
// (useSidebarNav.ts) and the app shell's route gate ((pages)/layout.tsx) read the same flag.

// Sub-departments are hidden for now (product decision) but the drill-in view, form wiring,
// and data model all still work — flip this back on to re-enable them. Every sub-department
// UI touchpoint (stat card, table column, "Add/N Sub-department(s)" buttons, the ?parent=
// drill-in route itself) is gated on this flag rather than removed.
const SHOW_SUB_DEPARTMENTS = false;

const empty = { name: '', company_id: '', parent_id: '', is_active: true };

function DepartmentsAdminContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Drill-in: /departments?parent=<id> shows just that department's subs instead of the
  // full top-level list. Kept in the URL (not just component state) so it's bookmarkable
  // and survives back/forward navigation.
  const parentId = searchParams.get('parent');
  const { user } = useAuthStore();
  const caps = useUserCapabilities();
  const t = useT();
  const allowed = tenant.features.departments;
  const canManage = caps.can_manage_departments;
  const canView = canManage || caps.can_view_departments;
  // Top Navbar's Global Company Selector (southernlanka only — see companyContextStore.ts;
  // this page is southernlanka-only anyway, see the file-level comment on the Department
  // type). Filters the list below via companyInScope — is now the ONLY place a company gets
  // picked for a new department (the modal no longer has its own Company field, see
  // openCreate/handleSave). companyId === '' is ambiguous on its own: a switchable admin who
  // hasn't picked one sees every company; a locked user with no company assigned
  // (companyContextBlocked) sees none — companyInScope is what enforces that, not a raw
  // `!companyId` check (see companyContextStore.ts).
  const { companyId, inScope: companyInScope, blocked: companyContextBlocked } = useCompanyContext();

  const [departments, setDepartments] = useState<Department[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState(empty);
  const [saving, setSaving] = useState(false);
  // Surface required-field errors only after the first save attempt.
  const [triedSave, setTriedSave] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Department | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!allowed) router.replace('/dashboard');
  }, [allowed, router]);

  // `silent` re-fetches without flipping the full-page skeleton, so a mutation updates the
  // list in place instead of remounting it (which replays the entrance animations — the
  // "whole page resets" effect).
  //
  // Fetched independently (not Promise.all'd) — Promise.all rejects as soon as ONE of them
  // throws, which would leave the other's setState never called. That silently emptied the
  // company picker whenever the departments read failed (e.g. a missing Firestore rule),
  // even though companies loaded fine. Each fetch now reports its own failure.
  const load = async (silent = false) => {
    if (!silent) setLoading(true);
    const results = await Promise.allSettled([
      getDepartments(),
      getCompanies(),
    ]);
    if (results[0].status === 'fulfilled') setDepartments(results[0].value);
    else {
      console.error(results[0].reason);
      toast.error('Failed to load departments');
    }
    if (results[1].status === 'fulfilled') setCompanies(results[1].value);
    else {
      console.error(results[1].reason);
      toast.error('Failed to load companies');
    }
    if (!silent) setLoading(false);
  };
  useEffect(() => {
    if (allowed) load();
  }, [allowed]);

  // The department whose subs are being viewed (?parent=<id>). Only a top-level department
  // qualifies — a sub-department can't have subs of its own (2-level max) — so an unknown or
  // foreign id just resolves to null and the redirect below bounces back to the top-level list.
  const viewParent = useMemo(() => {
    if (!parentId) return null;
    const d = departments.find((x) => x.id === parentId);
    return d && !d.parent_id ? d : null;
  }, [departments, parentId]);

  useEffect(() => {
    if (allowed && !loading && parentId && !viewParent) {
      toast.error('Department not found');
      router.replace('/departments');
    }
  }, [allowed, loading, parentId, viewParent, router]);

  // Sub-departments are hidden — bounce any ?parent= deep link back to the top-level list
  // instead of rendering the drill-in view.
  useEffect(() => {
    if (!SHOW_SUB_DEPARTMENTS && parentId) router.replace('/departments');
  }, [parentId, router]);

  // Reset to page 1 whenever the view switches between the top-level list and a parent's subs.
  useEffect(() => {
    setPage(1);
  }, [parentId]);

  // Rows for the table: top-level departments normally, or one department's subs when
  // drilled in. Both are flat (subs never have subs of their own), so no tree/indent needed.
  const topLevel = useMemo(() => {
    const ids = new Set(departments.map((d) => d.id));
    return departments
      .filter((d) => !d.parent_id || !ids.has(d.parent_id))
      // Global Company Selector filter, fail-closed — see companyInScope's doc comment above.
      .filter((d) => companyInScope(d.company_id))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [departments, companyInScope]);
  const subRows = useMemo(
    () =>
      viewParent
        ? departments
            .filter((d) => d.parent_id === viewParent.id)
            .sort((a, b) => a.name.localeCompare(b.name))
        : [],
    [departments, viewParent],
  );
  const rows = viewParent ? subRows : topLevel;

  // Search matches on department name and company name (viewing a parent's subs implies a
  // single company, but matching it too keeps this consistent for the top-level list).
  const q = search.trim().toLowerCase();
  const filteredRows = q
    ? rows.filter((d) =>
        [d.name, d.company_name].filter(Boolean).join(' ').toLowerCase().includes(q),
      )
    : rows;

  // Reset to page 1 whenever the search query changes, same as the parent-switch reset above.
  useEffect(() => {
    setPage(1);
  }, [search]);

  // Clamp the current page if a delete (or a reload with fewer rows) leaves it past the end.
  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(filteredRows.length / pageSize));
    if (page > maxPage) setPage(maxPage);
  }, [filteredRows.length, pageSize, page]);

  // Direct child count per department — used to badge parent rows, to block deleting a
  // department that still has sub-departments, and to stop a department that already HAS
  // sub-departments from becoming a sub-department itself (only 2 levels are allowed).
  const childCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of departments)
      if (d.parent_id) m.set(d.parent_id, (m.get(d.parent_id) ?? 0) + 1);
    return m;
  }, [departments]);

  // A department that's already a parent (has sub-departments of its own) can't also
  // become someone else's sub-department — that would create a 3rd level.
  const editingHasChildren = editId
    ? (childCounts.get(editId) ?? 0) > 0
    : false;

  // Live form validation — mirrors the guards in handleSave (name required + unique
  // within the company, company required) so the Save button and inline messages
  // match a real submit.
  const nameTrimmed = form.name.trim();
  const nameDupe =
    !!nameTrimmed &&
    !!form.company_id &&
    departments.some(
      (d) =>
        d.id !== editId &&
        d.company_id === form.company_id &&
        d.name.trim().toLowerCase() === nameTrimmed.toLowerCase(),
    );
  const nameError = !nameTrimmed
    ? 'Enter a department name'
    : nameDupe
      ? 'This company already has a department with that name'
      : '';
  const companyError = !form.company_id ? 'Select a company' : '';
  const saveDisabled = saving || !!nameError || !!companyError;
  // A brand-new top-level department needs a specific company from the navbar's Global
  // Company Selector — "All companies" (companyId === '') is a valid BROWSE state for a
  // switching admin but not a valid one to file a new record under, and companyContextBlocked
  // (a locked user with no company assigned) must never fall through to creating one either.
  // Sub-departments are unaffected (their company comes from viewParent, already fixed).
  const canCreateInCompany = !!viewParent || (!!companyId && !companyContextBlocked);

  const openCreate = () => {
    // Drilled into a parent's subs → pre-fill its company/parent so "Add Sub-department"
    // creates a child of the department currently being viewed (its company is already
    // fixed — no navbar dependency there). A top-level "Add Department" instead takes its
    // company straight from the navbar's Global Company Selector — there's no picker left
    // in this modal (see the read-only company line in the form below), so a specific
    // company MUST already be selected there; the "Add Department" button is disabled
    // otherwise (see canCreateInCompany below) rather than opening a modal with no company
    // to save against.
    if (!viewParent && !companyId) {
      toast.error('Select a company from the navbar first');
      return;
    }
    setForm(
      viewParent
        ? {
            name: '',
            company_id: viewParent.company_id,
            parent_id: viewParent.id,
            is_active: true,
          }
        : { ...empty, company_id: companyId },
    );
    setEditId(null);
    setTriedSave(false);
    setShowForm(true);
  };
  const openEdit = (d: Department) => {
    setForm({
      name: d.name,
      company_id: d.company_id,
      parent_id: d.parent_id ?? '',
      is_active: d.is_active,
    });
    setEditId(d.id);
    setTriedSave(false);
    setShowForm(true);
  };

  const handleSave = async () => {
    setTriedSave(true);
    if (!form.name.trim()) {
      toast.error('Enter a department name');
      return;
    }
    if (!form.company_id) {
      toast.error('Select a company');
      return;
    }
    const company = companies.find((c) => c.id === form.company_id);
    if (!company) {
      toast.error('Select a company');
      return;
    }

    // Department names are unique within a company — a different company can reuse
    // the same name, but one company can't have it twice.
    const nameKey = form.name.trim().toLowerCase();
    const dupe = departments.find(
      (d) =>
        d.id !== editId &&
        d.company_id === company.id &&
        d.name.trim().toLowerCase() === nameKey,
    );
    if (dupe) {
      toast.error('This company already has a department with that name');
      return;
    }

    // Parent must be a top-level department in the same company (never itself a sub-
    // department, and never this department) — keeps the hierarchy to exactly 2 levels.
    let parent: Department | null = null;
    if (form.parent_id) {
      parent = departments.find((d) => d.id === form.parent_id) ?? null;
      if (!parent || parent.company_id !== company.id) {
        toast.error('Pick a parent department from the same company');
        return;
      }
      if (parent.id === editId) {
        toast.error("A department can't be its own parent");
        return;
      }
      if (parent.parent_id) {
        toast.error('Pick a top-level department as the parent (max 2 levels)');
        return;
      }
      if (editingHasChildren) {
        toast.error(
          "This department already has sub-departments — it can't also be a sub-department",
        );
        return;
      }
    }

    setSaving(true);
    try {
      if (editId) {
        await updateDepartment(editId, {
          name: form.name.trim(),
          company_id: company.id,
          company_name: company.name,
          parent_id: parent?.id ?? null,
          parent_name: parent?.name ?? null,
          is_active: form.is_active,
        });
        toast.success('Department updated');
      } else {
        await createDepartment(
          form.name.trim(),
          company.id,
          company.name,
          parent?.id ?? null,
          parent?.name ?? null,
        );
        toast.success('Department created');
      }
      setShowForm(false);
      await load(true);
    } catch {
      toast.error(t.failedToSave);
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (d: Department) => {
    try {
      await updateDepartment(d.id, { is_active: !d.is_active });
      toast.success(d.is_active ? t.deactivatedWord : t.activatedWord);
      await load(true);
    } catch {
      toast.error(t.failedGeneric);
    }
  };

  // A department with sub-departments under it can't be removed until they're moved or
  // removed first — otherwise their parent_id would dangle. Checked before opening the
  // confirm dialog.
  const requestDelete = (d: Department) => {
    const childCount = childCounts.get(d.id) ?? 0;
    if (childCount > 0) {
      toast.error(
        `Move or remove its ${childCount} sub-department${childCount === 1 ? '' : 's'} first`,
      );
      return;
    }
    setConfirmDelete(d);
  };

  // Soft delete (departmentService.deleteDepartment) — the record is kept, just hidden from
  // this list, so the confirm dialog promises removal from view, not destruction.
  const handleDelete = async (d: Department) => {
    setDeletingId(d.id);
    try {
      await deleteDepartment(d.id, d.name);
      toast.success('Department removed');
      if (editId === d.id) setShowForm(false);
      await load(true);
    } catch (e) {
      // deleteDepartment throws a friendly, specific message when the department is still
      // actively referenced (shifts, rosters, employees) — surface that instead of a generic
      // failure so the admin knows exactly what to clear first.
      toast.error(e instanceof Error ? e.message : t.failedGeneric);
    } finally {
      setDeletingId(null);
    }
  };

  if (!allowed) return null;
  // Fail-closed: not allowed to switch companies AND no company on their own profile — bad
  // data, a not-yet-assigned account, or an admin-type role with no company. There is no
  // company to scope the department list by, so show nothing rather than let companyId === ''
  // be silently read as "every company" (see companyContextStore.ts's inScope/blocked).
  if (companyContextBlocked) {
    return (
      <div className="p-10 text-center text-muted-foreground">
        <Building className="w-8 h-8 mx-auto mb-3 opacity-40" />
        <p className="font-medium text-foreground">No assigned company</p>
        <p className="text-sm mt-1">Your account has no company assigned — contact an admin.</p>
      </div>
    );
  }
  if (user?.capabilities && !canView) {
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
        <StatCardsSkeleton count={4} />
        <TableSkeleton rows={6} cols={4} />
      </div>
    );
  // Bad/foreign ?parent=<id> — the redirect effect above is already sending us back to
  // /departments; render nothing for this tick rather than flash the wrong content.
  if (parentId && !viewParent) return null;
  // Sub-departments hidden — same deal, the redirect effect above is already firing.
  if (!SHOW_SUB_DEPARTMENTS && parentId) return null;

  const activeCount = (viewParent ? subRows : topLevel).filter(
    (d) => d.is_active,
  ).length;
  const companiesCovered = new Set((viewParent ? subRows : topLevel).map((d) => d.company_id)).size;
  const subDeptCount = departments.filter(
    (d) => d.parent_id && departments.some((p) => p.id === d.parent_id),
  ).length;
  const paginated = filteredRows.slice((page - 1) * pageSize, page * pageSize);
  const isEmpty = viewParent ? subRows.length === 0 : topLevel.length === 0;
  // Distinct from isEmpty: there IS data, the search just matched none of it — shows a
  // "clear search" prompt instead of the "add your first department" one below.
  const noSearchResults = !isEmpty && q !== '' && filteredRows.length === 0;

  return (
    <PageTransition className="space-y-6">
      {viewParent ? (
        <div className="space-y-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push('/departments')}
            className="-ml-2 text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="w-4 h-4" />
            Departments
          </Button>
          <PageHeader
            title={viewParent.name}
            description={`${subRows.length} sub-department${subRows.length === 1 ? '' : 's'} · ${viewParent.company_name || '—'}`}
            icon={Network}
            actions={
              canManage && (
                <Button onClick={openCreate}>
                  <Plus className="w-4 h-4" />
                  Add Sub-department
                </Button>
              )
            }
          />
        </div>
      ) : (
        <PageHeader
          title="Departments"
          description={
            `${topLevel.length} department${topLevel.length === 1 ? '' : 's'} configured` +
            (companyId ? ` · ${companies.find((c) => c.id === companyId)?.name ?? '—'}` : '')
          }
          icon={Building}
          actions={
            canManage && (
              <Button
                onClick={openCreate}
                disabled={!canCreateInCompany}
                title={!canCreateInCompany ? 'Select a company from the navbar first' : undefined}
              >
                <Plus className="w-4 h-4" />
                Add Department
              </Button>
            )
          }
        />
      )}

      {isEmpty ? (
        <Reveal>
          <Card>
            <EmptyState
              icon={viewParent ? Network : Building}
              title={
                viewParent ? 'No sub-departments yet' : 'No departments yet'
              }
              description={
                viewParent
                  ? `Add the first sub-department under "${viewParent.name}".`
                  : canCreateInCompany
                    ? 'Add your first department for this company.'
                    : 'Select a company from the navbar to add a department.'
              }
              action={
                canManage && (
                  <Button
                    onClick={openCreate}
                    disabled={!canCreateInCompany}
                    title={!canCreateInCompany ? 'Select a company from the navbar first' : undefined}
                  >
                    <Plus className="w-4 h-4" />
                    {viewParent ? 'Add Sub-department' : 'Add Department'}
                  </Button>
                )
              }
            />
          </Card>
        </Reveal>
      ) : (
        <>
          {viewParent ? (
            <Stagger className="grid grid-cols-2 gap-4">
              <StaggerItem>
                <StatCard
                  label="Sub-departments"
                  value={subRows.length}
                  icon={Network}
                  tone="warning"
                />
              </StaggerItem>
              <StaggerItem>
                <StatCard
                  label={t.statusActive}
                  value={activeCount}
                  icon={CheckCircle2}
                  tone="success"
                  hint={
                    subRows.length > activeCount
                      ? `${subRows.length - activeCount} ${t.inactiveLower}`
                      : undefined
                  }
                />
              </StaggerItem>
            </Stagger>
          ) : (
            <Stagger
              className={`grid grid-cols-2 gap-4 ${SHOW_SUB_DEPARTMENTS ? 'lg:grid-cols-4' : 'lg:grid-cols-3'}`}
            >
              <StaggerItem>
                <StatCard
                  label="Departments"
                  value={topLevel.length}
                  icon={Building}
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
                    topLevel.length > activeCount
                      ? `${topLevel.length - activeCount} ${t.inactiveLower}`
                      : undefined
                  }
                />
              </StaggerItem>
              {SHOW_SUB_DEPARTMENTS && (
                <StaggerItem>
                  <StatCard
                    label="Sub-departments"
                    value={subDeptCount}
                    icon={Network}
                    tone="warning"
                  />
                </StaggerItem>
              )}
              <StaggerItem>
                <StatCard
                  label="Companies covered"
                  value={companiesCovered}
                  icon={Building2}
                  tone="brand"
                />
              </StaggerItem>
            </Stagger>
          )}

          <Reveal delay={0.05}>
            <Card className="p-4">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  type="text"
                  name="search-field-no-autofill"
                  autoComplete="off"
                  data-form-type="other"
                  data-lpignore="true"
                  data-1p-ignore="true"
                  autoCorrect="off"
                  spellCheck={false}
                  readOnly
                  onFocus={(e) => e.target.removeAttribute('readonly')}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={
                    viewParent
                      ? 'Search sub-departments…'
                      : 'Search departments or companies…'
                  }
                  className="pl-9 read-only:cursor-text"
                />
              </div>
            </Card>
          </Reveal>

          {noSearchResults ? (
            <Reveal>
              <Card>
                <EmptyState
                  icon={Search}
                  title="No matches found"
                  description={`No departments match "${search.trim()}".`}
                  action={
                    <Button variant="outline" onClick={() => setSearch('')}>
                      Clear search
                    </Button>
                  }
                />
              </Card>
            </Reveal>
          ) : (
          <Reveal delay={0.05}>
            <Card className="overflow-hidden">
              <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
                <CardTitle className="text-sm">
                  {viewParent ? 'Sub-departments' : 'All Departments'}
                </CardTitle>
                <Badge variant="muted">{filteredRows.length} total</Badge>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader className="hidden md:table-header-group">
                    <TableRow>
                      <TableHead>Department</TableHead>
                      <TableHead>Company</TableHead>
                      {!viewParent && SHOW_SUB_DEPARTMENTS && (
                        <TableHead>Sub-departments</TableHead>
                      )}
                      <TableHead>{t.statusLabel}</TableHead>
                      <TableHead className="text-right">
                        {t.actionLabel}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paginated.map((d) => {
                      const childCount = viewParent
                        ? 0
                        : (childCounts.get(d.id) ?? 0);
                      return (
                        <TableRow
                          key={d.id}
                          className={`flex flex-col md:table-row ${!d.is_active ? 'opacity-60' : ''}`}
                        >
                          <TableCell className="md:align-middle">
                            <div className="flex items-center gap-2 min-w-0">
                              <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                                <Building className="w-4 h-4 text-primary" />
                              </div>
                              <div className="text-sm font-semibold text-foreground truncate">
                                {d.name}
                              </div>
                            </div>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground truncate">
                            {d.company_name || '—'}
                          </TableCell>
                          {!viewParent && SHOW_SUB_DEPARTMENTS && (
                            <TableCell>
                              {childCount > 0 || canManage ? (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() =>
                                    router.push(`/departments?parent=${d.id}`)
                                  }
                                  className="gap-1.5"
                                >
                                  <Network className="w-3.5 h-3.5" />
                                  {childCount > 0
                                    ? `${childCount} Sub${childCount === 1 ? '' : 's'}`
                                    : 'Add Sub-department'}
                                </Button>
                              ) : (
                                <span className="text-xs text-muted-foreground">
                                  —
                                </span>
                              )}
                            </TableCell>
                          )}
                          <TableCell>
                            <Badge variant={d.is_active ? 'success' : 'muted'}>
                              {d.is_active ? t.statusActive : t.inactiveWord}
                            </Badge>
                          </TableCell>
                          <TableCell className="md:text-right">
                            {canManage ? (
                              <div className="flex items-center gap-2 md:justify-end">
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  onClick={() => openEdit(d)}
                                  aria-label="Edit department"
                                  title="Edit"
                                  className="text-muted-foreground hover:text-primary"
                                >
                                  <Edit2 className="w-3.5 h-3.5" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  onClick={() => toggleActive(d)}
                                  aria-label={
                                    d.is_active ? 'Deactivate' : 'Activate'
                                  }
                                  title={
                                    d.is_active ? 'Deactivate' : 'Activate'
                                  }
                                  className="text-muted-foreground hover:text-foreground"
                                >
                                  {d.is_active ? (
                                    <ToggleRight className="w-4 h-4" />
                                  ) : (
                                    <ToggleLeft className="w-4 h-4" />
                                  )}
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  onClick={() => requestDelete(d)}
                                  disabled={deletingId === d.id}
                                  aria-label={t.deleteWord}
                                  title="Delete"
                                  className="text-muted-foreground hover:text-destructive"
                                >
                                  {deletingId === d.id ? (
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                  ) : (
                                    <Trash2 className="w-3.5 h-3.5" />
                                  )}
                                </Button>
                              </div>
                            ) : (
                              <span className="text-xs text-muted-foreground md:text-right block">
                                —
                              </span>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </Reveal>
          )}

          {filteredRows.length > pageSize && (
            <Pagination
              page={page}
              pageSize={pageSize}
              total={filteredRows.length}
              onPageChange={setPage}
              onPageSizeChange={setPageSize}
            />
          )}
        </>
      )}

      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {form.parent_id
                ? editId
                  ? 'Edit Sub-department'
                  : 'New Sub-department'
                : editId
                  ? 'Edit Department'
                  : 'New Department'}
            </DialogTitle>
            <DialogDescription className="sr-only">
              Set the department name, its company and (optionally) its parent
              department
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Company
              </Label>
              {/* Read-only — Company is no longer picked here. A new top-level department
                  takes it from the navbar's Global Company Selector (see openCreate, which
                  also blocks opening this form at all when no company is selected there); a
                  sub-department always matches its parent's company; an edit keeps the
                  department's own existing company regardless of what the navbar currently
                  shows. */}
              <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-foreground">
                {companies.find((c) => c.id === form.company_id)?.name ?? '—'}
              </div>
              {form.parent_id && (
                <p className="text-[11px] text-muted-foreground">
                  Matches the parent department&apos;s company.
                </p>
              )}
              {triedSave && <InlineError>{companyError}</InlineError>}
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Department Name <span className="text-destructive">*</span>
              </Label>
              <Input
                type="text"
                value={form.name}
                onChange={(e) =>
                  setForm((f) => ({ ...f, name: e.target.value }))
                }
                placeholder="e.g. Human Resources"
                aria-invalid={(triedSave || nameDupe) && !!nameError}
              />
              {(triedSave || nameDupe) && <InlineError>{nameError}</InlineError>}
            </div>

            {form.parent_id && (
              <p className="text-[11px] text-muted-foreground -mt-2">
                Sub-department of{' '}
                <span className="font-medium text-foreground">
                  {departments.find((d) => d.id === form.parent_id)?.name ??
                    '—'}
                </span>
                .
              </p>
            )}

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

          <DialogFooter>
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => setShowForm(false)}
            >
              {t.cancel}
            </Button>
            <Button className="flex-1" onClick={handleSave} disabled={saveDisabled}>
              {saving ? t.saving : t.save}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmModal
        open={!!confirmDelete}
        onOpenChange={() => setConfirmDelete(null)}
        variant="danger"
        title="Remove department?"
        description={confirmDelete ? `"${confirmDelete.name}" will no longer appear in this list.` : undefined}
        confirmText="Remove"
        busy={!!deletingId}
        onConfirm={async () => {
          if (confirmDelete) await handleDelete(confirmDelete);
          setConfirmDelete(null);
        }}
      />
    </PageTransition>
  );
}

export default function DepartmentsAdminPage() {
  return (
    // useSearchParams() inside DepartmentsAdminContent requires a Suspense boundary at the
    // static-render edge (matches the same pattern used in users/page.tsx and leaves/page.tsx).
    <Suspense
      fallback={
        <div className="space-y-6">
          <PageHeaderSkeleton />
          <StatCardsSkeleton count={4} />
          <TableSkeleton rows={6} cols={4} />
        </div>
      }
    >
      <DepartmentsAdminContent />
    </Suspense>
  );
}
