// Pure validation helpers for the flat payroll schema. No Firestore, no React — every
// function takes plain data and returns an array of human-readable error strings (empty =
// valid), reusable from both UI forms and the service layer.

import type { PayrollComponent, PayrollEmployee, PayrollLoan, PayrollSalaryAdvance, PayrollSettings, PayrollTaxSlab } from '@/lib/payrollTypes';

// Range rules for the tenant-wide payroll rate/hours settings. A `null` value means "not
// configured yet" and is allowed; a present value must be finite and inside its bounds.
// Shared by the Settings form (live inline errors + Save gating) and updatePayrollSettings
// (server-side enforcement) so the two can never disagree.
export const PAYROLL_SETTING_RULES: Record<
  'default_target_hours' | 'default_hours_per_day'
  | 'ph_day_multiplier' | 'ph_day_rate_divisor' | 'poya_day_multiplier' | 'poya_day_rate_divisor'
  | 'mercantile_day_multiplier' | 'mercantile_day_rate_divisor'
  | 'ph_overtime_multiplier' | 'poya_overtime_multiplier' | 'mercantile_overtime_multiplier'
  | 'epf_employee_rate' | 'epf_employer_rate' | 'etf_employer_rate' | 'stamp_duty_amount',
  { min: number; max: number; label: string; unit: 'hours' | 'multiplier' | 'percent' | 'days' | 'amount' }
> = {
  default_target_hours:      { min: 1,    max: 744, label: 'Monthly Target Hours', unit: 'hours' },
  default_hours_per_day:     { min: 0.5,  max: 24,  label: 'Hours per Day', unit: 'hours' },
  ph_day_multiplier:         { min: 0,    max: 20,  label: 'PH Day Multiplier', unit: 'multiplier' },
  ph_day_rate_divisor:       { min: 1,    max: 31,  label: 'PH Day Rate Divisor', unit: 'days' },
  poya_day_multiplier:       { min: 0,    max: 20,  label: 'Poya Day Multiplier', unit: 'multiplier' },
  poya_day_rate_divisor:     { min: 1,    max: 31,  label: 'Poya Day Rate Divisor', unit: 'days' },
  mercantile_day_multiplier: { min: 0,    max: 20,  label: 'Mercantile Day Multiplier', unit: 'multiplier' },
  mercantile_day_rate_divisor: { min: 1,  max: 31,  label: 'Mercantile Day Rate Divisor', unit: 'days' },
  ph_overtime_multiplier:    { min: 0,    max: 20,  label: 'PH Overtime Multiplier', unit: 'multiplier' },
  poya_overtime_multiplier:  { min: 0,    max: 20,  label: 'Poya Overtime Multiplier', unit: 'multiplier' },
  mercantile_overtime_multiplier: { min: 0, max: 20, label: 'Mercantile Overtime Multiplier', unit: 'multiplier' },
  epf_employee_rate:         { min: 0,    max: 100, label: 'EPF Employee Rate', unit: 'percent' },
  epf_employer_rate:         { min: 0,    max: 100, label: 'EPF Employer Rate', unit: 'percent' },
  etf_employer_rate:         { min: 0,    max: 100, label: 'ETF Employer Rate', unit: 'percent' },
  stamp_duty_amount:         { min: 0,    max: 10000, label: 'Stamp Duty Amount', unit: 'amount' },
};

export type PayrollSettingKey = keyof typeof PAYROLL_SETTING_RULES;

// '' when the value is null (unconfigured — allowed) or a valid in-range number; otherwise a
// specific message. Used per-field by the form and folded into validatePayrollSettings below.
export function payrollSettingFieldError(key: PayrollSettingKey, value: number | null | undefined): string {
  if (value == null) return '';
  const rule = PAYROLL_SETTING_RULES[key];
  if (!Number.isFinite(value)) return `${rule.label}: enter a valid number.`;
  if (value < rule.min || value > rule.max) {
    return `${rule.label}: must be between ${rule.min} and ${rule.max}.`;
  }
  return '';
}

