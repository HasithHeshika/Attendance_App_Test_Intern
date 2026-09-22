'use client';
// Salary Advances — standalone module, deliberately separate from Loans (/payroll-loans).
// A short-term cash advance always tied to exactly one payroll cycle
// (`period`) and always fully recovered (100%) in that single month's run — never a
// multi-month installment plan. Status only ever flips 'pending' -> 'recovered' server-side,
// inside the Finalize API route (see payrollSalaryAdvanceService.ts's module comment).
// Southern Lanka Hospitals tenant only.

import { useEffect, useMemo, useState } from 'react';
import { HandCoins, Plus, Search, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuthStore } from '@/store/authStore';
import { useUserCapabilities } from '@/store/rolesStore';
import { tenant } from '@/lib/firebase';
import { getCompanies } from '@/services/companyService';
import { useCompanyContext } from '@/store/companyContextStore';
import { getAllEmployees } from '@/services/userService';
import type { Company, AppUser } from '@/lib/types';
import type { PayrollSalaryAdvance, SalaryAdvanceStatus } from '@/lib/payrollTypes';
import { getSalaryAdvancesForCompany, createSalaryAdvance, updateSalaryAdvance, cancelSalaryAdvance } from '@/services/payrollSalaryAdvanceService';
import { approvePayrollRequest } from '@/services/payrollRequestService';
import { validatePayrollSalaryAdvance } from '@/lib/payrollValidation';
import PayrollRequestQueue, { type RequestPrefill } from '@/components/payroll/PayrollRequestQueue';
import { PageHeader } from '@/components/ui/page-header';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { EmptyState } from '@/components/ui/empty-state';
import { StatCard } from '@/components/ui/stat-card';
import { Stagger, StaggerItem } from '@/components/ui/motion';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import ConfirmModal from '@/components/ConfirmModal';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';

function useActor() {
  const { user } = useAuthStore();
  return { epf: user?.epf_number ?? '', name: user?.name ?? '' };
}

