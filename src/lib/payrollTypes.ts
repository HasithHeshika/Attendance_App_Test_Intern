// Payroll domain types — flat, direct-input hospital payroll.
//
// Southern Lanka Hospitals tenant only (tenant.features.payroll in src/lib/tenants.ts).
// This is a from-scratch rewrite replacing the earlier policy/catalogue/pay-group engine:
// no policy versioning, no component seed/catalogue code, no pay groups, no attendance-sync
// dependency. OT hours and No-Pay are typed in directly each month (Monthly Run bulk sheet).
// Allowances/deductions are individually named "components" (Settings → Components) with
// per-component EPF/ETF/tax flags. Statutory rates and tax slabs are editable Settings
// fields — never hard-coded in calculation code, since these can change by law/budget.
//
// As throughout this codebase: `null` = "cannot be honestly computed, missing config" —
// never silently substituted with 0. `0` = genuinely, legitimately zero (e.g. not EPF
// eligible, no OT worked).
//
// Firestore collections:
//   payroll_settings/{company_id}                — PayrollSettings
//   payroll_components/{componentId}             — PayrollComponent (tenant-wide, NOT
//                                                   scoped under any one company)
//   payroll_employees/{epfDocId}                 — PayrollEmployee
//   payroll_loans/{loanId}                       — PayrollLoan (multi-month Loans)
//   payroll_salary_advances/{advanceId}          — PayrollSalaryAdvance (single-month advances)
//   payroll_requests/{requestId}                 — PayrollRequest (employee ASKING for an
//                                                   advance/loan — not yet the real record;
//                                                   see that type's own comment)
//   payroll_runs/{company_id}_{yyyy}_{MM}        — PayrollRun
//   payroll_monthly_entries/{run_id}__{epfDocId} — PayrollMonthlyEntry
//   payroll_results/{run_id}__{epfDocId}         — PayrollResult
//   payroll_audit_logs/{logId}                   — PayrollAuditLogEntry

import type { Timestamp } from 'firebase/firestore';

// ─── Settings ────────────────────────────────────────────────────────────────────────

export interface PayrollTaxSlab {
  /** Lower bound of this bracket's taxable income (LKR), inclusive — e.g. "From". */
  from: number;
  /** Upper bound of this bracket's taxable income (LKR), inclusive — e.g. "To".
   *  `null` = open-ended final bracket (everything above `from`). */
  to: number | null;
  /** Percentage rate applied to the portion of taxable income that falls within this
   *  bracket (progressive — never the whole income at one rate). */
  rate: number;
}

// Tenant-wide — ONE settings doc for the whole tenant (not per company), same as
// PayrollComponent. Every branch/company shares the same target hours, statutory rates and
// tax slabs.
export interface PayrollSettings {
  id?: string; // fixed id — see PAYROLL_SETTINGS_DOC_ID in payrollSettingsService.ts

  // Monthly hours denominator for the OT hourly-rate formula (Basic ÷ Target Hours) — the
  // single global standard used everywhere. Per-employee overridable
  // (PayrollEmployee.target_hours_override).
  default_target_hours: number | null;

  // Plain unit-conversion constant — turns a "No Pay Days" / "PH Days" / "Poya Day" count
  // into hours (days × this) so they can be priced off the same hourly rate. Not a rules
  // engine, just one number (e.g. 8).
  default_hours_per_day: number | null;

