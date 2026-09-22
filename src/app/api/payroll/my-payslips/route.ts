import { NextRequest, NextResponse } from 'next/server';
import { adminDbFor } from '@/lib/firebaseAdmin';
import { verifyPayrollCaller, requirePayrollTenant } from '@/lib/payrollApiAuth';
import type { PayrollResult } from '@/lib/payrollTypes';

// POST /api/payroll/my-payslips — returns ONLY the caller's own finalized payslips.
// The caller's epf_number is resolved server-side from their verified ID token (never a
// client-supplied value), so this is the only safe way to serve "my payslips": this app has
// never minted Firebase Auth custom claims, so a Firestore security rule cannot itself scope
// payroll_results reads to "only your own" — see PAYROLL_002-006 plan §11.
export async function POST(req: NextRequest) {
  try {
    if (!requirePayrollTenant(req)) return NextResponse.json({ error: 'Payroll is not enabled for this organisation' }, { status: 404 });
    const { idToken } = await req.json();
    const db = adminDbFor(req);

    const caller = await verifyPayrollCaller(db, idToken);
    if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!caller.can_view_own_payslip) {
      return NextResponse.json({ error: 'Payslip access is not enabled for your role' }, { status: 403 });
    }

    const snap = await db.collection('payroll_results')
      .where('epf_number', '==', caller.epf_number)
      .where('run_status', '==', 'finalized')
      .get();

    const results = snap.docs
      .map(d => ({ id: d.id, ...d.data() } as PayrollResult))
      .sort((a, b) => b.id!.localeCompare(a.id!)); // run id encodes yyyy_MM — newest first

    return NextResponse.json({ success: true, results });
  } catch (e) {
    console.error('[payroll/my-payslips]', e);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
