// Payroll settings — TENANT-WIDE: one fixed settings doc (monthly target hours, EPF/ETF
// rates, tax slabs) plus a separate components collection (individually named
// allowances/deductions with per-component EPF/ETF/tax flags). Neither is scoped to any one
// company/branch — every company shares the same settings and component list. No seed/
// catalogue code — components are created one at a time from the Settings UI.

import {
  collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, Timestamp,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import type { PayrollSettings, PayrollComponent, PayrollTaxSlab } from '@/lib/payrollTypes';
import { draftPayrollSettings } from '@/lib/payrollTypes';
import { validatePayrollComponent, validatePayrollSettings } from '@/lib/payrollValidation';
import { writePayrollAudit } from '@/services/payrollAuditService';

const SETTINGS_COL = 'payroll_settings';
const COMPONENTS_COL = 'payroll_components';

// Fixed doc id — there is only ever one PayrollSettings document for the whole tenant.
// Mirrored (not imported — this file uses the client Firestore SDK, unsafe to pull into an
// Admin-SDK API route) as a plain string literal in generate/route.ts.
export const PAYROLL_SETTINGS_DOC_ID = 'global';

// Every payroll_audit_logs entry requires a company_id for its existing per-company filter
// views; settings/component changes aren't scoped to one, so they're tagged with this fixed
// sentinel instead of a real company id.
const GLOBAL_AUDIT_COMPANY_ID = 'global';

export async function getPayrollSettings(): Promise<PayrollSettings | null> {
  const snap = await getDoc(doc(db, SETTINGS_COL, PAYROLL_SETTINGS_DOC_ID));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() } as PayrollSettings;
}

/** Returns the existing settings doc, or creates a fresh one (all rates unconfigured
 *  except EPF/ETF pre-filled 8/12/3 — real, stable statutory defaults, still editable). */
export async function getOrCreatePayrollSettings(): Promise<PayrollSettings> {
  const existing = await getPayrollSettings();
  if (existing) return existing;
  const draft = draftPayrollSettings();
  await setDoc(doc(db, SETTINGS_COL, PAYROLL_SETTINGS_DOC_ID), draft as PayrollSettings);
  return { id: PAYROLL_SETTINGS_DOC_ID, ...draft };
}

export async function updatePayrollSettings(
  patch: Partial<Pick<PayrollSettings,
    'default_target_hours' | 'default_hours_per_day' | 'ph_day_multiplier' | 'ph_day_rate_divisor' | 'ph_overtime_multiplier'
    | 'poya_day_multiplier' | 'poya_day_rate_divisor' | 'poya_overtime_multiplier'
    | 'mercantile_day_multiplier' | 'mercantile_day_rate_divisor' | 'mercantile_overtime_multiplier'
    | 'epf_employee_rate' | 'epf_employer_rate' | 'etf_employer_rate' | 'stamp_duty_amount' | 'tax_slabs'>>,
  actorEpf: string, actorName: string,
): Promise<void> {
  // Range + non-negative enforcement for every scalar rate/hours field plus the tax slabs —
  // same rules the Settings form applies live (see @/lib/payrollValidation), re-checked here
  // so a corrupt value can never reach the payroll engine even via a direct call.
  const errors = validatePayrollSettings(patch);
  if (errors.length) throw new Error(errors[0]);

  await updateDoc(doc(db, SETTINGS_COL, PAYROLL_SETTINGS_DOC_ID), {
    ...patch,
    updated_by_epf: actorEpf, updated_by_name: actorName, updated_at: Timestamp.now(),
  });
  await writePayrollAudit({
    company_id: GLOBAL_AUDIT_COMPANY_ID, action: 'SETTINGS_UPDATED', entity_type: 'payroll_settings', entity_id: PAYROLL_SETTINGS_DOC_ID,
    after: patch, performed_by_epf: actorEpf, performed_by_name: actorName,
  });
}

export function normalizedTaxSlabs(slabs: PayrollTaxSlab[]): PayrollTaxSlab[] {
  return [...slabs].sort((a, b) => a.from - b.from);
}