  // Public Holiday pay multiplier — same fixed-statutory-rate shape as Poya/Mercantile: it
  // applies to (basic_salary ÷ ph_day_rate_divisor below), NOT the derived hourlyRate ×
  // hoursPerDay figure (that basis was retired — see ph_day_rate_divisor's own comment).
  // Tenant-wide, not per-employee (unlike ot_multiplier_normal/double on PayrollEmployee) — a
  // statutory-style holiday premium, not a per-person negotiated OT rate.
  ph_day_multiplier: number | null;
  // Divides basic_salary into the single-day statutory rate ph_day_multiplier is applied to
  // (see above) — independent of default_target_hours/default_hours_per_day, same reasoning
  // as poya_day_rate_divisor: a change to either setting can never silently move PH Day pay.
  ph_day_rate_divisor: number | null;
  // PH Overtime Hours — hours worked BEYOND a standard day's length on a PH day, paid on top
  // of (never instead of) the flat PH Day premium above. Runs off the plain hourlyRate, NOT
  // the statutory divisor rate — same basis as poya_overtime_multiplier/
  // mercantile_overtime_multiplier.
  ph_overtime_multiplier: number | null;
  // Poya Day pay multiplier — UNLIKE ph_day_multiplier, this applies to a fixed STATUTORY
  // daily rate (basic_salary ÷ poya_day_rate_divisor below), never the derived hourlyRate ×
  // hoursPerDay figure. Sri Lankan convention pays a half day's statutory rate for working a
  // Poya day (basic ÷ 25 ÷ 2) — hence the divisor default of 25 and multiplier default of 0.5.
  poya_day_multiplier: number | null;
  // Divides basic_salary into the single-day statutory rate poya_day_multiplier is applied
  // to (see above) — independent of default_target_hours/default_hours_per_day so a change to
  // either can never silently move Poya Day pay. Editable because, like every other rate
  // here, the statutory divisor can change by law, not because it's expected to vary by
  // employee.
  poya_day_rate_divisor: number | null;
  // Symmetric with ph_overtime_multiplier — hours worked on a Poya day BEYOND a standard
  // day's length (default_hours_per_day) are their own paid line, separate from both the
  // flat Poya Day premium (poya_day_multiplier, paid once per day worked regardless of how
  // many hours that day ran) and from ordinary OT (which excludes Poya hours entirely, so
  // this is never double-paid). Unlike the flat premium, this still runs off the plain
  // hourlyRate, same basis as ph_overtime_multiplier.
  poya_overtime_multiplier: number | null;

  // Mercantile Holiday pay — a legally distinct category from Public Holiday under Sri
  // Lankan law (see ScheduleAssignment.holiday_type in src/lib/types.ts), paid the same way
  // as Poya: a fixed STATUTORY daily rate (basic_salary ÷ mercantile_day_rate_divisor),
  // never the derived hourlyRate × hoursPerDay figure. Flat day pay only — no overtime-
  // beyond-a-standard-day bucket, unlike PH/Poya (not asked for; would need its own
  // OT-request type if it ever is).
  mercantile_day_multiplier: number | null;
  mercantile_day_rate_divisor: number | null;
  // Symmetric with ph_overtime_multiplier/poya_overtime_multiplier — hours worked on a
  // Mercantile holiday BEYOND a standard day's length, paid on top of (never instead of) the
  // flat Mercantile Day premium above. Runs off the plain hourlyRate, same basis as the other
  // two overtime multipliers — NOT the mercantile_day_rate_divisor statutory rate.
  mercantile_overtime_multiplier: number | null;

  epf_employee_rate: number | null; // percentage, e.g. 8 for 8%
  epf_employer_rate: number | null; // e.g. 12
  etf_employer_rate: number | null; // e.g. 3

  // Flat Rs. amount deducted from EVERY employee's pay, no per-employee opt-out (unlike
  // is_epf_applicable etc.) — a government stamp duty, not a negotiated or conditional term.
  // Applied via a 'deduction'-type result line named 'Stamp Fee', which is what the physical
  // payslip template's own NAMED_DEDUCTIONS list already expects (see
  // payrollPayslipExport.ts) — this is a pre-existing row on the paper form that has simply
  // never had anything to populate it before now.
  stamp_duty_amount: number | null;

  // Ordered ascending by `from`, contiguous (each bracket's `from` equals the previous
  // one's `to`), last entry's `to` is null (open-ended). Progressive — each bracket taxes
  // only the slice of taxable income within it.
  tax_slabs: PayrollTaxSlab[];

  created_by_epf?: string;
  created_by_name?: string;
  created_at?: Timestamp;
  updated_by_epf?: string;
  updated_by_name?: string;
  updated_at?: Timestamp;
}

