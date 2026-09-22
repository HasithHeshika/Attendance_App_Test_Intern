import { NextRequest, NextResponse } from 'next/server';
import { adminDbFor, tenantForRequest } from '@/lib/firebaseAdmin';
import { verifyPayrollCaller, epfDocId, requirePayrollTenant } from '@/lib/payrollApiAuth';
import { calculatePayrollForEmployee } from '@/lib/payroll/payrollCalculationEngine';
import type {
  PayrollRun, PayrollSettings, PayrollComponent, PayrollEmployee, PayrollMonthlyEntry, PayrollLoan, PayrollSalaryAdvance,
  SuspenseSplitCharge,
} from '@/lib/payrollTypes';

// POST /api/payroll/runs/[runId]/generate — calculates and writes payroll_results for
// every Bulk Sheet row (payroll_monthly_entries) in this run. Server-only (Admin SDK):
// payroll_results has `allow write: if false` in firestore.rules for the client SDK.
// Re-runnable while the run is 'draft' or 'generated' (recalculate); blocked once
// 'reviewed'/'finalized'. Never mutates a loan's balance — see the finalize route. It DOES
// housekeep loan `status` (active -> completed) for any loan whose end_month has already
// passed for this run's period; that's a monotonic, side-effect-free flip that doesn't touch
// balance or this run's own numbers (such a loan is excluded from activeLoans regardless of
// whether the write below succeeds).
export async function POST(req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  // Unconditional entry log — fires the instant this handler is invoked, before any auth/
  // tenant/param logic runs. If this line never shows up in the server console when Generate
  // is clicked, the request isn't reaching this route at all (wrong URL, a stale/uncompiled
  // dev server, a proxy intercepting it upstream) — that rules out everything below it as the
  // cause. `params` is resolved synchronously-first (no other work before it) so the runId is
  // in the very first log line, not buried after unrelated setup.
  console.log('[payroll/generate] POST hit');
  // Declared outside the try so the catch block can still identify which run failed in the
  // logs, even if the failure happened before/while resolving it.
  let runId: string | undefined;
  try {
    ({ runId } = await params);
    console.log(`[API] Processing generate for runId: ${runId}`);
    if (!requirePayrollTenant(req)) return NextResponse.json({ error: 'Payroll is not enabled for this organisation' }, { status: 404 });
    const { idToken } = await req.json();
    const db = adminDbFor(req);

    const caller = await verifyPayrollCaller(db, idToken);
    if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!caller.can_generate_payroll) {
      return NextResponse.json({ error: 'Payroll generation access required' }, { status: 403 });
    }

    const runSnap = await db.collection('payroll_runs').doc(runId).get();
    if (!runSnap.exists) return NextResponse.json({ error: 'Payroll run not found' }, { status: 404 });
    const run = runSnap.data() as PayrollRun;
    // 'reviewed' is intentionally still re-generatable — the run only truly locks at
    // Finalize. A correction found during review shouldn't require someone to manually walk
    // the run back to 'draft' first; Recalculate just re-derives payroll_results from
    // whatever the Bulk Sheet currently says.
    if (run.status !== 'draft' && run.status !== 'generated' && run.status !== 'reviewed') {
      return NextResponse.json({ error: `Cannot generate a ${run.status} run.` }, { status: 400 });
    }
    const wasReviewed = run.status === 'reviewed';

    // Tenant-wide settings — 'global' mirrors PAYROLL_SETTINGS_DOC_ID in
    // payrollSettingsService.ts (not imported directly: that file uses the client Firestore
    // SDK, unsafe to pull into this Admin-SDK route).
    const settingsSnap = await db.collection('payroll_settings').doc('global').get();
    if (!settingsSnap.exists) return NextResponse.json({ error: 'Payroll settings have not been configured yet.' }, { status: 400 });
    const settings = { id: settingsSnap.id, ...settingsSnap.data() } as PayrollSettings;

    // 'YYYY-MM' for this run's own period — compared against each loan's end_month (so a loan
    // never gets deducted, or shown, past its target completion month, even if its `status`
    // field hasn't been flipped to 'completed' yet — that persisted flip normally happens at
    // Finalize; this is the belt-and-suspenders guard that keeps it out of THIS run either way)
    // and used to fetch exactly this month's pending salary advances.
    const runPeriod = `${run.year}-${String(run.month).padStart(2, '0')}`;

    const [componentsSnap, employeesSnap, entriesSnap, loansSnap, advancesSnap, usersSnap, shortfallSnap] = await Promise.all([
      db.collection('payroll_components').get(), // tenant-wide, not scoped to this company
      db.collection('payroll_employees').where('company_id', '==', run.company_id).get(),
      db.collection('payroll_monthly_entries').where('run_id', '==', runId).get(),
      db.collection('payroll_loans').where('company_id', '==', run.company_id).where('status', '==', 'active').get(),
      db.collection('payroll_salary_advances')
        .where('company_id', '==', run.company_id).where('status', '==', 'pending').where('period', '==', runPeriod).get(),
      // NIC / Employee No snapshot source (AppUser) and Late Time snapshot source
      // (attendance_shortfall_summary) — both fetched once for the whole company rather than
      // per employee, and both purely informational/metadata for the payslip printout.
      db.collection('users').where('company_id', '==', run.company_id).get(),
      db.collection('attendance_shortfall_summary').where('company_id', '==', run.company_id).where('period', '==', runPeriod).get(),
    ]);

    const components = new Map(componentsSnap.docs.map(d => [d.id, { id: d.id, ...d.data() } as PayrollComponent]));
    const employeesByEpf = new Map(employeesSnap.docs.map(d => {
      const e = { id: d.id, ...d.data() } as PayrollEmployee;
      return [e.epf_number, e];
    }));
    const entries = entriesSnap.docs.map(d => ({ id: d.id, ...d.data() } as PayrollMonthlyEntry));
    const usersByEpf = new Map(usersSnap.docs.map(d => {
      const u = d.data() as { epf_number?: string; nic?: string; employee_number?: string; role?: string; designation?: string; department?: string };
      return [u.epf_number as string, u];
    }));
    const shortfallByEpf = new Map(shortfallSnap.docs.map(d => {
      const s = d.data() as { epf_number: string; total_late_minutes: number; total_early_departure_minutes: number };
      return [s.epf_number, s];
    }));

    const loansByEpf = new Map<string, PayrollLoan[]>();
    const loansToAutoComplete: string[] = [];
    loansSnap.docs.forEach(d => {
      const loan = { id: d.id, ...d.data() } as PayrollLoan;
      if (loan.current_balance <= 0) return;
      if (loan.end_month && runPeriod > loan.end_month) {
        loansToAutoComplete.push(d.id);
        return;
      }
      const list = loansByEpf.get(loan.epf_number) ?? [];
      list.push(loan);
      loansByEpf.set(loan.epf_number, list);
    });

    // Already filtered to this exact period server-side (the query above), so every doc here
    // is meant for this run — no further exclusion needed, unlike loans' open-ended end_month.
    const advancesByEpf = new Map<string, PayrollSalaryAdvance[]>();
    advancesSnap.docs.forEach(d => {
      const advance = { id: d.id, ...d.data() } as PayrollSalaryAdvance;
      const list = advancesByEpf.get(advance.epf_number) ?? [];
      list.push(advance);
      advancesByEpf.set(advance.epf_number, list);
    });

    // ── Suspense expense splits ───────────────────────────────────────────────────────────
    // Bill portions a colleague charged to this employee and nobody has recovered yet. Gated on
    // the tenant FEATURE, never on a tenant id — today only Alta Vision has both suspense and
    // payroll, and a tenant that switches suspense on later should get this without a code
    // change. Everywhere else the collection is not even read.
    //
    // NOT scoped to the run's month: a split is money the payer has been carrying since the day
    // it was approved, and one that missed last month's run must not be stranded forever. The
    // split's own bill date is on the payslip line's refs if anyone needs to trace it.
    const suspenseByEpf = new Map<string, SuspenseSplitCharge[]>();
    if (tenantForRequest(req).features.suspense) {
      const splitSnap = await db.collection('suspense_submissions').where('status', '==', 'approved').get();
      for (const d of splitSnap.docs) {
        const s = d.data() as {
          deleted?: boolean; bill_no?: string | null; epf_number: string; employee_name: string;
          splits?: Array<{ epf_number: string; amount: number; recovered_at?: unknown }>;
        };
        if (s.deleted || !s.splits?.length) continue;
        for (const sp of s.splits) {
          // recovered_at set = payroll has already taken it and the float has already been
          // credited. Deducting it a second time would charge the colleague twice.
          if (sp.recovered_at || !(Number(sp.amount) > 0)) continue;
          const list = suspenseByEpf.get(sp.epf_number) ?? [];
          list.push({
            submission_id: d.id, bill_no: s.bill_no ?? null,
            owed_by_epf: sp.epf_number, payer_epf: s.epf_number, payer_name: s.employee_name,
            amount: Number(sp.amount),
          });
          suspenseByEpf.set(sp.epf_number, list);
        }
      }
    }

    if (entries.length === 0) {
      return NextResponse.json({ error: 'No employees have been loaded into this run\'s Bulk Sheet yet.' }, { status: 400 });
    }

    const skipped: string[] = [];
    // Distinct from `skipped` (no profile at all, expected/routine) — `errors` is for a row
    // that DID have a profile but blew up during calculation/write (a real bug: a malformed
    // doc, an unexpected type, etc.). One bad row must never take down everyone else's
    // Generate — each entry gets its own try/catch, and a failure here is reported back to
    // the client as structured data instead of aborting the whole request with a 500.
    const errors: { epf_number: string; message: string }[] = [];
    let generated = 0;
    const batch = db.batch();
    const now = new Date();
    // Firestore's zero-arg number fallback: a Bulk Sheet row created before one of these
    // hour/day fields existed in the schema (or edited by hand) can have it `undefined` —
    // the Admin SDK REJECTS writing `undefined` into a document field (throws synchronously
    // on batch.set/commit), which is the single most likely real cause of a raw, non-JSON 500
    // here: an exception thrown while BUILDING the batch, not while computing payroll.
    const num = (v: unknown): number => (typeof v === 'number' && !Number.isNaN(v) ? v : 0);

    for (const entry of entries) {
      const employee = employeesByEpf.get(entry.epf_number);
      if (!employee) { skipped.push(entry.epf_number); continue; }

      try {
        const result = calculatePayrollForEmployee({
          settings, components, employee, monthlyEntry: entry,
          activeLoans: loansByEpf.get(entry.epf_number) ?? [],
          activeSalaryAdvances: advancesByEpf.get(entry.epf_number) ?? [],
          suspenseSplits: suspenseByEpf.get(entry.epf_number) ?? [],
        });

        const userRecord = usersByEpf.get(entry.epf_number);
        const shortfall = shortfallByEpf.get(entry.epf_number);

        const resultDoc = {
          run_id: runId,
          company_id: run.company_id,
          company_name: run.company_name,
          epf_number: entry.epf_number,
          employee_name: entry.employee_name,
          basic_salary: typeof employee.basic_salary === 'number' ? employee.basic_salary : null,
          bank_snapshot: {
            bank_name: employee.bank_name ?? null,
            bank_branch: employee.bank_branch ?? null,
            account_number: employee.account_number ?? null,
          },
          nic_snapshot: userRecord?.nic || null,
          employee_no_snapshot: userRecord?.employee_number || null,
          // Job title for the payslip's Designation field comes from `role` (e.g. "Nurse") —
          // the free-text `designation` field on a users doc is inconsistently filled in
          // across employees (often blank), while `role` is a required, always-populated
          // field. `designation` is kept only as a defensive fallback in case `role` is ever
          // somehow missing. `department` is unaffected — it already maps straight through.
          designation_snapshot: userRecord?.role || userRecord?.designation || null,
          department_snapshot: userRecord?.department || null,
          late_minutes_snapshot: shortfall?.total_late_minutes ?? null,
          early_departure_minutes_snapshot: shortfall?.total_early_departure_minutes ?? null,
          hours_summary: {
            total_hours: num(entry.total_hours),
            normal_ph_hours: num(entry.ph_hours_normal),
            normal_poya_hours: num(entry.poya_hours_normal),
            ph_overtime_hours: num(entry.ph_hours_overtime),
            poya_overtime_hours: num(entry.poya_hours_overtime),
            ot_hours: num(entry.ot_hours_normal) + num(entry.ot_hours_double),
            ph_days: num(entry.ph_days),
            poya_days: num(entry.poya_days),
            mercantile_days: num(entry.mercantile_days),
            normal_mercantile_hours: num(entry.mercantile_hours_normal),
            mercantile_overtime_hours: num(entry.mercantile_hours_overtime),
            no_pay_days: num(entry.no_pay_days),
            no_pay_hours: num(entry.no_pay_hours),
          },
          lines: result.lines,
          target_hours_used: result.target_hours_used,
          hourly_rate_used: result.hourly_rate_used,
          gross_pay: result.gross_pay,
          epf_base: result.epf_base,
          etf_base: result.etf_base,
          taxable_base: result.taxable_base,
          apit_amount: result.apit_amount,
          total_deductions: result.total_deductions,
          net_pay: result.net_pay,
          employer_epf: result.employer_epf,
          employer_etf: result.employer_etf,
          warnings: result.warnings,
          run_status: 'generated',
          calculated_at: now,
        };
        batch.set(db.collection('payroll_results').doc(`${runId}__${epfDocId(entry.epf_number)}`), resultDoc);
        generated++;
      } catch (rowError) {
        console.error(`[payroll/generate] row failed for ${entry.epf_number} (run ${runId}):`, rowError instanceof Error ? rowError.stack : rowError);
        errors.push({ epf_number: entry.epf_number, message: rowError instanceof Error ? rowError.message : 'Unknown error calculating this row.' });
      }
    }

    batch.update(db.collection('payroll_runs').doc(runId), {
      status: 'generated',
      generated_at: now,
      generated_by_epf: caller.epf_number,
      generated_by_name: caller.display_name,
      updated_at: now,
      // Re-generating over a previously-reviewed run invalidates that review — the reviewer
      // approved the OLD numbers, not whatever the recalculation just produced. Clearing
      // these means the run correctly needs a fresh Mark Reviewed before it can be finalized.
      ...(wasReviewed ? { reviewed_at: null, reviewed_by_epf: null, reviewed_by_name: null } : {}),
    });
    // Housekeeping: persist the 'completed' flip for any loan whose end_month has already
    // passed relative to this run — it was already excluded from activeLoans above regardless
    // of whether this write happens, but persisting it keeps the Loans page/tab from showing
    // it as stuck 'active' forever with no further runs to trigger Finalize's own check.
    for (const loanId of loansToAutoComplete) {
      batch.update(db.collection('payroll_loans').doc(loanId), { status: 'completed', updated_at: now });
    }
    await batch.commit();

    await db.collection('payroll_audit_logs').add({
      company_id: run.company_id,
      action: 'RUN_GENERATED',
      entity_type: 'payroll_run',
      entity_id: runId,
      epf_number: null,
      before: null,
      after: { generated, skipped_count: skipped.length, error_count: errors.length, loans_auto_completed: loansToAutoComplete.length, advances_included: advancesSnap.size },
      reason: null,
      performed_by_epf: caller.epf_number,
      performed_by_name: caller.display_name,
      performed_at: now,
    });

    return NextResponse.json({ success: true, generated, skipped, errors });
  } catch (e) {
    // Log the full stack server-side (console.error on an Error prints .stack, but this makes
    // it explicit and includes which run failed) — this is the one place a genuinely
    // unexpected exception (not a per-row calculation error, which is caught above and never
    // reaches here) lands, so the message pinpointing WHERE it happened matters.
    console.error(`[payroll/generate] run ${runId} failed:`, e instanceof Error ? e.stack : e);
    const message = e instanceof Error ? e.message : 'Internal error';
    const stack = e instanceof Error ? e.stack : undefined;
    // Stack trace included in the response so this can be diagnosed straight from the
    // browser without shelling into server logs — safe here specifically because this route
    // is already gated behind an authenticated, can_generate_payroll-capable caller (checked
    // above), not a public endpoint. Not a pattern to copy onto a public-facing route.
    return NextResponse.json({ error: message, stack }, { status: 500 });
  }
}
