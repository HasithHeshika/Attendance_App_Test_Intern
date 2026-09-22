'use client';
// Payroll Employees — Step 2: profile with 5 sub-tabs (Basic/Statutory, Allowances/
// Deductions, OT Rules, Tax, Loans). Single flat doc per employee — Basic Salary is editable
// ONLY here; the Monthly Run Bulk Sheet locks it and only accepts this-month figures. The
// Loans tab is strictly multi-month staff loans (payroll_loans) — short-term single-month
// salary advances are a separate standalone module (/salary-advances,
// payroll_salary_advances), never shown here. Southern Lanka Hospitals tenant only.

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Users, Save, Search, Plus, Trash2, Banknote, UserPlus } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuthStore } from '@/store/authStore';
import { useUserCapabilities } from '@/store/rolesStore';
import { tenant } from '@/lib/firebase';
import { getCompanies } from '@/services/companyService';
import { useCompanyContext } from '@/store/companyContextStore';
import { getAllEmployees } from '@/services/userService';
import type { Company, AppUser } from '@/lib/types';
import type { PayrollEmployee, PayrollEmployeeComponentLine, PayrollComponent, PayrollLoan, PayrollSettings, OtRateMode } from '@/lib/payrollTypes';
import { emptyPayrollEmployee } from '@/lib/payrollTypes';
import { getPayrollEmployee, savePayrollEmployee } from '@/services/payrollEmployeeService';
import { getActivePayrollComponents, getPayrollSettings } from '@/services/payrollSettingsService';
import { getActiveRoles } from '@/services/roleService';
import { getLoansForEmployee, createLoan, updateLoan, cancelLoan } from '@/services/payrollLoanService';
import { validatePayrollLoan, validatePayrollEmployee } from '@/lib/payrollValidation';
import { ComponentRows } from '@/components/payroll/ComponentRows';
import InlineError from '@/components/InlineError';
import { PageHeader } from '@/components/ui/page-header';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { EmptyState } from '@/components/ui/empty-state';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import ConfirmModal from '@/components/ConfirmModal';

function useActor() {
  const { user } = useAuthStore();
  return { epf: user?.epf_number ?? '', name: user?.name ?? '' };
}

export default function PayrollEmployeesPage() {
  const caps = useUserCapabilities();

  if (!tenant.features.payroll) {
    return <div className="p-10 text-center text-muted-foreground">Payroll is not enabled for this organisation.</div>;
  }
  if (!caps.is_system_admin && !caps.can_view_payroll && !caps.can_manage_pay_profiles) {
    return <div className="p-10 text-center text-muted-foreground">You don&apos;t have access to this section.</div>;
  }
  return <PayrollEmployeesContent canEdit={caps.is_system_admin || caps.can_manage_pay_profiles} />;
}