export function draftPayrollSettings(): Omit<PayrollSettings, 'id'> {
  return {
    default_target_hours: null,
    default_hours_per_day: null,
    ph_day_multiplier: 2,
    ph_day_rate_divisor: 25,
    ph_overtime_multiplier: 3,
    poya_day_multiplier: 0.5,
    poya_day_rate_divisor: 25,
    poya_overtime_multiplier: 3,
    mercantile_day_multiplier: 1,
    mercantile_day_rate_divisor: 25,
    mercantile_overtime_multiplier: 3,
    epf_employee_rate: 8,
    epf_employer_rate: 12,
    etf_employer_rate: 3,
    stamp_duty_amount: 25,
    tax_slabs: [],
  };
}

export type PayrollComponentType = 'allowance' | 'deduction';

/** A named allowance/deduction the admin defines once (e.g. "Transport Allowance",
 *  "Welfare Fee") — shared across EVERY company in the tenant, not scoped to one. Firestore
 *  doc id is a slug, not a controlled catalogue code. */
export interface PayrollComponent {
  id?: string;
  name: string;
  type: PayrollComponentType;
  // Pre-fills the amount field wherever this component is attached to an employee (single
  // profile or Bulk Add) — purely a starting point, always overridable per employee; `null`
  // means no default (pre-fills as 0), same "null = not configured" convention as elsewhere.
  default_amount: number | null;
  isEpfApplicable: boolean;
  isEtfApplicable: boolean;
  isTaxApplicable: boolean;
  is_active: boolean;
  created_by_epf?: string;
  created_at?: Timestamp;
  updated_by_epf?: string;
  updated_at?: Timestamp;
}

// ─── Employee pay profile ──────────────────────────────────────────────────────────────
// Single flat doc per employee — NOT effective-dated history. Basic Salary is locked in
// the Monthly Run sheet; it can only be changed here.

export interface PayrollEmployeeComponentLine {
  component_id: string;
  amount: number;
}

export type OtRateMode = 'DERIVED' | 'FIXED';

export interface PayrollEmployee {
  id?: string; // == epfDocId(epf_number)

  company_id: string;
  company_name: string;
  epf_number: string;
  employee_name: string; // display snapshot, refreshed on save — not re-read live

  basic_salary: number;

  is_epf_applicable: boolean;
  is_etf_applicable: boolean;
  is_tax_applicable: boolean;
  // Manually entered APIT figure that bypasses the tax-slab calculation entirely for this
  // employee when set (e.g. tax already remitted elsewhere).
  tax_override_amount: number | null;

  // OT Rules sub-tab
  target_hours_override: number | null; // null → falls back to PayrollSettings.default_target_hours
  hours_per_day: number | null; // null → falls back to PayrollSettings.default_hours_per_day (see
                                // payrollCalculationEngine.ts's No-Pay/PH/Poya daily-rate math)
  ot_multiplier_normal: number; // default 1.5
  ot_multiplier_double: number; // default 2.0
  ot_rate_mode: OtRateMode;
  ot_fixed_hourly_rate: number | null; // used only when ot_rate_mode === 'FIXED'

  allowances: PayrollEmployeeComponentLine[];
  deductions: PayrollEmployeeComponentLine[];

  // Optional — a profile can be saved without these.
  bank_name?: string | null;
  bank_branch?: string | null;
  account_number?: string | null;

  is_active: boolean;

  created_by_epf?: string;
  created_at?: Timestamp;
  updated_by_epf?: string;
  updated_at?: Timestamp;
}

export function emptyPayrollEmployee(
  companyId: string, companyName: string, epfNumber: string, employeeName: string,
): Omit<PayrollEmployee, 'id'> {
  return {
    company_id: companyId,
    company_name: companyName,
    epf_number: epfNumber,
    employee_name: employeeName,
    basic_salary: 0,
    is_epf_applicable: true,
    is_etf_applicable: true,
    is_tax_applicable: true,
    tax_override_amount: null,
    target_hours_override: null,
    hours_per_day: null,
    ot_multiplier_normal: 1.5,
    ot_multiplier_double: 2.0,
    ot_rate_mode: 'DERIVED',
    ot_fixed_hourly_rate: null,
    allowances: [],
    deductions: [],
    bank_name: null,
    bank_branch: null,
    account_number: null,
    is_active: true,
  };
}

