import { NextRequest, NextResponse } from 'next/server';
import { adminDbFor } from '@/lib/firebaseAdmin';
import { verifyPayrollCaller, requirePayrollTenant } from '@/lib/payrollApiAuth';
import type { PayrollRun } from '@/lib/payrollTypes';

// POST /api/payroll/runs/[runId]/review — 'generated' → 'reviewed' only. Server-only.
export async function POST(req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  try {
    if (!requirePayrollTenant(req)) return NextResponse.json({ error: 'Payroll is not enabled for this organisation' }, { status: 404 });
    const { runId } = await params;
    const { idToken } = await req.json();
    const db = adminDbFor(req);

    const caller = await verifyPayrollCaller(db, idToken);
    if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!caller.can_review_payroll) {
      return NextResponse.json({ error: 'Payroll review access required' }, { status: 403 });
    }

    const runRef = db.collection('payroll_runs').doc(runId);
    const runSnap = await runRef.get();
    if (!runSnap.exists) return NextResponse.json({ error: 'Payroll run not found' }, { status: 404 });
    const run = runSnap.data() as PayrollRun;
    if (run.status !== 'generated') {
      return NextResponse.json({ error: `Cannot review a ${run.status} run — it must be 'generated' first.` }, { status: 400 });
    }

    const now = new Date();
    const resultsSnap = await db.collection('payroll_results').where('run_id', '==', runId).get();
    const batch = db.batch();
    resultsSnap.docs.forEach(d => batch.update(d.ref, { run_status: 'reviewed' }));
    batch.update(runRef, {
      status: 'reviewed', reviewed_at: now, reviewed_by_epf: caller.epf_number, reviewed_by_name: caller.display_name, updated_at: now,
    });
    await batch.commit();

    await db.collection('payroll_audit_logs').add({
      company_id: run.company_id, action: 'RUN_REVIEWED', entity_type: 'payroll_run', entity_id: runId,
      epf_number: null, before: { status: 'generated' }, after: { status: 'reviewed' }, reason: null,
      performed_by_epf: caller.epf_number, performed_by_name: caller.display_name, performed_at: now,
    });

    return NextResponse.json({ success: true });
  } catch (e) {
    console.error('[payroll/review]', e);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