// Local calendar date, not toISOString()'s UTC one — Southern Lanka is UTC+5:30, so
// converting to UTC first rolls anything before ~05:30 local back a day (and on the 1st of
// the month, back a whole month) before the string is ever sliced.
function todayLocalStr(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function currentPeriod(): string {
  return todayLocalStr().slice(0, 7);
}

export default function SalaryAdvancesPage() {
  const caps = useUserCapabilities();

  if (!tenant.features.payroll) {
    return <div className="p-10 text-center text-muted-foreground">Payroll is not enabled for this organisation.</div>;
  }
  if (!caps.is_system_admin && !caps.can_view_payroll && !caps.can_manage_pay_profiles) {
    return <div className="p-10 text-center text-muted-foreground">You don&apos;t have access to this section.</div>;
  }
  return <SalaryAdvancesContent canEdit={caps.is_system_admin || caps.can_manage_pay_profiles} />;
}

function SalaryAdvancesContent({ canEdit }: { canEdit: boolean }) {
  const actor = useActor();
  // Company SCOPE (which company's data this page shows) now follows the Top Navbar's Global
  // Company Selector, same as Schedule/Shifts/Departments/Users/Attendance View — no more
  // page-local company picker duplicating it. companyId === '' is a switching admin's
  // deliberate "All companies" pick (the navbar selector has its own explicit "All companies"
  // row for exactly that); companyContextBlocked is a LOCKED user with no company assigned at
  // all — fail-closed, never silently read as "all companies" (see companyContextStore.ts).
  const { companyId: scopeId, blocked: companyContextBlocked, ready: companyContextReady } = useCompanyContext();
  const allCompanies = scopeId === '';
  const scopeReady = companyContextReady && !companyContextBlocked;
  // Separate from the page's own SCOPE above — this is the full company list, needed to
  // resolve an arbitrary employee's OWN company (see NewAdvanceDialog: an advance is always
  // stamped with the employee's company, never the page scope) regardless of which company
  // (or none, for a locked user) the navbar has picked.
  const [companies, setCompanies] = useState<Company[]>([]);
  useEffect(() => { getCompanies().then(setCompanies).catch(() => {}); }, []);
  const [employees, setEmployees] = useState<AppUser[]>([]);
  const [advances, setAdvances] = useState<PayrollSalaryAdvance[]>([]);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState(currentPeriod());
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  // Set when the form was opened from a request in the queue below: carries the request id so
  // recording the advance can mark the request approved. Cleared whenever the dialog closes.
  const [prefill, setPrefill] = useState<RequestPrefill | null>(null);
  const [queueTick, setQueueTick] = useState(0);

  const load = async () => {
    if (!scopeReady) return;
    setLoading(true);
    try {
      // Advances are read with an equality filter on company_id, so unlike getAllEmployees
      // there is no empty id that widens it — All companies means one query per company.
      // Companies are few (and the list is cached), so the fan-out stays cheap.
      const [a, e] = await Promise.all([
        allCompanies
          ? Promise.all(companies.map(c => getSalaryAdvancesForCompany(c.id)))
            .then(perCompany => perCompany.flat().sort((x, y) => x.employee_name.localeCompare(y.employee_name)))
          : getSalaryAdvancesForCompany(scopeId),
        getAllEmployees(scopeId),
      ]);
      setAdvances(a); setEmployees(e);
    } catch (err) { console.error(err); toast.error('Failed to load salary advances.'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [scopeId, scopeReady]); // eslint-disable-line react-hooks/exhaustive-deps

  // Records for the picked month only — the whole point of the top picker is "what happened/
  // is owed for this specific payroll cycle", so unlike Loans (an open-ended list) this list
  // is scoped to one period at a time.
  const forPeriod = useMemo(() => advances.filter(a => a.period === period), [advances, period]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return forPeriod;
    return forPeriod.filter(a => a.employee_name.toLowerCase().includes(q) || a.epf_number.toLowerCase().includes(q));
  }, [forPeriod, search]);

  const pendingCount = forPeriod.filter(a => a.status === 'pending').length;
  const pendingTotal = forPeriod.filter(a => a.status === 'pending').reduce((s, a) => s + a.amount, 0);
  const recoveredCount = forPeriod.filter(a => a.status === 'recovered').length;

  const handleUpdateAmount = async (advance: PayrollSalaryAdvance, amount: number) => {
    try { await updateSalaryAdvance(advance.id as string, { amount }, actor.epf, actor.name); await load(); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Failed.'); }
  };
  const [confirmCancel, setConfirmCancel] = useState<PayrollSalaryAdvance | null>(null);
  const handleCancel = async (advance: PayrollSalaryAdvance) => {
    try { await cancelSalaryAdvance(advance.id as string, actor.epf, actor.name); await load(); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Failed.'); }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Salary Advances"
        description="Short-term cash advances — automatically fetched and fully deducted (100%) during that same month's payroll run, then marked Recovered. Separate from multi-month Loans."
        icon={HandCoins}
        // The company selector that used to live here is gone — it duplicated the Top
        // Navbar's own Global Company Selector, which already drives `scopeId` above.
        actions={canEdit && <Button onClick={() => setShowForm(true)}><Plus className="w-4 h-4" />Record Salary Advance</Button>}
      />

      {!companyContextReady ? (
        // See payroll-loans/page.tsx's matching comment — companyId is forced to '' and
        // `blocked` can't compute true until useCompanyContext() actually settles, so without
        // this branch PayrollRequestQueue below would fire an unscoped, premature read.
        <Card className="p-10 text-center text-sm text-muted-foreground">Loading…</Card>
      ) : companyContextBlocked ? (
        <Card className="p-10">
          <EmptyState
            icon={HandCoins}
            title="No assigned company"
            description="Your account has no company assigned — contact an admin."
          />
        </Card>
      ) : (
      <>
      <Stagger className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        <StaggerItem><StatCard label="Pending recovery" value={pendingCount} icon={HandCoins} tone="warning" /></StaggerItem>
        <StaggerItem><StatCard label="Pending amount" value={pendingTotal.toLocaleString()} icon={HandCoins} tone="brand" /></StaggerItem>
        <StaggerItem><StatCard label="Recovered this month" value={recoveredCount} icon={HandCoins} tone="success" wrapLabel /></StaggerItem>
      </Stagger>

      {/* The queue follows the page scope (one company, or all of them) on purpose: the dialog's
          employee list is loaded for that same scope, so any request shown here is guaranteed to
          have its employee selectable in the form. A cross-company request simply waits until the
          approver picks that company — or All companies. */}
      <PayrollRequestQueue
        kind="advance"
        companyId={scopeId}
        canDecide={canEdit}
        actor={{ epf: actor.epf, name: actor.name }}
        refreshKey={queueTick}
        onApprove={(r) => {
          setPrefill({ requestId: r.id!, epf: r.epf_number, amount: r.amount, note: r.reason, period: r.period });
          setPeriod(r.period);
          setShowForm(true);
        }}
      />

      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <Input type="month" className="w-40" value={period} onChange={e => setPeriod(e.target.value)} />
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input className="pl-9" placeholder="Search employee…" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        </div>

        {loading ? (
          <p className="text-center text-sm text-muted-foreground py-8">Loading…</p>
        ) : filtered.length === 0 ? (
          <EmptyState icon={HandCoins} title="No salary advances" description={`No salary advances recorded for ${period}.`} />
        ) : (
          <div className="space-y-2">
            {filtered.map(a => (
              <div key={a.id} className="flex items-center gap-3 rounded-lg border border-border p-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-foreground">{a.employee_name} <span className="text-muted-foreground font-normal">· {a.epf_number}{allCompanies ? ` · ${a.company_name}` : ''}</span></div>
                  <div className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
                    Amount:
                    {canEdit && a.status === 'pending' ? (
                      <Input type="number" min={0} className="w-24 h-6 text-xs" defaultValue={a.amount}
                        onBlur={e => {
                          const v = +e.target.value;
                          // A number input's `min` only affects the spinner/validity flag, not
                          // what can be typed — a negative value would otherwise sit here
                          // un-flagged until a native form-submit tooltip caught it. Reject and
                          // revert here instead, with a visible reason.
                          if (!(v > 0)) {
                            toast.error('Amount must be greater than zero.');
                            e.target.value = String(a.amount);
                            return;
                          }
                          if (v !== a.amount) handleUpdateAmount(a, v);
                        }} />
                    ) : a.amount.toLocaleString()}
                    · Given {a.advance_date} {a.note ? `· ${a.note}` : ''}
                  </div>
                </div>
                <Badge variant={a.status === 'pending' ? 'warning' : a.status === 'recovered' ? 'success' : 'muted'}>
                  {a.status === 'pending' ? 'Pending Recovery' : a.status === 'recovered' ? 'Recovered' : 'Cancelled'}
                </Badge>
                {canEdit && a.status === 'pending' && <Button variant="outline" size="icon-sm" onClick={() => setConfirmCancel(a)}><Trash2 className="w-3.5 h-3.5" /></Button>}
              </div>
            ))}
          </div>
        )}
      </Card>

      <NewAdvanceDialog open={showForm} onOpenChange={(v) => { setShowForm(v); if (!v) setPrefill(null); }} companies={companies} employees={employees} defaultPeriod={period} showCompany={allCompanies}
        initial={prefill}
        onSave={async (payload) => {
          const errors = validatePayrollSalaryAdvance(payload);
          if (errors.length) { toast.error(errors[0]); return; }
          let id: string;
          try {
            id = await createSalaryAdvance(payload, actor.epf, actor.name);
          } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to record advance.'); return; }
          // The advance exists from here on. Marking the request is bookkeeping on top of it —
          // if that fails the money record stands and the request stays pending for a retry.
          if (prefill?.requestId) {
            try {
              await approvePayrollRequest(prefill.requestId, id, { epf: actor.epf, name: actor.name });
              toast.success('Salary advance recorded and the request approved.');
            } catch (e) {
              console.error(e);
              toast.error('The advance was recorded, but the request could not be marked approved. It stays in the queue.');
            }
            setQueueTick(n => n + 1);
          } else {
            toast.success('Salary advance recorded.');
          }
          setPrefill(null);
          setShowForm(false);
          await load();
        }}
      />

      <ConfirmModal
        open={!!confirmCancel}
        onOpenChange={() => setConfirmCancel(null)}
        variant="warning"
        title="Cancel this salary advance?"
        description={confirmCancel ? `${confirmCancel.employee_name}'s salary advance will be cancelled — it will no longer be deducted.` : undefined}
        confirmText="Cancel advance"
        cancelText="Keep"
        onConfirm={async () => {
          const a = confirmCancel;
          setConfirmCancel(null);
          if (a) await handleCancel(a);
        }}
      />
      </>
      )}
    </div>
  );
}

function NewAdvanceDialog({
  open, onOpenChange, companies, employees, defaultPeriod, showCompany, initial, onSave,
}: {
  open: boolean; onOpenChange: (v: boolean) => void; companies: Company[]; employees: AppUser[]; defaultPeriod: string;
  showCompany: boolean;
  // Present when opened from an employee's request: the form starts with their employee,
  // amount and reason instead of blanks. The approver can still change any of it.
  initial?: RequestPrefill | null;
  onSave: (payload: Omit<PayrollSalaryAdvance, 'id' | 'status' | 'created_at' | 'updated_at'>) => Promise<void>;
}) {
  const [epf, setEpf] = useState('');
  const [date, setDate] = useState(todayLocalStr());
  // null (not 0) so the field starts blank and Backspace on a lone digit clears it instead
  // of snapping back to "0".
  const [amount, setAmount] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  // Reset on open — to the request's values when there is one, blanks otherwise. `initial`
  // is deliberately not a dependency: it is set before the dialog opens and cleared after it
  // closes, and re-applying it mid-edit would wipe the approver's changes.
  useEffect(() => {
    if (!open) return;
    setEpf(initial?.epf ?? '');
    setDate(todayLocalStr());
    setAmount(initial ? initial.amount : null);
    setNote(initial?.note ?? '');
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const amountValid = amount != null && amount > 0;

  const handleSave = async () => {
    const emp = employees.find(e => e.epf_number === epf);
    if (!emp) { toast.error('Select an employee.'); return; }
    // The advance is stamped with the EMPLOYEE's own company, never the page scope — that is
    // what lets "All companies" list every employee without ever filing a record under an
    // empty or sentinel company id.
    const company = companies.find(c => c.id === emp.company_id) ?? null;
    if (!company) { toast.error('This employee isn’t assigned to a company.'); return; }
    if (!amountValid) { toast.error('Enter an advance amount greater than zero.'); return; }
    setSaving(true);
    try {
      await onSave({
        company_id: company.id, company_name: company.name, epf_number: epf, employee_name: emp.display_name,
        amount: amount as number, advance_date: date, period: defaultPeriod, note: note || null,
      });
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">Record salary advance{initial && <Badge variant="brand">From a request</Badge>}</DialogTitle>
          <DialogDescription>Recovered 100% from {defaultPeriod}&apos;s payroll run — the month currently selected above.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Employee *</Label>
            <Select value={epf} onValueChange={setEpf}>
              <SelectTrigger><SelectValue placeholder="Select employee" /></SelectTrigger>
              <SelectContent>{employees.map(e => <SelectItem key={e.epf_number} value={e.epf_number}>{e.display_name} · {e.epf_number}{showCompany ? ` · ${e.company_name}` : ''}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          {/* min-w-0 on both columns/inputs — a native type="date" control's calendar-icon
              chrome can force intrinsic width past its grid track without it, letting Advance
              amount overlap/overflow past Date given. Stacked to one field per row below sm:
              too — even with min-w-0, the date picker's chrome left Advance amount visibly
              cramped beside it at phone widths. Back to grid-cols-2 from sm: up, where there's
              room for both. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div className="space-y-1 min-w-0"><Label className="text-[11px] text-muted-foreground">Date given</Label><Input type="date" className="w-full min-w-0" value={date} onChange={e => setDate(e.target.value)} /></div>
            <div className="space-y-1 min-w-0"><Label className="text-[11px] text-muted-foreground">Advance amount</Label><Input type="number" min={0} placeholder="0" className="min-w-0" value={amount ?? ''} aria-invalid={amount != null && !amountValid} onChange={e => setAmount(e.target.value === '' ? null : +e.target.value)} /></div>
          </div>
          <div className="space-y-1"><Label className="text-[11px] text-muted-foreground">Note (optional)</Label><Input value={note} onChange={e => setNote(e.target.value)} /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" className="flex-1" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button className="flex-1" onClick={handleSave} disabled={saving || !epf || !amountValid}>{saving ? 'Saving…' : 'Record Advance'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