// ─── Loans ──────────────────────────────────────────────────────────────────────────────

export type PayrollLoanStatus = 'active' | 'completed' | 'cancelled';

export interface PayrollLoan {
  id?: string;

  company_id: string;
  epf_number: string;
  employee_name: string;

  full_amount: number; // Total original loan amount
  current_balance: number; // Remaining balance still to pay. Set explicitly at creation (may
                            // be < full_amount when onboarding a pre-existing loan that's
                            // already been partly paid down elsewhere); decremented only at
                            // Finalize from then on (see payrollCalculationEngine.ts).
  monthly_deduction_amount: number;

  start_month: string; // 'YYYY-MM'
  end_month: string; // 'YYYY-MM' — mandatory target completion month. The loan auto-completes
                      // the moment a payroll run's period reaches/passes this month, or
                      // current_balance hits 0 — whichever happens first (see the generate and
                      // finalize API routes).
  status: PayrollLoanStatus;
  note?: string | null;

  created_by_epf?: string;
  created_by_name?: string;
  created_at?: Timestamp;
  updated_by_epf?: string;
  updated_at?: Timestamp;
}

// ─── Salary advances ────────────────────────────────────────────────────────────────────
// Deliberately separate from PayrollLoan — a short-term cash advance, not a multi-month
// loan. Always tied to exactly one payroll cycle (`period`) and always recovered 100% in
// that single month's run, never partially/across months like a loan's monthly_deduction.

export type SalaryAdvanceStatus = 'pending' | 'recovered' | 'cancelled';

export interface PayrollSalaryAdvance {
  id?: string;

  company_id: string;
  company_name: string;
  epf_number: string;
  employee_name: string;

  amount: number;
  advance_date: string; // 'YYYY-MM-DD' — the day the cash was actually handed over (informational only)
  period: string; // 'YYYY-MM' — the payroll cycle this MUST be fully recovered in
  status: SalaryAdvanceStatus; // 'pending' -> 'recovered' (set only by Finalize) or 'cancelled'
  note?: string | null;

  created_by_epf?: string;
  created_by_name?: string;
  created_at?: Timestamp;
  updated_by_epf?: string;
  updated_at?: Timestamp;
}

// ─── Employee requests for an advance or a loan ─────────────────────────────────────────
// Raised by the employee themselves from their profile. Nothing here touches payroll: a
// request is a conversation with whoever manages pay profiles, and only THEIR approval — which
// records a real PayrollSalaryAdvance / PayrollLoan through the existing services — puts money
// in motion. The request then carries the id of the record it became, so the two can always be
// read back together. Rejections carry a note the employee sees.

export type PayrollRequestKind   = 'advance' | 'loan';
export type PayrollRequestStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';

export interface PayrollRequest {
  id?: string;

  kind: PayrollRequestKind;
  company_id: string;
  company_name: string;
  epf_number: string;
  employee_name: string;

  amount: number;
  // What the employee asked for, in their words. Required — the approver was not there.
  reason: string;
  // Advance: the payroll cycle it would be recovered in ('YYYY-MM'). Loan: the month the
  // deductions would start ('YYYY-MM').
  period: string;
  // Loan only — how many months they would like to repay over. The approver may set the
  // actual monthly deduction and end month when recording the loan; this is the employee's
  // preference, not a term.
  repay_months?: number | null;

  status: PayrollRequestStatus;
  // Set when approved: the PayrollSalaryAdvance / PayrollLoan the approver recorded for it.
  linked_id?: string | null;
  decided_by_epf?: string | null;
  decided_by_name?: string | null;
  decided_at?: Timestamp | null;
  decision_note?: string | null;

  created_at?: Timestamp;
  updated_at?: Timestamp;
}

// ─── Payroll run ────────────────────────────────────────────────────────────────────────

export type PayrollRunStatus = 'draft' | 'generated' | 'reviewed' | 'finalized';

export interface PayrollRun {
  id?: string; // `${company_id}_${yyyy}_${MM}`

  company_id: string;
  company_name: string;
  year: number;
  month: number; // 1-based

  status: PayrollRunStatus;
  employee_count: number;

  generated_at?: Timestamp | null;
  generated_by_epf?: string | null;
  generated_by_name?: string | null;

