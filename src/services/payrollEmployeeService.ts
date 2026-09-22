// Payroll employee profiles — a single flat doc per employee (NOT effective-dated history).
// Basic Salary and every other field here is editable only from this page; the Monthly Run
// Bulk Sheet locks Basic Salary and only accepts this-month figures (OT hours, no-pay).

import { collection, doc, getDoc, getDocs, setDoc, updateDoc, query, where, writeBatch, Timestamp } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import type { PayrollEmployee, PayrollEmployeeComponentLine } from '@/lib/payrollTypes';
import { validatePayrollEmployee } from '@/lib/payrollValidation';
import { epfDocId } from '@/services/userService';
import { writePayrollAudit } from '@/services/payrollAuditService';

const COL = 'payroll_employees';

export async function getPayrollEmployee(epf: string): Promise<PayrollEmployee | null> {
  const snap = await getDoc(doc(db, COL, epfDocId(epf)));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() } as PayrollEmployee;
}

export async function getPayrollEmployeesForCompany(companyId: string): Promise<PayrollEmployee[]> {
  const snap = await getDocs(query(collection(db, COL), where('company_id', '==', companyId)));
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() } as PayrollEmployee))
    .sort((a, b) => a.employee_name.localeCompare(b.employee_name));
}

export async function getActivePayrollEmployees(companyId: string): Promise<PayrollEmployee[]> {
  const all = await getPayrollEmployeesForCompany(companyId);
  return all.filter(e => e.is_active);
}

/** Create or fully replace this employee's profile (there is only ever one doc per
 *  employee — no effective-dated history in this schema). */
export async function savePayrollEmployee(
  payload: Omit<PayrollEmployee, 'id' | 'created_at' | 'updated_at'>,
  actorEpf: string, actorName: string,
  opts: { knownComponentIds?: Set<string> } = {},
): Promise<void> {
  const errors = validatePayrollEmployee(payload, opts);
  if (errors.length) throw new Error(errors[0]);

  const id = epfDocId(payload.epf_number);
  const ref = doc(db, COL, id);
  const existing = await getDoc(ref);
  const now = Timestamp.now();

  if (existing.exists()) {
    await updateDoc(ref, { ...payload, updated_by_epf: actorEpf, updated_at: now });
    await writePayrollAudit({
      company_id: payload.company_id, action: 'EMPLOYEE_UPDATED', entity_type: 'payroll_employee', entity_id: id,
      epf_number: payload.epf_number, after: payload,
      performed_by_epf: actorEpf, performed_by_name: actorName,
    });
  } else {
    await setDoc(ref, { ...payload, created_by_epf: actorEpf, created_at: now, updated_by_epf: actorEpf, updated_at: now });
    await writePayrollAudit({
      company_id: payload.company_id, action: 'EMPLOYEE_CREATED', entity_type: 'payroll_employee', entity_id: id,
      epf_number: payload.epf_number, after: payload,
      performed_by_epf: actorEpf, performed_by_name: actorName,
    });
  }
}

export async function setPayrollEmployeeActive(epf: string, isActive: boolean, actorEpf: string): Promise<void> {
  await updateDoc(doc(db, COL, epfDocId(epf)), { is_active: isActive, updated_by_epf: actorEpf, updated_at: Timestamp.now() });
}

/** The Step B "baseline values" applied identically to every employee in a bulk-add batch —
 *  everything a profile needs EXCEPT identity (epf/name, filled in per employee) and
 *  bank details/tax override (left blank — genuinely per-person, never a sensible shared
 *  default). */
export interface PayrollBulkDefaults {
  basic_salary: number;
  is_epf_applicable: boolean;
  is_etf_applicable: boolean;
  is_tax_applicable: boolean;
  target_hours_override: number | null;
  hours_per_day: number | null;
  ot_multiplier_normal: number;
  ot_multiplier_double: number;
  allowances: PayrollEmployeeComponentLine[];
  deductions: PayrollEmployeeComponentLine[];
}

/** Merges baseline component lines onto an existing profile's list: a component already
 *  present keeps its position but takes the new amount (replace), anything not already
 *  there gets appended — so re-running a bulk overwrite never wipes out an allowance/
 *  deduction an employee had individually, that just isn't part of this baseline. */
function mergeComponentLines(
  existing: PayrollEmployeeComponentLine[],
  incoming: PayrollEmployeeComponentLine[],
): PayrollEmployeeComponentLine[] {
  const merged = existing.map(l => ({ ...l }));
  for (const inc of incoming) {
    const idx = merged.findIndex(l => l.component_id === inc.component_id);
    if (idx >= 0) merged[idx] = { ...merged[idx], amount: inc.amount };
    else merged.push({ ...inc });
  }
  return merged;
}

