// Staff loan/advance engine. Balances are ONLY ever decremented by the Finalize API route
// (src/app/api/payroll/runs/[runId]/finalize/route.ts) — never here, and never by Generate/
// Recalculate — so re-generating a draft run stays non-destructive. See the calculation
// engine for how each active loan's intended per-run deduction is computed.

import { collection, doc, getDoc, getDocs, setDoc, updateDoc, query, where, Timestamp } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import type { PayrollLoan } from '@/lib/payrollTypes';
import { validatePayrollLoan } from '@/lib/payrollValidation';
import { writePayrollAudit } from '@/services/payrollAuditService';

const COL = 'payroll_loans';

export async function getLoansForCompany(companyId: string): Promise<PayrollLoan[]> {
  const snap = await getDocs(query(collection(db, COL), where('company_id', '==', companyId)));
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() } as PayrollLoan))
    .sort((a, b) => a.employee_name.localeCompare(b.employee_name));
}

export async function getLoansForEmployee(epf: string): Promise<PayrollLoan[]> {
  const snap = await getDocs(query(collection(db, COL), where('epf_number', '==', epf)));
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as PayrollLoan));
}

export async function getActiveLoansForEmployee(epf: string): Promise<PayrollLoan[]> {
  const all = await getLoansForEmployee(epf);
  return all.filter(l => l.status === 'active' && l.current_balance > 0);
}

/** `payload.current_balance` is the starting balance — normally equal to `full_amount` for a
 *  brand-new loan, but settable lower when onboarding a pre-existing loan the employee has
 *  already been partly paying off outside this system. */
export async function createLoan(
  payload: Omit<PayrollLoan, 'id' | 'status' | 'created_at' | 'updated_at'>,
  actorEpf: string, actorName: string,
): Promise<string> {
  const errors = validatePayrollLoan(payload);
  if (errors.length) throw new Error(errors[0]);

  const now = Timestamp.now();
  const ref = doc(collection(db, COL));
  const doc_: Omit<PayrollLoan, 'id'> = {
    ...payload,
    status: 'active',
    created_by_epf: actorEpf, created_by_name: actorName, created_at: now,
    updated_by_epf: actorEpf, updated_at: now,
  };
  await setDoc(ref, doc_);
  await writePayrollAudit({
    company_id: payload.company_id, action: 'LOAN_CREATED', entity_type: 'payroll_loan', entity_id: ref.id,
    epf_number: payload.epf_number, after: doc_,
    performed_by_epf: actorEpf, performed_by_name: actorName,
  });
  return ref.id;
}

export async function updateLoan(
  loanId: string,
  patch: Partial<Pick<PayrollLoan, 'monthly_deduction_amount' | 'end_month' | 'note'>>,
  actorEpf: string, actorName: string,
): Promise<void> {
  const snap = await getDoc(doc(db, COL, loanId));
  if (!snap.exists()) throw new Error('Loan not found.');
  const loan = snap.data() as PayrollLoan;
  await updateDoc(doc(db, COL, loanId), { ...patch, updated_by_epf: actorEpf, updated_at: Timestamp.now() });
  await writePayrollAudit({
    company_id: loan.company_id, action: 'LOAN_UPDATED', entity_type: 'payroll_loan', entity_id: loanId,
    epf_number: loan.epf_number, after: patch,
    performed_by_epf: actorEpf, performed_by_name: actorName,
  });
}

export async function cancelLoan(loanId: string, actorEpf: string, actorName: string): Promise<void> {
  const snap = await getDoc(doc(db, COL, loanId));
  if (!snap.exists()) throw new Error('Loan not found.');
  const loan = snap.data() as PayrollLoan;
  await updateDoc(doc(db, COL, loanId), { status: 'cancelled', updated_by_epf: actorEpf, updated_at: Timestamp.now() });
  await writePayrollAudit({
    company_id: loan.company_id, action: 'LOAN_CANCELLED', entity_type: 'payroll_loan', entity_id: loanId,
    epf_number: loan.epf_number,
    performed_by_epf: actorEpf, performed_by_name: actorName,
  });
}
