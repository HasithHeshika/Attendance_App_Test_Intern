'use client';
// Reports — Step 5: pick any run and pull payslips, EPF/ETF C-Form data, PAYE/APIT summary,
// salary-by-department, OT-summary-by-department, and the bank statement export. Southern
// Lanka Hospitals tenant only.

import { useEffect, useMemo, useState } from 'react';
import { FileBarChart2, Download, AlertTriangle } from 'lucide-react';
import toast from 'react-hot-toast';
import { useUserCapabilities } from '@/store/rolesStore';
import { tenant } from '@/lib/firebase';
import { getCompanies } from '@/services/companyService';
import { useCompanyContext } from '@/store/companyContextStore';
import { getAllEmployees } from '@/services/userService';
import type { Company } from '@/lib/types';
import type { PayrollRun, PayrollResult } from '@/lib/payrollTypes';
import { getPayrollRunsForCompany } from '@/services/payrollRunService';
import { getResultsForRun } from '@/services/payrollResultService';
import { exportPayslipPdf, buildPayslipData } from '@/lib/payroll/payrollPayslipExport';
import { buildBankExportData, exportBankTransferCsv, exportBankTransferXlsx } from '@/lib/payroll/payrollBankExport';
import { buildMasterSummaryData, exportMasterSummaryCsv, exportMasterSummaryXlsx } from '@/lib/payroll/payrollMasterSummaryExport';
import { buildStatutoryExportData, exportStatutoryCsv, exportStatutoryXlsx } from '@/lib/payroll/payrollStatutoryExport';
import { buildPayeExportData, exportPayeCsv, exportPayeXlsx } from '@/lib/payroll/payrollPayeExport';
import { buildDepartmentSalaryData, exportDepartmentSalaryCsv, exportDepartmentSalaryXlsx } from '@/lib/payroll/payrollDepartmentSalaryExport';
import { buildOtByDepartmentData, exportOtByDepartmentCsv, exportOtByDepartmentXlsx } from '@/lib/payroll/payrollOtByDepartmentExport';
import { PageHeader } from '@/components/ui/page-header';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import ConfirmModal from '@/components/ConfirmModal';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export default function PayrollReportsPage() {
  const caps = useUserCapabilities();

  if (!tenant.features.payroll) {
    return <div className="p-10 text-center text-muted-foreground">Payroll is not enabled for this organisation.</div>;
  }
  if (!caps.is_system_admin && !caps.can_view_payroll) {
    return <div className="p-10 text-center text-muted-foreground">You don&apos;t have access to this section.</div>;
  }
  return <PayrollReportsContent canExportBank={caps.is_system_admin || caps.can_finalize_payroll} />;
}

