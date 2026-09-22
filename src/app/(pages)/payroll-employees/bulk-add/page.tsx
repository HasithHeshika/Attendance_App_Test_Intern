'use client';
// Bulk Add / Mass Initialize Payroll Profiles — a dedicated full-page workflow (not a modal)
// for onboarding many employees at once. Departments and Roles/Designations do NOT have
// payroll profiles of their own — profiles belong strictly to individual employees; picking
// a department or designation here is only a bulk-selection shortcut, never an entity that
// gets written to Firestore. Step 3 always ends by writing one independent
// payroll_employees/{epfDocId} document per selected employee — see
// createBulkPayrollEmployees() in payrollEmployeeService.ts, which is what actually performs
// the batch write. Employees who already have a profile CAN be selected too (flagged with a
// "Profile Exists" badge in Step 1) — by default they're safely skipped at save time, but the
// Step 2 "Overwrite existing profile values" toggle applies the baseline to them as well.

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Search, CheckCircle2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuthStore } from '@/store/authStore';
import { useUserCapabilities } from '@/store/rolesStore';
import { tenant } from '@/lib/firebase';
import { useCompanyContext } from '@/store/companyContextStore';
import { getCompany } from '@/services/companyService';
import { getAllEmployees } from '@/services/userService';
import type { Company, AppUser } from '@/lib/types';
import type { PayrollComponent, PayrollSettings } from '@/lib/payrollTypes';
import {
  getPayrollEmployeesForCompany, createBulkPayrollEmployees, type PayrollBulkDefaults,
} from '@/services/payrollEmployeeService';
import { getActivePayrollComponents, getPayrollSettings } from '@/services/payrollSettingsService';
import { getActiveRoles } from '@/services/roleService';
import { validatePayrollEmployee } from '@/lib/payrollValidation';
import { ComponentRows } from '@/components/payroll/ComponentRows';
import InlineError from '@/components/InlineError';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { EmptyState } from '@/components/ui/empty-state';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

function useActor() {
  const { user } = useAuthStore();
  return { epf: user?.epf_number ?? '', name: user?.name ?? '' };
}

const STEPS = [
  { key: 'select', label: 'Select Employees' },
  { key: 'defaults', label: 'Set Defaults' },
  { key: 'review', label: 'Review & Save' },
] as const;
type StepKey = typeof STEPS[number]['key'];

function emptyBulkDefaults(): PayrollBulkDefaults {
  return {
    basic_salary: 0,
    is_epf_applicable: true,
    is_etf_applicable: true,
    is_tax_applicable: true,
    target_hours_override: null,
    hours_per_day: null,
    ot_multiplier_normal: 1.5,
    ot_multiplier_double: 2.0,
    allowances: [],
    deductions: [],
  };
}

export default function BulkAddPayrollEmployeesPage() {
  const caps = useUserCapabilities();

  if (!tenant.features.payroll) {
    return <div className="p-10 text-center text-muted-foreground">Payroll is not enabled for this organisation.</div>;
  }
  if (!caps.is_system_admin && !caps.can_manage_pay_profiles) {
    return <div className="p-10 text-center text-muted-foreground">You don&apos;t have access to this section.</div>;
  }
  return <BulkAddContent />;
}