  reviewed_at?: Timestamp | null;
  reviewed_by_epf?: string | null;
  reviewed_by_name?: string | null;

  finalized_at?: Timestamp | null;
  finalized_by_epf?: string | null;
  finalized_by_name?: string | null;

  created_by_epf?: string;
  created_at?: Timestamp;
  updated_at?: Timestamp;
}

// ─── Monthly entry (Bulk Sheet row) ──────────────────────────────────────────────────────
// Direct monthly input — replaces the old attendance-sync snapshot entirely. Directly
// editable by payroll staff on the Monthly Run page.

export interface PayrollOneOffLine {
  component_id: string;
  amount: number;
}

export interface PayrollMonthlyEntry {
  id?: string; // `${run_id}__${epfDocId}`

  run_id: string;
  company_id: string;
  epf_number: string;
  employee_name: string;

  ot_hours_normal: number; // paid at the employee's ot_multiplier_normal
  ot_hours_double: number; // paid at the employee's ot_multiplier_double
  no_pay_hours: number; // direct hours input
  no_pay_days: number; // converted via the resolved hours-per-day (see hours_per_day below), added to no_pay_hours
  // This run's one-off override of the day-length used for No-Pay/PH/Poya day-rate math —
  // null falls back to the employee profile's own hours_per_day, then
  // PayrollSettings.default_hours_per_day (see payrollCalculationEngine.ts).
  hours_per_day: number | null;

  // Southern Lanka Hospitals payslip fields (see PayrollResultHoursSummary for the printed
  // labels). "Normal" PH/Poya hours are a pure hours record — no payment line of their own
  // (the day's holiday premium is paid via ph_days/poya_days below, not per-hour). PH
  // Overtime Hours IS paid, at settings.ph_overtime_multiplier × hourly rate.
  total_hours: number; // manual entry — direct-input, not attendance-derived
  ph_hours_normal: number; // "Normal PH Hours" — informational only, no separate payment
  ph_hours_overtime: number; // "PH Overtime Hours" — paid via ph_overtime_multiplier
  ph_days: number; // "PH Days" — full public-holiday days worked, paid via ph_day_multiplier
  poya_hours_normal: number; // "Normal Poya Hours" — informational only, no separate payment
  poya_days: number; // "Poya Day" — full poya days worked, paid via poya_day_multiplier
  poya_hours_overtime: number; // "Poya Overtime Hours" — paid via poya_overtime_multiplier, symmetric with ph_hours_overtime

  // Mercantile Holiday. mercantile_days is the flat day count, paid via
  // mercantile_day_multiplier. mercantile_hours_normal/mercantile_hours_overtime mirror
  // ph_hours_normal/ph_hours_overtime — "Normal" is informational only (no payment line of
  // its own; also used to keep the ordinary OT-1.5x suggestion from double-counting a
  // mercantile day's hours), "Overtime" IS paid, via mercantile_overtime_multiplier.
  mercantile_days: number;
  mercantile_hours_normal: number;
  mercantile_hours_overtime: number;

  // ── Approved-OT sync bookkeeping (Southern Lanka) ──────────────────────────────────────
  // How many hours of the four OT fields above were contributed by APPROVED ot_requests at
  // the last "Sync Approved OT" run (see syncApprovedOtToRun in payrollRunService.ts). The
  // sync writes (newly-approved total − this value) as a delta onto the matching field, so
  // re-running is a no-op, hand edits on top survive, and a later reject/delete subtracts.
  // Absent on rows written before this shipped → read as 0 everywhere (see the calc engine's
  // and generate route's existing `?? 0` schema-drift guards).
  ot_synced_normal?: number;
  ot_synced_double?: number;
  ot_synced_ph?: number;
  ot_synced_poya?: number;
  ot_synced_mercantile?: number;
  ot_synced_at?: Timestamp | null;

  // One-off amounts for this month only (bonus, one-time deduction) — not saved to the
  // recurring employee profile.
  one_off_lines: PayrollOneOffLine[];

  // Bulk Sheet row lock — a soft, informational control (does not block Generate) so
  // payroll staff can mark a row as confirmed before running the calculation.
  locked: boolean;

