import { NextRequest, NextResponse } from 'next/server';
import { adminDbFor } from '@/lib/firebaseAdmin';
import { verifyPayrollCaller, requirePayrollTenant } from '@/lib/payrollApiAuth';
import type { PayrollRun, PayrollResult, PayrollLoan } from '@/lib/payrollTypes';

// POST /api/payroll/runs/[runId]/reopen — 'finalized' → 'draft' only. Server-only, and
// gated stricter than every other transition in this workflow: system admin ONLY (not just
// can_finalize_payroll), because this is the one action that undoes what Finalize deliberately
// made irreversible for everyone else. Precisely reverses finalize/route.ts's own side
// effects — the exact inverse of each of its three moves:
//   1. Every payroll_results doc for this run goes back to run_status 'draft' — otherwise a
//      payslip Finalize made visible in My Payslips would stay visible even though the run
//      itself is no longer final.
//   2. Every loan_repayment line's amount is ADDED BACK to that loan's current_balance, and a
//      loan Finalize completed is reopened to 'active' UNLESS this run's period is at/past its
//      end_month regardless (that's a real, period-based completion, not an artifact of this
//      run). Note: if a loan's balance was clamped to 0 at Finalize (the deduction exceeded
//      what was left), this adds back the full nominal line amount, which can overshoot the
//      loan's true original balance by that clamped difference — an acceptable, documented
//      edge case for what is meant to be an exceptional admin correction, not a full
//      historical ledger.
//   3. Every salary_advance_repayment line's advance goes back to 'pending' from 'recovered'.
// Generate is fully re-runnable once the run is back in 'draft' (see generate/route.ts), so
// nothing else needs to change there — reopening just clears the gate.
export async function POST(req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  try {
    if (!requirePayrollTenant(req)) return NextResponse.json({ error: 'Payroll is not enabled for this organisation' }, { status: 404 });
    const { runId } = await params;
    const { idToken } = await req.json();
    const db = adminDbFor(req);

    const caller = await verifyPayrollCaller(db, idToken);
    if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!caller.is_system_admin) {
      return NextResponse.json({ error: 'Only a system admin can re-open a finalized payroll run.' }, { status: 403 });
    }

    const runRef = db.collection('payroll_runs').doc(runId);
    const runSnap = await runRef.get();
    if (!runSnap.exists) return NextResponse.json({ error: 'Payroll run not found' }, { status: 404 });
    const run = runSnap.data() as PayrollRun;
    if (run.status !== 'finalized') {
      return NextResponse.json({ error: `Cannot re-open a ${run.status} run — only a finalized run can be re-opened.` }, { status: 400 });
    }

    const now = new Date();
    const resultsSnap = await db.collection('payroll_results').where('run_id', '==', runId).get();
    const results = resultsSnap.docs.map(d => ({ ref: d.ref, data: d.data() as PayrollResult }));

    // Same per-loan/per-advance aggregation finalize itself used, run in reverse.
    const loanRefundTotals = new Map<string, number>();
    const advanceIdsToRestore = new Set<string>();
    for (const { data } of results) {
      for (const line of data.lines) {
        if (line.type === 'loan_repayment' && line.loan_id && line.amount != null && line.amount > 0) {
          loanRefundTotals.set(line.loan_id, (loanRefundTotals.get(line.loan_id) ?? 0) + line.amount);
        }
        if (line.type === 'salary_advance_repayment' && line.advance_id && line.amount != null && line.amount > 0) {
          advanceIdsToRestore.add(line.advance_id);
        }
      }
    }

    const loanRefs = [...loanRefundTotals.keys()].map(id => db.collection('payroll_loans').doc(id));
    const loanSnaps = loanRefs.length ? await db.getAll(...loanRefs) : [];
    const advanceRefs = [...advanceIdsToRestore].map(id => db.collection('payroll_salary_advances').doc(id));
    const advanceSnaps = advanceRefs.length ? await db.getAll(...advanceRefs) : [];

    const runPeriod = `${run.year}-${String(run.month).padStart(2, '0')}`;

    const batch = db.batch();
    results.forEach(({ ref }) => batch.update(ref, { run_status: 'draft' }));
    batch.update(runRef, {
      status: 'draft',
      // Reset all the way back — a stale reviewed_at/finalized_at hanging around on a
      // 'draft'-status run would misreport its own history. generated_at/by is left alone
      // (still accurate: it reflects when Generate last actually ran); Generate will refresh
      // it on the very next recalculation anyway.
      reviewed_at: null, reviewed_by_epf: null, reviewed_by_name: null,
      finalized_at: null, finalized_by_epf: null, finalized_by_name: null,
      updated_at: now,
    });
    let loansReopened = 0;
    loanSnaps.forEach(snap => {
      if (!snap.exists) return;
      const loan = snap.data() as PayrollLoan;
      const refund = loanRefundTotals.get(snap.id) ?? 0;
      const newBalance = loan.current_balance + refund;
      // Still genuinely complete regardless of this run (past its own end_month) — don't
      // reopen it back to active just because THIS run is being undone.
      const stillPastEndMonth = Boolean(loan.end_month) && runPeriod >= loan.end_month;
      const reopening = loan.status === 'completed' && newBalance > 0 && !stillPastEndMonth;
      if (reopening) loansReopened++;
      batch.update(snap.ref, {
        current_balance: newBalance,
        status: reopening ? 'active' : loan.status,
        updated_at: now,
      });
    });
    advanceSnaps.forEach(snap => {
      if (!snap.exists) return;
      batch.update(snap.ref, { status: 'pending', updated_at: now });
    });
    await batch.commit();

    await db.collection('payroll_audit_logs').add({
      company_id: run.company_id, action: 'RUN_REOPENED', entity_type: 'payroll_run', entity_id: runId,
      epf_number: null, before: { status: 'finalized' },
      after: {
        status: 'draft', loans_refunded: loanRefundTotals.size, loans_reopened: loansReopened,
        advances_restored: advanceSnaps.filter(s => s.exists).length,
      }, reason: null,
      performed_by_epf: caller.epf_number, performed_by_name: caller.display_name, performed_at: now,
    });

    return NextResponse.json({ success: true });
  } catch (e) {
    console.error('[payroll/reopen]', e);
    const message = e instanceof Error ? e.message : 'Internal error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
