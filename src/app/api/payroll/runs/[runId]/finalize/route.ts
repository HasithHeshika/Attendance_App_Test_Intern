import { NextRequest, NextResponse } from 'next/server';
import { adminDbFor } from '@/lib/firebaseAdmin';
import { verifyPayrollCaller, requirePayrollTenant, epfDocId } from '@/lib/payrollApiAuth';
import type { PayrollRun, PayrollResult, PayrollLoan, SuspenseSplitCharge } from '@/lib/payrollTypes';

// POST /api/payroll/runs/[runId]/finalize — 'reviewed' → 'finalized' only. Server-only.
// This is the step that makes payslips visible in My Payslips (payroll_results.run_status
// flips to 'finalized') and unlocks the bank export — and the ONLY step that ever touches a
// loan's current_balance: each result's loan_repayment lines are applied to
// payroll_loans.current_balance here, atomically, exactly once, since a finalized run can
// never be re-finalized. A loan also auto-completes here (status -> 'completed') once
// current_balance reaches 0 OR this run's period reaches/passes the loan's end_month —
// whichever comes first. It's also the ONLY step that ever flips a salary advance's status:
// every salary_advance_repayment line (always 100% of the advance, single month) flips that
// advance straight to 'recovered'. Generate/Recalculate never mutate a loan's balance or an
// advance's status (see payrollCalculationEngine.ts) so re-generating a draft run stays
// non-destructive right up to this point. A finalized run is not reopened by this build.
export async function POST(req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  try {
    if (!requirePayrollTenant(req)) return NextResponse.json({ error: 'Payroll is not enabled for this organisation' }, { status: 404 });
    const { runId } = await params;
    const { idToken } = await req.json();
    const db = adminDbFor(req);

    const caller = await verifyPayrollCaller(db, idToken);
    if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!caller.can_finalize_payroll) {
      return NextResponse.json({ error: 'Payroll finalization access required' }, { status: 403 });
    }

    const runRef = db.collection('payroll_runs').doc(runId);
    const runSnap = await runRef.get();
    if (!runSnap.exists) return NextResponse.json({ error: 'Payroll run not found' }, { status: 404 });
    const run = runSnap.data() as PayrollRun;
    if (run.status !== 'reviewed') {
      return NextResponse.json({ error: `Cannot finalize a ${run.status} run — it must be 'reviewed' first.` }, { status: 400 });
    }

    const now = new Date();
    const resultsSnap = await db.collection('payroll_results').where('run_id', '==', runId).get();
    const results = resultsSnap.docs.map(d => ({ ref: d.ref, data: d.data() as PayrollResult }));

    // Sum every loan_repayment line across all results, per loan_id — one loan doc read/
    // write per loan, not per employee. Salary advances are collected the same way, but
    // there's only ever one line per advance (single-month, 100%) so no summing is needed —
    // just the set of advance ids to flip to 'recovered'.
    const loanDeductionTotals = new Map<string, number>();
    const advanceIdsToRecover = new Set<string>();
    for (const { data } of results) {
      for (const line of data.lines) {
        if (line.type === 'loan_repayment' && line.loan_id && line.amount != null && line.amount > 0) {
          loanDeductionTotals.set(line.loan_id, (loanDeductionTotals.get(line.loan_id) ?? 0) + line.amount);
        }
        if (line.type === 'salary_advance_repayment' && line.advance_id && line.amount != null && line.amount > 0) {
          advanceIdsToRecover.add(line.advance_id);
        }
      }
    }

    // 'YYYY-MM' for this run's own period — a loan completes here once this run's period
    // reaches/passes its end_month, even if current_balance hasn't quite reached 0 (e.g. the
    // final month's deduction was edited down and left a small residual). Also names the period
    // on each suspense recovery's ledger note.
    const runPeriod = `${run.year}-${String(run.month).padStart(2, '0')}`;

    const loanRefs = [...loanDeductionTotals.keys()].map(id => db.collection('payroll_loans').doc(id));
    const loanSnaps = loanRefs.length ? await db.getAll(...loanRefs) : [];
    const advanceRefs = [...advanceIdsToRecover].map(id => db.collection('payroll_salary_advances').doc(id));
    const advanceSnaps = advanceRefs.length ? await db.getAll(...advanceRefs) : [];

    // ── Suspense split recoveries ─────────────────────────────────────────────────────────
    // Each suspense_recovery line carries the exact splits it deducted. Finalising is where that
    // money goes home: the split is stamped recovered and the PAYER's float is credited, because
    // they have been carrying it since the bill was approved. Read off the payslip rather than
    // recomputed, so a split raised after this run was generated cannot be credited to someone
    // who was never charged for it.
    const charges: SuspenseSplitCharge[] = [];
    for (const { data } of results) {
      for (const line of data.lines) {
        if (line.type === 'suspense_recovery' && line.amount != null && line.amount > 0) {
          charges.push(...(line.suspense_refs ?? []));
        }
      }
    }
    const subIds = [...new Set(charges.map(c => c.submission_id))];
    const subSnaps = subIds.length
      ? await db.getAll(...subIds.map(id => db.collection('suspense_submissions').doc(id)))
      : [];
    const subById = new Map(subSnaps.filter(s => s.exists).map(s => [s.id, s]));

    // Per submission: the splits to stamp. Per account: what to credit and the lines explaining it.
    type Credit = { epf: string; companyId: string; amount: number; note: string; subId: string };
    const creditsByAccount = new Map<string, Credit[]>();
    const stampBySubmission = new Map<string, Set<string>>();
    let skipped = 0;
    for (const c of charges) {
      const snap = subById.get(c.submission_id);
      if (!snap) { skipped++; continue; }
      const sub = snap.data() as {
        company_id: string; bill_no?: string | null;
        splits?: Array<{ epf_number: string; amount: number; recovered_at?: unknown }>;
      };
      const row = (sub.splits ?? []).find(s => s.epf_number === c.owed_by_epf);
      // Already recovered = someone marked it in the Recoveries tab between generate and now.
      // The payslip still deducted it, which is correct, but crediting the float twice is not.
      if (!row || row.recovered_at) { skipped++; continue; }
      const acct = `${epfDocId(c.payer_epf)}__${sub.company_id}`;
      const list = creditsByAccount.get(acct) ?? [];
      list.push({
        epf: c.payer_epf, companyId: sub.company_id, amount: Number(row.amount) || 0,
        note: `Split recovered through payroll ${runPeriod} · ${c.owed_by_epf}${sub.bill_no ? ` · bill ${sub.bill_no}` : ''}`,
        subId: c.submission_id,
      });
      creditsByAccount.set(acct, list);
      const stamps = stampBySubmission.get(c.submission_id) ?? new Set<string>();
      stamps.add(c.owed_by_epf);
      stampBySubmission.set(c.submission_id, stamps);
    }
    const acctSnaps = creditsByAccount.size
      ? await db.getAll(...[...creditsByAccount.keys()].map(id => db.collection('suspense_accounts').doc(id)))
      : [];
    const acctById = new Map(acctSnaps.filter(s => s.exists).map(s => [s.id, s]));

    const batch = db.batch();
    results.forEach(({ ref }) => batch.update(ref, { run_status: 'finalized' }));
    batch.update(runRef, {
      status: 'finalized', finalized_at: now, finalized_by_epf: caller.epf_number, finalized_by_name: caller.display_name, updated_at: now,
    });
    let loansCompleted = 0;
    loanSnaps.forEach(snap => {
      if (!snap.exists) return;
      const loan = snap.data() as PayrollLoan;
      const deducted = loanDeductionTotals.get(snap.id) ?? 0;
      const newBalance = Math.max(0, loan.current_balance - deducted);
      const pastEndMonth = Boolean(loan.end_month) && runPeriod >= loan.end_month;
      const completed = newBalance <= 0 || pastEndMonth;
      if (completed && loan.status === 'active') loansCompleted++;
      batch.update(snap.ref, {
        current_balance: newBalance,
        status: completed ? 'completed' : loan.status,
        updated_at: now,
      });
    });
    advanceSnaps.forEach(snap => {
      if (!snap.exists) return;
      batch.update(snap.ref, { status: 'recovered', updated_at: now });
    });

    // Credit each payer's float and post a ledger line per split. balance_after is carried
    // forward inside the loop because several splits can land on the same account in this one
    // commit — reading acc.balance for each would write the same "after" figure repeatedly and
    // break the chain the whole suspense ledger is verified against.
    let recovered = 0, recoveredValue = 0;
    for (const [acctId, credits] of creditsByAccount) {
      const snap = acctById.get(acctId);
      // No account, or a closed one: the payslip still deducted it (right — the colleague owes
      // it) but there is nowhere to put the money back. Left unstamped so it stays outstanding
      // in the Recoveries tab rather than vanishing.
      if (!snap) { skipped += credits.length; continue; }
      const acc = snap.data() as { balance: number; is_closed?: boolean };
      if (acc.is_closed) { skipped += credits.length; continue; }
      let running = Number(acc.balance) || 0;
      for (const c of credits) {
        running = Math.round((running + c.amount) * 100) / 100;
        const ledRef = db.collection('suspense_ledger').doc();
        batch.set(ledRef, {
          id: ledRef.id, epf_number: c.epf, company_id: c.companyId, kind: 'credit',
          amount: c.amount, balance_after: running, ref_type: 'submission', ref_id: c.subId,
          note: c.note,
          actor_epf: caller.epf_number, actor_name: caller.display_name, created_at: now,
        });
        recovered++; recoveredValue += c.amount;
      }
      batch.update(snap.ref, { balance: running, updated_at: now });
    }
    // Stamp the split rows last, writing the whole array back — Firestore cannot update one
    // element of an array in place.
    for (const [subId, epfs] of stampBySubmission) {
      const snap = subById.get(subId);
      if (!snap) continue;
      const sub = snap.data() as { company_id: string; splits?: Array<Record<string, unknown>> };
      // Only stamp what actually got credited: an account that was missing or closed above was
      // counted as skipped, and its splits must stay outstanding.
      const acctId = `${epfDocId(charges.find(c => c.submission_id === subId)!.payer_epf)}__${sub.company_id}`;
      const credited = acctById.has(acctId) && !(acctById.get(acctId)!.data() as { is_closed?: boolean }).is_closed;
      if (!credited) continue;
      const splits = (sub.splits ?? []).map(s =>
        epfs.has(s.epf_number as string) && !s.recovered_at
          ? { ...s, recovered_at: now, recovered_by: caller.epf_number, recovered_by_name: caller.display_name, recovered_entry_id: null }
          : s);
      batch.update(snap.ref, { splits, updated_at: now });
    }

    await batch.commit();

    await db.collection('payroll_audit_logs').add({
      company_id: run.company_id, action: 'RUN_FINALIZED', entity_type: 'payroll_run', entity_id: runId,
      epf_number: null, before: { status: 'reviewed' },
      after: {
        status: 'finalized', loans_deducted: loanDeductionTotals.size, loans_completed: loansCompleted,
        advances_recovered: advanceSnaps.filter(s => s.exists).length,
        suspense_splits_recovered: recovered, suspense_value_recovered: Math.round(recoveredValue * 100) / 100,
        suspense_splits_skipped: skipped,
      }, reason: null,
      performed_by_epf: caller.epf_number, performed_by_name: caller.display_name, performed_at: now,
    });

    return NextResponse.json({ success: true });
  } catch (e) {
    console.error('[payroll/finalize]', e);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