function PayrollEmployeesContent({ canEdit }: { canEdit: boolean }) {
  const router = useRouter();
  const actor = useActor();
  // Company SCOPE now follows the Top Navbar's Global Company Selector, same as Schedule/
  // Shifts/Departments/Users/Attendance View — no more page-local company picker duplicating
  // it. companyId === '' is a switching admin's deliberate "All companies" pick (the navbar
  // selector has its own explicit "All companies" row for exactly that); companyContextBlocked
  // is a LOCKED user with no company assigned at all — fail-closed, never read as "all".
  const { companyId: scopeId, blocked: companyContextBlocked, ready: companyContextReady } = useCompanyContext();
  const allCompanies = scopeId === '';
  const scopeReady = companyContextReady && !companyContextBlocked;
  // Separate from the page's own SCOPE above — the full company list, needed to resolve an
  // arbitrary employee's OWN company (an employee's profile/loan is always stamped with THEIR
  // company, never the page scope) regardless of which company the navbar has picked.
  const [companies, setCompanies] = useState<Company[]>([]);
  const [employees, setEmployees] = useState<AppUser[]>([]);
  const [components, setComponents] = useState<PayrollComponent[]>([]);
  const [settings, setSettings] = useState<PayrollSettings | null>(null);
  const [roleNames, setRoleNames] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [departmentFilter, setDepartmentFilter] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [selectedEpf, setSelectedEpf] = useState<string | null>(null);
  const [profile, setProfile] = useState<PayrollEmployee | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getCompanies().then(setCompanies).catch(() => {});
    // Tenant-wide, not company-scoped — fetched once so the OT Rules tab can show what
    // "company default" actually resolves to next to the override field.
    getPayrollSettings().then(setSettings).catch(() => {});
    // Also tenant-wide — the Roles module, for the left panel's Role filter.
    getActiveRoles().then(roles => setRoleNames(roles.map(r => r.name).sort())).catch(() => {});
  }, []);

  const loadEmployeesAndProfiles = () => {
    if (!scopeReady) return;
    getAllEmployees(scopeId).then(setEmployees).catch(() => {});
  };

  useEffect(() => {
    if (!scopeReady) return;
    loadEmployeesAndProfiles();
    getActivePayrollComponents().then(setComponents).catch(() => {});
    setSelectedEpf(null); setProfile(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeId, scopeReady]);

  const departments = useMemo(() => Array.from(new Set(employees.map(e => e.department).filter(Boolean))).sort(), [employees]);
  const filteredEmployees = useMemo(() => {
    const q = search.trim().toLowerCase();
    return employees.filter(e => {
      if (departmentFilter && e.department !== departmentFilter) return false;
      if (roleFilter && e.role !== roleFilter) return false;
      if (!q) return true;
      // Same haystack convention as the Users page search — null-safe (filter(Boolean) drops
      // missing fields before joining) so a migrated/incomplete record never throws and kills
      // the whole list.
      return [e.display_name, e.first_name, e.last_name, e.epf_number, e.employee_number]
        .filter(Boolean).join(' ').toLowerCase().includes(q);
    });
  }, [employees, search, departmentFilter, roleFilter]);
  const filtersActive = Boolean(search || departmentFilter || roleFilter);
  const resetFilters = () => { setSearch(''); setDepartmentFilter(''); setRoleFilter(''); };
  const selectedUser = employees.find(e => e.epf_number === selectedEpf) ?? null;
  // Every record this page files (a new profile, a loan) is stamped with the EMPLOYEE's own
  // company rather than the page scope, so the All state can never write 'all' or ''. An
  // employee whose company_id doesn't resolve gets no writable profile at all — see below.
  const selectedCompany = selectedUser ? companies.find(c => c.id === selectedUser.company_id) ?? null : null;
  const componentMap = useMemo(() => new Map(components.map(c => [c.id as string, c])), [components]);

  // Range / non-negative validation of the loaded profile — mirrors savePayrollEmployee so
  // the Save button and the server can never disagree. Blocks saving a negative salary /
  // OT multiplier / tax override, or a non-numeric account number.
  const profileErrors = useMemo(
    () => (profile ? validatePayrollEmployee(profile, { knownComponentIds: new Set(components.map(c => c.id as string)) }) : []),
    [profile, components],
  );
  const profileInvalid = profileErrors.length > 0;

  const selectEmployee = async (epf: string) => {
    setSelectedEpf(epf);
    // Drop the previous employee's profile BEFORE the await. Neither branch below fires when the
    // person has no saved profile AND no resolvable company, and handleSave keys the write off
    // `profile.epf_number` — so a profile left standing here would render under the newly clicked
    // name and save back over the PREVIOUS employee's record.
    setProfile(null);
    setLoading(true);
    try {
      const existing = await getPayrollEmployee(epf);
      const u = employees.find(e => e.epf_number === epf);
      const co = u ? companies.find(c => c.id === u.company_id) ?? null : null;
      if (existing) setProfile(existing);
      else if (co && u) setProfile({ ...emptyPayrollEmployee(co.id, co.name, epf, u.display_name) });
    } catch (e) { console.error(e); toast.error('Failed to load profile.'); }
    finally { setLoading(false); }
  };

  const handleSave = async () => {
    if (!profile) return;
    if (profileErrors.length) { toast.error(profileErrors[0]); return; }
    setSaving(true);
    try {
      const { id: _id, created_at: _ca, updated_at: _ua, ...payload } = profile;
      void _id; void _ca; void _ua;
      await savePayrollEmployee(payload, actor.epf, actor.name, { knownComponentIds: new Set(components.map(c => c.id as string)) });
      toast.success('Profile saved.');
      if (selectedEpf) await selectEmployee(selectedEpf);
      loadEmployeesAndProfiles();
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to save.'); }
    finally { setSaving(false); }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Payroll Employees"
        description="Basic salary, statutory eligibility, allowances/deductions, OT rules, tax, and loans — one profile per employee."
        icon={Users}
        // The company selector that used to live here is gone — it duplicated the Top
        // Navbar's own Global Company Selector, which already drives `scopeId` above.
        actions={canEdit && <Button variant="outline" onClick={() => router.push('/payroll-employees/bulk-add')}><UserPlus className="w-4 h-4" />Bulk Add</Button>}
      />

      {!companyContextReady ? (
        // See payroll-loans/page.tsx's matching comment — companyId is forced to '' and
        // `blocked` can't compute true until useCompanyContext() actually settles.
        <Card className="p-10 text-center text-sm text-muted-foreground">Loading…</Card>
      ) : companyContextBlocked ? (
        <Card className="p-10">
          <EmptyState
            icon={Users}
            title="No assigned company"
            description="Your account has no company assigned — contact an admin."
          />
        </Card>
      ) : (
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="p-4 lg:col-span-1">
          <div className="relative mb-3">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input className="pl-9" placeholder="Search employee…" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-2 mb-3">
            <Select value={departmentFilter || '__all'} onValueChange={v => setDepartmentFilter(v === '__all' ? '' : v)}>
              <SelectTrigger><SelectValue placeholder="Filter by Department" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all">All Departments</SelectItem>
                {departments.map(d => <SelectItem key={d} value={d}>{d}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={roleFilter || '__all'} onValueChange={v => setRoleFilter(v === '__all' ? '' : v)}>
              <SelectTrigger><SelectValue placeholder="Filter by Role" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all">All Roles</SelectItem>
                {roleNames.map(r => <SelectItem key={r} value={r}>{r}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {filtersActive && (
            <div className="flex items-center justify-between mb-3">
              <span className="text-[11px] text-muted-foreground">{filteredEmployees.length} of {employees.length} shown</span>
              <Button variant="outline" size="sm" onClick={resetFilters}>Reset Filters</Button>
            </div>
          )}
          <div className="space-y-1 max-h-[65vh] overflow-y-auto">
            {filteredEmployees.map(e => (
              <button key={e.epf_number} onClick={() => selectEmployee(e.epf_number)}
                className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${selectedEpf === e.epf_number ? 'bg-primary/10 text-primary' : 'hover:bg-muted/60 text-foreground'}`}>
                <div className="font-medium truncate">{e.display_name}</div>
                <div className="text-xs text-muted-foreground truncate">{e.epf_number}{e.employee_number ? ` · ${e.employee_number}` : ''} · {e.designation}{allCompanies ? ` · ${e.company_name}` : ''}</div>
              </button>
            ))}
            {filteredEmployees.length === 0 && <p className="text-xs text-muted-foreground px-2 py-4 text-center">No employees found.</p>}
          </div>
        </Card>

        <div className="lg:col-span-2">
          {!selectedUser ? (
            <Card className="p-10"><EmptyState icon={Users} title="Select an employee" description="Choose an employee on the left to view or edit their payroll profile." /></Card>
          ) : loading ? (
            <Card className="p-8 text-center text-sm text-muted-foreground">Loading…</Card>
          ) : !profile ? (
            <Card className="p-8 text-center text-sm text-muted-foreground">
              This employee isn&apos;t assigned to a company, so a payroll profile can&apos;t be opened. Set their company on the Users page first.
            </Card>
          ) : (
            <Card className="p-4 space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="font-semibold text-foreground">{selectedUser.display_name}</div>
                  <div className="text-xs text-muted-foreground">{selectedUser.epf_number} · {selectedUser.designation}{allCompanies ? ` · ${selectedUser.company_name}` : ''}</div>
                </div>
                {canEdit && (
                  <div className="flex flex-col items-end gap-1">
                    <Button onClick={handleSave} disabled={saving || profileInvalid}><Save className="w-4 h-4" />{saving ? 'Saving…' : 'Save Profile'}</Button>
                    {profileInvalid && <span className="text-[11px] text-destructive">{profileErrors[0]}</span>}
                  </div>
                )}
              </div>

              <Tabs defaultValue="basic">
                {/* Five tabs, "Allowances/Deductions" alone runs long — the base TabsList has
                    no scroll or wrap of its own, so on a narrow card the strip just overflowed
                    the card (and, for the tabs past OT Rules, the screen). overflow-x-auto +
                    natural (never-shrink) tab width turns that into a scrollable strip instead,
                    same fix as the Approvals page's segment control. */}
                <TabsList className="w-full justify-start overflow-x-auto scrollbar-none">
                  <TabsTrigger value="basic" className="flex-shrink-0">Basic/Statutory</TabsTrigger>
                  <TabsTrigger value="components" className="flex-shrink-0">Allowances/Deductions</TabsTrigger>
                  <TabsTrigger value="ot" className="flex-shrink-0">OT Rules</TabsTrigger>
                  <TabsTrigger value="tax" className="flex-shrink-0">Tax</TabsTrigger>
                  <TabsTrigger value="loans" className="flex-shrink-0">Loans</TabsTrigger>
                </TabsList>

                <TabsContent value="basic">
                  <BasicTab profile={profile} setProfile={setProfile} canEdit={canEdit} />
                </TabsContent>
                <TabsContent value="components">
                  <ComponentsSubTab profile={profile} setProfile={setProfile} components={components} componentMap={componentMap} canEdit={canEdit} />
                </TabsContent>
                <TabsContent value="ot">
                  <OtTab profile={profile} setProfile={setProfile} canEdit={canEdit} settings={settings} />
                </TabsContent>
                <TabsContent value="tax">
                  <TaxTab profile={profile} setProfile={setProfile} canEdit={canEdit} />
                </TabsContent>
                <TabsContent value="loans">
                  <LoansTab epf={selectedUser.epf_number} employeeName={selectedUser.display_name} companyId={selectedCompany?.id ?? ''} canEdit={canEdit} />
                </TabsContent>
              </Tabs>
            </Card>
          )}
        </div>
      </div>
      )}
    </div>
  );
}

// ─── Basic/Statutory ─────────────────────────────────────────────────────────────────

function BasicTab({ profile, setProfile, canEdit }: { profile: PayrollEmployee; setProfile: (p: PayrollEmployee) => void; canEdit: boolean }) {
  return (
    <div className="space-y-4 pt-3">
      <div className="space-y-1.5">
        <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Basic Salary (LKR)</Label>
        <Input type="number" min={0} disabled={!canEdit} placeholder="0"
          aria-invalid={!(profile.basic_salary >= 0)}
          value={Number.isFinite(profile.basic_salary) ? profile.basic_salary : ''}
          onChange={e => setProfile({ ...profile, basic_salary: e.target.value === '' ? NaN : +e.target.value })} />
        {!(profile.basic_salary >= 0) && <InlineError>Enter a basic salary of 0 or more.</InlineError>}
        <p className="text-[10px] text-muted-foreground">Locked in the Monthly Run sheet — editable only here.</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="flex items-center justify-between rounded-lg border border-border p-3 cursor-pointer">
          <span className="text-sm text-foreground">EPF applicable</span>
          <Switch checked={profile.is_epf_applicable} disabled={!canEdit} onCheckedChange={v => setProfile({ ...profile, is_epf_applicable: v })} />
        </label>
        <label className="flex items-center justify-between rounded-lg border border-border p-3 cursor-pointer">
          <span className="text-sm text-foreground">ETF applicable</span>
          <Switch checked={profile.is_etf_applicable} disabled={!canEdit} onCheckedChange={v => setProfile({ ...profile, is_etf_applicable: v })} />
        </label>
      </div>
      <div className="space-y-1.5 pt-2 border-t border-border">
        <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Bank details (optional)</Label>
        <div className="grid grid-cols-2 gap-2">
          <Input placeholder="Bank name" disabled={!canEdit} value={profile.bank_name ?? ''} onChange={e => setProfile({ ...profile, bank_name: e.target.value || null })} />
          <Input placeholder="Branch (name/code)" disabled={!canEdit} value={profile.bank_branch ?? ''} onChange={e => setProfile({ ...profile, bank_branch: e.target.value || null })} />
        </div>
        <Input placeholder="Account number" inputMode="numeric" disabled={!canEdit}
          aria-invalid={!!profile.account_number && !/^\d+$/.test(profile.account_number)}
          value={profile.account_number ?? ''}
          onChange={e => setProfile({ ...profile, account_number: e.target.value.replace(/\D/g, '') || null })} />
        {!!profile.account_number && !/^\d+$/.test(profile.account_number) && <InlineError>Account number must be digits only.</InlineError>}
      </div>
      <label className="flex items-center justify-between rounded-lg border border-border p-3 cursor-pointer">
        <span className="text-sm text-foreground">Active in payroll</span>
        <Switch checked={profile.is_active} disabled={!canEdit} onCheckedChange={v => setProfile({ ...profile, is_active: v })} />
      </label>
    </div>
  );
}

// ─── Allowances / Deductions ─────────────────────────────────────────────────────────

function ComponentsSubTab({
  profile, setProfile, components, componentMap, canEdit,
}: { profile: PayrollEmployee; setProfile: (p: PayrollEmployee) => void; components: PayrollComponent[]; componentMap: Map<string, PayrollComponent>; canEdit: boolean }) {
  const allowanceOptions = components.filter(c => c.type === 'allowance');
  const deductionOptions = components.filter(c => c.type === 'deduction');
  const totalAllowances = profile.allowances.reduce((s, a) => s + a.amount, 0);
  const totalDeductions = profile.deductions.reduce((s, d) => s + d.amount, 0);
  const componentAmountsInvalid = [...profile.allowances, ...profile.deductions].some(r => !(r.amount >= 0));

  return (
    <div className="space-y-4 pt-3">
      <div className="space-y-1.5">
        <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Allowances (total {totalAllowances.toLocaleString()})</Label>
        {allowanceOptions.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">No allowance components exist yet — add one in Payroll Settings.</p>
        ) : (
          <ComponentRows rows={profile.allowances} options={allowanceOptions} canEdit={canEdit} onChange={rows => setProfile({ ...profile, allowances: rows })} />
        )}
      </div>
      <div className="space-y-1.5 pt-2 border-t border-border">
        <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Deductions (total {totalDeductions.toLocaleString()})</Label>
        {deductionOptions.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">No deduction components exist yet — add one in Payroll Settings.</p>
        ) : (
          <ComponentRows rows={profile.deductions} options={deductionOptions} canEdit={canEdit} onChange={rows => setProfile({ ...profile, deductions: rows })} />
        )}
      </div>
      {componentAmountsInvalid && <InlineError>Every allowance / deduction amount must be zero or more.</InlineError>}
      <div className="flex flex-wrap gap-1.5 pt-2">
        {[...profile.allowances, ...profile.deductions].map((r, i) => {
          const c = componentMap.get(r.component_id);
          if (!c) return null;
          const flags = [c.isEpfApplicable && 'EPF', c.isEtfApplicable && 'ETF', c.isTaxApplicable && 'Tax'].filter(Boolean).join(' · ');
          return flags ? <Badge key={i} variant="outline">{c.name}: {flags}</Badge> : null;
        })}
      </div>
    </div>
  );
}

// ─── OT Rules ────────────────────────────────────────────────────────────────────────

function OtTab({ profile, setProfile, canEdit, settings }: { profile: PayrollEmployee; setProfile: (p: PayrollEmployee) => void; canEdit: boolean; settings: PayrollSettings | null }) {
  return (
    <div className="space-y-4 pt-3">
      <div className="space-y-1.5">
        <Label className="text-[11px] text-muted-foreground">Target Hours override (blank = use company default)</Label>
        <Input type="number" disabled={!canEdit} value={profile.target_hours_override ?? ''}
          placeholder={settings?.default_target_hours != null ? String(settings.default_target_hours) : 'e.g. 200'}
          onChange={e => setProfile({ ...profile, target_hours_override: e.target.value === '' ? null : +e.target.value })} />
        <p className="text-[10px] text-muted-foreground">
          Company rule (Payroll Settings): {settings?.default_target_hours ?? '—'} hrs/month.
        </p>
      </div>
      <div className="space-y-1.5">
        <Label className="text-[11px] text-muted-foreground">Hours per Day override (blank = use company default)</Label>
        <Input type="number" disabled={!canEdit} value={profile.hours_per_day ?? ''}
          placeholder={settings?.default_hours_per_day != null ? String(settings.default_hours_per_day) : 'e.g. 8'}
          onChange={e => setProfile({ ...profile, hours_per_day: e.target.value === '' ? null : +e.target.value })} />
        <p className="text-[10px] text-muted-foreground">
          Used for this employee's No-Pay / PH / Poya day-rate math. Company rule (Payroll Settings): {settings?.default_hours_per_day ?? '—'} hrs/day.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-[11px] text-muted-foreground">OT Multiplier (1.5x bucket)</Label>
          <Input type="number" step="0.1" min={0} disabled={!canEdit}
            aria-invalid={!(Number.isFinite(profile.ot_multiplier_normal) && profile.ot_multiplier_normal > 0)}
            value={Number.isFinite(profile.ot_multiplier_normal) ? profile.ot_multiplier_normal : ''}
            onChange={e => setProfile({ ...profile, ot_multiplier_normal: e.target.value === '' ? NaN : +e.target.value })} />
          {!(Number.isFinite(profile.ot_multiplier_normal) && profile.ot_multiplier_normal > 0) && <InlineError>Must be a positive number.</InlineError>}
        </div>
        <div className="space-y-1.5">
          <Label className="text-[11px] text-muted-foreground">OT Multiplier (2.0x bucket)</Label>
          <Input type="number" step="0.1" min={0} disabled={!canEdit}
            aria-invalid={!(Number.isFinite(profile.ot_multiplier_double) && profile.ot_multiplier_double > 0)}
            value={Number.isFinite(profile.ot_multiplier_double) ? profile.ot_multiplier_double : ''}
            onChange={e => setProfile({ ...profile, ot_multiplier_double: e.target.value === '' ? NaN : +e.target.value })} />
          {!(Number.isFinite(profile.ot_multiplier_double) && profile.ot_multiplier_double > 0) && <InlineError>Must be a positive number.</InlineError>}
        </div>
      </div>
      <div className="space-y-1.5 pt-2 border-t border-border">
        <Label className="text-[11px] text-muted-foreground">OT Rate Mode</Label>
        <Select value={profile.ot_rate_mode} onValueChange={v => setProfile({ ...profile, ot_rate_mode: v as OtRateMode })}>
          <SelectTrigger disabled={!canEdit}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="DERIVED">Derived (Basic ÷ Target Hours)</SelectItem>
            <SelectItem value="FIXED">Fixed custom hourly rate</SelectItem>
          </SelectContent>
        </Select>
        {profile.ot_rate_mode === 'FIXED' && (
          <>
            <Input type="number" min={0} className="mt-2" placeholder="Fixed hourly rate (LKR)" disabled={!canEdit}
              aria-invalid={!(profile.ot_fixed_hourly_rate != null && profile.ot_fixed_hourly_rate >= 0)}
              value={profile.ot_fixed_hourly_rate ?? ''}
              onChange={e => setProfile({ ...profile, ot_fixed_hourly_rate: e.target.value === '' ? null : +e.target.value })} />
            {!(profile.ot_fixed_hourly_rate != null && profile.ot_fixed_hourly_rate >= 0) && <InlineError>A fixed OT hourly rate of 0 or more is required in Fixed mode.</InlineError>}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Tax ─────────────────────────────────────────────────────────────────────────────

function TaxTab({ profile, setProfile, canEdit }: { profile: PayrollEmployee; setProfile: (p: PayrollEmployee) => void; canEdit: boolean }) {
  return (
    <div className="space-y-4 pt-3">
      <label className="flex items-center justify-between rounded-lg border border-border p-3 cursor-pointer">
        <span className="text-sm text-foreground">Tax (APIT) applicable</span>
        <Switch checked={profile.is_tax_applicable} disabled={!canEdit} onCheckedChange={v => setProfile({ ...profile, is_tax_applicable: v })} />
      </label>
      {profile.is_tax_applicable && (
        <div className="space-y-1.5">
          <Label className="text-[11px] text-muted-foreground">Fixed Monthly Tax Amount (Optional)</Label>
          <Input type="number" min={0} disabled={!canEdit} value={profile.tax_override_amount ?? ''}
            aria-invalid={profile.tax_override_amount != null && !(profile.tax_override_amount >= 0)}
            onChange={e => setProfile({ ...profile, tax_override_amount: e.target.value === '' ? null : +e.target.value })} />
          {profile.tax_override_amount != null && !(profile.tax_override_amount >= 0) && <InlineError>Fixed tax amount can’t be negative.</InlineError>}
          <p className="text-[10px] text-muted-foreground">Leave blank to automatically calculate tax using government tax slabs. Only enter an amount here if this employee requires a fixed manual tax deduction.</p>
        </div>
      )}
    </div>
  );
}

// ─── Loans ───────────────────────────────────────────────────────────────────────────

function LoansTab({ epf, employeeName, companyId, canEdit }: { epf: string; employeeName: string; companyId: string; canEdit: boolean }) {
  const actor = useActor();
  const [loans, setLoans] = useState<PayrollLoan[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  // null (not 0) so the fields start blank and Backspace on a lone digit clears them.
  const [fullAmount, setFullAmount] = useState<number | null>(null);
  const [currentBalance, setCurrentBalance] = useState<number | null>(null);
  const [monthlyAmount, setMonthlyAmount] = useState<number | null>(null);
  const [startMonth, setStartMonth] = useState(new Date().toISOString().slice(0, 7));
  const [endMonth, setEndMonth] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState<PayrollLoan | null>(null);

  const load = async () => {
    setLoading(true);
    try { setLoans(await getLoansForEmployee(epf)); }
    catch (e) { console.error(e); toast.error('Failed to load loans.'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [epf]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCreate = async () => {
    // Current Balance left blank (0) means "start equal to the full amount" — the common case
    // of a brand-new loan; only set it separately when onboarding one that's already been
    // partly paid down elsewhere.
    const payload = {
      company_id: companyId, epf_number: epf, employee_name: employeeName,
      full_amount: fullAmount ?? 0,
      current_balance: currentBalance != null && currentBalance > 0 ? currentBalance : (fullAmount ?? 0),
      monthly_deduction_amount: monthlyAmount ?? 0, start_month: startMonth, end_month: endMonth,
      note: note || null,
    };
    const errors = validatePayrollLoan(payload);
    if (errors.length) { toast.error(errors[0]); return; }
    setSaving(true);
    try {
      await createLoan(payload, actor.epf, actor.name);
      toast.success('Loan created.');
      setShowForm(false); setFullAmount(null); setCurrentBalance(null); setMonthlyAmount(null); setEndMonth(''); setNote('');
      await load();
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to create loan.'); }
    finally { setSaving(false); }
  };

  const handleUpdateMonthly = async (loan: PayrollLoan, amount: number) => {
    try { await updateLoan(loan.id as string, { monthly_deduction_amount: amount }, actor.epf, actor.name); await load(); toast.success('Monthly deduction updated.'); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Failed.'); }
  };
  const handleUpdateEndMonth = async (loan: PayrollLoan, value: string) => {
    try { await updateLoan(loan.id as string, { end_month: value }, actor.epf, actor.name); await load(); toast.success('End month updated.'); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Failed.'); }
  };
  const handleCancel = async (loan: PayrollLoan) => {
    try { await cancelLoan(loan.id as string, actor.epf, actor.name); await load(); toast.success('Loan cancelled.'); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Failed.'); }
  };

  if (loading) return <div className="pt-3 text-sm text-muted-foreground">Loading…</div>;

  // companyId here is the employee's OWN company, never the page's scope — so it is empty
  // only for a profile whose company has since been deleted. Blocked rather than defaulted:
  // a loan filed under the wrong company is silently deducted from the wrong payroll run.
  const canCreate = canEdit && Boolean(companyId);

  return (
    <div className="space-y-3 pt-3">
      {canEdit && !companyId && (
        <p className="text-xs text-muted-foreground">This employee&apos;s company is no longer on record, so a new loan can&apos;t be filed. Reassign them on the Users page.</p>
      )}
      {canCreate && (
        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={() => setShowForm(v => !v)}><Plus className="w-3.5 h-3.5" />New Loan</Button>
        </div>
      )}
      {showForm && canCreate && (
        <Card className="p-3 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1"><Label className="text-[11px] text-muted-foreground">Full Amount</Label><Input type="number" min={0} placeholder="0" value={fullAmount ?? ''} onChange={e => setFullAmount(e.target.value === '' ? null : +e.target.value)} /></div>
            <div className="space-y-1"><Label className="text-[11px] text-muted-foreground">Monthly Deduction</Label><Input type="number" min={0} placeholder="0" value={monthlyAmount ?? ''} onChange={e => setMonthlyAmount(e.target.value === '' ? null : +e.target.value)} /></div>
          </div>
          <div className="space-y-1"><Label className="text-[11px] text-muted-foreground">Current Amount / Remaining Balance</Label><Input type="number" min={0} placeholder="Leave blank = same as Full Amount" value={currentBalance ?? ''} onChange={e => setCurrentBalance(e.target.value === '' ? null : +e.target.value)} /></div>
          {/* Start/End month — stacked to one field per row on mobile: two native month
              pickers' calendar-icon chrome side by side left too little room inside this
              card, same as the standalone Loans page's New Loan dialog. Back to grid-cols-2
              from sm: up, where there's room for both. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div className="space-y-1 min-w-0"><Label className="text-[11px] text-muted-foreground">Start Month</Label><Input type="month" className="w-full min-w-0" value={startMonth} onChange={e => setStartMonth(e.target.value)} /></div>
            <div className="space-y-1 min-w-0"><Label className="text-[11px] text-muted-foreground">End Date *</Label><Input type="month" className="w-full min-w-0" value={endMonth} onChange={e => setEndMonth(e.target.value)} /></div>
          </div>
          <div className="space-y-1"><Label className="text-[11px] text-muted-foreground">Note (optional)</Label><Input value={note} onChange={e => setNote(e.target.value)} /></div>
          <Button size="sm" onClick={handleCreate} disabled={saving}>{saving ? 'Saving…' : 'Create Loan'}</Button>
        </Card>
      )}
      {loans.length === 0 ? (
        <p className="text-xs text-muted-foreground">No loans for this employee.</p>
      ) : (
        loans.map(l => (
          <div key={l.id} className="flex items-center gap-3 rounded-lg border border-border p-3">
            <Banknote className="w-4 h-4 text-muted-foreground flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-sm text-foreground">Balance {l.current_balance.toLocaleString()} / {l.full_amount.toLocaleString()} {l.note ? `— ${l.note}` : ''}</div>
              <div className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
                Monthly:
                {canEdit && l.status === 'active' ? (
                  <Input type="number" min={0} className="w-24 h-7 text-xs" defaultValue={l.monthly_deduction_amount}
                    onBlur={e => {
                      const raw = +e.target.value;
                      // Same boundary rule validatePayrollLoan enforces at creation — a
                      // zero/negative/oversized edit here would otherwise reach Firestore
                      // unchecked, since updateLoan() writes the patch with no server-side check.
                      if (!(raw > 0) || raw > l.current_balance) {
                        toast.error(raw > 0 ? 'Monthly deduction cannot exceed the current balance.' : 'Monthly deduction must be greater than zero.');
                        e.target.value = String(l.monthly_deduction_amount);
                        return;
                      }
                      if (raw !== l.monthly_deduction_amount) handleUpdateMonthly(l, raw);
                    }} />
                ) : l.monthly_deduction_amount.toLocaleString()}
                · Since {l.start_month} · Ends
                {canEdit && l.status === 'active' ? (
                  <Input type="month" className="w-40 h-7 text-xs" defaultValue={l.end_month}
                    onBlur={e => { const v = e.target.value; if (v && v !== l.end_month) handleUpdateEndMonth(l, v); }} />
                ) : ` ${l.end_month}`}
              </div>
            </div>
            <Badge variant={l.status === 'active' ? 'success' : l.status === 'completed' ? 'muted' : 'destructive'}>{l.status}</Badge>
            {canEdit && l.status === 'active' && <Button variant="outline" size="icon-sm" onClick={() => setConfirmCancel(l)}><Trash2 className="w-3.5 h-3.5" /></Button>}
          </div>
        ))
      )}

      <ConfirmModal
        open={!!confirmCancel}
        onOpenChange={() => setConfirmCancel(null)}
        variant="warning"
        title="Cancel this loan?"
        description="No further deductions will be applied to this loan."
        confirmText="Cancel loan"
        cancelText="Keep"
        onConfirm={async () => {
          const l = confirmCancel;
          setConfirmCancel(null);
          if (l) await handleCancel(l);
        }}
      />
    </div>
  );
}
