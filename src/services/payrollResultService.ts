// PAYROLL-004/005 — payroll_results reads. No write function is exposed here at all:
// results are written ONLY by the generate/review/finalize Admin-SDK API routes (see
// firestore.rules: `payroll_results` has `allow write: if false` for the client SDK).
//
// getMyPayrollResults() does NOT read payroll_results directly — this app has never minted
// Firebase Auth custom claims, so a client-side security rule cannot scope "only your own"
// results by epf_number. Instead it calls the server route, which resolves the caller's own
// epf_number from their verified ID token and queries with the Admin SDK (bypassing rules
// entirely, so the missing-claims gap doesn't matter there). See PAYROLL_002-006 plan §11.

import { collection, getDocs, query, where } from 'firebase/firestore';
import { db, auth } from '@/lib/firebase';
import type { PayrollResult } from '@/lib/payrollTypes';

const COL = 'payroll_results';

/** Admin/payroll-staff view of every result in a run (requires can_view_payroll — enforced
 *  by firestore.rules). */
export async function getResultsForRun(runId: string): Promise<PayrollResult[]> {
  const snap = await getDocs(query(collection(db, COL), where('run_id', '==', runId)));
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() } as PayrollResult))
    .sort((a, b) => a.employee_name.localeCompare(b.employee_name));
}

/** The signed-in employee's OWN finalized payslips only — via the server route, never a
 *  direct client Firestore query. */
export async function getMyPayrollResults(): Promise<PayrollResult[]> {
  const idToken = await auth.currentUser?.getIdToken();
  if (!idToken) throw new Error('Not signed in.');
  const res = await fetch('/api/payroll/my-payslips', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || 'Failed to load payslips.');
  return data.results as PayrollResult[];
}