  notes?: string | null;

  updated_by_epf?: string;
  updated_at?: Timestamp;
}

export function emptyMonthlyEntry(runId: string, companyId: string, epf: string, name: string): Omit<PayrollMonthlyEntry, 'id'> {
  return {
    run_id: runId,
    company_id: companyId,
    epf_number: epf,
    employee_name: name,
    ot_hours_normal: 0,
    ot_hours_double: 0,
    no_pay_hours: 0,
    no_pay_days: 0,
    hours_per_day: null,
    total_hours: 0,
    ph_hours_normal: 0,
    ph_hours_overtime: 0,
    ph_days: 0,
    poya_hours_normal: 0,
    poya_days: 0,
    poya_hours_overtime: 0,
    mercantile_days: 0,
    mercantile_hours_normal: 0,
    mercantile_hours_overtime: 0,
    ot_synced_normal: 0,
    ot_synced_double: 0,
    ot_synced_ph: 0,
    ot_synced_poya: 0,
    ot_synced_mercantile: 0,
    ot_synced_at: null,
    one_off_lines: [],
    locked: false,
    notes: null,
  };
}

// ─── Calculation result shapes ───────────────────────────────────────────────────────────

export type PayrollResultLineType =
  | 'basic' | 'allowance' | 'deduction' | 'ot_normal' | 'ot_double' | 'no_pay'
  | 'ph_overtime' | 'ph_day' | 'poya_day' | 'poya_overtime' | 'mercantile_day' | 'mercantile_overtime'
  | 'epf_employee' | 'epf_employer' | 'etf_employer' | 'apit' | 'loan_repayment' | 'salary_advance_repayment'
  // Suspense bill portions a colleague charged to this employee. Only ever present on a tenant
  // with the suspense module — see the `suspense` TenantFeatures flag.
  | 'suspense_recovery';

/** One suspense split being recovered through payroll. The payslip line carries these so
 *  finalisation returns EXACTLY what was deducted to the payer's float — recomputing the list at
 *  finalise time could pick up a split raised after the run was generated and credit money that
 *  nobody was actually charged for. */
export interface SuspenseSplitCharge {
  submission_id: string;
  bill_no:       string | null;
  /** The colleague who owes it — this payslip's employee. */
  owed_by_epf:   string;
  /** Whose float gets the money back. */
  payer_epf:     string;
  payer_name:    string;
  amount:        number;
}

export interface PayrollResultLine {
  type: PayrollResultLineType;
  code: string; // component id for allowance/deduction, loan id / advance id for repayment lines, else the type itself
  name: string;

  units: number | null; // hours/days, where applicable
  rate: number | null;
  multiplier: number | null;

  // null = not computable (missing/unconfigured input) — never silently coalesced to 0.
  amount: number | null;

  loan_id?: string | null; // set only for type === 'loan_repayment'
  advance_id?: string | null; // set only for type === 'salary_advance_repayment'
  /** Set only for type === 'suspense_recovery' — the exact splits this line deducted, so
   *  finalising the run can return them to the payers' floats and mark them recovered. */
  suspense_refs?: SuspenseSplitCharge[];
}

export type PayrollWarningSeverity = 'blocking' | 'info';

export interface PayrollCalculationWarning {
  code: string;
  message: string;
  severity: PayrollWarningSeverity;
}

// The Southern Lanka Hospitals payslip's top "hours worked" block — pure counts, snapshotted
// straight off the PayrollMonthlyEntry at generate time (ot_hours = normal + double combined,
// matching the payslip's single "OT Hours" row). Printed for record-keeping; only ph_days,
// poya_days, ph_hours_overtime and no_pay_days/no_pay_hours feed a money line — the rest are
// informational.
export interface PayrollResultHoursSummary {
  total_hours: number;
  normal_ph_hours: number;
  normal_poya_hours: number;
  ph_overtime_hours: number;
  poya_overtime_hours: number;
  ot_hours: number;
  ph_days: number;
  poya_days: number;
  mercantile_days: number;
  normal_mercantile_hours: number;
  mercantile_overtime_hours: number;
  no_pay_days: number;
  no_pay_hours: number;
}