function BulkAddContent() {
  const router = useRouter();
  const actor = useActor();
  // Follows the Top Navbar's Global Company Selector, same as the Payroll Employees page this
  // is reached from — no page-local picker here (there never was one; this page only READ
  // usePayrollUiStore's shared companyId, which would have gone stale once the other payroll
  // pages stopped writing to it). '' (a switching admin's "All companies" pick) is correctly
  // treated as "no company selected" below — a bulk-initialize run always targets ONE company.
  const { companyId, ready: companyContextReady } = useCompanyContext();

  const [company, setCompany] = useState<Company | null>(null);
  const [users, setUsers] = useState<AppUser[]>([]);
  const [existingProfileEpfs, setExistingProfileEpfs] = useState<Set<string>>(new Set());
  const [components, setComponents] = useState<PayrollComponent[]>([]);
  const [settings, setSettings] = useState<PayrollSettings | null>(null);
  const [roleNames, setRoleNames] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [step, setStep] = useState<StepKey>('select');

  // Step 1 state
  const [search, setSearch] = useState('');
  const [departmentFilter, setDepartmentFilter] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [selectedEpfs, setSelectedEpfs] = useState<Set<string>>(new Set());

  // Step 2 state
  const [defaults, setDefaults] = useState<PayrollBulkDefaults>(emptyBulkDefaults());
  const [overwriteExisting, setOverwriteExisting] = useState(false);

  useEffect(() => {
    // See payroll-loans/page.tsx's matching comment — useCompanyContext() forces companyId to
    // '' until it actually settles (Firebase Auth + the roles registry both need to load).
    // Returning here without touching `loading` (which starts true) keeps the skeleton up
    // instead of flashing "No company selected" for an instant before the real id arrives.
    if (!companyContextReady) return;
    if (!companyId) { setLoading(false); return; }
    setLoading(true);
    Promise.all([
      getCompany(companyId),
      getAllEmployees(companyId),
      getPayrollEmployeesForCompany(companyId),
      getActivePayrollComponents(),
      getPayrollSettings(),
      getActiveRoles(),
    ]).then(([c, u, profiles, comps, s, roles]) => {
      setCompany(c);
      setUsers(u);
      setExistingProfileEpfs(new Set(profiles.map(p => p.epf_number)));
      setComponents(comps);
      setSettings(s);
      // The full list of active Roles from the Roles module — NOT derived from this
      // company's candidates, so every configured role shows up here even if no one in
      // this specific filtered set currently holds it.
      setRoleNames(roles.map(r => r.name).sort());
    }).catch(() => toast.error('Failed to load employees.'))
      .finally(() => setLoading(false));
  }, [companyId, companyContextReady]);

  // Every active employee is selectable — including ones who already have a profile (shown
  // with a "Profile Exists" badge in Step 1 and, unless the Step 2 overwrite toggle is on,
  // safely skipped rather than clobbered at save time). A Department/Role is just a filter
  // over this same list, never its own entity.
  const candidates = useMemo(() => users.filter(u => u.is_active), [users]);
  const departments = useMemo(() => Array.from(new Set(candidates.map(u => u.department).filter(Boolean))).sort(), [candidates]);

  const visibleCandidates = useMemo(() => {
    const q = search.trim().toLowerCase();
    return candidates.filter(u => {
      if (departmentFilter && u.department !== departmentFilter) return false;
      if (roleFilter && u.role !== roleFilter) return false;
      if (!q) return true;
      return [u.display_name, u.first_name, u.last_name, u.epf_number, u.employee_number]
        .filter(Boolean).join(' ').toLowerCase().includes(q);
    });
  }, [candidates, search, departmentFilter, roleFilter]);

  const toggleOne = (epf: string, checked: boolean) => {
    setSelectedEpfs(prev => {
      const next = new Set(prev);
      if (checked) next.add(epf); else next.delete(epf);
      return next;
    });
  };
  const setManyChecked = (list: AppUser[], checked: boolean) => {
    setSelectedEpfs(prev => {
      const next = new Set(prev);
      list.forEach(u => { if (checked) next.add(u.epf_number); else next.delete(u.epf_number); });
      return next;
    });
  };
  // Picking a department/designation is a bulk-selection SHORTCUT — it narrows the visible
  // table to that group AND immediately checks everyone in it. Nothing is written anywhere;
  // it only ever touches the in-memory selectedEpfs set.
  const applyDepartmentFilter = (value: string) => {
    setDepartmentFilter(value);
    setRoleFilter('');
    if (value) setManyChecked(candidates.filter(u => u.department === value), true);
  };
  const applyRoleFilter = (value: string) => {
    setRoleFilter(value);
    setDepartmentFilter('');
    // Checks every active employee assigned to this role — matches AppUser.role against the
    // Roles module's own role name. Including one who already has a profile is fine here;
    // whether that's an overwrite or a no-op skip is decided later by the Step 2 toggle.
    if (value) setManyChecked(candidates.filter(u => u.role === value), true);
  };
  const clearSelection = () => setSelectedEpfs(new Set());

  const selectedUsers = useMemo(() => candidates.filter(u => selectedEpfs.has(u.epf_number)), [candidates, selectedEpfs]);
  const allVisibleChecked = visibleCandidates.length > 0 && visibleCandidates.every(u => selectedEpfs.has(u.epf_number));

  const allowanceOptions = useMemo(() => components.filter(c => c.type === 'allowance'), [components]);
  const deductionOptions = useMemo(() => components.filter(c => c.type === 'deduction'), [components]);
  const knownComponentIds = useMemo(() => new Set(components.map(c => c.id as string)), [components]);
  const componentMap = useMemo(() => new Map(components.map(c => [c.id as string, c])), [components]);

  const handleInitialize = async () => {
    if (selectedUsers.length === 0 || !company) return;
    const templateErrors = validatePayrollEmployee(
      { company_id: company.id, epf_number: selectedUsers[0].epf_number, ot_rate_mode: 'DERIVED', ot_fixed_hourly_rate: null, ...defaults },
      { knownComponentIds },
    );
    if (templateErrors.length) { toast.error(templateErrors[0]); return; }

    setSaving(true);
    try {
      const r = await createBulkPayrollEmployees(
        company.id, company.name,
        selectedUsers.map(u => ({ epf_number: u.epf_number, employee_name: u.display_name })),
        defaults, actor.epf, actor.name,
        { overwriteExisting },
      );
      const parts: string[] = [];
      if (r.created > 0) parts.push(`${r.created} new profile(s) initialized`);
      if (r.updated > 0) parts.push(`${r.updated} existing profile(s) overwritten`);
      if (r.skipped > 0) parts.push(`${r.skipped} already had a profile and were skipped`);
      toast.success(parts.length ? parts.join(' · ') + '.' : 'Nothing to do — no changes made.');
      router.push('/payroll-employees');
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to initialize profiles.'); }
    finally { setSaving(false); }
  };

  const stepIndex = STEPS.findIndex(s => s.key === step);

  return (
    <div className="space-y-6">
      {/* Top nav header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="outline" onClick={() => router.push('/payroll-employees')}>
          <ArrowLeft className="w-4 h-4" />Back to Payroll Employees
        </Button>
        <div className="flex items-center gap-2">
          {STEPS.map((s, i) => (
            <div key={s.key} className="flex items-center gap-2">
              <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium ${
                i === stepIndex ? 'bg-primary text-primary-foreground' : i < stepIndex ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground'
              }`}>
                {i < stepIndex ? <CheckCircle2 className="w-3.5 h-3.5" /> : <span>{i + 1}</span>}
                <span>{s.label}</span>
              </div>
              {i < STEPS.length - 1 && <div className="w-6 h-px bg-border" />}
            </div>
          ))}
        </div>
      </div>

      <div>
        <h1 className="text-xl font-semibold text-foreground">Bulk Add / Mass Initialize Payroll Profiles</h1>
        <p className="text-sm text-muted-foreground">
          {company ? `For ${company.name}. ` : ''}Department and Designation are filters to help you multi-select — they don&apos;t have payroll profiles themselves. Every profile created is a fully independent record, freely overridable later on the main Payroll Employees page.
        </p>
      </div>

      {loading ? (
        <Card className="p-10 text-center text-sm text-muted-foreground">Loading…</Card>
      ) : !company ? (
        <Card className="p-10"><EmptyState icon={Search} title="No company selected" description="Pick a company on the Payroll Employees page first." /></Card>
      ) : step === 'select' ? (
        <StepSelect
          candidates={candidates} visibleCandidates={visibleCandidates}
          departments={departments} roleOptions={roleNames}
          existingProfileEpfs={existingProfileEpfs}
          search={search} setSearch={setSearch}
          departmentFilter={departmentFilter} roleFilter={roleFilter}
          applyDepartmentFilter={applyDepartmentFilter} applyRoleFilter={applyRoleFilter}
          selectedEpfs={selectedEpfs} toggleOne={toggleOne}
          allVisibleChecked={allVisibleChecked}
          onToggleAllVisible={checked => setManyChecked(visibleCandidates, checked)}
          clearSelection={clearSelection}
          onNext={() => setStep('defaults')}
        />
      ) : step === 'defaults' ? (
        <StepDefaults
          selectedCount={selectedUsers.length}
          selectedExistingCount={selectedUsers.filter(u => existingProfileEpfs.has(u.epf_number)).length}
          defaults={defaults} setDefaults={setDefaults}
          overwriteExisting={overwriteExisting} setOverwriteExisting={setOverwriteExisting}
          allowanceOptions={allowanceOptions} deductionOptions={deductionOptions}
          settings={settings}
          onBack={() => setStep('select')}
          onNext={() => setStep('review')}
        />
      ) : (
        <StepReview
          company={company} selectedUsers={selectedUsers} defaults={defaults} componentMap={componentMap}
          existingProfileEpfs={existingProfileEpfs} overwriteExisting={overwriteExisting}
          saving={saving}
          onBack={() => setStep('defaults')}
          onSave={handleInitialize}
        />
      )}
    </div>
  );
}

// ─── Step 1 — Select Employees ──────────────────────────────────────────────────────────

function StepSelect({
  candidates, visibleCandidates, departments, roleOptions, existingProfileEpfs,
  search, setSearch, departmentFilter, roleFilter, applyDepartmentFilter, applyRoleFilter,
  selectedEpfs, toggleOne, allVisibleChecked, onToggleAllVisible, clearSelection, onNext,
}: {
  candidates: AppUser[]; visibleCandidates: AppUser[]; departments: string[]; roleOptions: string[];
  existingProfileEpfs: Set<string>;
  search: string; setSearch: (v: string) => void;
  departmentFilter: string; roleFilter: string;
  applyDepartmentFilter: (v: string) => void; applyRoleFilter: (v: string) => void;
  selectedEpfs: Set<string>; toggleOne: (epf: string, checked: boolean) => void;
  allVisibleChecked: boolean; onToggleAllVisible: (checked: boolean) => void;
  clearSelection: () => void; onNext: () => void;
}) {
  if (candidates.length === 0) {
    return (
      <Card className="p-10">
        <EmptyState icon={Search} title="No active employees" description="This company has no active employees to select from." />
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card className="p-4 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="relative sm:col-span-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input className="pl-9" placeholder="Search employee…" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <div>
            <Select value={departmentFilter || '__all'} onValueChange={v => applyDepartmentFilter(v === '__all' ? '' : v)}>
              <SelectTrigger><SelectValue placeholder="Filter by Department" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all">All Departments</SelectItem>
                {departments.map(d => <SelectItem key={d} value={d}>{d}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Select value={roleFilter || '__all'} onValueChange={v => applyRoleFilter(v === '__all' ? '' : v)}>
              <SelectTrigger><SelectValue placeholder="Filter by Role" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all">All Roles</SelectItem>
                {roleOptions.map(r => <SelectItem key={r} value={r}>{r}</SelectItem>)}
              </SelectContent>
            </Select>
            {roleFilter && roleOptions.length > 0 && !candidates.some(u => u.role === roleFilter) && (
              <p className="text-[10px] text-muted-foreground mt-1">No eligible employees currently hold this role.</p>
            )}
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">Picking a Department or Role is just a bulk-selection shortcut — it checks every matching employee below; it doesn&apos;t create a profile for the department or role itself.</p>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={clearSelection}>Clear Selection</Button>
          <Badge variant="brand" className="ml-auto">{selectedEpfs.size} selected</Badge>
        </div>
      </Card>

      <Card className="p-0 overflow-hidden">
        <div className="overflow-x-auto max-h-[55vh] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wider text-muted-foreground sticky top-0 z-10 [&_th]:bg-muted [&_th]:border-b [&_th]:border-border">
              <tr>
                <th className="px-3 py-2 text-left w-10">
                  <Checkbox checked={allVisibleChecked} onCheckedChange={v => onToggleAllVisible(v === true)} />
                </th>
                <th className="px-3 py-2 text-left">Name</th>
                <th className="px-3 py-2 text-left">EPF No</th>
                <th className="px-3 py-2 text-left">Department</th>
                <th className="px-3 py-2 text-left">Designation</th>
                <th className="px-3 py-2 text-left">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {visibleCandidates.map(u => (
                <tr key={u.epf_number} className={`cursor-pointer hover:bg-muted/30 ${selectedEpfs.has(u.epf_number) ? 'bg-primary/5' : ''}`}
                  onClick={() => toggleOne(u.epf_number, !selectedEpfs.has(u.epf_number))}>
                  <td className="px-3 py-2" onClick={e => e.stopPropagation()}>
                    <Checkbox checked={selectedEpfs.has(u.epf_number)} onCheckedChange={v => toggleOne(u.epf_number, v === true)} />
                  </td>
                  <td className="px-3 py-2 font-medium text-foreground">{u.display_name}</td>
                  <td className="px-3 py-2 text-muted-foreground">{u.epf_number}</td>
                  <td className="px-3 py-2 text-muted-foreground">{u.department || '—'}</td>
                  <td className="px-3 py-2 text-muted-foreground">{u.designation || '—'}</td>
                  <td className="px-3 py-2">
                    {existingProfileEpfs.has(u.epf_number) && <Badge variant="warning">Profile Exists</Badge>}
                  </td>
                </tr>
              ))}
              {visibleCandidates.length === 0 && (
                <tr><td colSpan={6} className="px-3 py-8 text-center text-xs text-muted-foreground">No employees match this search/filter.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="flex justify-end">
        <Button onClick={onNext} disabled={selectedEpfs.size === 0}>Next: Set Defaults ({selectedEpfs.size})</Button>
      </div>
    </div>
  );
}

// ─── Step 2 — Baseline Values ───────────────────────────────────────────────────────────

function StepDefaults({
  selectedCount, selectedExistingCount, defaults, setDefaults,
  overwriteExisting, setOverwriteExisting,
  allowanceOptions, deductionOptions, settings, onBack, onNext,
}: {
  selectedCount: number; selectedExistingCount: number;
  defaults: PayrollBulkDefaults; setDefaults: (d: PayrollBulkDefaults) => void;
  overwriteExisting: boolean; setOverwriteExisting: (v: boolean) => void;
  allowanceOptions: PayrollComponent[]; deductionOptions: PayrollComponent[]; settings: PayrollSettings | null;
  onBack: () => void; onNext: () => void;
}) {
  // Block advancing to Review while any baseline value is negative / invalid — the same
  // range rules the final save (and the server) enforce, applied here so bad data can't
  // even reach the staging payload.
  const baselineErrors = validatePayrollEmployee({
    company_id: 'x', epf_number: 'x', ot_rate_mode: 'DERIVED', ot_fixed_hourly_rate: null, ...defaults,
  });
  const salaryErr = !(defaults.basic_salary >= 0) ? 'Enter a base salary of 0 or more.' : '';
  const otNormalErr = !(Number.isFinite(defaults.ot_multiplier_normal) && defaults.ot_multiplier_normal > 0) ? 'Must be a positive number.' : '';
  const otDoubleErr = !(Number.isFinite(defaults.ot_multiplier_double) && defaults.ot_multiplier_double > 0) ? 'Must be a positive number.' : '';
  const targetErr = defaults.target_hours_override != null && !(defaults.target_hours_override > 0) ? 'Must be a positive number.' : '';
  const hoursErr = defaults.hours_per_day != null && !(defaults.hours_per_day > 0) ? 'Must be a positive number.' : '';
  const componentsErr = [...defaults.allowances, ...defaults.deductions].some(c => !(c.amount >= 0)) ? 'Every allowance / deduction amount must be zero or more.' : '';
  const handleNext = () => {
    if (baselineErrors.length) { toast.error(baselineErrors[0]); return; }
    onNext();
  };

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <p className="text-sm text-foreground"><strong>{selectedCount}</strong> employee(s) selected — these values will be applied identically to each one. Every resulting profile stays fully independent, so any single employee can be overridden later without affecting the rest.</p>
      </Card>

      {selectedExistingCount > 0 && (
        <Card className="p-4 space-y-2">
          <label className="flex items-center justify-between gap-3 cursor-pointer">
            <span className="space-y-0.5">
              <span className="block text-sm font-medium text-foreground">Overwrite existing profile values</span>
              <span className="block text-[11px] text-muted-foreground">
                <strong>{selectedExistingCount}</strong> of the {selectedCount} selected already have a payroll profile.{' '}
                {overwriteExisting
                  ? 'These baseline values will replace their Basic Salary, Target Hours, Hours per Day, statutory flags, tax status and OT multipliers; allowances/deductions above are merged in (not wiped), and their bank details stay untouched.'
                  : 'Off by default — they will be safely skipped so nothing already configured for them is lost.'}
              </span>
            </span>
            <Switch checked={overwriteExisting} onCheckedChange={setOverwriteExisting} />
          </label>
        </Card>
      )}

      <Card className="p-4 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Base Salary (LKR)</Label>
            <Input type="number" min={0} placeholder="0" aria-invalid={!!salaryErr}
              value={Number.isFinite(defaults.basic_salary) ? defaults.basic_salary : ''}
              onChange={e => setDefaults({ ...defaults, basic_salary: e.target.value === '' ? NaN : +e.target.value })} />
            <InlineError>{salaryErr}</InlineError>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Standard Target Hours</Label>
            <Input type="number" min={0} aria-invalid={!!targetErr} value={defaults.target_hours_override ?? ''}
              placeholder={settings?.default_target_hours != null ? String(settings.default_target_hours) : 'Blank = company default'}
              onChange={e => setDefaults({ ...defaults, target_hours_override: e.target.value === '' ? null : +e.target.value })} />
            <InlineError>{targetErr}</InlineError>
            <p className="text-[10px] text-muted-foreground">
              Company rule (Payroll Settings): {settings?.default_target_hours ?? '—'} hrs/month.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Hours per Day</Label>
            <Input type="number" min={0} step="0.5" aria-invalid={!!hoursErr} value={defaults.hours_per_day ?? ''}
              placeholder={settings?.default_hours_per_day != null ? String(settings.default_hours_per_day) : 'Blank = company default'}
              onChange={e => setDefaults({ ...defaults, hours_per_day: e.target.value === '' ? null : +e.target.value })} />
            <InlineError>{hoursErr}</InlineError>
            <p className="text-[10px] text-muted-foreground">
              Company rule (Payroll Settings): {settings?.default_hours_per_day ?? '—'} hrs/day.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">OT Multiplier (1.5x bucket)</Label>
            <Input type="number" step="0.1" min={0} aria-invalid={!!otNormalErr}
              value={Number.isFinite(defaults.ot_multiplier_normal) ? defaults.ot_multiplier_normal : ''}
              onChange={e => setDefaults({ ...defaults, ot_multiplier_normal: e.target.value === '' ? NaN : +e.target.value })} />
            <InlineError>{otNormalErr}</InlineError>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">OT Multiplier (2.0x bucket)</Label>
            <Input type="number" step="0.1" min={0} aria-invalid={!!otDoubleErr}
              value={Number.isFinite(defaults.ot_multiplier_double) ? defaults.ot_multiplier_double : ''}
              onChange={e => setDefaults({ ...defaults, ot_multiplier_double: e.target.value === '' ? NaN : +e.target.value })} />
            <InlineError>{otDoubleErr}</InlineError>
          </div>
        </div>
        {componentsErr && <InlineError>{componentsErr}</InlineError>}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2 border-t border-border">
          <label className="flex items-center justify-between rounded-lg border border-border p-3 cursor-pointer">
            <span className="text-sm text-foreground">EPF applicable</span>
            <Switch checked={defaults.is_epf_applicable} onCheckedChange={v => setDefaults({ ...defaults, is_epf_applicable: v })} />
          </label>
          <label className="flex items-center justify-between rounded-lg border border-border p-3 cursor-pointer">
            <span className="text-sm text-foreground">ETF applicable</span>
            <Switch checked={defaults.is_etf_applicable} onCheckedChange={v => setDefaults({ ...defaults, is_etf_applicable: v })} />
          </label>
          <label className="flex items-center justify-between rounded-lg border border-border p-3 cursor-pointer">
            <span className="text-sm text-foreground">Tax (APIT) applicable</span>
            <Switch checked={defaults.is_tax_applicable} onCheckedChange={v => setDefaults({ ...defaults, is_tax_applicable: v })} />
          </label>
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="p-4 space-y-2">
          <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Common recurring allowances</Label>
          {allowanceOptions.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">No allowance components exist yet — add one in Payroll Settings.</p>
          ) : (
            <ComponentRows rows={defaults.allowances} options={allowanceOptions} canEdit onChange={rows => setDefaults({ ...defaults, allowances: rows })} />
          )}
        </Card>
        <Card className="p-4 space-y-2">
          <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Common recurring deductions</Label>
          {deductionOptions.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">No deduction components exist yet — add one in Payroll Settings.</p>
          ) : (
            <ComponentRows rows={defaults.deductions} options={deductionOptions} canEdit onChange={rows => setDefaults({ ...defaults, deductions: rows })} />
          )}
        </Card>
      </div>

      <div className="flex justify-between">
        <Button variant="outline" onClick={onBack}>Back</Button>
        <Button onClick={handleNext} disabled={baselineErrors.length > 0}>Next: Review &amp; Save</Button>
      </div>
    </div>
  );
}

// ─── Step 3 — Review & Save ─────────────────────────────────────────────────────────────

function StepReview({
  company, selectedUsers, defaults, componentMap, existingProfileEpfs, overwriteExisting, saving, onBack, onSave,
}: {
  company: Company; selectedUsers: AppUser[]; defaults: PayrollBulkDefaults; componentMap: Map<string, PayrollComponent>;
  existingProfileEpfs: Set<string>; overwriteExisting: boolean;
  saving: boolean; onBack: () => void; onSave: () => void;
}) {
  const allowanceNames = defaults.allowances.map(a => `${componentMap.get(a.component_id)?.name ?? a.component_id} (${a.amount.toLocaleString()})`).join(', ') || '—';
  const deductionNames = defaults.deductions.map(d => `${componentMap.get(d.component_id)?.name ?? d.component_id} (${d.amount.toLocaleString()})`).join(', ') || '—';
  const willCreate = selectedUsers.filter(u => !existingProfileEpfs.has(u.epf_number)).length;
  const willOverwrite = overwriteExisting ? selectedUsers.filter(u => existingProfileEpfs.has(u.epf_number)).length : 0;
  const willSkip = !overwriteExisting ? selectedUsers.filter(u => existingProfileEpfs.has(u.epf_number)).length : 0;

  return (
    <div className="space-y-4">
      <Card className="p-4 space-y-3">
        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Baseline profile values — {company.name}</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-2 text-sm">
          <div><span className="text-muted-foreground">Base Salary:</span> {defaults.basic_salary.toLocaleString()}</div>
          <div><span className="text-muted-foreground">Target Hours:</span> {defaults.target_hours_override ?? 'Company default'}</div>
          <div><span className="text-muted-foreground">Hours per Day:</span> {defaults.hours_per_day ?? 'Company default'}</div>
          <div><span className="text-muted-foreground">OT Multipliers:</span> {defaults.ot_multiplier_normal}x / {defaults.ot_multiplier_double}x</div>
          <div><span className="text-muted-foreground">EPF:</span> {defaults.is_epf_applicable ? 'Applicable' : 'Not applicable'}</div>
          <div><span className="text-muted-foreground">ETF:</span> {defaults.is_etf_applicable ? 'Applicable' : 'Not applicable'}</div>
          <div><span className="text-muted-foreground">Tax (APIT):</span> {defaults.is_tax_applicable ? 'Applicable' : 'Not applicable'}</div>
          <div className="sm:col-span-2 lg:col-span-3"><span className="text-muted-foreground">Allowances:</span> {allowanceNames}</div>
          <div className="sm:col-span-2 lg:col-span-3"><span className="text-muted-foreground">Deductions:</span> {deductionNames}</div>
        </div>
      </Card>

      <Card className="p-0 overflow-hidden">
        <div className="px-4 py-3 border-b border-border text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          {willCreate} new profile(s){willOverwrite > 0 ? ` · ${willOverwrite} existing profile(s) will be overwritten` : ''}{willSkip > 0 ? ` · ${willSkip} existing profile(s) will be skipped` : ''}
        </div>
        <div className="overflow-x-auto max-h-[45vh] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wider text-muted-foreground sticky top-0 z-10 [&_th]:bg-muted [&_th]:border-b [&_th]:border-border">
              <tr>
                <th className="px-3 py-2 text-left">Name</th>
                <th className="px-3 py-2 text-left">EPF No</th>
                <th className="px-3 py-2 text-left">Department</th>
                <th className="px-3 py-2 text-left">Designation</th>
                <th className="px-3 py-2 text-left">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {selectedUsers.map(u => {
                const hasProfile = existingProfileEpfs.has(u.epf_number);
                return (
                  <tr key={u.epf_number}>
                    <td className="px-3 py-2 font-medium text-foreground">{u.display_name}</td>
                    <td className="px-3 py-2 text-muted-foreground">{u.epf_number}</td>
                    <td className="px-3 py-2 text-muted-foreground">{u.department || '—'}</td>
                    <td className="px-3 py-2 text-muted-foreground">{u.designation || '—'}</td>
                    <td className="px-3 py-2">
                      {!hasProfile ? <Badge variant="success">Create</Badge>
                        : overwriteExisting ? <Badge variant="warning">Overwrite</Badge>
                        : <Badge variant="muted">Skip (has profile)</Badge>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="flex justify-between">
        <Button variant="outline" onClick={onBack} disabled={saving}>Back</Button>
        <Button onClick={onSave} disabled={saving}>{saving ? 'Saving…' : `Initialize ${selectedUsers.length} Profile(s)`}</Button>
      </div>
    </div>
  );
}
