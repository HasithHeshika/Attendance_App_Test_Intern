// Pure calculation engine — no Firestore, no React. Takes plain config + one employee's
// monthly input and returns a fully-lined-out PayrollCalculationResult. Deterministic and
// unit-testable: the same inputs always produce the same output.
//
// Strict missing-config rule throughout: a value that cannot be honestly computed becomes
// `null` with a warning — NEVER silently coalesced to 0. A `0` always means "genuinely,
// legitimately zero" (e.g. not EPF-eligible, no OT worked).

import type {
  PayrollSettings, PayrollComponent, PayrollEmployee, PayrollMonthlyEntry, PayrollLoan, PayrollSalaryAdvance,
  PayrollCalculationResult, PayrollCalculationWarning, PayrollResultLine, SuspenseSplitCharge,
} from '@/lib/payrollTypes';

export interface PayrollCalculationInput {
  settings: PayrollSettings;
  components: Map<string, PayrollComponent>; // component id -> definition, this company only
  employee: PayrollEmployee;
  monthlyEntry: PayrollMonthlyEntry;
  activeLoans: PayrollLoan[]; // this employee's loans with status 'active', current_balance >
                              // 0, and end_month not yet passed for this run's period — the
                              // caller (the generate route) is responsible for that filtering.
  activeSalaryAdvances: PayrollSalaryAdvance[]; // this employee's advances with status
                              // 'pending' and period === this run's period — always deducted
                              // 100% in this one run, never partially/across months.
  /** Suspense bill portions colleagues charged to THIS employee that payroll has not yet
   *  deducted. The caller resolves them — the generate route, gated on the `suspense` tenant
   *  feature — and omits them everywhere the module is off, so this stays a no-op there. */
  suspenseSplits?: SuspenseSplitCharge[];
}

function warn(code: string, message: string, severity: PayrollCalculationWarning['severity'] = 'blocking'): PayrollCalculationWarning {
  return { code, message, severity };
}

/** Progressive tax: each bracket taxes only the slice of `taxableIncome` that falls within
 *  it. `slabs` must be ascending and contiguous by `from`/`to` (last entry's `to` may be
 *  null = open-ended) — see validateTaxSlabs(), which accepts either a `from` that picks up
 *  exactly where the previous bracket's `to` ends, or one rupee after it (the common
 *  human-readable tax-table style: "up to 100,000" then "100,001 to 141,667"). The split
 *  point used here is always the previous bracket's own `to` — not `from` — so neither
 *  convention leaves a sliver of income silently untaxed at the boundary. */
export function calculateProgressiveTax(taxableIncome: number, slabs: PayrollSettings['tax_slabs']): number {
  if (taxableIncome <= 0 || slabs.length === 0) return 0;
  let tax = 0;
  let lowerBound = slabs[0].from; // respects a configured first bracket that doesn't start at 0
  for (const slab of slabs) {
    if (taxableIncome <= lowerBound) break;
    const upper = slab.to ?? Infinity;
    const slice = Math.max(0, Math.min(taxableIncome, upper) - lowerBound);
    tax += slice * (slab.rate / 100);
    lowerBound = upper;
    if (taxableIncome <= upper) break;
  }
  return tax;
}

