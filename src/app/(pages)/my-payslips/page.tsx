'use client';
// PAYROLL-005 — employee self-service: preview and download PDF snapshots of the
// signed-in employee's OWN finalized payslips. Reads through the server route (never a
// direct client Firestore query against payroll_results — see payrollResultService.ts).
// Mirrors the leaves page's list-of-cards layout convention.

import { useEffect, useState } from 'react';
import { Wallet, Download, Eye } from 'lucide-react';
import toast from 'react-hot-toast';
import { useUserCapabilities } from '@/store/rolesStore';
import { tenant } from '@/lib/firebase';
import type { PayrollResult } from '@/lib/payrollTypes';
import { getMyPayrollResults } from '@/services/payrollResultService';
import { getCompany } from '@/services/companyService';
import { buildPayslipData, exportPayslipPdf, type PayslipData } from '@/lib/payroll/payrollPayslipExport';
import { PageHeader } from '@/components/ui/page-header';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { StatCard } from '@/components/ui/stat-card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageTransition, Reveal, Stagger, StaggerItem } from '@/components/ui/motion';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';

export default function MyPayslipsPage() {
  const caps = useUserCapabilities();

  if (!tenant.features.payroll) {
    return <div className="p-10 text-center text-muted-foreground">Payroll is not enabled for this organisation.</div>;
  }
  if (!caps.can_view_own_payslip) {
    return <div className="p-10 text-center text-muted-foreground">Payslip access is not enabled for your role.</div>;
  }
  return <MyPayslipsContent />;
}

function MyPayslipsContent() {
  const [results, setResults] = useState<PayrollResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState<PayslipData | null>(null);
  const [companyAddress, setCompanyAddress] = useState<string | null>(null);

  useEffect(() => {
    getMyPayrollResults()
      .then(async rows => {
        setResults(rows);
        // Every payslip here belongs to the same person, hence (almost always) the same
        // company — one lookup off the most recent result is enough for the PDF header.
        if (rows[0]) getCompany(rows[0].company_id).then(c => setCompanyAddress(c?.address ?? null)).catch(() => {});
      })
      .catch(e => { console.error(e); toast.error(e instanceof Error ? e.message : 'Failed to load payslips.'); })
      .finally(() => setLoading(false));
  }, []);

  const latest = results[0] ?? null;
  const ytdNet = results.reduce((sum, r) => sum + (r.net_pay ?? 0), 0);
  const ytdGross = results.reduce((sum, r) => sum + (r.gross_pay ?? 0), 0);

  if (loading) return <div className="p-10 text-center text-sm text-muted-foreground">Loading…</div>;

  return (
    <PageTransition className="space-y-6">
      <PageHeader
        title="My Payslips"
        description="Finalized payslip snapshots only — these never change after they're issued."
        icon={Wallet}
      />

      {results.length === 0 ? (
        <Reveal><Card className="p-8"><EmptyState icon={Wallet} title="No payslips yet" description="Finalized payslips will appear here once payroll has been processed." /></Card></Reveal>
      ) : (
        <>
          <Stagger className="grid grid-cols-2 lg:grid-cols-3 gap-4">
            <StaggerItem><StatCard label="Latest net pay" value={latest?.net_pay?.toLocaleString() ?? '—'} icon={Wallet} tone="brand" hint={periodLabel(latest?.run_id)} /></StaggerItem>
            <StaggerItem><StatCard label="Payslips on file" value={results.length} icon={Wallet} tone="primary" /></StaggerItem>
            <StaggerItem><StatCard label="Total net (all time)" value={ytdNet.toLocaleString()} icon={Wallet} tone="success" hint={`Gross ${ytdGross.toLocaleString()}`} /></StaggerItem>
          </Stagger>

          <Reveal delay={0.05}>
            <Card className="p-4">
              <div className="space-y-2">
                {results.map(r => (
                  <div key={r.id} className="flex items-center gap-4 rounded-lg border border-border p-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold text-foreground">{periodLabel(r.run_id)}</div>
                      <div className="text-xs text-muted-foreground">
                        Net {r.net_pay == null ? '—' : r.net_pay.toLocaleString()} · Gross {r.gross_pay == null ? '—' : r.gross_pay.toLocaleString()}
                      </div>
                    </div>
                    <Badge variant="success">Finalized</Badge>
                    <div className="flex items-center gap-2">
                      <Button variant="outline" size="sm" onClick={() => setPreview(buildPayslipData(r, companyAddress))}><Eye className="w-3.5 h-3.5" />Preview</Button>
                      <Button size="sm" onClick={() => exportPayslipPdf(buildPayslipData(r, companyAddress))}><Download className="w-3.5 h-3.5" />PDF</Button>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </Reveal>
        </>
      )}

      <Dialog open={!!preview} onOpenChange={v => !v && setPreview(null)}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          {preview && (
            <>
              <DialogHeader>
                <DialogTitle>{preview.periodLabel}</DialogTitle>
                <DialogDescription>{preview.companyName} · {preview.employeeName}</DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <PayslipSection title="Pay & Time" rows={preview.topRows} />
                <PayslipSection title="Allowances" rows={preview.allowanceRows} />
                <PayslipSection title="Deductions" rows={preview.deductionRows} />
                <PayslipSection title="Employer's Contribution" rows={preview.employerRows} />
                <div className="rounded-lg border border-border p-3 space-y-1 text-sm">
                  <div className="flex justify-between"><span className="text-muted-foreground">Gross Pay</span><span>{preview.grossPay == null ? '—' : preview.grossPay.toLocaleString()}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Total Deductions</span><span>{preview.totalDeductions == null ? '—' : preview.totalDeductions.toLocaleString()}</span></div>
                  <div className="flex justify-between font-semibold"><span>Net Pay</span><span>{preview.netPay == null ? '—' : preview.netPay.toLocaleString()}</span></div>
                </div>
                <Button className="w-full" onClick={() => exportPayslipPdf(preview)}><Download className="w-4 h-4" />Download PDF</Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </PageTransition>
  );
}

function PayslipSection({ title, rows }: { title: string; rows: PayslipData['topRows'] }) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{title}</div>
      {rows.map((r, i) => (
        <div key={i} className={`flex justify-between text-sm ${r.bold ? 'font-semibold' : ''}`}>
          <span className="text-foreground">{r.label}</span>
          <span>{r.value}</span>
        </div>
      ))}
    </div>
  );
}

function periodLabel(runId: string | undefined): string {
  if (!runId) return '';
  const m = runId.match(/_(\d{4})_(\d{2})$/);
  if (!m) return runId;
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${months[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}