function PayrollReportsContent({ canExportBank }: { canExportBank: boolean }) {
  // Company SCOPE now follows the Top Navbar's Global Company Selector, same as Schedule/
  // Shifts/Departments/Users/Attendance View — no more page-local company picker duplicating
  // it. companyId === '' is a switching admin's deliberate "All companies" pick (the navbar
  // selector has its own explicit "All companies" row for exactly that); companyContextBlocked
  // is a LOCKED user with no company assigned at all — fail-closed, never read as "all".
  const { companyId: scopeId, blocked: companyContextBlocked, ready: companyContextReady } = useCompanyContext();
  const allCompanies = scopeId === '';
  const scopeReady = companyContextReady && !companyContextBlocked;
  // Separate from the page's own SCOPE above — the full company list, needed for the "All
  // companies" fan-out query below regardless of which company the navbar has picked.
  const [companies, setCompanies] = useState<Company[]>([]);
  useEffect(() => { getCompanies().then(setCompanies).catch(() => {}); }, []);
  const [runs, setRuns] = useState<PayrollRun[]>([]);
  const [runId, setRunId] = useState('');
  const [results, setResults] = useState<PayrollResult[]>([]);
  const [nicByEpf, setNicByEpf] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!scopeReady) return;
    // Runs are read with an equality filter on company_id, so unlike getAllEmployees there is
    // no empty id that widens it — All companies means one query per company, merged into a
    // single newest-first picker. A run itself always belongs to exactly one company, so every
    // export below stays single-company regardless of the scope.
    const runsPromise = allCompanies
      ? Promise.all(companies.map(c => getPayrollRunsForCompany(c.id)))
        .then(perCompany => perCompany.flat().sort((a, b) => (b.year - a.year) || (b.month - a.month) || a.company_name.localeCompare(b.company_name)))
      : getPayrollRunsForCompany(scopeId);
    runsPromise.then(list => {
      setRuns(list);
      setRunId(list[0]?.id ?? '');
    }).catch(() => {});
    getAllEmployees(scopeId).then(list => setNicByEpf(new Map(list.map(e => [e.epf_number, e.nic]))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeId, scopeReady]);

  useEffect(() => {
    if (!runId) { setResults([]); return; }
    setLoading(true);
    getResultsForRun(runId).then(setResults).catch(e => { console.error(e); toast.error('Failed to load results.'); }).finally(() => setLoading(false));
  }, [runId]);

  const run = runs.find(r => r.id === runId) ?? null;
  const periodLabel = run ? `${MONTHS[run.month - 1]} ${run.year}` : '';
  // In the All state the picker spans companies, so the payslip list has to name the one the
  // selected run actually belongs to.
  const runLabel = run && allCompanies ? `${periodLabel} · ${run.company_name}` : periodLabel;

  const bankData = useMemo(() => buildBankExportData(results), [results]);
  const summaryData = useMemo(() => buildMasterSummaryData(results), [results]);
  const statutoryData = useMemo(() => buildStatutoryExportData(results, nicByEpf), [results, nicByEpf]);
  const payeData = useMemo(() => buildPayeExportData(results, nicByEpf), [results, nicByEpf]);
  const departmentSalaryData = useMemo(() => buildDepartmentSalaryData(results), [results]);
  const otByDepartmentData = useMemo(() => buildOtByDepartmentData(results), [results]);

  const [confirmExport, setConfirmExport] = useState<'csv' | 'xlsx' | null>(null);
  const doExportBank = (fmt: 'csv' | 'xlsx') => {
    if (fmt === 'csv') exportBankTransferCsv(bankData); else exportBankTransferXlsx(bankData);
  };
  const handleExportBank = (fmt: 'csv' | 'xlsx') => {
    if (bankData.excluded.length > 0) { setConfirmExport(fmt); return; }
    doExportBank(fmt);
  };

  return (
    <div className="space-y-6">
      {/* The company selector that used to live in this header's actions is gone — it
          duplicated the Top Navbar's own Global Company Selector, which already drives
          `scopeId` above. */}
      <PageHeader title="Reports" description="Payslips, EPF/ETF C-Form data, and bank statement exports for any payroll run." icon={FileBarChart2} />

      {!companyContextReady ? (
        // See payroll-loans/page.tsx's matching comment — companyId is forced to '' and
        // `blocked` can't compute true until useCompanyContext() actually settles.
        <Card className="p-10 text-center text-sm text-muted-foreground">Loading…</Card>
      ) : companyContextBlocked ? (
        <Card className="p-10">
          <EmptyState
            icon={FileBarChart2}
            title="No assigned company"
            description="Your account has no company assigned — contact an admin."
          />
        </Card>
      ) : (
      <>
      <Card className="p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1 min-w-[220px]">
            <Select value={runId} onValueChange={setRunId}>
              <SelectTrigger><SelectValue placeholder="Select a run" /></SelectTrigger>
              <SelectContent>
                {runs.map(r => <SelectItem key={r.id} value={r.id as string}>{allCompanies ? `${r.company_name} · ` : ''}{MONTHS[r.month - 1]} {r.year} — {r.status}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {run && <Badge variant={run.status === 'finalized' ? 'success' : 'muted'}>{run.status}</Badge>}
        </div>
      </Card>

      {runs.length === 0 ? (
        <Card className="p-8"><EmptyState icon={FileBarChart2} title="No runs yet" description="Open and generate a Monthly Run first." /></Card>
      ) : loading ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">Loading…</Card>
      ) : results.length === 0 ? (
        <Card className="p-8"><EmptyState icon={FileBarChart2} title="No results for this run" description="This run hasn't been generated yet." /></Card>
      ) : (
        <>
          {/* Cards stretch to equal height (grid), and each is a flex column with the button
              row pinned to the bottom (mt-auto) — so the CSV/Excel actions stay on one
              baseline even though the Bank Statement card carries an extra "N excluded" line. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4 items-stretch">
            <Card className="p-4 flex flex-col gap-2">
              <div className="text-sm font-semibold text-foreground">Master Summary</div>
              <p className="text-xs text-muted-foreground">Gross/deductions/net per employee, with totals.</p>
              <div className="flex gap-2 pt-1 mt-auto">
                <Button variant="outline" size="sm" onClick={() => exportMasterSummaryCsv(summaryData)}><Download className="w-3.5 h-3.5" />CSV</Button>
                <Button variant="outline" size="sm" onClick={() => exportMasterSummaryXlsx(summaryData)}><Download className="w-3.5 h-3.5" />Excel</Button>
              </div>
            </Card>
            <Card className="p-4 flex flex-col gap-2">
              <div className="text-sm font-semibold text-foreground">EPF/ETF C-Form Data</div>
              <p className="text-xs text-muted-foreground">EPF/ETF base and contributions per employee.</p>
              <div className="flex gap-2 pt-1 mt-auto">
                <Button variant="outline" size="sm" onClick={() => exportStatutoryCsv(statutoryData)}><Download className="w-3.5 h-3.5" />CSV</Button>
                <Button variant="outline" size="sm" onClick={() => exportStatutoryXlsx(statutoryData)}><Download className="w-3.5 h-3.5" />Excel</Button>
              </div>
            </Card>
            <Card className="p-4 flex flex-col gap-2">
              <div className="text-sm font-semibold text-foreground">PAYE / APIT Summary</div>
              <p className="text-xs text-muted-foreground">Taxable base and APIT per employee, {payeData.employeesWithApit} with tax due.</p>
              <div className="flex gap-2 pt-1 mt-auto">
                <Button variant="outline" size="sm" onClick={() => exportPayeCsv(payeData)}><Download className="w-3.5 h-3.5" />CSV</Button>
                <Button variant="outline" size="sm" onClick={() => exportPayeXlsx(payeData)}><Download className="w-3.5 h-3.5" />Excel</Button>
              </div>
            </Card>
            <Card className="p-4 flex flex-col gap-2">
              <div className="text-sm font-semibold text-foreground">Salary by Department</div>
              <p className="text-xs text-muted-foreground">{departmentSalaryData.groups.length} department(s), each with a subtotal and grand total.</p>
              <div className="flex gap-2 pt-1 mt-auto">
                <Button variant="outline" size="sm" onClick={() => exportDepartmentSalaryCsv(departmentSalaryData)}><Download className="w-3.5 h-3.5" />CSV</Button>
                <Button variant="outline" size="sm" onClick={() => exportDepartmentSalaryXlsx(departmentSalaryData)}><Download className="w-3.5 h-3.5" />Excel</Button>
              </div>
            </Card>
            <Card className="p-4 flex flex-col gap-2">
              <div className="text-sm font-semibold text-foreground">OT Summary by Department</div>
              <p className="text-xs text-muted-foreground">Ordinary + PH/Poya/Mercantile overtime hours and pay, totalled per department.</p>
              <div className="flex gap-2 pt-1 mt-auto">
                <Button variant="outline" size="sm" onClick={() => exportOtByDepartmentCsv(otByDepartmentData)}><Download className="w-3.5 h-3.5" />CSV</Button>
                <Button variant="outline" size="sm" onClick={() => exportOtByDepartmentXlsx(otByDepartmentData)}><Download className="w-3.5 h-3.5" />Excel</Button>
              </div>
            </Card>
            <Card className="p-4 flex flex-col gap-2">
              <div className="text-sm font-semibold text-foreground">Bank Statement</div>
              <p className="text-xs text-muted-foreground">
                {canExportBank ? 'Net pay per employee\'s bank account.' : 'Requires payroll finalization access.'}
              </p>
              {bankData.excluded.length > 0 && (
                <p className="text-[11px] text-warning flex items-center gap-1"><AlertTriangle className="w-3 h-3" />{bankData.excluded.length} excluded (missing bank details)</p>
              )}
              {canExportBank && (
                <div className="flex gap-2 pt-1 mt-auto">
                  <Button variant="outline" size="sm" onClick={() => handleExportBank('csv')}><Download className="w-3.5 h-3.5" />CSV</Button>
                  <Button variant="outline" size="sm" onClick={() => handleExportBank('xlsx')}><Download className="w-3.5 h-3.5" />Excel</Button>
                </div>
              )}
            </Card>
          </div>

          <Card className="p-0 overflow-hidden">
            <div className="px-4 py-3 border-b border-border text-sm font-semibold text-foreground">Payslips — {runLabel}</div>
            <div className="divide-y divide-border">
              {results.map(r => (
                <div key={r.id} className="flex items-center gap-3 px-4 py-2.5">
                  <div className="flex-1 min-w-0 text-sm">{r.employee_name} <span className="text-muted-foreground">· {r.epf_number}</span></div>
                  <div className="text-sm font-medium">{r.net_pay == null ? '—' : r.net_pay.toLocaleString()}</div>
                  <Button variant="outline" size="sm" onClick={() => exportPayslipPdf(buildPayslipData(r))}><Download className="w-3.5 h-3.5" />PDF</Button>
                </div>
              ))}
            </div>
          </Card>
        </>
      )}

      <ConfirmModal
        open={confirmExport !== null}
        onOpenChange={() => setConfirmExport(null)}
        variant="warning"
        title="Some employees will be excluded"
        description={`${bankData.excluded.length} employee(s) are missing bank details or have an unresolved net pay and won't be in the file. Continue?`}
        confirmText="Export anyway"
        onConfirm={() => {
          const fmt = confirmExport;
          setConfirmExport(null);
          if (fmt) doExportBank(fmt);
        }}
      />
      </>
      )}
    </div>
  );
}
