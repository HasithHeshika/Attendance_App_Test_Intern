'use client';
// Loans — Step 4: org-wide multi-month staff loan list. Create/edit/cancel; balances are
// only ever decremented by the Finalize API route (see payrollLoanService.ts's module
// comment). Deliberately separate from the standalone Salary Advances module
// (/salary-advances) — short-term single-month advances are a different workflow, never
// mixed into this collection or this page. Southern Lanka Hospitals tenant only.

import { useEffect, useMemo, useState } from 'react';
import { Banknote, Plus, Search, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuthStore } from '@/store/authStore';
import { useUserCapabilities } from '@/store/rolesStore';
import { tenant } from '@/lib/firebase';
import { getCompanies } from '@/services/companyService';
import { useCompanyContext } from '@/store/companyContextStore';
import { getAllEmployees } from '@/services/userService';
import type { Company, AppUser } from '@/lib/types';
import type { PayrollLoan, PayrollLoanStatus } from '@/lib/payrollTypes';
import { getLoansForCompany, createLoan, updateLoan, cancelLoan } from '@/services/payrollLoanService';
import { approvePayrollRequest } from '@/services/payrollRequestService';
import { validatePayrollLoan } from '@/lib/payrollValidation';
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

export default function PayrollLoansPage() {
  const caps = useUserCapabilities();

  if (!tenant.features.payroll) {
    return <div className="p-10 text-center text-muted-foreground">Payroll is not enabled for this organisation.</div>;
  }
  if (!caps.is_system_admin && !caps.can_view_payroll && !caps.can_manage_pay_profiles) {
    return <div className="p-10 text-center text-muted-foreground">You don&apos;t have access to this section.</div>;
  }
  return <PayrollLoansContent canEdit={caps.is_system_admin || caps.can_manage_pay_profiles} />;
}