export interface PayrollCalculationResult {
  lines: PayrollResultLine[];

  target_hours_used: number | null;
  hourly_rate_used: number | null;

  gross_pay: number | null;
  epf_base: number | null;
  etf_base: number | null;
  taxable_base: number | null;
  apit_amount: number | null;
  total_deductions: number | null;
  net_pay: number | null;
  employer_epf: number | null;
  employer_etf: number | null;

  warnings: PayrollCalculationWarning[];
}

// ─── Payroll result (persisted) ──────────────────────────────────────────────────────────
// One immutable-once-finalized snapshot per employee per run. Written ONLY by the
// generate/review/finalize Admin-SDK API routes — never a client write (firestore.rules:
// `payroll_results` has `allow write: if false`).

export interface PayrollResultBankSnapshot {
  bank_name: string | null;
  bank_branch: string | null;
  account_number: string | null;
}

export interface PayrollResult extends PayrollCalculationResult {
  id?: string; // `${run_id}__${epfDocId}`

  run_id: string;
  company_id: string;
  company_name: string;
  epf_number: string;
  employee_name: string;

  basic_salary: number; // snapshot at generation time

  bank_snapshot: PayrollResultBankSnapshot;

  // Payslip metadata snapshotted from the linked AppUser (users/{uid}) at generation time —
  // never a live join at print/render time, same reasoning as bank_snapshot. `null` when the
  // source field was itself empty on the user record, not when the user record was missing
  // (that case just leaves both null too — same effect, no separate flag needed).
  nic_snapshot: string | null;
  employee_no_snapshot: string | null;
  // Sourced from AppUser.role (e.g. "Nurse"), not AppUser.designation — that free-text field
  // is inconsistently filled in across employee records (often left blank), while role is
  // required and always populated. See generate/route.ts's own comment at the write site.
  designation_snapshot: string | null;
  department_snapshot: string | null;

  // Informational only — pulled from attendance_shortfall_summary for this run's period at
  // generation time. Never affects gross_pay/total_deductions/net_pay; payroll staff act on
  // it manually (e.g. via a one-off No Pay Days/Hours entry on the Bulk Sheet) if they choose
  // to. `null` when no shortfall summary exists for this employee/period (nothing computed on
  // the Attendance View page yet), not the same as 0.
  late_minutes_snapshot: number | null;
  early_departure_minutes_snapshot: number | null;

  hours_summary: PayrollResultHoursSummary;

  // Denormalized from payroll_runs.status at generation time, updated on review/finalize —
  // lets My Payslips filter to 'finalized' without a join.
  run_status: PayrollRunStatus;

  calculated_at?: Timestamp;
}

// ─── Audit ────────────────────────────────────────────────────────────────────────────

export type PayrollAuditAction =
  | 'SETTINGS_UPDATED'
  | 'COMPONENT_CREATED' | 'COMPONENT_UPDATED' | 'COMPONENT_DELETED'
  | 'EMPLOYEE_CREATED' | 'EMPLOYEE_UPDATED'
  | 'LOAN_CREATED' | 'LOAN_UPDATED' | 'LOAN_CANCELLED'
  | 'SALARY_ADVANCE_CREATED' | 'SALARY_ADVANCE_UPDATED' | 'SALARY_ADVANCE_CANCELLED'
  | 'PAYROLL_REQUEST_APPROVED' | 'PAYROLL_REQUEST_REJECTED'
  | 'RUN_CREATED' | 'RUN_GENERATED' | 'RUN_REVIEWED' | 'RUN_FINALIZED' | 'RUN_REOPENED'
  | 'MONTHLY_ENTRY_UPDATED';

export interface PayrollAuditLogEntry {
  id?: string;
  company_id: string;
  action: PayrollAuditAction;
  entity_type: 'payroll_settings' | 'payroll_component' | 'payroll_employee' | 'payroll_loan'
    | 'payroll_salary_advance' | 'payroll_run' | 'payroll_monthly_entry' | 'payroll_request';
  entity_id: string;
  epf_number?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  performed_by_epf: string;
  performed_by_name: string;
  performed_at?: Timestamp;
}
