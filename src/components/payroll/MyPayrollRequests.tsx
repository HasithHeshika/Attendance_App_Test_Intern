'use client';
// The employee's side of salary advances and loans, shown as a card on the profile page.
// Three things live here: what they currently owe (active loans, advances still to be
// recovered), the two "ask for one" buttons, and the history of what they have asked for.
// Nothing in this file moves money — a request is a conversation with whoever manages pay
// profiles, and only their approval (on /salary-advances or /payroll-loans) records the real
// advance or loan. See payrollRequestService.ts for the rules the form repeats.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { HandCoins, Loader2, Banknote, ChevronDown, ChevronUp } from 'lucide-react';
import toast from 'react-hot-toast';
import { useT } from '@/store/appStore';
import { tenant } from '@/lib/firebase';
import type { PayrollLoan, PayrollRequest, PayrollRequestKind, PayrollSalaryAdvance } from '@/lib/payrollTypes';
import {
  validatePayrollRequest, createPayrollRequest, getMyPayrollRequests, withdrawPayrollRequest,
  type PayrollRequestInput,
} from '@/services/payrollRequestService';
import { getSalaryAdvancesForEmployee } from '@/services/payrollSalaryAdvanceService';
import { getActiveLoansForEmployee } from '@/services/payrollLoanService';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import ConfirmModal from '@/components/ConfirmModal';
import InlineError from '@/components/InlineError';

const SHOW_FIRST = 5;

interface RequestUser {
  epf_number: string;
  name: string;
  company_id?: string;
  company?: string;
}

