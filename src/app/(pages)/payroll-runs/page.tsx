'use client';
// Monthly Run — Step 3: the Bulk Sheet. Direct monthly input (OT hours, no-pay) per
// employee, then Generate/Review/Finalize. Basic Salary is locked here — only editable on
// the Employees page. Southern Lanka Hospitals tenant only.

import { useEffect, useMemo, useState } from 'react';
import {
  BadgeDollarSign, RefreshCcw, PlayCircle, CheckCircle2, Lock, Unlock, Download, AlertTriangle, Plus, X, Sparkles, Eye, Printer, Timer,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuthStore } from '@/store/authStore';
import { useUserCapabilities } from '@/store/rolesStore';
import Link from 'next/link';
import { auth, tenant } from '@/lib/firebase';
import { getCompanies } from '@/services/companyService';
import { useCompanyContext } from '@/store/companyContextStore';
import { getAllEmployees } from '@/services/userService';
import type { Company, AppUser } from '@/lib/types';
import type { PayrollRun, PayrollMonthlyEntry, PayrollResult, PayrollComponent, PayrollEmployee, PayrollCalculationWarning } from '@/lib/payrollTypes';
import {
  getOrCreatePayrollRun, addEmployeesToRun, addAllActiveEmployeesToRun, getPayrollRun, getMonthlyEntriesForRun, updateMonthlyEntry,
  computeAttendanceSyncSuggestions, findRosterCoverageGaps, syncApprovedOtToRun,
} from '@/services/payrollRunService';
import type { RosterCoverageGap } from '@/lib/rosterCoverage';
import { getActivePayrollEmployees } from '@/services/payrollEmployeeService';
import { getResultsForRun } from '@/services/payrollResultService';
import { getActivePayrollComponents } from '@/services/payrollSettingsService';
import { getAttendanceShortfallSummaries, type AttendanceShortfallSummary } from '@/services/attendanceShortfallService';
import { formatMinutes } from '@/lib/attendanceShortfallEngine';
import { exportPayslipPdf, buildPayslipData, type PayslipData, type PayslipRow } from '@/lib/payroll/payrollPayslipExport';
import { EmployeeSelectorTabs } from '@/components/payroll/EmployeeSelectorTabs';
import { PageHeader } from '@/components/ui/page-header';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { EmptyState } from '@/components/ui/empty-state';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import ConfirmModal from '@/components/ConfirmModal';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function useActor() {
  const { user } = useAuthStore();
  return { epf: user?.epf_number ?? '', name: user?.name ?? '' };
}

async function callPayrollRoute(path: string): Promise<{ success?: boolean; error?: string; [k: string]: unknown }> {
  const idToken = await auth.currentUser?.getIdToken();
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ idToken }),
  });
  // Read as text FIRST, never call res.json() blind — a non-2xx response from a platform
  // layer (a timeout, a crashed dev server, a proxy's own error page) can come back as plain
  // text/HTML instead of our route's JSON, and res.json() throws an opaque
  // "Unexpected token '<'/'I'... is not valid JSON" that swallows the real server message.
  // Reading text first means that real message (or the raw body, if it's not JSON at all)
  // always reaches the console and the thrown Error, instead of a syntax-error dead end.
  const text = await res.text();
  let data: Record<string, unknown> = {};
  if (text) {
    try { data = JSON.parse(text); }
    catch {
      console.error(`[payroll] ${path} → ${res.status} returned non-JSON body:`, text);
      throw new Error(`Server returned an unexpected response (status ${res.status}): ${text.slice(0, 300)}`);
    }
  }
  if (!res.ok) {
    // The route includes a stack trace on 500s (see generate/route.ts's catch block) — too
    // long/noisy for a toast, but logging it here means the exact failing line is one
    // devtools-console-open away, no server terminal access needed.
    if (data?.stack) console.error(`[payroll] ${path} → 500:`, data.stack);
    throw new Error((data?.error as string) || `Request failed (status ${res.status}).`);
  }
  return data;
}

export default function PayrollRunsPage() {
  const caps = useUserCapabilities();

  if (!tenant.features.payroll) {
    return <div className="p-10 text-center text-muted-foreground">Payroll is not enabled for this organisation.</div>;
  }
  if (!caps.is_system_admin && !caps.can_view_payroll && !caps.can_generate_payroll) {
    return <div className="p-10 text-center text-muted-foreground">You don&apos;t have access to this section.</div>;
  }
  return <PayrollRunsContent caps={caps} />;
}

function statusBadge(status: PayrollRun['status']) {
  if (status === 'finalized') return <Badge variant="success">Finalized</Badge>;
  if (status === 'reviewed') return <Badge variant="brand">Reviewed</Badge>;
  if (status === 'generated') return <Badge variant="default">Generated</Badge>;
  return <Badge variant="muted">Draft</Badge>;
}