export function validatePayrollSettings(
  s: Partial<Pick<PayrollSettings, PayrollSettingKey | 'tax_slabs'>>,
): string[] {
  const errors: string[] = [];
  (Object.keys(PAYROLL_SETTING_RULES) as PayrollSettingKey[]).forEach(key => {
    if (key in s) {
      const e = payrollSettingFieldError(key, s[key] as number | null | undefined);
      if (e) errors.push(e);
    }
  });
  if (s.tax_slabs) errors.push(...validateTaxSlabs(s.tax_slabs));
  return errors;
}

export function validatePayrollComponent(
  c: Pick<PayrollComponent, 'name' | 'type'> & Partial<Pick<PayrollComponent, 'default_amount'>>,
  existing: Pick<PayrollComponent, 'id' | 'name'>[] = [],
  excludeId?: string,
): string[] {
  const errors: string[] = [];
  const name = c.name?.trim();
  if (!name) errors.push('Component name is required.');
  if (c.type !== 'allowance' && c.type !== 'deduction') errors.push('Component type must be allowance or deduction.');
  if (c.default_amount != null && c.default_amount < 0) errors.push('Default amount cannot be negative.');
  if (name && existing.some(e => e.id !== excludeId && e.name.trim().toLowerCase() === name.toLowerCase())) {
    errors.push(`A component named "${name}" already exists — choose a different name.`);
  }
  return errors;
}

export function validateTaxSlabs(slabs: PayrollTaxSlab[]): string[] {
  const errors: string[] = [];
  const seenFrom = new Set<number>();
  slabs.forEach((s, i) => {
    // Blank / non-numeric first — a NaN slips past every `< 0` / `> 100` comparison below.
    if (!Number.isFinite(s.from)) errors.push(`Slab ${i + 1}: enter a "From" value.`);
    if (!Number.isFinite(s.rate)) errors.push(`Slab ${i + 1}: enter a rate.`);
    if (s.to != null && !Number.isFinite(s.to)) errors.push(`Slab ${i + 1}: "To" is not a valid number.`);
    if (Number.isFinite(s.rate) && (s.rate < 0 || s.rate > 100)) errors.push(`Slab ${i + 1}: rate must be between 0 and 100.`);
    if (Number.isFinite(s.from) && s.from < 0) errors.push(`Slab ${i + 1}: "From" cannot be negative.`);
    if (s.to != null && Number.isFinite(s.to) && Number.isFinite(s.from) && s.to <= s.from) errors.push(`Slab ${i + 1}: "To" must be greater than "From".`);
    if (s.to == null && i !== slabs.length - 1) errors.push('Only the last tax slab may be open-ended (no "To" value).');
    // Duplicate / contiguity checks only make sense once "From" is a real number.
    if (Number.isFinite(s.from)) {
      if (seenFrom.has(s.from)) errors.push(`Slab ${i + 1}: duplicate bracket — another slab already starts at ${s.from}.`);
      seenFrom.add(s.from);
    }
    if (i > 0 && Number.isFinite(s.from)) {
      const prev = slabs[i - 1];
      if (prev.to == null) {
        errors.push(`Slab ${i}: an open-ended bracket must be the last one — slab ${i + 1} starts after it.`);
      } else if (s.from < prev.to || s.from > prev.to + 1) {
        // Accepts either convention: "From" picks up exactly where the previous "To" left
        // off (to-exclusive), or one rupee after it (the common human-readable tax-table
        // style — "up to 100,000" then "100,001 to 141,667"). Anything wider is a real gap.
        errors.push(`Slab ${i + 1}: "From" (${s.from}) must continue where slab ${i}'s "To" (${prev.to}) ends — no gap or overlap.`);
      }
    }
  });
  return errors;
}