function PayrollLoansContent({ canEdit }: { canEdit: boolean }) {
  const actor = useActor();
  // Company scope now follows the Top Navbar's Global Company Selector, same as Schedule/
  // Shifts/Departments/Users/Attendance View — no more page-local company picker duplicating
  // it. This page has always been single-company only (no "All companies" mode); '' (a
  // switching admin's deliberate "All companies" pick) is correctly treated below the same way
  // "no company selected yet" already was.
  const { companyId, blocked: companyContextBlocked, ready: companyContextReady } = useCompanyContext();
  // Full company list — separate from the scope above — just to resolve the CURRENT scoped
  // company's own name for the NewLoanDialog prop below (a locked user's own company might not
  // be in useCompanyContext().companies, which is only populated for a switching admin).
  const [companies, setCompanies] = useState<Company[]>([]);
  useEffect(() => { getCompanies().then(setCompanies).catch(() => {}); }, []);
  const [employees, setEmployees] = useState<AppUser[]>([]);
  const [loans, setLoans] = useState<PayrollLoan[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<PayrollLoanStatus | 'all'>('active');
  const [showForm, setShowForm] = useState(false);
  // Set when the form was opened from a request in the queue below: carries the request id so
  // creating the loan can mark the request approved. Cleared whenever the dialog closes.
  const [prefill, setPrefill] = useState<RequestPrefill | null>(null);
  const [queueTick, setQueueTick] = useState(0);

  const load = async () => {
    if (!companyId) return;
    setLoading(true);
    try {
      const [l, e] = await Promise.all([getLoansForCompany(companyId), getAllEmployees(companyId)]);
      setLoans(l); setEmployees(e);
    } catch (err) { console.error(err); toast.error('Failed to load loans.'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [companyId]); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return loans.filter(l =>
      (statusFilter === 'all' || l.status === statusFilter) &&
      (!q || l.employee_name.toLowerCase().includes(q) || l.epf_number.toLowerCase().includes(q)));
  }, [loans, search, statusFilter]);

  const totalOutstanding = loans.filter(l => l.status === 'active').reduce((s, l) => s + l.current_balance, 0);
  const activeCount = loans.filter(l => l.status === 'active').length;

  const handleUpdateMonthly = async (loan: PayrollLoan, amount: number) => {
    try { await updateLoan(loan.id as string, { monthly_deduction_amount: amount }, actor.epf, actor.name); await load(); toast.success('Monthly deduction updated.'); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Failed.'); }
  };
  const handleUpdateEndMonth = async (loan: PayrollLoan, value: string) => {
    try { await updateLoan(loan.id as string, { end_month: value }, actor.epf, actor.name); await load(); toast.success('End month updated.'); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Failed.'); }
  };
  const [confirmCancel, setConfirmCancel] = useState<PayrollLoan | null>(null);
  const handleCancel = async (loan: PayrollLoan) => {
    try { await cancelLoan(loan.id as string, actor.epf, actor.name); await load(); toast.success('Loan cancelled.'); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Failed.'); }
  };

  const company = companies.find(c => c.id === companyId) ?? null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Loans"
        description="Multi-month staff loans — auto-deducted during Monthly Run finalization until the balance reaches zero or the end date passes. For short-term single-month advances, see Salary Advances."
        icon={Banknote}
        // The company selector that used to live here is gone — it duplicated the Top
        // Navbar's own Global Company Selector, which already drives `companyId` above.
        // Disabled while browsing "All companies" (companyId === '') — a loan is always filed
        // under ONE company, and `company` below resolves to null in that state, so without
        // this the button used to just silently do nothing when clicked.
        actions={canEdit && (
          <Button onClick={() => setShowForm(true)} disabled={!companyId}
            title={!companyId ? 'Pick a specific company from the navbar above to create a loan.' : undefined}>
            <Plus className="w-4 h-4" />New Loan
          </Button>
        )}
      />

      {!companyContextReady ? (
        // useCompanyContext() isn't settled yet (Firebase Auth + the roles registry both need
        // to load) — companyId is forced to '' and `blocked` can't even compute true during
        // this window, so without this branch PayrollRequestQueue below would mount with that
        // placeholder '' companyId and fire an unscoped, premature Firestore read (surfacing
        // as "Could not load pending requests." once, before the real companyId arrives a
        // moment later and everything quietly reloads correctly).
        <Card className="p-10 text-center text-sm text-muted-foreground">Loading…</Card>
      ) : companyContextBlocked ? (
        <Card className="p-10">
          <EmptyState
            icon={Banknote}
            title="No assigned company"
            description="Your account has no company assigned — contact an admin."
          />
        </Card>
      ) : (
      <>
      <Stagger className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        <StaggerItem><StatCard label="Active loans" value={activeCount} icon={Banknote} tone="brand" /></StaggerItem>
        <StaggerItem><StatCard label="Total outstanding" value={totalOutstanding.toLocaleString()} icon={Banknote} tone="warning" /></StaggerItem>
      </Stagger>

      {/* Scoped to the picked company on purpose: the dialog's employee list is loaded for that
          same company, so any request shown here has its employee selectable in the form. A
          request from another company waits until the approver switches to it. */}
      <PayrollRequestQueue
        kind="loan"
        companyId={companyId}
        canDecide={canEdit}
        actor={{ epf: actor.epf, name: actor.name }}
        refreshKey={queueTick}
        onApprove={(r) => {
          setPrefill({ requestId: r.id!, epf: r.epf_number, amount: r.amount, note: r.reason, period: r.period, repayMonths: r.repay_months ?? null });
          setShowForm(true);
        }}
      />

      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input className="pl-9" placeholder="Search employee…" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <Select value={statusFilter} onValueChange={v => setStatusFilter(v as PayrollLoanStatus | 'all')}>
            <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
              <SelectItem value="all">All</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {loading ? (
          <p className="text-center text-sm text-muted-foreground py-8">Loading…</p>
        ) : filtered.length === 0 ? (
          <EmptyState icon={Banknote} title="No loans" description="No loans match this filter." />
        ) : (
          <div className="space-y-2">
            {filtered.map(l => (
              <div key={l.id} className="flex items-center gap-3 rounded-lg border border-border p-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-foreground">{l.employee_name} <span className="text-muted-foreground font-normal">· {l.epf_number}</span></div>
                  <div className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
                    Balance {l.current_balance.toLocaleString()} / {l.full_amount.toLocaleString()} · Monthly:
                    {canEdit && l.status === 'active' ? (
                      <Input type="number" min={0} className="w-24 h-7 text-xs" defaultValue={l.monthly_deduction_amount}
                        onBlur={e => {
                          const v = +e.target.value;
                          // Same boundary rule validatePayrollLoan enforces at creation —
                          // updateLoan() writes this straight to Firestore with no
                          // server-side check, so a zero/negative/oversized edit here
                          // would otherwise reach the balance unchecked.
                          if (!(v > 0) || v > l.current_balance) {
                            toast.error(v > 0 ? 'Monthly deduction cannot exceed the current balance.' : 'Monthly deduction must be greater than zero.');
                            e.target.value = String(l.monthly_deduction_amount);
                            return;
                          }
                          if (v !== l.monthly_deduction_amount) handleUpdateMonthly(l, v);
                        }} />
                    ) : l.monthly_deduction_amount.toLocaleString()}
                    · Since {l.start_month} · Ends
                    {canEdit && l.status === 'active' ? (
                      <Input type="month" className="w-40 h-7 text-xs" defaultValue={l.end_month}
                        onBlur={e => { const v = e.target.value; if (v && v !== l.end_month) handleUpdateEndMonth(l, v); }} />
                    ) : ` ${l.end_month}`}
                    {l.note ? `· ${l.note}` : ''}
                  </div>
                </div>
                <Badge variant={l.status === 'active' ? 'success' : l.status === 'completed' ? 'muted' : 'destructive'}>{l.status}</Badge>
                {canEdit && l.status === 'active' && <Button variant="outline" size="icon-sm" onClick={() => setConfirmCancel(l)}><Trash2 className="w-3.5 h-3.5" /></Button>}
              </div>
            ))}
          </div>
        )}
      </Card>

      {company && (
        <NewLoanDialog open={showForm} onOpenChange={(v) => { setShowForm(v); if (!v) setPrefill(null); }} company={company} employees={employees}
          initial={prefill}
          onSave={async (payload) => {
            const errors = validatePayrollLoan(payload);
            if (errors.length) { toast.error(errors[0]); return; }
            let id: string;
            try {
              id = await createLoan(payload, actor.epf, actor.name);
            } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to create loan.'); return; }
            // The loan exists from here on. Marking the request is bookkeeping on top of it —
            // if that fails the money record stands and the request stays pending for a retry.
            if (prefill?.requestId) {
              try {
                await approvePayrollRequest(prefill.requestId, id, { epf: actor.epf, name: actor.name });
                toast.success('Loan created and the request approved.');
              } catch (e) {
                console.error(e);
                toast.error('The loan was created, but the request could not be marked approved. It stays in the queue.');
              }
              setQueueTick(n => n + 1);
            } else {
              toast.success('Loan created.');
            }
            setPrefill(null);
            setShowForm(false);
            await load();
          }}
        />
      )}

      <ConfirmModal
        open={!!confirmCancel}
        onOpenChange={() => setConfirmCancel(null)}
        variant="warning"
        title="Cancel this loan?"
        description={confirmCancel ? `${confirmCancel.employee_name}'s loan will be cancelled — no further deductions will be applied.` : undefined}
        confirmText="Cancel loan"
        cancelText="Keep"
        onConfirm={async () => {
          const l = confirmCancel;
          setConfirmCancel(null);
          if (l) await handleCancel(l);
        }}
      />
      </>
      )}
    </div>
  );
}

// 'YYYY-MM' plus a number of months, staying in 'YYYY-MM'. Used to turn a request's "from
// July, over 6 months" into the loan's end month (July + 5 = December).
function addMonths(yyyyMm: string, months: number): string {
  const [y, m] = yyyyMm.split('-').map(Number);
  if (!y || !m) return yyyyMm;
  const total = y * 12 + (m - 1) + months;
  const yy = Math.floor(total / 12);
  const mm = (total % 12) + 1;
  return `${yy}-${String(mm).padStart(2, '0')}`;
}

function NewLoanDialog({
  open, onOpenChange, company, employees, initial, onSave,
}: {
  open: boolean; onOpenChange: (v: boolean) => void; company: Company; employees: AppUser[];
  // Present when opened from an employee's request: the form starts with their employee,
  // amount, months and reason instead of blanks. The approver can still change any of it —
  // the employee's repayment term is a preference, not something they get to set.
  initial?: RequestPrefill | null;
  onSave: (payload: Omit<PayrollLoan, 'id' | 'status' | 'created_at' | 'updated_at'>) => Promise<void>;
}) {
  const [epf, setEpf] = useState('');
  // null (not 0) so the fields start blank and Backspace on a lone digit clears them.
  const [fullAmount, setFullAmount] = useState<number | null>(null);
  const [currentBalance, setCurrentBalance] = useState<number | null>(null);
  const [monthlyAmount, setMonthlyAmount] = useState<number | null>(null);
  const [startMonth, setStartMonth] = useState(new Date().toISOString().slice(0, 7));
  const [endMonth, setEndMonth] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  // Reset on open — to the request's values when there is one, blanks otherwise. `initial`
  // is deliberately not a dependency: it is set before the dialog opens and cleared after it
  // closes, and re-applying it mid-edit would wipe the approver's changes.
  useEffect(() => {
    if (!open) return;
    if (initial) {
      const months = initial.repayMonths && initial.repayMonths > 0 ? Math.floor(initial.repayMonths) : null;
      setEpf(initial.epf);
      setFullAmount(initial.amount);
      setCurrentBalance(initial.amount);
      // Whole rupees, rounded up so the last instalment is never the one that runs short.
      setMonthlyAmount(months ? Math.ceil(initial.amount / months) : null);
      setStartMonth(initial.period);
      setEndMonth(months ? addMonths(initial.period, months - 1) : '');
      setNote(initial.note);
    } else {
      setEpf(''); setFullAmount(null); setCurrentBalance(null); setMonthlyAmount(null);
      setStartMonth(new Date().toISOString().slice(0, 7)); setEndMonth(''); setNote('');
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = async () => {
    const emp = employees.find(e => e.epf_number === epf);
    if (!emp) { toast.error('Select an employee.'); return; }
    setSaving(true);
    try {
      await onSave({
        company_id: company.id, epf_number: epf, employee_name: emp.display_name,
        full_amount: fullAmount ?? 0,
        current_balance: currentBalance != null && currentBalance > 0 ? currentBalance : (fullAmount ?? 0),
        monthly_deduction_amount: monthlyAmount ?? 0, start_month: startMonth, end_month: endMonth,
        note: note || null,
      });
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">New loan{initial && <Badge variant="brand">From a request</Badge>}</DialogTitle>
          <DialogDescription className="sr-only">Create a multi-month staff loan</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Employee *</Label>
            <Select value={epf} onValueChange={setEpf}>
              <SelectTrigger><SelectValue placeholder="Select employee" /></SelectTrigger>
              <SelectContent>{employees.map(e => <SelectItem key={e.epf_number} value={e.epf_number}>{e.display_name} · {e.epf_number}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1"><Label className="text-[11px] text-muted-foreground">Full Amount</Label><Input type="number" min={0} placeholder="0" value={fullAmount ?? ''} onChange={e => setFullAmount(e.target.value === '' ? null : +e.target.value)} /></div>
            <div className="space-y-1"><Label className="text-[11px] text-muted-foreground">Monthly Deduction</Label><Input type="number" min={0} placeholder="0" value={monthlyAmount ?? ''} onChange={e => setMonthlyAmount(e.target.value === '' ? null : +e.target.value)} /></div>
          </div>
          {/* Own full-width row so the "= full amount" hint isn't clipped by the number spinner */}
          <div className="space-y-1"><Label className="text-[11px] text-muted-foreground">Current Amount / Remaining Balance</Label><Input type="number" min={0} placeholder="Leave blank = same as Full Amount" value={currentBalance ?? ''} onChange={e => setCurrentBalance(e.target.value === '' ? null : +e.target.value)} /></div>
          {/* Start/End month — stacked to one field per row on mobile: two native month
              pickers' calendar-icon chrome side by side left too little room inside the
              dialog's width on phones, same as the other request modals' date rows. Back to
              grid-cols-2 from sm: up, where there's room for both. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div className="space-y-1 min-w-0"><Label className="text-[11px] text-muted-foreground">Start Month</Label><Input type="month" className="w-full min-w-0" value={startMonth} onChange={e => setStartMonth(e.target.value)} /></div>
            <div className="space-y-1 min-w-0"><Label className="text-[11px] text-muted-foreground">End Month *</Label><Input type="month" className="w-full min-w-0" value={endMonth} onChange={e => setEndMonth(e.target.value)} /></div>
          </div>
          <div className="space-y-1"><Label className="text-[11px] text-muted-foreground">Note (optional)</Label><Input value={note} onChange={e => setNote(e.target.value)} /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" className="flex-1" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button className="flex-1" onClick={handleSave} disabled={saving || !epf}>{saving ? 'Saving…' : 'Create Loan'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