// ─── Components (tenant-wide — NOT scoped to any one company) ─────────────────────────

function componentsCol() {
  return collection(db, COMPONENTS_COL);
}

export async function getPayrollComponents(): Promise<PayrollComponent[]> {
  const snap = await getDocs(componentsCol());
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() } as PayrollComponent))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function getActivePayrollComponents(type?: 'allowance' | 'deduction'): Promise<PayrollComponent[]> {
  const all = await getPayrollComponents();
  return all.filter(c => c.is_active && (!type || c.type === type));
}

export async function createPayrollComponent(
  payload: Omit<PayrollComponent, 'id' | 'created_at' | 'updated_at'>,
  actorEpf: string, actorName: string,
): Promise<string> {
  const existing = await getPayrollComponents();
  const errors = validatePayrollComponent(payload, existing);
  if (errors.length) throw new Error(errors[0]);

  const now = Timestamp.now();
  const ref = doc(componentsCol());
  await setDoc(ref, { ...payload, created_by_epf: actorEpf, created_at: now, updated_by_epf: actorEpf, updated_at: now });
  await writePayrollAudit({
    company_id: GLOBAL_AUDIT_COMPANY_ID, action: 'COMPONENT_CREATED', entity_type: 'payroll_component', entity_id: ref.id,
    after: payload, performed_by_epf: actorEpf, performed_by_name: actorName,
  });
  return ref.id;
}

export async function updatePayrollComponent(
  componentId: string,
  patch: Partial<Pick<PayrollComponent, 'name' | 'type' | 'default_amount' | 'isEpfApplicable' | 'isEtfApplicable' | 'isTaxApplicable' | 'is_active'>>,
  actorEpf: string, actorName: string,
): Promise<void> {
  if (patch.name != null) {
    const trimmed = patch.name.trim();
    if (!trimmed) throw new Error('Component name is required.');
    const existing = await getPayrollComponents();
    if (existing.some(c => c.id !== componentId && c.name.trim().toLowerCase() === trimmed.toLowerCase())) {
      throw new Error(`A component named "${trimmed}" already exists — choose a different name.`);
    }
  }
  if (patch.default_amount != null && patch.default_amount < 0) {
    throw new Error('Default amount cannot be negative.');
  }
  await updateDoc(doc(componentsCol(), componentId), {
    ...patch, updated_by_epf: actorEpf, updated_at: Timestamp.now(),
  });
  await writePayrollAudit({
    company_id: GLOBAL_AUDIT_COMPANY_ID, action: 'COMPONENT_UPDATED', entity_type: 'payroll_component', entity_id: componentId,
    after: patch, performed_by_epf: actorEpf, performed_by_name: actorName,
  });
}

/**
 * Hard delete — components are the one payroll config collection where this is allowed
 * (see firestore.rules). Any employee/monthly-entry row still referencing this component
 * id keeps working: the calculation engine treats an unresolved component_id as an
 * info-level warning (its raw id is shown as the name) rather than failing, so an existing
 * reference degrades gracefully instead of breaking a run. Deleting a component removes it
 * for EVERY company, since it was never company-specific.
 */
export async function deletePayrollComponent(componentId: string, actorEpf: string, actorName: string): Promise<void> {
  await deleteDoc(doc(componentsCol(), componentId));
  await writePayrollAudit({
    company_id: GLOBAL_AUDIT_COMPANY_ID, action: 'COMPONENT_DELETED', entity_type: 'payroll_component', entity_id: componentId,
    performed_by_epf: actorEpf, performed_by_name: actorName,
  });
}

/** Look up a subset of components by id (e.g. to resolve the components referenced by an
 *  employee's recurring lines) without a second round-trip per id. */
export async function getComponentsByIds(ids: string[]): Promise<Map<string, PayrollComponent>> {
  const all = await getPayrollComponents();
  const set = new Set(ids);
  return new Map(all.filter(c => set.has(c.id as string)).map(c => [c.id as string, c]));
}
