// Salary advances — short-term cash advances, deliberately separate from PayrollLoan
// (payrollLoanService.ts). Always tied to exactly one payroll cycle (`period`) and always
// recovered 100% in that single month's run; status only ever flips 'pending' -> 'recovered'
// server-side, inside the Finalize API route — never here, and never by Generate/Recalculate,
// same non-destructive-until-Finalize convention as loans.

import { collection, doc, getDoc, getDocs, setDoc, updateDoc, query, where, Timestamp } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import type { PayrollSalaryAdvance } from '@/lib/payrollTypes';
import { validatePayrollSalaryAdvance } from '@/lib/payrollValidation';
import { writePayrollAudit } from '@/services/payrollAuditService';

const COL = 'payroll_salary_advances';

export async function getSalaryAdvancesForCompany(companyId: string): Promise<PayrollSalaryAdvance[]> {
  const snap = await getDocs(query(collection(db, COL), where('company_id', '==', companyId)));
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() } as PayrollSalaryAdvance))
    .sort((a, b) => a.employee_name.localeCompare(b.employee_name));
}

export async function getSalaryAdvancesForEmployee(epf: string): Promise<PayrollSalaryAdvance[]> {
  const snap = await getDocs(query(collection(db, COL), where('epf_number', '==', epf)));
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as PayrollSalaryAdvance));
}

export async function createSalaryAdvance(
  payload: Omit<PayrollSalaryAdvance, 'id' | 'status' | 'created_at' | 'updated_at'>,
  actorEpf: string, actorName: string,
): Promise<string> {
  const errors = validatePayrollSalaryAdvance(payload);
  if (errors.length) throw new Error(errors[0]);

  const now = Timestamp.now();
  const ref = doc(collection(db, COL));
  const doc_: Omit<PayrollSalaryAdvance, 'id'> = {
    ...payload,
    status: 'pending',
    created_by_epf: actorEpf, created_by_name: actorName, created_at: now,
    updated_by_epf: actorEpf, updated_at: now,
  };
  await setDoc(ref, doc_);
  await writePayrollAudit({
    company_id: payload.company_id, action: 'SALARY_ADVANCE_CREATED', entity_type: 'payroll_salary_advance', entity_id: ref.id,
    epf_number: payload.epf_number, after: doc_,
    performed_by_epf: actorEpf, performed_by_name: actorName,
  });
  return ref.id;
}

export async function updateSalaryAdvance(
  advanceId: string,
  patch: Partial<Pick<PayrollSalaryAdvance, 'amount' | 'advance_date' | 'note'>>,
  actorEpf: string, actorName: string,
): Promise<void> {
  const snap = await getDoc(doc(db, COL, advanceId));
  if (!snap.exists()) throw new Error('Salary advance not found.');
  const advance = snap.data() as PayrollSalaryAdvance;
  await updateDoc(doc(db, COL, advanceId), { ...patch, updated_by_epf: actorEpf, updated_at: Timestamp.now() });
  await writePayrollAudit({
    company_id: advance.company_id, action: 'SALARY_ADVANCE_UPDATED', entity_type: 'payroll_salary_advance', entity_id: advanceId,
    epf_number: advance.epf_number, after: patch,
    performed_by_epf: actorEpf, performed_by_name: actorName,
  });
}

export async function cancelSalaryAdvance(advanceId: string, actorEpf: string, actorName: string): Promise<void> {
  const snap = await getDoc(doc(db, COL, advanceId));
  if (!snap.exists()) throw new Error('Salary advance not found.');
  const advance = snap.data() as PayrollSalaryAdvance;
  await updateDoc(doc(db, COL, advanceId), { status: 'cancelled', updated_by_epf: actorEpf, updated_at: Timestamp.now() });
  await writePayrollAudit({
    company_id: advance.company_id, action: 'SALARY_ADVANCE_CANCELLED', entity_type: 'payroll_salary_advance', entity_id: advanceId,
    epf_number: advance.epf_number,
    performed_by_epf: actorEpf, performed_by_name: actorName,
  });
}