export function calculatePayrollForEmployee(input: PayrollCalculationInput): PayrollCalculationResult {
  const { settings, components, employee, monthlyEntry, activeLoans, activeSalaryAdvances } = input;
  const lines: PayrollResultLine[] = [];
  const warnings: PayrollCalculationWarning[] = [];

  // Defensive: a legacy/partially-written payroll_employees, payroll_monthly_entries, or
  // payroll_settings doc (e.g. hand-edited in the Firestore console, or created before one of
  // these array fields existed in the schema) can have `undefined` where an array is
  // expected. `[...undefined]`/`undefined.filter(...)` throws a TypeError that would
  // otherwise crash the whole Generate batch for every OTHER employee too — defaulting to []
  // here keeps a malformed doc a warning-worthy zero instead of a request-ending exception.
  const safeAllowances = employee.allowances ?? [];
  const safeDeductions = employee.deductions ?? [];
  const safeOneOffLines = monthlyEntry.one_off_lines ?? [];
  const safeTaxSlabs = settings.tax_slabs ?? [];
  const safeActiveLoans = activeLoans ?? [];
  const safeActiveSalaryAdvances = activeSalaryAdvances ?? [];

  // Same reasoning, for the Bulk Sheet's own numeric fields: a payroll_monthly_entries doc
  // written before one of these existed in the schema (e.g. poya_hours_overtime, added after
  // this run's rows were first created) reads back as `undefined`, not 0. Arithmetic on an
  // undefined operand quietly becomes NaN (wrong, but not a crash) — the real danger is a
  // field passed straight through into a `units:` value with no arithmetic in between, which
  // stays literally `undefined` and makes the WHOLE batch.set() throw when Firestore refuses
  // to write it (`Cannot use "undefined" as a Firestore value`), taking down every other
  // employee's row in the same Generate call too. Defaulting every one of them here closes
  // that off for good, not just for the field that happened to break this time.
  const safeOtHoursNormal = monthlyEntry.ot_hours_normal ?? 0;
  const safeOtHoursDouble = monthlyEntry.ot_hours_double ?? 0;
  const safeNoPayHours = monthlyEntry.no_pay_hours ?? 0;
  const safeNoPayDays = monthlyEntry.no_pay_days ?? 0;
  const safePhDays = monthlyEntry.ph_days ?? 0;
  const safePhHoursOvertime = monthlyEntry.ph_hours_overtime ?? 0;
  const safePoyaDays = monthlyEntry.poya_days ?? 0;
  const safePoyaHoursOvertime = monthlyEntry.poya_hours_overtime ?? 0;
  const safeMercantileDays = monthlyEntry.mercantile_days ?? 0;
  const safeMercantileHoursOvertime = monthlyEntry.mercantile_hours_overtime ?? 0;

  // Same failure mode, on the OTHER side: payroll_settings is a single tenant-wide doc that
  // gets incrementally patched as new Settings fields ship — a field added after that doc was
  // last saved (e.g. poya_overtime_multiplier) reads back as `undefined`, not `null`, even
  // though its TypeScript type says `number | null`. `undefined == null` is true for every
  // "is this configured?" check in this file, so the WARNING/null-propagation logic already
  // treats it correctly either way — but a raw `settings.x` passed straight into a line's
  // `multiplier`/`rate` field (no `== null` check first) stays literally `undefined` and hits
  // the exact same Firestore write failure. Normalized once here so every reference below is
  // provably safe to serialize, regardless of which fields a given settings doc happens to
  // have been saved with so far.
  const safeDefaultHoursPerDay = settings.default_hours_per_day ?? null;
  const safeDefaultTargetHours = settings.default_target_hours ?? null;
  const safePhDayMultiplier = settings.ph_day_multiplier ?? null;
  const safePhDayRateDivisor = settings.ph_day_rate_divisor ?? null;
  const safePhOvertimeMultiplier = settings.ph_overtime_multiplier ?? null;
  const safePoyaDayMultiplier = settings.poya_day_multiplier ?? null;
  const safePoyaDayRateDivisor = settings.poya_day_rate_divisor ?? null;
  const safeMercantileDayMultiplier = settings.mercantile_day_multiplier ?? null;
  const safeMercantileDayRateDivisor = settings.mercantile_day_rate_divisor ?? null;
  const safeMercantileOvertimeMultiplier = settings.mercantile_overtime_multiplier ?? null;
  const safePoyaOvertimeMultiplier = settings.poya_overtime_multiplier ?? null;
  const safeEpfEmployeeRate = settings.epf_employee_rate ?? null;
  const safeEpfEmployerRate = settings.epf_employer_rate ?? null;
  const safeEtfEmployerRate = settings.etf_employer_rate ?? null;
  const safeStampDutyAmount = settings.stamp_duty_amount ?? null;

  // A non-numeric basic_salary (missing field, or a string slipped in from a hand-edited
  // doc) would silently poison every downstream figure with NaN rather than throwing, since
  // EVERY other total in this engine derives from it directly or indirectly (hourly rate, EPF/
  // ETF base, taxable base, gross pay). Rather than threading a `number | null` guard through
  // every one of those individually, bail out immediately with a single clear warning and an
  // all-null result — a broken basic_salary makes the whole payslip untrustworthy, not just
  // one line of it, so a partial mix of real numbers and nulls would be more misleading than
  // an explicit "nothing could be calculated."
  const basicSalary = typeof employee.basic_salary === 'number' && !Number.isNaN(employee.basic_salary) ? employee.basic_salary : null;
  if (basicSalary == null) {
    return {
      lines: [{ type: 'basic', code: 'BASIC', name: 'Basic Salary', units: null, rate: null, multiplier: null, amount: null }],
      target_hours_used: null, hourly_rate_used: null,
      gross_pay: null, epf_base: null, etf_base: null, taxable_base: null, apit_amount: null,
      total_deductions: null, net_pay: null, employer_epf: null, employer_etf: null,
      warnings: [warn('BASIC_SALARY_INVALID', 'This employee has no valid Basic Salary configured — nothing could be calculated. Set it on the Payroll Employees page.')],
    };
  }

  // ── Target hours / hourly rate ──────────────────────────────────────────────────────
  const targetHours = employee.target_hours_override ?? safeDefaultTargetHours;
  let hourlyRate: number | null = null;
  if (employee.ot_rate_mode === 'FIXED') {
    hourlyRate = employee.ot_fixed_hourly_rate;
    if (hourlyRate == null) warnings.push(warn('OT_RATE_UNRESOLVED', 'OT rate mode is Fixed but no fixed hourly rate is set on this employee.'));
  } else if (targetHours == null || targetHours <= 0) {
    warnings.push(warn('TARGET_HOURS_UNRESOLVED', 'No target hours configured (neither an employee override nor a company default) — OT and No-Pay cannot be calculated.'));
  } else {
    hourlyRate = basicSalary / targetHours;
  }

  lines.push({ type: 'basic', code: 'BASIC', name: 'Basic Salary', units: null, rate: null, multiplier: null, amount: basicSalary });

  // ── Overtime ─────────────────────────────────────────────────────────────────────────
  const otNormalAmount = hourlyRate != null ? safeOtHoursNormal * hourlyRate * employee.ot_multiplier_normal : null;
  lines.push({
    type: 'ot_normal', code: 'OT_NORMAL', name: `OT (${employee.ot_multiplier_normal}x)`,
    units: safeOtHoursNormal, rate: hourlyRate, multiplier: employee.ot_multiplier_normal, amount: otNormalAmount,
  });
  const otDoubleAmount = hourlyRate != null ? safeOtHoursDouble * hourlyRate * employee.ot_multiplier_double : null;
  lines.push({
    type: 'ot_double', code: 'OT_DOUBLE', name: `OT (${employee.ot_multiplier_double}x)`,
    units: safeOtHoursDouble, rate: hourlyRate, multiplier: employee.ot_multiplier_double, amount: otDoubleAmount,
  });

  // ── No-Pay (hours + days, days converted via the resolved hours-per-day) ───────────────
  // Three-level fallback, most-specific wins: this run's own override (monthlyEntry, set on
  // the Bulk Sheet) → this employee's own profile override → the company-wide Settings
  // default. Mirrors target_hours_override's own resolution one section up.
  const hoursPerDay = monthlyEntry.hours_per_day ?? employee.hours_per_day ?? safeDefaultHoursPerDay;
  let noPayAmount: number | null = null;
  const noPayUnits = safeNoPayHours + safeNoPayDays; // display only — see units below
  if (hourlyRate != null) {
    if (safeNoPayDays > 0 && (hoursPerDay == null || hoursPerDay <= 0)) {
      warnings.push(warn('HOURS_PER_DAY_UNRESOLVED', 'No Pay Days is set but Hours per Day is not configured (no run override, employee override, or company default) — cannot convert days to an amount.'));
    } else {
      const totalNoPayHours = safeNoPayHours + safeNoPayDays * (hoursPerDay ?? 0);
      noPayAmount = totalNoPayHours > 0 ? -(totalNoPayHours * hourlyRate) : 0;
    }
  }
  // else: already warned above (target hours / fixed rate unresolved).
  lines.push({
    type: 'no_pay', code: 'NO_PAY', name: 'No Pay',
    units: noPayUnits,
    rate: hourlyRate, multiplier: null, amount: noPayAmount,
  });

  // ── Public Holiday / Poya Day pay ───────────────────────────────────────────────────────
  // PH: a FIXED statutory daily rate (basic_salary ÷ ph_day_rate_divisor) — deliberately
  // independent of hourlyRate/hoursPerDay/target hours, same shape as Poya/Mercantile below.
  // PH Overtime Hours is priced off the plain hourly rate instead, like regular OT.
  const phStatutoryDailyRate = (safePhDayRateDivisor != null && safePhDayRateDivisor > 0)
    ? basicSalary / safePhDayRateDivisor : null;
  if (phStatutoryDailyRate == null && safePhDays > 0) {
    warnings.push(warn('PH_DAY_RATE_DIVISOR_UNRESOLVED', 'PH Days is set but no PH Day Rate Divisor is configured in Settings — cannot price a full day.'));
  }

  // Poya: a FIXED statutory daily rate (basic_salary ÷ poya_day_rate_divisor) — deliberately
  // independent of hourlyRate/hoursPerDay, so it can never move with target-hours/hours-per-
  // day settings. See PayrollSettings.poya_day_multiplier.
  const poyaStatutoryDailyRate = (safePoyaDayRateDivisor != null && safePoyaDayRateDivisor > 0)
    ? basicSalary / safePoyaDayRateDivisor : null;
  if (poyaStatutoryDailyRate == null && safePoyaDays > 0) {
    warnings.push(warn('POYA_DAY_RATE_DIVISOR_UNRESOLVED', 'Poya Day is set but no Poya Day Rate Divisor is configured in Settings — cannot price a full day.'));
  }

  const phOvertimeAmount = hourlyRate != null && safePhOvertimeMultiplier != null
    ? safePhHoursOvertime * hourlyRate * safePhOvertimeMultiplier : null;
  if (hourlyRate != null && safePhOvertimeMultiplier == null && safePhHoursOvertime > 0) {
    warnings.push(warn('PH_OVERTIME_MULTIPLIER_UNRESOLVED', 'PH Overtime Hours is set but no PH Overtime multiplier is configured in Settings.'));
  }
  lines.push({
    type: 'ph_overtime', code: 'PH_OVERTIME', name: 'PH Overtime Pay',
    units: safePhHoursOvertime, rate: hourlyRate, multiplier: safePhOvertimeMultiplier, amount: phOvertimeAmount,
  });

  const phDayAmount = phStatutoryDailyRate != null && safePhDayMultiplier != null
    ? safePhDays * phStatutoryDailyRate * safePhDayMultiplier : null;
  if (phStatutoryDailyRate != null && safePhDayMultiplier == null && safePhDays > 0) {
    warnings.push(warn('PH_DAY_MULTIPLIER_UNRESOLVED', 'PH Days is set but no PH Day multiplier is configured in Settings.'));
  }
  lines.push({
    type: 'ph_day', code: 'PH_DAY', name: 'PH Day Payment',
    units: safePhDays, rate: phStatutoryDailyRate, multiplier: safePhDayMultiplier, amount: phDayAmount,
  });

  const poyaDayAmount = poyaStatutoryDailyRate != null && safePoyaDayMultiplier != null
    ? safePoyaDays * poyaStatutoryDailyRate * safePoyaDayMultiplier : null;
  if (poyaStatutoryDailyRate != null && safePoyaDayMultiplier == null && safePoyaDays > 0) {
    warnings.push(warn('POYA_DAY_MULTIPLIER_UNRESOLVED', 'Poya Day is set but no Poya Day multiplier is configured in Settings.'));
  }
  lines.push({
    type: 'poya_day', code: 'POYA_DAY', name: 'Poya Day Pay',
    units: safePoyaDays, rate: poyaStatutoryDailyRate, multiplier: safePoyaDayMultiplier, amount: poyaDayAmount,
  });

  const poyaOvertimeAmount = hourlyRate != null && safePoyaOvertimeMultiplier != null
    ? safePoyaHoursOvertime * hourlyRate * safePoyaOvertimeMultiplier : null;
  if (hourlyRate != null && safePoyaOvertimeMultiplier == null && safePoyaHoursOvertime > 0) {
    warnings.push(warn('POYA_OVERTIME_MULTIPLIER_UNRESOLVED', 'Poya Overtime Hours is set but no Poya Overtime multiplier is configured in Settings.'));
  }
  lines.push({
    type: 'poya_overtime', code: 'POYA_OVERTIME', name: 'Poya Overtime Pay',
    units: safePoyaHoursOvertime, rate: hourlyRate, multiplier: safePoyaOvertimeMultiplier, amount: poyaOvertimeAmount,
  });

  // Mercantile Holiday: same fixed-statutory-rate shape as Poya (basic_salary ÷ divisor),
  // flat day pay only — no overtime-beyond-a-standard-day bucket (unlike PH/Poya).
  const mercantileStatutoryDailyRate = (safeMercantileDayRateDivisor != null && safeMercantileDayRateDivisor > 0)
    ? basicSalary / safeMercantileDayRateDivisor : null;
  if (mercantileStatutoryDailyRate == null && safeMercantileDays > 0) {
    warnings.push(warn('MERCANTILE_DAY_RATE_DIVISOR_UNRESOLVED', 'Mercantile Days is set but no Mercantile Day Rate Divisor is configured in Settings — cannot price a full day.'));
  }
  const mercantileDayAmount = mercantileStatutoryDailyRate != null && safeMercantileDayMultiplier != null
    ? safeMercantileDays * mercantileStatutoryDailyRate * safeMercantileDayMultiplier : null;
  if (mercantileStatutoryDailyRate != null && safeMercantileDayMultiplier == null && safeMercantileDays > 0) {
    warnings.push(warn('MERCANTILE_DAY_MULTIPLIER_UNRESOLVED', 'Mercantile Days is set but no Mercantile Day multiplier is configured in Settings.'));
  }
  lines.push({
    type: 'mercantile_day', code: 'MERCANTILE_DAY', name: 'Mercantile Day Pay',
    units: safeMercantileDays, rate: mercantileStatutoryDailyRate, multiplier: safeMercantileDayMultiplier, amount: mercantileDayAmount,
  });

  const mercantileOvertimeAmount = hourlyRate != null && safeMercantileOvertimeMultiplier != null
    ? safeMercantileHoursOvertime * hourlyRate * safeMercantileOvertimeMultiplier : null;
  if (hourlyRate != null && safeMercantileOvertimeMultiplier == null && safeMercantileHoursOvertime > 0) {
    warnings.push(warn('MERCANTILE_OVERTIME_MULTIPLIER_UNRESOLVED', 'Mercantile Overtime Hours is set but no Mercantile Overtime multiplier is configured in Settings.'));
  }
  lines.push({
    type: 'mercantile_overtime', code: 'MERCANTILE_OVERTIME', name: 'Mercantile Overtime Pay',
    units: safeMercantileHoursOvertime, rate: hourlyRate, multiplier: safeMercantileOvertimeMultiplier, amount: mercantileOvertimeAmount,
  });

  // ── Allowances / deductions (recurring + this month's one-off lines) ───────────────────
  const allowanceLines = [...safeAllowances, ...safeOneOffLines.filter(l => components.get(l.component_id)?.type === 'allowance')];
  const deductionLines = [...safeDeductions, ...safeOneOffLines.filter(l => components.get(l.component_id)?.type === 'deduction')];

  for (const a of allowanceLines) {
    const comp = components.get(a.component_id);
    lines.push({ type: 'allowance', code: a.component_id, name: comp?.name ?? a.component_id, units: null, rate: null, multiplier: null, amount: a.amount });
    if (!comp) warnings.push(warn(`COMPONENT_MISSING_${a.component_id}`, `An allowance component (${a.component_id}) no longer exists in Settings — its EPF/ETF/tax flags could not be resolved.`, 'info'));
  }
  for (const d of deductionLines) {
    const comp = components.get(d.component_id);
    lines.push({ type: 'deduction', code: d.component_id, name: comp?.name ?? d.component_id, units: null, rate: null, multiplier: null, amount: d.amount });
    if (!comp) warnings.push(warn(`COMPONENT_MISSING_${d.component_id}`, `A deduction component (${d.component_id}) no longer exists in Settings.`, 'info'));
  }

  // ── Stamp Duty ───────────────────────────────────────────────────────────────────────
  // Flat, mandatory, no per-employee opt-out — unlike every allowance/deduction above, this
  // is never attached per employee, it applies to everyone whenever configured. 'deduction'
  // type + the exact name 'Stamp Fee' is deliberate: that is the physical payslip template's
  // own pre-existing row (see NAMED_DEDUCTIONS in payrollPayslipExport.ts) — this line
  // populates it without any change needed to that file.
  const stampDutyAmount = safeStampDutyAmount;
  if (safeStampDutyAmount == null) {
    warnings.push(warn('STAMP_DUTY_UNRESOLVED', 'Stamp Duty amount is not configured in Settings — required for every employee.'));
  }
  lines.push({ type: 'deduction', code: 'STAMP_DUTY', name: 'Stamp Fee', units: null, rate: null, multiplier: null, amount: stampDutyAmount });

  const epfApplicableAllowances = allowanceLines.filter(a => components.get(a.component_id)?.isEpfApplicable).reduce((s, a) => s + a.amount, 0);
  const etfApplicableAllowances = allowanceLines.filter(a => components.get(a.component_id)?.isEtfApplicable).reduce((s, a) => s + a.amount, 0);
  const taxApplicableAllowances = allowanceLines.filter(a => components.get(a.component_id)?.isTaxApplicable).reduce((s, a) => s + a.amount, 0);

  // ── EPF / ETF ────────────────────────────────────────────────────────────────────────
  // Base = Basic Salary + EPF/ETF-flagged allowances + the flat PH/Poya/Mercantile Day
  // premiums (a statutory requirement — "payments made for Poya days and statutory
  // holidays"). Deliberately EXCLUDES every overtime-type line (ordinary OT, PH/Poya/
  // Mercantile Overtime) — overtime is excluded from the EPF/ETF base everywhere else in
  // this engine, and the requirement is phrased around the day payment itself, not hours
  // worked beyond it.
  //
  // Any of the three Day amounts being null (missing divisor/multiplier config) makes the
  // WHOLE base null rather than silently treating the unresolved holiday as a zero
  // contribution — same "never coalesce an unknown to 0" rule as everywhere else here.
  const holidayDayPayForContributions = (phDayAmount == null || poyaDayAmount == null || mercantileDayAmount == null)
    ? null : phDayAmount + poyaDayAmount + mercantileDayAmount;

  const epfBase = !employee.is_epf_applicable ? 0
    : holidayDayPayForContributions == null ? null
      : basicSalary + epfApplicableAllowances + holidayDayPayForContributions;
  const etfBase = !employee.is_etf_applicable ? 0
    : holidayDayPayForContributions == null ? null
      : basicSalary + etfApplicableAllowances + holidayDayPayForContributions;

  let epfEmployeeAmount: number | null = 0;
  let epfEmployerAmount: number | null = 0;
  if (employee.is_epf_applicable) {
    if (epfBase == null) {
      epfEmployeeAmount = null;
      epfEmployerAmount = null;
      warnings.push(warn('EPF_BASE_UNRESOLVED', 'EPF could not be calculated because PH/Poya/Mercantile Day pay could not be resolved first.'));
    } else {
      if (safeEpfEmployeeRate == null) {
        epfEmployeeAmount = null;
        warnings.push(warn('EPF_EMPLOYEE_RATE_UNRESOLVED', 'EPF employee rate is not configured in Settings.'));
      } else {
        epfEmployeeAmount = epfBase * (safeEpfEmployeeRate / 100);
      }
      if (safeEpfEmployerRate == null) {
        epfEmployerAmount = null;
        warnings.push(warn('EPF_EMPLOYER_RATE_UNRESOLVED', 'EPF employer rate is not configured in Settings.', 'info'));
      } else {
        epfEmployerAmount = epfBase * (safeEpfEmployerRate / 100);
      }
    }
  }
  lines.push({ type: 'epf_employee', code: 'EPF_EMPLOYEE', name: 'EPF (Employee)', units: null, rate: safeEpfEmployeeRate, multiplier: null, amount: epfEmployeeAmount });
  lines.push({ type: 'epf_employer', code: 'EPF_EMPLOYER', name: 'EPF (Employer)', units: null, rate: safeEpfEmployerRate, multiplier: null, amount: epfEmployerAmount });

  let etfEmployerAmount: number | null = 0;
  if (employee.is_etf_applicable) {
    if (etfBase == null) {
      etfEmployerAmount = null;
      warnings.push(warn('ETF_BASE_UNRESOLVED', 'ETF could not be calculated because PH/Poya/Mercantile Day pay could not be resolved first.', 'info'));
    } else if (safeEtfEmployerRate == null) {
      etfEmployerAmount = null;
      warnings.push(warn('ETF_EMPLOYER_RATE_UNRESOLVED', 'ETF employer rate is not configured in Settings.', 'info'));
    } else {
      etfEmployerAmount = etfBase * (safeEtfEmployerRate / 100);
    }
  }
  lines.push({ type: 'etf_employer', code: 'ETF_EMPLOYER', name: 'ETF (Employer)', units: null, rate: safeEtfEmployerRate, multiplier: null, amount: etfEmployerAmount });

  // ── APIT (progressive slabs, or a per-employee manual override) ────────────────────────
  let taxableBase: number | null = null;
  let apitAmount: number | null = 0;
  if (employee.is_tax_applicable) {
    if (employee.tax_override_amount != null) {
      apitAmount = employee.tax_override_amount;
    } else if (otNormalAmount == null || otDoubleAmount == null || epfEmployeeAmount == null
      || phOvertimeAmount == null || phDayAmount == null || poyaDayAmount == null || poyaOvertimeAmount == null
      || mercantileDayAmount == null || mercantileOvertimeAmount == null) {
      apitAmount = null;
      warnings.push(warn('APIT_UNRESOLVED', 'APIT could not be calculated because OT, PH/Poya/Mercantile pay, or EPF could not be resolved first.'));
    } else if (safeTaxSlabs.length === 0) {
      apitAmount = null;
      warnings.push(warn('TAX_SLABS_UNRESOLVED', 'No tax slabs configured in Settings, and no manual APIT override is set for this employee.'));
    } else {
      taxableBase = basicSalary + taxApplicableAllowances + otNormalAmount + otDoubleAmount
        + phOvertimeAmount + phDayAmount + poyaDayAmount + poyaOvertimeAmount + mercantileDayAmount + mercantileOvertimeAmount - epfEmployeeAmount;
      apitAmount = calculateProgressiveTax(Math.max(0, taxableBase), safeTaxSlabs);
    }
  }
  lines.push({ type: 'apit', code: 'APIT', name: 'APIT (Income Tax)', units: null, rate: null, multiplier: null, amount: apitAmount });

  // ── Loans ────────────────────────────────────────────────────────────────────────────
  let loanTotal = 0;
  for (const loan of safeActiveLoans) {
    const amount = Math.min(loan.monthly_deduction_amount, loan.current_balance);
    loanTotal += amount;
    lines.push({
      type: 'loan_repayment', code: loan.id as string, name: `Loan Repayment${loan.note ? ` (${loan.note})` : ''}`,
      units: null, rate: null, multiplier: null, amount, loan_id: loan.id as string,
    });
  }

  // ── Salary advances ─────────────────────────────────────────────────────────────────
  // Always 100% in this one run — no partial/multi-month spread like a loan.
  let advanceTotal = 0;
  for (const advance of safeActiveSalaryAdvances) {
    advanceTotal += advance.amount;
    lines.push({
      type: 'salary_advance_repayment', code: advance.id as string, name: `Salary Advance${advance.note ? ` (${advance.note})` : ''}`,
      units: null, rate: null, multiplier: null, amount: advance.amount, advance_id: advance.id as string,
    });
  }

  // ── Suspense expense splits ──────────────────────────────────────────────────────────
  // A colleague paid a bill out of their own float and charged part of it to this employee.
  // Recovering it here is the whole point: the payer is carrying the money until payroll takes
  // it, and finalising the run returns it to their float (see the finalize route). One line
  // rather than one per bill — the payslip needs a figure, not a bill list — but the refs ride
  // along so finalisation returns exactly what was deducted and not a rupee more.
  const safeSuspenseSplits = (input.suspenseSplits ?? []).filter(s => s && s.amount > 0);
  let suspenseTotal = 0;
  if (safeSuspenseSplits.length > 0) {
    // Unrounded, like loanTotal and advanceTotal above — this engine keeps raw values and
    // leaves presentation rounding to the exports.
    suspenseTotal = safeSuspenseSplits.reduce((s, x) => s + x.amount, 0);
    lines.push({
      type: 'suspense_recovery', code: 'SUSPENSE_SPLITS', name: 'Suspense expense splits',
      units: safeSuspenseSplits.length, rate: null, multiplier: null, amount: suspenseTotal,
      suspense_refs: safeSuspenseSplits,
    });
  }

  // ── Totals ───────────────────────────────────────────────────────────────────────────
  const allowanceTotal = allowanceLines.reduce((s, a) => s + a.amount, 0);
  const deductionTotal = deductionLines.reduce((s, d) => s + d.amount, 0);

  const grossPay = (otNormalAmount == null || otDoubleAmount == null || noPayAmount == null
    || phOvertimeAmount == null || phDayAmount == null || poyaDayAmount == null || poyaOvertimeAmount == null
    || mercantileDayAmount == null || mercantileOvertimeAmount == null) ? null
    : basicSalary + allowanceTotal + otNormalAmount + otDoubleAmount + noPayAmount
      + phOvertimeAmount + phDayAmount + poyaDayAmount + poyaOvertimeAmount + mercantileDayAmount + mercantileOvertimeAmount;

  const totalDeductions = (epfEmployeeAmount == null || apitAmount == null || stampDutyAmount == null) ? null
    : deductionTotal + epfEmployeeAmount + apitAmount + loanTotal + advanceTotal + stampDutyAmount + suspenseTotal;

  const netPay = (grossPay == null || totalDeductions == null) ? null : grossPay - totalDeductions;

  return {
    lines,
    target_hours_used: employee.ot_rate_mode === 'FIXED' ? null : targetHours,
    hourly_rate_used: hourlyRate,
    gross_pay: grossPay,
    epf_base: epfBase,
    etf_base: etfBase,
    taxable_base: taxableBase,
    apit_amount: apitAmount,
    total_deductions: totalDeductions,
    net_pay: netPay,
    employer_epf: epfEmployerAmount,
    employer_etf: etfEmployerAmount,
    warnings,
  };
}