function PayrollRunsContent({ caps }: { caps: ReturnType<typeof useUserCapabilities> }) {
  const actor = useActor();
  const now = new Date();

  // Company scope now follows the Top Navbar's Global Company Selector, same as Schedule/
  // Shifts/Departments/Users/Attendance View — no more page-local company picker duplicating
  // it. This page has always been single-company only.
  const { companyId, blocked: companyContextBlocked, ready: companyContextReady } = useCompanyContext();
  // Full company list — separate from the scope above — just to resolve the scoped company's
  // own name (a locked user's own company might not be in useCompanyContext().companies,
  // which is only populated for a switching admin).
  const [companies, setCompanies] = useState<Company[]>([]);
  useEffect(() => { getCompanies().then(setCompanies).catch(() => {}); }, []);
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);

  // Department filter — view-only. It narrows which Bulk Sheet ROWS are shown; Generate/
  // Review/Finalize still act on the WHOLE run regardless of this filter, since a PayrollRun
  // is one document per company per month, not per department (see runDocId in
  // payrollRunService.ts). Department comes from the AppUser record, not payroll data, since
  // neither PayrollEmployee nor PayrollMonthlyEntry carries one.
  const [employees, setEmployees] = useState<AppUser[]>([]);
  useEffect(() => { if (companyId) getAllEmployees(companyId).then(setEmployees).catch(() => {}); }, [companyId]);
  const departmentByEpf = useMemo(() => new Map(employees.map(e => [e.epf_number, e.department])), [employees]);
  const departments = useMemo(() => Array.from(new Set(employees.map(e => e.department).filter(Boolean))).sort(), [employees]);
  const [departmentFilter, setDepartmentFilter] = useState<string>('all');

  // Pre-open preview only — before a run exists there's no Bulk Sheet to filter yet. This
  // narrows nothing about what "Open Run" does (still just creates the empty draft, same as
  // always); it only tells the admin how many employees match before they commit, using the
  // same department dropdown the post-open Bulk Sheet filter (above) reuses, plus a free-text
  // search over name/EPF/employee number (same fields EmployeeSelectorTabs already searches).
  const [employeeSearch, setEmployeeSearch] = useState('');
  const previewMatches = useMemo(() => {
    const q = employeeSearch.trim().toLowerCase();
    return employees.filter(e => {
      if (departmentFilter !== 'all' && e.department !== departmentFilter) return false;
      if (!q) return true;
      return [e.display_name, e.first_name, e.last_name, e.epf_number, e.employee_number]
        .filter(Boolean).join(' ').toLowerCase().includes(q);
    });
  }, [employees, departmentFilter, employeeSearch]);

  const [components, setComponents] = useState<PayrollComponent[]>([]);
  const [run, setRun] = useState<PayrollRun | null>(null);
  const [entries, setEntries] = useState<PayrollMonthlyEntry[]>([]);
  const [results, setResults] = useState<PayrollResult[]>([]);
  const [shortfalls, setShortfalls] = useState<AttendanceShortfallSummary[]>([]);

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmRun, setConfirmRun] = useState<'finalize' | 'reopen' | null>(null);
  const [selectedEpf, setSelectedEpf] = useState<string | null>(null);
  const [showLoadDialog, setShowLoadDialog] = useState(false);
  const [previewEpf, setPreviewEpf] = useState<string | null>(null);
  const [warningsEpf, setWarningsEpf] = useState<string | null>(null);
  const [rosterGaps, setRosterGaps] = useState<RosterCoverageGap[] | null>(null);
  // Which handler to re-run once the roster gaps are fixed — handleOpenRun and
  // handleAddSelectedToSheet both hit the same strictRosterPayroll check, so the Retry button
  // in RosterGapsModal needs to know which one asked, not always assume "just open the run".
  const [rosterGapRetry, setRosterGapRetry] = useState<(() => void) | null>(null);
  const [selectedEpfs, setSelectedEpfs] = useState<Set<string>>(new Set());

  const company = companies.find(c => c.id === companyId) ?? null;
  const runId = company ? `${company.id}_${year}_${String(month).padStart(2, '0')}` : '';

  const loadRunState = async () => {
    if (!company) return;
    setLoading(true);
    try {
      const period = `${year}-${String(month).padStart(2, '0')}`;
      const [c, r, sf] = await Promise.all([
        getActivePayrollComponents(), getPayrollRun(runId),
        getAttendanceShortfallSummaries(company.id, period).catch(() => []), // informational only — never blocks the sheet
      ]);
      setComponents(c); setRun(r); setShortfalls(sf);
      if (r) {
        const [e, res] = await Promise.all([getMonthlyEntriesForRun(r.id as string), getResultsForRun(r.id as string)]);
        setEntries(e); setResults(res);
      } else { setEntries([]); setResults([]); }
    } catch (e) { console.error(e); toast.error('Failed to load payroll run.'); }
    finally { setLoading(false); }
  };
  useEffect(() => { loadRunState(); }, [companyId, year, month]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleOpenRun = async () => {
    if (!company) return;
    setBusy(true);
    try {
      // Southern Lanka only (TenantFeatures.strictRosterPayroll): refuse to open the run at
      // all while any active employee has a real check-in on a date nobody rostered them for.
      // Default tenants (flag off) skip this and keep today's behaviour unchanged.
      if (tenant.features.strictRosterPayroll) {
        const gaps = await findRosterCoverageGaps(company.id, year, month);
        if (gaps.length > 0) { setRosterGaps(gaps); setRosterGapRetry(() => handleOpenRun); return; }
      }
      await getOrCreatePayrollRun({ companyId: company.id, companyName: company.name, year, month, actorEpf: actor.epf, actorName: actor.name });
      toast.success('Payroll run opened.');
      await loadRunState();
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to open run.'); }
    finally { setBusy(false); }
  };

  // Driven by the checkboxes on the pre-open preview table (Month/Year/Department/Search
  // screen). Opens the run if it isn't open yet — going through the SAME roster-coverage gate
  // as handleOpenRun, never bypassing it — then loads exactly the checked employees via the
  // same addEmployeesToRun the "Load Specific Employees" dialog already uses. "Open Run" on
  // its own is untouched: it still creates an empty draft either way.
  const handleAddSelectedToSheet = async () => {
    if (!company || selectedEpfs.size === 0) return;
    setBusy(true);
    try {
      if (tenant.features.strictRosterPayroll) {
        const gaps = await findRosterCoverageGaps(company.id, year, month);
        if (gaps.length > 0) { setRosterGaps(gaps); setRosterGapRetry(() => handleAddSelectedToSheet); return; }
      }
      const openedRunId = await getOrCreatePayrollRun({ companyId: company.id, companyName: company.name, year, month, actorEpf: actor.epf, actorName: actor.name });
      const selected = employees
        .filter(e => selectedEpfs.has(e.epf_number))
        .map(e => ({ epf_number: e.epf_number, employee_name: e.display_name }));
      const r = await addEmployeesToRun(openedRunId, selected, actor.epf);
      toast.success(`Added ${r.added} employee(s) to the sheet.${r.alreadyPresent ? ` ${r.alreadyPresent} were already on it.` : ''}`);
      setSelectedEpfs(new Set());
      await loadRunState();
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to add selected employees.'); }
    finally { setBusy(false); }
  };

  const handleGenerate = async () => {
    if (!run) return;
    setBusy(true);
    try {
      const r = await callPayrollRoute(`/api/payroll/runs/${run.id}/generate`);
      const skippedCount = (r.skipped as string[])?.length ?? 0;
      const rowErrors = (r.errors as { epf_number: string; message: string }[]) ?? [];
      toast.success(`Generated ${r.generated} result(s).${skippedCount ? ` ${skippedCount} skipped (no employee profile).` : ''}`);
      if (rowErrors.length > 0) {
        toast.error(`${rowErrors.length} row(s) failed to calculate: ${rowErrors.map(e => `${e.epf_number} (${e.message})`).join('; ')}`, { duration: 8000 });
      }
      await loadRunState();
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to generate.'); }
    finally { setBusy(false); }
  };
  const handleReview = async () => {
    if (!run) return;
    setBusy(true);
    try { await callPayrollRoute(`/api/payroll/runs/${run.id}/review`); toast.success('Run marked reviewed.'); await loadRunState(); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to review.'); }
    finally { setBusy(false); }
  };
  const handleFinalize = async () => {
    if (!run) return;
    setBusy(true);
    try { await callPayrollRoute(`/api/payroll/runs/${run.id}/finalize`); toast.success('Run finalized.'); await loadRunState(); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to finalize.'); }
    finally { setBusy(false); }
  };
  // System-admin-only escape hatch: precisely reverses Finalize's own side effects (loan
  // balance deductions, salary advance recovery, payslip visibility) and drops the run back to
  // 'draft' — see reopen/route.ts for exactly what gets undone. Meant for correcting a
  // premature/test finalize (e.g. finalizing on a single employee before the rest of the
  // month's data was ready), not routine use.
  const handleReopen = async () => {
    if (!run) return;
    setBusy(true);
    try { await callPayrollRoute(`/api/payroll/runs/${run.id}/reopen`); toast.success('Run re-opened — back to Draft.'); await loadRunState(); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to re-open run.'); }
    finally { setBusy(false); }
  };

  const patchEntry = async (entry: PayrollMonthlyEntry, patch: Partial<PayrollMonthlyEntry>) => {
    setEntries(prev => prev.map(e => (e.id === entry.id ? { ...e, ...patch } : e)));
    try { await updateMonthlyEntry(entry.id as string, patch, actor.epf); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to save row.'); await loadRunState(); }
  };

  // "Sync Payroll Data" — the single smart primary action that replaces separately clicking
  // Load Employees then Sync from Attendance: (1) loads every active payroll-eligible
  // employee not already on the sheet (addAllActiveEmployeesToRun — same "all active" mode
  // the old Load Employees dialog offered), THEN (2) pre-fills Total Hours / PH Days / Poya
  // Days (and their informational "normal hours" companions) plus a suggested OT 1.5x figure
  // for every row now on the sheet, straight from each employee's REAL schedule for this
  // month. Everything it touches stays a normal editable Input afterward — this is a starting
  // point, never a lock. The granular picker (single/multi/department/designation) is still
  // available via "Load specific employees" below, for the case where not everyone active
  // should go on this particular run.
  //
  // Never touches No-Pay or OT 2.0x — those stay a deliberate human call (No-Pay isn't
  // derivable from attendance at all; OT 2.0x has no schedule-driven rule the way 1.5x does —
  // see computeAttendanceSyncSuggestions's own comment for exactly why 1.5x is the one OT
  // case a schedule alone can determine).
  const handleSyncPayrollData = async () => {
    if (!run || !company) return;
    setBusy(true);
    try {
      const loadResult = await addAllActiveEmployeesToRun(run.id as string, actor.epf);
      const freshEntries = await getMonthlyEntriesForRun(run.id as string);
      setEntries(freshEntries);

      if (freshEntries.length > 0) {
        const suggestions = await computeAttendanceSyncSuggestions(company.id, year, month, freshEntries.map(e => e.epf_number));
        await Promise.all(freshEntries.map(entry => {
          const s = suggestions.get(entry.epf_number);
          if (!s) return Promise.resolve();
          return updateMonthlyEntry(entry.id as string, {
            total_hours: s.total_hours, ph_days: s.ph_days, ph_hours_normal: s.ph_hours_normal, ph_hours_overtime: s.ph_hours_overtime,
            poya_days: s.poya_days, poya_hours_normal: s.poya_hours_normal, poya_hours_overtime: s.poya_hours_overtime,
            mercantile_days: s.mercantile_days, mercantile_hours_normal: s.mercantile_hours_normal, mercantile_hours_overtime: s.mercantile_hours_overtime,
            ot_hours_normal: s.ot_hours_normal,
          }, actor.epf);
        }));
      }
      toast.success(`Loaded ${loadResult.added} employee(s) and synced Total Hours, PH/Poya Days and suggested OT for all ${freshEntries.length} row(s) — review and adjust before Generate.`);
      await loadRunState();
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to sync payroll data.'); }
    finally { setBusy(false); }
  };

  // "Sync Approved OT" — the missing half of the OT pipeline. An employee applies on
  // /ot-requests, a manager approves it there, and until this button existed nothing ever
  // pulled that approved request onto this sheet: syncApprovedOtToRun (payrollRunService.ts)
  // was fully built and tested but had no caller anywhere in the UI, so approved overtime could
  // never reach a paycheck no matter what anyone did here. Deliberately separate from "Sync
  // Payroll Data" above, which only derives an OT SUGGESTION from the schedule — this pulls in
  // hours a human actually attested and an approver signed off, as a DELTA on top of whatever
  // is already in ot_hours_normal/double/ph_hours_overtime/poya_hours_overtime/
  // mercantile_hours_overtime, so re-running it is always safe and never double-counts.
  const handleSyncApprovedOt = async () => {
    if (!run) return;
    setBusy(true);
    try {
      const r = await syncApprovedOtToRun(run.id as string, actor.epf);
      if (r.rowsTouched === 0 && r.skippedOtherRun === 0) {
        toast.success('No new approved OT to sync — every approved request is already reflected on this sheet.');
      } else {
        toast.success(`Synced approved OT into ${r.rowsTouched} row(s)${r.requestsStamped ? ` (${r.requestsStamped} request(s) marked applied)` : ''}.`);
      }
      if (r.skippedOtherRun > 0) {
        toast(`${r.skippedOtherRun} approved request(s) are already applied to a different run and were left alone.`, { icon: 'ℹ️' });
      }
      await loadRunState();
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to sync approved OT.'); }
    finally { setBusy(false); }
  };

  const shortfallByEpf = useMemo(() => new Map(shortfalls.map(s => [s.epf_number, s])), [shortfalls]);
  const filteredEntries = useMemo(
    () => (departmentFilter === 'all' ? entries : entries.filter(e => departmentByEpf.get(e.epf_number) === departmentFilter)),
    [entries, departmentFilter, departmentByEpf],
  );
  // Has any Bulk Sheet row been touched (Sync, or a manual edit) since the last successful
  // Generate/Recalculate? Compares each entry's own updated_at against the run's
  // generated_at — a plain, always-correct signal with no extra state to keep in sync.
  // Inapplicable (never "dirty") for a run that's never been generated at all.
  const isDirty = !!run?.generated_at && entries.some(e => e.updated_at && e.updated_at.toMillis() > run.generated_at!.toMillis());
  // 'reviewed' stays editable too — the run only truly locks at Finalize (see
  // generate/route.ts's matching guard, which also clears any stale review approval when a
  // reviewed run is re-generated).
  const editable = (run?.status === 'draft' || run?.status === 'generated' || run?.status === 'reviewed') && caps.can_generate_payroll;
  const selectedResult = results.find(r => r.epf_number === selectedEpf) ?? null;
  const selectedEntry = entries.find(e => e.epf_number === selectedEpf) ?? null;
  const canAct = caps.is_system_admin || caps.can_manage_payroll_config || caps.can_generate_payroll;

  return (
    <div className="space-y-6">
      {/* The company selector that used to live in this header's actions is gone — it
          duplicated the Top Navbar's own Global Company Selector, which already drives
          `companyId` above. */}
      <PageHeader
        title="Monthly Run"
        description="Direct monthly input — hours, OT, PH/Poya days and no-pay are typed in each period, then generated, reviewed and finalized. Late Time is read-only, synced from Attendance View."
        icon={BadgeDollarSign}
      />

      {!companyContextReady ? (
        // See payroll-loans/page.tsx's matching comment — companyId is forced to '' and
        // `blocked` can't compute true until useCompanyContext() actually settles.
        <Card className="p-10 text-center text-sm text-muted-foreground">Loading…</Card>
      ) : companyContextBlocked ? (
        <Card className="p-10">
          <EmptyState
            icon={BadgeDollarSign}
            title="No assigned company"
            description="Your account has no company assigned — contact an admin."
          />
        </Card>
      ) : (
      <>
      <Card className="p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Month</Label>
            <Select value={String(month)} onValueChange={v => setMonth(+v)}>
              <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent>{MONTHS.map((m, i) => <SelectItem key={m} value={String(i + 1)}>{m}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Year</Label>
            <Input
              type="number" className="w-28" value={year}
              min={now.getFullYear() - 5} max={now.getFullYear() + 1}
              onChange={e => setYear(+e.target.value)}
              onBlur={e => {
                // Clamp on blur (not onChange) so typing a 4-digit year isn't fought mid-keystroke
                // — same "let them type, fix up on leave" pattern the Bulk Sheet's own numeric
                // inputs use. Keeps someone from silently opening a "20266" or "1900" run.
                const raw = +e.target.value;
                if (!Number.isFinite(raw)) { setYear(now.getFullYear()); return; }
                const clamped = Math.min(now.getFullYear() + 1, Math.max(now.getFullYear() - 5, raw));
                if (clamped !== year) setYear(clamped);
              }}
            />
          </div>

          {/* Preview-filter group — visually separated from Month/Year (which decide WHICH run
              you're opening) since Department/Search are optional and only preview who'd
              match; a non-technical reader shouldn't read all four fields as equally required.
              Always shown when there are employees at all — NOT conditional on department data
              existing. Gating it on departments.length used to make the whole group vanish for
              any tenant whose employees have no department field set, which looked like a
              Southern-Lanka-only feature from the outside even though nothing here actually
              checks tenant identity. A tenant with no department data just sees "All
              Departments" as the dropdown's only option — harmless, and the Search side still
              works regardless. */}
          {employees.length > 0 && (
            <div className="flex flex-wrap items-end gap-3 pl-3 border-l border-border">
              <div className="space-y-1">
                <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Department</Label>
                <Select value={departmentFilter} onValueChange={setDepartmentFilter}>
                  <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Departments</SelectItem>
                    {departments.map(d => <SelectItem key={d} value={d}>{d}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              {!run && (
                <div className="space-y-1">
                  <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Search</Label>
                  <Input className="w-56" placeholder="Name, EPF or employee no." value={employeeSearch} onChange={e => setEmployeeSearch(e.target.value)} />
                </div>
              )}
              {(departmentFilter !== 'all' || employeeSearch.trim() !== '') && (
                <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={() => { setDepartmentFilter('all'); setEmployeeSearch(''); }}>
                  <X className="w-3.5 h-3.5" />Clear filters
                </Button>
              )}
            </div>
          )}
          {run && <div className="ml-2">{statusBadge(run.status)}</div>}
          {run && (
            <span className="text-xs text-muted-foreground">
              {departmentFilter === 'all' ? `${entries.length} employee(s) on sheet` : `${filteredEntries.length} of ${entries.length} employee(s) shown (${departmentFilter})`}
            </span>
          )}
        </div>

        {loading ? (
          <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
        ) : !run ? (
          canAct ? (
            <div className="mt-4 space-y-3">
              {employees.length > 0 && (departmentFilter !== 'all' || employeeSearch.trim() !== '') && (() => {
                const visibleEpfs = previewMatches.map(e => e.epf_number);
                const allVisibleSelected = visibleEpfs.length > 0 && visibleEpfs.every(epf => selectedEpfs.has(epf));
                const toggleSelectAllVisible = (checked: boolean) => {
                  setSelectedEpfs(prev => {
                    const next = new Set(prev);
                    visibleEpfs.forEach(epf => (checked ? next.add(epf) : next.delete(epf)));
                    return next;
                  });
                };
                const toggleOne = (epf: string, checked: boolean) => {
                  setSelectedEpfs(prev => {
                    const next = new Set(prev);
                    if (checked) next.add(epf); else next.delete(epf);
                    return next;
                  });
                };
                return (
                  <div className="space-y-1.5">
                    <p className="text-xs text-muted-foreground">
                      {previewMatches.length} of {employees.length} employee(s) match this filter — checking employees below doesn&apos;t require opening the run first.
                    </p>
                    <div className="max-h-64 overflow-y-auto rounded-lg border border-border">
                      <table className="w-full text-sm">
                        <thead className="bg-muted/50 text-xs uppercase tracking-wider text-muted-foreground sticky top-0">
                          <tr>
                            <th className="px-3 py-2 w-10"><Checkbox checked={allVisibleSelected} onCheckedChange={v => toggleSelectAllVisible(v === true)} aria-label="Select all matching employees" /></th>
                            <th className="px-3 py-2 text-left">Employee</th>
                            <th className="px-3 py-2 text-left">Department</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {previewMatches.map(e => (
                            <tr key={e.epf_number}>
                              <td className="px-3 py-2"><Checkbox checked={selectedEpfs.has(e.epf_number)} onCheckedChange={v => toggleOne(e.epf_number, v === true)} aria-label={`Select ${e.display_name}`} /></td>
                              <td className="px-3 py-2">{e.display_name} <span className="text-muted-foreground text-xs">· {e.epf_number}</span></td>
                              <td className="px-3 py-2 text-muted-foreground">{e.department || '—'}</td>
                            </tr>
                          ))}
                          {previewMatches.length === 0 && (
                            <tr><td colSpan={3} className="px-3 py-4 text-center text-xs text-muted-foreground">No employees match this filter.</td></tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })()}
              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={handleOpenRun} disabled={busy}><Plus className="w-4 h-4" />Open {MONTHS[month - 1]} {year} run</Button>
                {selectedEpfs.size > 0 && (
                  <Button variant="outline" onClick={handleAddSelectedToSheet} disabled={busy}>
                    <Sparkles className="w-4 h-4" />Add {selectedEpfs.size} to Sheet
                  </Button>
                )}
              </div>
            </div>
          ) : <p className="mt-4 text-sm text-muted-foreground">No run open for this period yet.</p>
        ) : (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {/* Primary smart action: loads everyone missing + syncs attendance in one click. */}
            {editable && (
              <Button onClick={handleSyncPayrollData} disabled={busy}>
                <Sparkles className="w-4 h-4" />Sync Payroll Data
              </Button>
            )}
            {/* Pulls APPROVED ot_requests onto this sheet as a delta — separate from the
                schedule-derived suggestion above, and safe to click repeatedly. */}
            {editable && entries.length > 0 && (
              <Button variant="outline" onClick={handleSyncApprovedOt} disabled={busy}>
                <Timer className="w-4 h-4" />Sync Approved OT
              </Button>
            )}
            {/* Secondary/ghost by default — becomes an outlined, warning-dot "changes pending"
                button once the sheet has been touched since the last Generate, without ever
                competing with Sync Payroll Data as a second solid primary button. */}
            {editable && entries.length > 0 && (
              <Button variant={isDirty ? 'outline' : 'ghost'} onClick={handleGenerate} disabled={busy}>
                <PlayCircle className="w-4 h-4" />{run.status === 'draft' ? 'Generate' : 'Recalculate'}
                {isDirty && <span className="w-1.5 h-1.5 rounded-full bg-warning animate-pulse" aria-label="Changes pending" />}
              </Button>
            )}
            {run.status === 'generated' && caps.can_review_payroll && (
              <Button onClick={handleReview} disabled={busy}><CheckCircle2 className="w-4 h-4" />Mark Reviewed</Button>
            )}
            {run.status === 'reviewed' && caps.can_finalize_payroll && (
              <Button onClick={() => setConfirmRun('finalize')} disabled={busy}><Lock className="w-4 h-4" />Finalize</Button>
            )}
            {run.status === 'finalized' && caps.can_view_payroll && (
              <span className="text-xs text-muted-foreground">Exports are available on the Reports page.</span>
            )}
            {run.status === 'finalized' && caps.is_system_admin && (
              <Button variant="outline" onClick={() => setConfirmRun('reopen')} disabled={busy}>
                <Unlock className="w-4 h-4" />Re-open Run
              </Button>
            )}
            {editable && (
              <Button variant="link" size="sm" className="text-xs text-muted-foreground" onClick={() => setShowLoadDialog(true)} disabled={busy}>
                <RefreshCcw className="w-3.5 h-3.5" />Load specific employees…
              </Button>
            )}
            {run.status === 'reviewed' && editable && (
              <span className="text-[11px] text-muted-foreground w-full basis-full">Still editable — recalculating here will clear this run&apos;s review approval, so it needs to be marked Reviewed again before it can be finalized.</span>
            )}
            {departmentFilter !== 'all' && (
              <span className="text-[11px] text-muted-foreground w-full basis-full">Department is a view filter only — Sync/Generate/Review/Finalize always act on every employee in this month&apos;s run, not just {departmentFilter}.</span>
            )}
          </div>
        )}
      </Card>

      {run && entries.length > 0 && filteredEntries.length === 0 && (
        <Card className="p-8"><EmptyState icon={BadgeDollarSign} title={`No employees in ${departmentFilter}`} description="Nobody currently on this sheet belongs to that department. Switch the Department filter above, or choose All Departments." /></Card>
      )}

      {run && filteredEntries.length > 0 && (
        <Card className="p-0 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">Employee</th>
                  <th className="px-3 py-2 text-right">Hrs/Day (override)</th>
                  <th className="px-3 py-2 text-right">Total Hrs</th>
                  <th className="px-3 py-2 text-right">OT 1.5x (hrs)</th>
                  <th className="px-3 py-2 text-right">OT 2.0x (hrs)</th>
                  <th className="px-3 py-2 text-right">Normal PH Hrs</th>
                  <th className="px-3 py-2 text-right">PH OT Hrs</th>
                  <th className="px-3 py-2 text-right">PH Days</th>
                  <th className="px-3 py-2 text-right">Normal Poya Hrs</th>
                  <th className="px-3 py-2 text-right">Poya OT Hrs</th>
                  <th className="px-3 py-2 text-right">Poya Days</th>
                  <th className="px-3 py-2 text-right">Normal Mercantile Hrs</th>
                  <th className="px-3 py-2 text-right">Mercantile OT Hrs</th>
                  <th className="px-3 py-2 text-right">Mercantile Days</th>
                  <th className="px-3 py-2 text-right">No-Pay Hrs</th>
                  <th className="px-3 py-2 text-right">No-Pay Days</th>
                  <th className="px-3 py-2 text-right">Late Time</th>
                  <th className="px-3 py-2 text-center">Locked</th>
                  {results.length > 0 && <th className="px-3 py-2 text-right">Net Pay</th>}
                  {results.length > 0 && <th className="px-3 py-2 text-center">Warnings</th>}
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredEntries.map(entry => {
                  const result = results.find(r => r.epf_number === entry.epf_number);
                  const shortfall = shortfallByEpf.get(entry.epf_number);
                  // `defaultValue` (uncontrolled — deliberately, so typing doesn't re-render
                  // every keystroke) only ever applies on mount. Without a value-aware key, an
                  // EXTERNAL update to entry[field] — Sync from Attendance, or any other reload
                  // that changes the underlying data without the user having typed it — would
                  // never visually appear, since React reuses the same <input> DOM node across
                  // re-renders and never re-applies defaultValue to it. Keying by the field's
                  // current value forces a remount (and a fresh defaultValue) exactly when the
                  // stored value actually changed out from under the input, while a normal
                  // typed edit doesn't cause extra remounts (the value only "changes" to what
                  // was already typed, after the user has already blurred away).
                  const numField = (field: keyof PayrollMonthlyEntry, width = 'w-16') => (
                    <Input key={`${entry.id}-${field}-${entry[field]}`} type="number" min={0} className={`${width} h-7 text-right ml-auto`} disabled={!editable || entry.locked}
                      defaultValue={entry[field] as number}
                      onBlur={e => {
                        // Reject negatives / non-numbers — a payroll metric can never be < 0.
                        const raw = +e.target.value;
                        const v = Number.isFinite(raw) && raw >= 0 ? raw : 0;
                        if (raw < 0) toast.error('Value can’t be negative — reset to 0.');
                        if (v !== entry[field]) patchEntry(entry, { [field]: v });
                      }} />
                  );
                  // hours_per_day is nullable (blank = "use the employee profile's own override,
                  // else the company default") — unlike every other Bulk Sheet field above, blank
                  // must patch to `null`, never coerce to 0.
                  const hoursPerDayField = (
                    <Input key={`${entry.id}-hours_per_day-${entry.hours_per_day}`} type="number" min={0} step="0.5" className="w-16 h-7 text-right ml-auto" disabled={!editable || entry.locked}
                      defaultValue={entry.hours_per_day ?? ''} placeholder="e.g. 8"
                      onBlur={e => {
                        if (e.target.value === '') { if (entry.hours_per_day != null) patchEntry(entry, { hours_per_day: null }); return; }
                        const raw = +e.target.value;
                        const v = Number.isFinite(raw) && raw >= 0 ? raw : 0;
                        if (raw < 0) toast.error('Hours per day can’t be negative — reset to 0.');
                        if (v !== entry.hours_per_day) patchEntry(entry, { hours_per_day: v });
                      }} />
                  );
                  return (
                    <tr key={entry.id} className="hover:bg-muted/30">
                      <td className="px-3 py-2 cursor-pointer whitespace-nowrap" onClick={() => setSelectedEpf(entry.epf_number)}>{entry.employee_name} <span className="text-muted-foreground">· {entry.epf_number}</span></td>
                      <td className="px-3 py-2 text-right">{hoursPerDayField}</td>
                      <td className="px-3 py-2 text-right">{numField('total_hours')}</td>
                      <td className="px-3 py-2 text-right">{numField('ot_hours_normal', 'w-20')}</td>
                      <td className="px-3 py-2 text-right">{numField('ot_hours_double', 'w-20')}</td>
                      <td className="px-3 py-2 text-right">{numField('ph_hours_normal')}</td>
                      <td className="px-3 py-2 text-right">{numField('ph_hours_overtime')}</td>
                      <td className="px-3 py-2 text-right">{numField('ph_days', 'w-14')}</td>
                      <td className="px-3 py-2 text-right">{numField('poya_hours_normal')}</td>
                      <td className="px-3 py-2 text-right">{numField('poya_hours_overtime')}</td>
                      <td className="px-3 py-2 text-right">{numField('poya_days', 'w-14')}</td>
                      <td className="px-3 py-2 text-right">{numField('mercantile_hours_normal')}</td>
                      <td className="px-3 py-2 text-right">{numField('mercantile_hours_overtime')}</td>
                      <td className="px-3 py-2 text-right">{numField('mercantile_days', 'w-14')}</td>
                      <td className="px-3 py-2 text-right">{numField('no_pay_hours')}</td>
                      <td className="px-3 py-2 text-right">{numField('no_pay_days', 'w-14')}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        {shortfall && shortfall.total_late_minutes > 0
                          ? <Badge variant="warning">{formatMinutes(shortfall.total_late_minutes)}</Badge>
                          : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="px-3 py-2 text-center">
                        <Switch checked={entry.locked} disabled={!editable} onCheckedChange={v => patchEntry(entry, { locked: v })} />
                      </td>
                      {results.length > 0 && <td className="px-3 py-2 text-right font-semibold">{result?.net_pay == null ? '—' : result.net_pay.toLocaleString()}</td>}
                      {results.length > 0 && (
                        <td className="px-3 py-2 text-center">
                          {result && result.warnings.length > 0 && (
                            <button type="button" onClick={() => setWarningsEpf(entry.epf_number)} title="View warnings">
                              <Badge variant="warning" className="cursor-pointer transition-opacity hover:opacity-80">
                                <AlertTriangle className="w-3 h-3" />{result.warnings.length}
                              </Badge>
                            </button>
                          )}
                        </td>
                      )}
                      <td className="px-3 py-2 whitespace-nowrap">
                        {result && (
                          <div className="flex items-center justify-end gap-1.5">
                            <Button variant="outline" size="sm" className="px-2" title="Preview payslip" onClick={() => setPreviewEpf(entry.epf_number)}><Eye className="w-3.5 h-3.5" /></Button>
                            <Button variant="outline" size="sm" onClick={() => exportPayslipPdf(buildPayslipData(result, company?.address ?? null))}>PDF</Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {run && entries.length === 0 && !loading && (
        <Card className="p-8"><EmptyState icon={BadgeDollarSign} title="No employees on the sheet yet" description="Click Sync Payroll Data above to load everyone active, or Load specific employees… to pick a single employee, a department, or a designation instead." /></Card>
      )}

      {selectedEntry && (
        <RowDetailDrawer
          entry={selectedEntry}
          result={selectedResult}
          components={components}
          companyAddress={company?.address ?? null}
          canEdit={editable && !selectedEntry.locked}
          onClose={() => setSelectedEpf(null)}
          onSave={patch => patchEntry(selectedEntry, patch)}
        />
      )}

      {previewEpf && (() => {
        const previewResult = results.find(r => r.epf_number === previewEpf);
        if (!previewResult) return null;
        return (
          <PayslipPreviewModal
            data={buildPayslipData(previewResult, company?.address ?? null)}
            onClose={() => setPreviewEpf(null)}
          />
        );
      })()}

      {warningsEpf && (() => {
        const warningsResult = results.find(r => r.epf_number === warningsEpf);
        if (!warningsResult) return null;
        return (
          <WarningsModal
            employeeName={warningsResult.employee_name}
            epfNumber={warningsResult.epf_number}
            warnings={warningsResult.warnings}
            onClose={() => setWarningsEpf(null)}
          />
        );
      })()}

      {rosterGaps && (
        <RosterGapsModal
          gaps={rosterGaps}
          onClose={() => setRosterGaps(null)}
          onRetry={() => { setRosterGaps(null); rosterGapRetry?.(); }}
        />
      )}

      {run && company && (
        <LoadEmployeesDialog
          open={showLoadDialog}
          onOpenChange={setShowLoadDialog}
          companyId={company.id}
          runId={run.id as string}
          onLoaded={loadRunState}
        />
      )}

      <ConfirmModal
        open={confirmRun !== null}
        onOpenChange={() => setConfirmRun(null)}
        variant="warning"
        title={confirmRun === 'reopen' ? 'Re-open this finalized run?' : 'Finalize this run?'}
        description={
          confirmRun === 'reopen'
            ? 'Payslips will no longer be visible to employees, any loan / salary-advance deductions it made will be reversed, and it goes back to Draft. Use only to correct a mistaken finalize.'
            : 'Payslips become visible to employees, loan balances are deducted, and this cannot be undone from here.'
        }
        confirmText={confirmRun === 'reopen' ? 'Re-open' : 'Finalize'}
        busy={busy}
        onConfirm={async () => {
          const kind = confirmRun;
          setConfirmRun(null);
          if (kind === 'finalize') await handleFinalize();
          else if (kind === 'reopen') await handleReopen();
        }}
      />
      </>
      )}
    </div>
  );
}

// ─── Load Employees dialog — 5 selection modes ─────────────────────────────────────────
// Only active users who already have an active payroll profile (payroll_employees) are
// selectable — Generate needs Basic Salary etc. configured first, so offering someone
// without a profile would just produce a silent no-op on the sheet.

function LoadEmployeesDialog({
  open, onOpenChange, companyId, runId, onLoaded,
}: {
  open: boolean; onOpenChange: (v: boolean) => void; companyId: string; runId: string; onLoaded: () => Promise<void>;
}) {
  const actor = useActor();
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [users, setUsers] = useState<AppUser[]>([]);
  const [payrollEmployees, setPayrollEmployees] = useState<PayrollEmployee[]>([]);
  const [selection, setSelection] = useState<AppUser[]>([]);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    Promise.all([getAllEmployees(companyId), getActivePayrollEmployees(companyId)])
      .then(([u, pe]) => { setUsers(u); setPayrollEmployees(pe); })
      .catch(() => toast.error('Failed to load employees.'))
      .finally(() => setLoading(false));
  }, [open, companyId]);

  const payrollEpfSet = useMemo(() => new Set(payrollEmployees.map(e => e.epf_number)), [payrollEmployees]);
  const activeUsers = useMemo(() => users.filter(u => u.is_active), [users]);
  const eligible = useMemo(() => activeUsers.filter(u => payrollEpfSet.has(u.epf_number)), [activeUsers, payrollEpfSet]);
  const ineligibleCount = activeUsers.length - eligible.length;

  const handleLoad = async () => {
    if (selection.length === 0) return;
    setBusy(true);
    try {
      const r = await addEmployeesToRun(runId, selection.map(u => ({ epf_number: u.epf_number, employee_name: u.display_name })), actor.epf);
      toast.success(r.added > 0
        ? `Added ${r.added} employee(s) to the sheet.${r.alreadyPresent ? ` ${r.alreadyPresent} were already on it.` : ''}`
        : 'Everyone selected is already on the sheet.');
      onOpenChange(false);
      await onLoaded();
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to load employees.'); }
    finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Load Employees</DialogTitle>
          <DialogDescription>Choose how to select who gets added to this period&apos;s Bulk Sheet — everyone loaded starts with zeroed OT/no-pay; their Target Hours and recurring Allowances/Deductions are pulled live from their profile at Generate time.</DialogDescription>
        </DialogHeader>

        {loading ? (
          <p className="text-sm text-muted-foreground py-6 text-center">Loading…</p>
        ) : (
          <>
            {ineligibleCount > 0 && (
              <p className="text-[11px] text-muted-foreground">{ineligibleCount} active employee(s) don&apos;t have a payroll profile yet and aren&apos;t listed — set one up on the Payroll Employees page first.</p>
            )}
            <EmployeeSelectorTabs candidates={eligible} onSelectionChange={setSelection}
              allLabel={n => `Loads all ${n} active employee(s) with a payroll profile.`} />
          </>
        )}

        <DialogFooter>
          <Button variant="outline" className="flex-1" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button className="flex-1" onClick={handleLoad} disabled={busy || loading || selection.length === 0}>
            {busy ? 'Adding…' : `Add ${selection.length || ''} to Sheet`.trim()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RowDetailDrawer({
  entry, result, components, companyAddress, canEdit, onClose, onSave,
}: {
  entry: PayrollMonthlyEntry; result: PayrollResult | null | undefined; components: PayrollComponent[]; companyAddress: string | null;
  canEdit: boolean; onClose: () => void; onSave: (patch: Partial<PayrollMonthlyEntry>) => void;
}) {
  const usedIds = new Set(entry.one_off_lines.map(l => l.component_id));
  const availableComponents = components.filter(c => !usedIds.has(c.id as string));
  const [componentId, setComponentId] = useState(availableComponents[0]?.id ?? '');
  // null (not 0) so the field starts blank and Backspace on a lone digit clears it.
  const [amount, setAmount] = useState<number | null>(null);
  const amountValid = amount != null && amount > 0;

  const addOneOff = () => {
    if (!componentId || usedIds.has(componentId)) return;
    // The engine applies +/- from the component's own type — a one-off amount is always a
    // positive magnitude. Block negatives/blank before they reach the payslip totals.
    if (!amountValid) { toast.error('Enter an amount greater than zero.'); return; }
    onSave({ one_off_lines: [...entry.one_off_lines, { component_id: componentId, amount: amount as number }] });
    setAmount(null);
  };
  const removeOneOff = (i: number) => {
    onSave({ one_off_lines: entry.one_off_lines.filter((_, idx) => idx !== i) });
  };

  return (
    <Dialog open onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{entry.employee_name}</DialogTitle>
          <DialogDescription>{entry.epf_number}</DialogDescription>
        </DialogHeader>

        {result && result.warnings.length > 0 && (
          <div className="rounded-lg border border-warning/30 bg-warning/10 p-3 space-y-1">
            {result.warnings.map((w, i) => (
              <p key={i} className="text-xs text-warning-foreground flex items-start gap-1.5"><AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />{w.message}</p>
            ))}
          </div>
        )}

        {result ? (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs uppercase tracking-wider text-muted-foreground">
                <tr><th className="px-3 py-2 text-left">Line</th><th className="px-3 py-2 text-right">Amount</th></tr>
              </thead>
              <tbody className="divide-y divide-border">
                {result.lines.map((l, i) => (
                  <tr key={i}><td className="px-3 py-2">{l.name}</td><td className="px-3 py-2 text-right">{l.amount == null ? '—' : l.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="text-sm text-muted-foreground">Not yet generated — click Generate on the Monthly Run page.</p>}

        <div className="space-y-2 pt-2 border-t border-border">
          <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">One-off lines this month</Label>
          {entry.one_off_lines.map((l, i) => {
            const comp = components.find(c => c.id === l.component_id);
            return (
              <div key={i} className="flex items-center gap-2 text-sm">
                <span className="flex-1">{comp?.name ?? l.component_id} — {l.amount.toLocaleString()}</span>
                {canEdit && <Button variant="outline" size="icon-sm" onClick={() => removeOneOff(i)}><X className="w-3.5 h-3.5" /></Button>}
              </div>
            );
          })}
          {canEdit && availableComponents.length > 0 && (
            <div className="flex items-center gap-2 pt-1">
              <Select value={componentId} onValueChange={setComponentId}>
                <SelectTrigger className="flex-1"><SelectValue placeholder="Component" /></SelectTrigger>
                <SelectContent>{availableComponents.map(c => <SelectItem key={c.id} value={c.id as string}>{c.name}</SelectItem>)}</SelectContent>
              </Select>
              <Input type="number" min={0} className="w-28" placeholder="0" value={amount ?? ''}
                aria-invalid={amount != null && !amountValid}
                onChange={e => setAmount(e.target.value === '' ? null : +e.target.value)} />
              <Button size="sm" onClick={addOneOff} disabled={!amountValid}><Plus className="w-3.5 h-3.5" />Add</Button>
            </div>
          )}
          {canEdit && components.length > 0 && availableComponents.length === 0 && (
            <p className="text-[10px] text-muted-foreground">Every available component already has a one-off line this month.</p>
          )}
        </div>

        <DialogFooter>
          {result && <Button variant="outline" className="flex-1" onClick={() => exportPayslipPdf(buildPayslipData(result, companyAddress))}><Download className="w-4 h-4" />Download PDF</Button>}
          <Button className="flex-1" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Warnings modal — the Bulk Sheet row's Warnings badge, in isolation ────────────────────
// A focused list, separate from RowDetailDrawer (which also shows the full line breakdown and
// one-off-line editing) — clicking the warning count just wants the warnings, nothing else.
// 'blocking' vs 'info' (see PayrollCalculationWarning) get distinct styling so a warning that
// actually held something back from the calculation reads differently from a purely
// informational one.
function WarningsModal({
  employeeName, epfNumber, warnings, onClose,
}: {
  employeeName: string; epfNumber: string; warnings: PayrollCalculationWarning[]; onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><AlertTriangle className="w-4 h-4 text-warning" />Calculation warnings</DialogTitle>
          <DialogDescription>{employeeName} · {epfNumber}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {warnings.map((w, i) => (
            <div
              key={i}
              className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${
                w.severity === 'blocking'
                  ? 'border-destructive/30 bg-destructive/10 text-destructive'
                  : 'border-warning/30 bg-warning/10 text-warning-foreground'
              }`}
            >
              <AlertTriangle className={`mt-0.5 w-4 h-4 flex-shrink-0 ${w.severity === 'blocking' ? 'text-destructive' : 'text-warning'}`} />
              <span>{w.message}</span>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button className="flex-1" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Roster coverage blocker (Southern Lanka, TenantFeatures.strictRosterPayroll) ──────────
// Hard-blocks opening a Monthly Run: lists every employee/date with a real attendance
// check-in but no schedule_assignments/day_offs row (see findRosterCoverageGaps). The only
// way past it is to actually roster the missing shifts on /schedule, then retry.
function RosterGapsModal({
  gaps, onClose, onRetry,
}: {
  gaps: RosterCoverageGap[]; onClose: () => void; onRetry: () => void;
}) {
  return (
    <Dialog open onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><AlertTriangle className="w-4 h-4 text-destructive" />Unrostered attendance</DialogTitle>
          <DialogDescription>
            {gaps.length} attendance record{gaps.length === 1 ? '' : 's'} fall on a date with no shift assigned. Assign the missing shifts on Schedule, then retry.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 max-h-80 overflow-y-auto">
          {gaps.map((g, i) => (
            <div key={i} className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 w-4 h-4 flex-shrink-0 text-destructive" />
              <span>{g.employeeName} · {g.employeeId} — {g.date}</span>
            </div>
          ))}
        </div>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button asChild variant="outline" className="flex-1">
            <Link href="/schedule">Go to Schedule</Link>
          </Button>
          <Button className="flex-1" onClick={onRetry}>Retry</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Payslip Preview modal ──────────────────────────────────────────────────────────────
// Renders the SAME PayslipData structure/order the actual PDF export (payrollPayslipExport.ts)
// uses — a single stacked Description|Amount sheet matching the real company payslip form —
// as plain HTML/CSS instead of jsPDF/autoTable, a true preview, not a re-derived summary.
// Deliberately styled as paper (white background, dark text, bordered cells) regardless of
// the app's own dark theme, since it's standing in for a physical/PDF document, not app chrome.

function PayslipPreviewSection({ title, rows }: { title: string; rows: PayslipRow[] }) {
  if (rows.length === 0) return null;
  return (
    <table className="w-full text-xs border-collapse mb-3">
      <thead>
        <tr>
          <th className="text-left px-2 py-1 font-semibold border border-gray-300 bg-gray-100 text-gray-900">{title}</th>
          <th className="text-right px-2 py-1 font-semibold border border-gray-300 bg-gray-100 text-gray-900 w-28">Amount</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className={r.bold ? 'bg-gray-100 font-semibold' : ''}>
            <td className="px-2 py-1 border border-gray-300 text-gray-900">{r.label}</td>
            <td className="px-2 py-1 border border-gray-300 text-right text-gray-900">{r.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PayslipPreviewModal({ data, onClose }: { data: PayslipData; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] p-0 gap-0 flex flex-col overflow-hidden">
        {/* Print-only scoping: hide everything except the payslip sheet itself, regardless of
            the Dialog's own portal/overlay DOM structure — the standard "print just this
            element" visibility trick. @page controls size/margins; it can't remove a
            browser's own print header/footer (URL, date, page number) — that's a setting in
            the browser's print dialog itself ("More settings" → Headers and footers), not
            something a page can override. Download PDF (jsPDF) never goes through the
            browser's print pipeline at all, so it never has that problem in the first place. */}
        <style>{`
          @media print {
            @page { size: A4; margin: 12mm; }
            body * { visibility: hidden !important; }
            #payslip-print-area, #payslip-print-area * { visibility: visible !important; }
            /* Every ancestor between <body> and the print area (Radix dialog wrapper + the
               scroll container) constrains height / clips overflow / is transform-centred —
               all three would crop the printout to one viewport. Flatten them so the payslip
               can flow its full length across pages. */
            [role="dialog"], #payslip-print-scroll {
              position: static !important; transform: none !important;
              max-width: none !important; max-height: none !important; height: auto !important;
              overflow: visible !important; padding: 0 !important; margin: 0 !important;
            }
            .payslip-no-print { display: none !important; }
            #payslip-print-area {
              position: absolute !important; left: 0 !important; top: 0 !important;
              width: 100% !important; max-height: none !important; overflow: visible !important;
              padding: 0 !important; box-shadow: none !important; border: none !important;
            }
          }
        `}</style>

        <DialogHeader className="payslip-no-print flex-shrink-0 px-6 pt-6 pb-3">
          <DialogTitle>Payslip Preview</DialogTitle>
          <DialogDescription>{data.employeeName} · {data.epfNumber} · {data.periodLabel}</DialogDescription>
        </DialogHeader>

        <div id="payslip-print-scroll" className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-6">
          <div id="payslip-print-area" className="bg-white text-gray-900 border border-gray-300 rounded-lg p-5 mb-4 shadow-sm">
            <div className="mb-3">
              <div className="text-base font-bold">{data.companyName}</div>
              {data.companyAddress && <div className="text-[11px] text-gray-600">{data.companyAddress}</div>}
              <div className="text-sm font-medium mt-2">Payslip — {data.periodShortLabel}</div>
              <div className="text-[11px] text-gray-600">{data.employeeName} · {data.epfNumber} · {data.periodLabel} · Status: {data.runStatus}</div>
            </div>

            <PayslipPreviewSection title="Description" rows={data.topRows} />
            <PayslipPreviewSection title="Allowances" rows={data.allowanceRows} />
            <PayslipPreviewSection title="Deductions" rows={data.deductionRows} />
            <PayslipPreviewSection title="Employer's Contribution" rows={data.employerRows} />

            {(data.bankName || data.accountNumber) && (
              <div className="text-[11px] text-gray-600 mb-2">
                Bank: {data.bankName ?? '—'} · Branch: {data.bankBranch ?? '—'} · Account: {data.accountNumber ?? '—'}
              </div>
            )}
            <div className="text-xs font-medium">Employee Name: {data.employeeName}</div>
            {data.warningsCount > 0 && (
              <p className="text-[10px] text-amber-700 mt-2">{data.warningsCount} calculation warning(s) were recorded for this payslip.</p>
            )}
          </div>
        </div>

        <div className="payslip-no-print flex-shrink-0 flex justify-end gap-2 px-6 py-4 border-t border-border">
          <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
          <Button variant="outline" size="sm" onClick={() => window.print()}><Printer className="w-3.5 h-3.5" />Print</Button>
          <Button size="sm" onClick={() => exportPayslipPdf(data)}><Download className="w-3.5 h-3.5" />Download PDF</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