/**
 * Bulk-creates (and optionally overwrites) profiles — Basic Salary, statutory flags, target
 * hours, OT multipliers, tax status, and any common recurring allowances/deductions — for
 * each given employee, all from one shared `defaults` baseline. Backs the Bulk Add wizard's
 * Step B.
 *
 * By default (`overwriteExisting` false/omitted) anyone who already has a profile is
 * silently skipped and counted, so this is safe to run repeatedly (e.g. add a department,
 * then separately bulk-add a few more people). With `overwriteExisting: true`, an existing
 * profile's baseline fields (Basic Salary, Target Hours override, Hours per Day override,
 * statutory flags, tax status, OT multipliers) are replaced outright, while its
 * allowances/deductions are MERGED
 * with the new baseline lines (see mergeComponentLines) rather than replaced wholesale, so an
 * individually-added component that isn't part of this baseline survives the overwrite.
 * Bank details and any per-employee tax override are never touched by a bulk run — genuinely
 * per-person, no sensible shared default. Newly-created profiles get fresh array copies
 * (never a shared object reference) so each doc's later independent edits can't alias another.
 */
export async function createBulkPayrollEmployees(
  companyId: string, companyName: string,
  employees: { epf_number: string; employee_name: string }[],
  defaults: PayrollBulkDefaults,
  actorEpf: string, actorName: string,
  opts: { overwriteExisting?: boolean } = {},
): Promise<{ created: number; updated: number; skipped: number }> {
  // Re-enforce the baseline range/non-negative rules on the write path — the wizard's
  // "Next" step also checks, but a direct call must not be able to seed corrupt values.
  const defaultsErrors = validatePayrollEmployee(
    { company_id: companyId, epf_number: employees[0]?.epf_number ?? 'x', ot_rate_mode: 'DERIVED', ot_fixed_hourly_rate: null, ...defaults },
  );
  if (defaultsErrors.length) throw new Error(defaultsErrors[0]);

  const existing = await getPayrollEmployeesForCompany(companyId);
  const existingByEpf = new Map(existing.map(e => [e.epf_number, e]));

  const batch = writeBatch(db);
  const now = Timestamp.now();
  const createdEpfs: string[] = [];
  const updatedEpfs: string[] = [];
  let skipped = 0;

  for (const emp of employees) {
    const current = existingByEpf.get(emp.epf_number);
    const ref = doc(db, COL, epfDocId(emp.epf_number));

    if (!current) {
      const payload: Omit<PayrollEmployee, 'id'> = {
        company_id: companyId,
        company_name: companyName,
        epf_number: emp.epf_number,
        employee_name: emp.employee_name,
        basic_salary: defaults.basic_salary,
        is_epf_applicable: defaults.is_epf_applicable,
        is_etf_applicable: defaults.is_etf_applicable,
        is_tax_applicable: defaults.is_tax_applicable,
        tax_override_amount: null,
        target_hours_override: defaults.target_hours_override,
        hours_per_day: defaults.hours_per_day,
        ot_multiplier_normal: defaults.ot_multiplier_normal,
        ot_multiplier_double: defaults.ot_multiplier_double,
        ot_rate_mode: 'DERIVED',
        ot_fixed_hourly_rate: null,
        allowances: defaults.allowances.map(a => ({ ...a })),
        deductions: defaults.deductions.map(d => ({ ...d })),
        bank_name: null,
        bank_branch: null,
        account_number: null,
        is_active: true,
        created_by_epf: actorEpf,
        created_at: now,
        updated_by_epf: actorEpf,
        updated_at: now,
      };
      batch.set(ref, payload);
      createdEpfs.push(emp.epf_number);
      continue;
    }

    if (!opts.overwriteExisting) { skipped++; continue; }

    const patch: Partial<PayrollEmployee> = {
      basic_salary: defaults.basic_salary,
      is_epf_applicable: defaults.is_epf_applicable,
      is_etf_applicable: defaults.is_etf_applicable,
      is_tax_applicable: defaults.is_tax_applicable,
      target_hours_override: defaults.target_hours_override,
      hours_per_day: defaults.hours_per_day,
      ot_multiplier_normal: defaults.ot_multiplier_normal,
      ot_multiplier_double: defaults.ot_multiplier_double,
      allowances: mergeComponentLines(current.allowances, defaults.allowances),
      deductions: mergeComponentLines(current.deductions, defaults.deductions),
      updated_by_epf: actorEpf,
      updated_at: now,
    };
    batch.update(ref, patch);
    updatedEpfs.push(emp.epf_number);
  }

  if (createdEpfs.length > 0 || updatedEpfs.length > 0) {
    await batch.commit();
    // One summary audit entry per outcome kind, rather than one per employee, so a bulk run
    // doesn't flood the audit trail.
    if (createdEpfs.length > 0) {
      await writePayrollAudit({
        company_id: companyId, action: 'EMPLOYEE_CREATED', entity_type: 'payroll_employee', entity_id: 'bulk',
        after: { created: createdEpfs.length, epf_numbers: createdEpfs, defaults },
        performed_by_epf: actorEpf, performed_by_name: actorName,
      });
    }
    if (updatedEpfs.length > 0) {
      await writePayrollAudit({
        company_id: companyId, action: 'EMPLOYEE_UPDATED', entity_type: 'payroll_employee', entity_id: 'bulk',
        after: { updated: updatedEpfs.length, epf_numbers: updatedEpfs, overwrite: true, defaults },
        performed_by_epf: actorEpf, performed_by_name: actorName,
      });
    }
  }
  return { created: createdEpfs.length, updated: updatedEpfs.length, skipped };
}