/** 'YYYY-MM' for today plus `offset` months — the form's default periods. */
function monthFromNow(offset: number): string {
  const d = new Date();
  d.setDate(1); // avoid the 31st rolling over an extra month
  d.setMonth(d.getMonth() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function fmtDate(ts: PayrollRequest['decided_at']): string {
  const d = ts?.toDate?.();
  return d ? d.toLocaleDateString() : '';
}

export default function MyPayrollRequests({ epf, user }: { epf: string; user: RequestUser }) {
  const t = useT();
  const companyId   = user.company_id ?? '';
  const companyName = user.company ?? '';

  // null = still loading. Errors leave an empty list and a toast, never a broken card.
  const [loans, setLoans]       = useState<PayrollLoan[] | null>(null);
  const [advances, setAdvances] = useState<PayrollSalaryAdvance[] | null>(null);
  const [requests, setRequests] = useState<PayrollRequest[] | null>(null);
  const [showAll, setShowAll]   = useState(false);
  const [formKind, setFormKind] = useState<PayrollRequestKind | null>(null);
  const [toWithdraw, setToWithdraw] = useState<PayrollRequest | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);

  const load = useCallback(async () => {
    if (!epf) { setLoans([]); setAdvances([]); setRequests([]); return; }
    try {
      const [l, a, r] = await Promise.all([
        getActiveLoansForEmployee(epf),
        getSalaryAdvancesForEmployee(epf),
        getMyPayrollRequests(epf),
      ]);
      setLoans(l);
      setAdvances(a.filter((x) => x.status === 'pending'));
      setRequests(r);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not load your requests.');
      setLoans([]); setAdvances([]); setRequests([]);
    }
  }, [epf]);

  // Reads happen after mount, like the other profile cards — Firebase Auth is settled by then.
  useEffect(() => { void load(); }, [load]);

  const loading = loans === null || advances === null || requests === null;
  const loanBalance   = (loans ?? []).reduce((s, l) => s + l.current_balance, 0);
  const advanceTotal  = (advances ?? []).reduce((s, a) => s + a.amount, 0);
  const pendingKinds  = useMemo(() => new Set((requests ?? []).filter((r) => r.status === 'pending').map((r) => r.kind)), [requests]);
  const visible = showAll ? (requests ?? []) : (requests ?? []).slice(0, SHOW_FIRST);

  const canAdvance = Boolean(tenant.features.salaryAdvances);
  // Southern Lanka records loans directly on /payroll-loans (admin-only) and doesn't want
  // employees able to ask for one from their profile — the balance card above still shows an
  // existing loan either way, only the self-service "ask for one" button is tenant-gated.
  const canLoan    = Boolean(tenant.features.payrollLoans) && tenant.id !== 'southernlanka';

  const handleWithdraw = async () => {
    if (!toWithdraw?.id) return;
    setWithdrawing(true);
    try {
      await withdrawPayrollRequest(toWithdraw.id, { epf, name: user.name });
      toast.success(t.requestWithdrawnToast);
      setToWithdraw(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not withdraw the request.');
    } finally {
      setWithdrawing(false);
    }
  };

  const statusBadge = (s: PayrollRequest['status']) => {
    switch (s) {
      case 'pending':   return <Badge variant="warning">{t.statusPending}</Badge>;
      case 'approved':  return <Badge variant="success">{t.statusApproved}</Badge>;
      case 'rejected':  return <Badge variant="destructive">{t.statusRejected}</Badge>;
      case 'withdrawn': return <Badge variant="muted">{t.statusWithdrawn}</Badge>;
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-warning/10 flex items-center justify-center flex-shrink-0">
            <HandCoins className="w-4 h-4 text-warning" />
          </div>
          <div>
            <CardTitle className="text-sm">{t.payrollRequestsTitle}</CardTitle>
            <CardDescription className="text-xs">{t.payrollRequestsDesc}</CardDescription>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex justify-center py-4"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
        ) : (
          <>
            {/* ── Current standing ── hidden entirely when there is nothing owed; the buttons
                below are the point of the card, not an empty "no loans" line. */}
            {(loans!.length > 0 || advances!.length > 0) && (
              <div className="grid gap-2 sm:grid-cols-2">
                {loans!.length > 0 && (
                  <div className="rounded-lg border border-border/60 bg-card/50 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
                        {t.activeLoansLabel} · {loans!.length}
                      </div>
                      <div className="text-sm font-bold tabular-nums text-destructive">{loanBalance.toLocaleString()}</div>
                    </div>
                    <ul className="mt-2 space-y-1">
                      {loans!.map((l) => (
                        <li key={l.id} className="text-xs text-muted-foreground tabular-nums">
                          {t.balanceWord} {l.current_balance.toLocaleString()} / {l.full_amount.toLocaleString()}
                          {' · '}{l.monthly_deduction_amount.toLocaleString()} {t.monthlyWord}
                          {' · '}<span className="whitespace-nowrap">→ {l.end_month}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {advances!.length > 0 && (
                  <div className="rounded-lg border border-border/60 bg-card/50 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
                        {t.pendingAdvancesLabel} · {advances!.length}
                      </div>
                      <div className="text-sm font-bold tabular-nums text-destructive">{advanceTotal.toLocaleString()}</div>
                    </div>
                    <ul className="mt-2 space-y-1">
                      {advances!.map((a) => (
                        <li key={a.id} className="text-xs text-muted-foreground tabular-nums">
                          {a.amount.toLocaleString()} · {a.period}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {/* ── Ask for one ── */}
            {!companyId ? (
              // No key for this — see the report. validatePayrollRequest refuses without a
              // company anyway, so a form here would only ever fail.
              <p className="text-xs text-muted-foreground">Your profile has no company yet.</p>
            ) : (
              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                {canAdvance && (
                  <div className="flex flex-col gap-1">
                    <Button type="button" variant="outline" className="w-full sm:w-auto"
                      disabled={pendingKinds.has('advance')} onClick={() => setFormKind('advance')}>
                      <HandCoins className="w-4 h-4" /> {t.requestAdvanceWord}
                    </Button>
                    {pendingKinds.has('advance') && <span className="text-[11px] text-muted-foreground">{t.advanceWord}: {t.statusPending}</span>}
                  </div>
                )}
                {canLoan && (
                  <div className="flex flex-col gap-1">
                    <Button type="button" variant="outline" className="w-full sm:w-auto"
                      disabled={pendingKinds.has('loan')} onClick={() => setFormKind('loan')}>
                      <Banknote className="w-4 h-4" /> {t.requestLoanWord}
                    </Button>
                    {pendingKinds.has('loan') && <span className="text-[11px] text-muted-foreground">{t.loanWord}: {t.statusPending}</span>}
                  </div>
                )}
              </div>
            )}

            {/* ── My requests ── */}
            {requests!.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t.noPayrollRequestsYet}</p>
            ) : (
              <div className="space-y-2">
                {visible.map((r) => (
                  <div key={r.id} className="rounded-lg border border-border/60 bg-card/50 p-3 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">{r.kind === 'advance' ? t.advanceWord : t.loanWord}</Badge>
                      <span className="text-sm font-bold tabular-nums text-foreground">{r.amount.toLocaleString()}</span>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {r.period}{r.kind === 'loan' && r.repay_months ? ` · ${r.repay_months} ${t.monthsWord}` : ''}
                      </span>
                      <span className="ml-auto">{statusBadge(r.status)}</span>
                    </div>
                    <div className="rounded-md bg-muted/50 px-2.5 py-1.5 text-xs text-foreground/90 whitespace-pre-wrap">{r.reason}</div>
                    {r.decision_note && (
                      <div className="rounded-md bg-muted/50 px-2.5 py-1.5 text-xs text-muted-foreground whitespace-pre-wrap">{r.decision_note}</div>
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                      {r.decided_by_name && (
                        <span className="text-[11px] text-muted-foreground">
                          {r.decided_by_name}{r.decided_at ? ` · ${fmtDate(r.decided_at)}` : ''}
                        </span>
                      )}
                      {r.status === 'pending' && (
                        <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={() => setToWithdraw(r)}>
                          {t.withdrawWord}
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
                {requests!.length > SHOW_FIRST && (
                  <Button type="button" variant="ghost" size="sm" className="w-full" onClick={() => setShowAll((v) => !v)}>
                    {showAll ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    {showAll ? t.showFewerWord : `${t.showAllWord} (${requests!.length})`}
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>

      {formKind && (
        <RequestDialog
          kind={formKind}
          epf={epf}
          user={user}
          companyId={companyId}
          companyName={companyName}
          onClose={() => setFormKind(null)}
          onSent={async () => { setFormKind(null); await load(); }}
        />
      )}

      <ConfirmModal
        open={toWithdraw !== null}
        onOpenChange={(o) => { if (!o) setToWithdraw(null); }}
        onConfirm={handleWithdraw}
        busy={withdrawing}
        variant="warning"
        title={`${t.withdrawWord}?`}
        description={toWithdraw ? `${toWithdraw.kind === 'advance' ? t.advanceWord : t.loanWord} · ${toWithdraw.amount.toLocaleString()} · ${toWithdraw.period}` : undefined}
        confirmText={t.withdrawWord}
        cancelText={t.cancel}
      />
    </Card>
  );
}

// ─── The form ──────────────────────────────────────────────────────────────────────────
// One dialog for both kinds; the loan variant adds "repay over N months" and a rough
// per-month figure. Validation is validatePayrollRequest, the same function the service runs
// before saving, so what the user sees inline is exactly what would be refused.

function RequestDialog({ kind, epf, user, companyId, companyName, onClose, onSent }: {
  kind: PayrollRequestKind;
  epf: string;
  user: RequestUser;
  companyId: string;
  companyName: string;
  onClose: () => void;
  onSent: () => Promise<void>;
}) {
  const t = useT();
  const isLoan = kind === 'loan';
  const [amount, setAmount] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  // Advance: recovered this month. Loan: deductions start next month, the first cycle the
  // approver could realistically add it to.
  const [period, setPeriod] = useState(monthFromNow(isLoan ? 1 : 0));
  const [repayMonths, setRepayMonths] = useState<number | null>(6);
  const [touched, setTouched] = useState(false);
  const [sending, setSending] = useState(false);

  const input: PayrollRequestInput = {
    kind, company_id: companyId, company_name: companyName,
    epf_number: epf, employee_name: user.name,
    amount: amount ?? 0, reason, period,
    repay_months: isLoan ? repayMonths : null,
  };
  const errors = validatePayrollRequest(input);
  const valid = errors.length === 0;
  const perMonth = isLoan && amount && repayMonths && repayMonths > 0 ? Math.ceil(amount / repayMonths) : null;

  const submit = async () => {
    setTouched(true);
    if (!valid) return;
    setSending(true);
    try {
      await createPayrollRequest(input, { epf, name: user.name });
      toast.success(t.requestSentToast);
      await onSent();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not send the request.');
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !sending) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isLoan ? t.requestLoanWord : t.requestAdvanceWord}</DialogTitle>
          <DialogDescription>{isLoan ? t.loanRepayHint : t.advanceRepayHint}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">{t.amountWord}</Label>
            <Input type="number" min={1} inputMode="decimal" placeholder="0" value={amount ?? ''}
              onChange={(e) => { setTouched(true); setAmount(e.target.value === '' ? null : +e.target.value); }} />
          </div>

          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">{t.reasonWord}</Label>
            <Textarea rows={3} placeholder={t.requestReasonPlaceholder} value={reason}
              onChange={(e) => { setTouched(true); setReason(e.target.value); }} />
          </div>

          <div className={isLoan ? 'grid grid-cols-1 sm:grid-cols-2 gap-3' : 'w-full'}>
            <div className="space-y-1 min-w-0">
              <Label className="text-[11px] text-muted-foreground">{isLoan ? t.startFromMonthLabel : t.recoverInMonthLabel}</Label>
              {/* min-w-0 alongside the Input's own w-full — a native month/date control's
                  calendar-icon chrome can force intrinsic width past 100% of its container
                  without it, which is exactly what let this field alone (advance's wrapper
                  carried no width class at all) protrude past Amount/Reason on mobile. Stacked
                  to one column below sm: too — even with min-w-0, two columns this narrow
                  (inside a modal, not the full viewport) left Repay over squeezed against the
                  month picker's own calendar-icon chrome. */}
              <Input type="month" className="w-full min-w-0" value={period} onChange={(e) => { setTouched(true); setPeriod(e.target.value); }} />
            </div>
            {isLoan && (
              <div className="space-y-1 min-w-0">
                <Label className="text-[11px] text-muted-foreground">{t.repayOverLabel}</Label>
                <div className="flex items-center gap-2">
                  <Input type="number" min={1} max={60} step={1} className="min-w-0" value={repayMonths ?? ''}
                    onChange={(e) => { setTouched(true); setRepayMonths(e.target.value === '' ? null : Math.trunc(+e.target.value)); }} />
                  <span className="text-xs text-muted-foreground whitespace-nowrap">{t.monthsWord}</span>
                </div>
              </div>
            )}
          </div>

          {isLoan && perMonth !== null && (
            <p className="text-xs text-muted-foreground tabular-nums">≈ {perMonth.toLocaleString()} {t.perMonthWord}</p>
          )}

          {touched && <InlineError>{errors[0]}</InlineError>}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={sending}>{t.cancel}</Button>
          <Button type="button" onClick={submit} disabled={!valid || sending}>
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <HandCoins className="w-4 h-4" />}
            {t.sendRequestWord}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