export function validatePayrollEmployee(
  e: Pick<PayrollEmployee, 'company_id' | 'epf_number' | 'basic_salary' | 'allowances' | 'deductions' | 'target_hours_override' | 'hours_per_day' | 'ot_rate_mode' | 'ot_fixed_hourly_rate'>
    & Partial<Pick<PayrollEmployee, 'ot_multiplier_normal' | 'ot_multiplier_double' | 'tax_override_amount' | 'account_number'>>,
  opts: { knownComponentIds?: Set<string> } = {},
): string[] {
  const errors: string[] = [];
  if (!e.company_id) errors.push('Company is required.');
  if (!e.epf_number) errors.push('An employee must be selected.');
  if (!(e.basic_salary >= 0)) errors.push('Basic salary must be a non-negative number.');
  if (e.target_hours_override != null && !(e.target_hours_override > 0)) {
    errors.push('Target hours override must be a positive number.');
  }
  if (e.hours_per_day != null && !(e.hours_per_day > 0)) {
    errors.push('Hours per day override must be a positive number.');
  }
  // OT multipliers are stored non-nullable; a NaN (field cleared) or ≤ 0 is invalid.
  if (e.ot_multiplier_normal !== undefined && !(Number.isFinite(e.ot_multiplier_normal) && e.ot_multiplier_normal! > 0)) {
    errors.push('OT multiplier (1.5x bucket) must be a positive number.');
  }
  if (e.ot_multiplier_double !== undefined && !(Number.isFinite(e.ot_multiplier_double) && e.ot_multiplier_double! > 0)) {
    errors.push('OT multiplier (2.0x bucket) must be a positive number.');
  }
  if (e.tax_override_amount != null && !(Number.isFinite(e.tax_override_amount) && e.tax_override_amount >= 0)) {
    errors.push('Fixed monthly tax amount cannot be negative.');
  }
  if (e.account_number != null && e.account_number.trim() !== '' && !/^\d+$/.test(e.account_number.trim())) {
    errors.push('Account number must contain digits only.');
  }
  if (e.ot_rate_mode === 'FIXED' && !(e.ot_fixed_hourly_rate != null && e.ot_fixed_hourly_rate >= 0)) {
    errors.push('A fixed OT hourly rate is required when OT rate mode is Fixed.');
  }
  [...e.allowances, ...e.deductions].forEach(c => {
    if (!c.component_id) errors.push('Every recurring line must reference a component.');
    else if (opts.knownComponentIds && !opts.knownComponentIds.has(c.component_id)) {
      errors.push(`Unknown component "${c.component_id}" — it no longer exists in Settings.`);
    }
    if (!(c.amount >= 0)) errors.push('Component amounts must be non-negative.');
  });
  const dupe = (label: string, rows: { component_id: string }[]) => {
    const seen = new Set<string>();
    for (const r of rows) {
      if (!r.component_id) continue;
      if (seen.has(r.component_id)) { errors.push(`The same ${label} component is listed twice — combine them into one row instead.`); break; }
      seen.add(r.component_id);
    }
  };
  dupe('allowance', e.allowances);
  dupe('deduction', e.deductions);
  return errors;
}

export function validatePayrollLoan(
  l: Pick<PayrollLoan, 'company_id' | 'epf_number' | 'full_amount' | 'current_balance' | 'monthly_deduction_amount' | 'start_month' | 'end_month'>,
): string[] {
  const errors: string[] = [];
  if (!l.company_id) errors.push('Company is required.');
  if (!l.epf_number) errors.push('An employee must be selected.');
  if (!(l.full_amount > 0)) errors.push('Full loan amount must be greater than zero.');
  if (!(l.current_balance > 0)) errors.push('Current balance must be greater than zero.');
  if (l.current_balance > l.full_amount) errors.push('Current balance cannot exceed the full loan amount.');
  if (!(l.monthly_deduction_amount > 0)) errors.push('Monthly deduction amount must be greater than zero.');
  if (l.monthly_deduction_amount > l.current_balance) errors.push('Monthly deduction cannot exceed the current balance.');
  if (!/^\d{4}-\d{2}$/.test(l.start_month)) errors.push('Start month must be in YYYY-MM format.');
  if (!/^\d{4}-\d{2}$/.test(l.end_month)) errors.push('End date (target completion month) is required, in YYYY-MM format.');
  else if (l.end_month < l.start_month) errors.push('End date cannot be before the start month.');
  return errors;
}

export function validatePayrollSalaryAdvance(
  a: Pick<PayrollSalaryAdvance, 'company_id' | 'epf_number' | 'amount' | 'advance_date' | 'period'>,
): string[] {
  const errors: string[] = [];
  if (!a.company_id) errors.push('Company is required.');
  if (!a.epf_number) errors.push('An employee must be selected.');
  if (!(a.amount > 0)) errors.push('Advance amount must be greater than zero.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a.advance_date)) errors.push('Date is required.');
  if (!/^\d{4}-\d{2}$/.test(a.period)) errors.push('Recovery month is required, in YYYY-MM format.');
  return errors;
}
