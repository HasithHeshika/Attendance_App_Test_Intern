import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculatePayrollForEmployee, calculateProgressiveTax } from '../payroll/payrollCalculationEngine';
import { draftPayrollSettings, emptyPayrollEmployee, emptyMonthlyEntry } from '../payrollTypes';
import type { PayrollSettings, PayrollEmployee, PayrollMonthlyEntry, PayrollComponent } from '../payrollTypes';

// These tests pin down the invariant behind "approved OT is the only thing that ever reaches
// payroll pay": the engine reads OT/PH/Poya pay EXCLUSIVELY from monthlyEntry's four synced
// fields (ot_hours_normal, ot_hours_double, ph_hours_overtime, poya_hours_overtime — see
// syncApprovedOtToRun in payrollRunService.ts, the only writer of these sourced from approved
// ot_requests). The passive "Extra hours" shown on the attendance calendar
// (src/components/attendance/workDayModel.ts) has no persistence path into this engine at all —
// this file is pure with zero Firestore/attendance imports (see its own header comment) — so
// there's nothing to assert against directly; instead this locks in that unrelated
// PayrollMonthlyEntry fields (an attendance-shaped one like total_hours included) never move
// the OT-priced lines, so a future change can't quietly wire a new source in.

function settings(over: Partial<PayrollSettings> = {}): PayrollSettings {
  return { ...draftPayrollSettings(), default_target_hours: 200, default_hours_per_day: 8, ...over };
}
function employee(over: Partial<PayrollEmployee> = {}): PayrollEmployee {
  return { ...emptyPayrollEmployee('c1', 'Co', 'E1', 'Amaya'), basic_salary: 100000, ...over };
}
function entry(over: Partial<PayrollMonthlyEntry> = {}): PayrollMonthlyEntry {
  return { ...emptyMonthlyEntry('run1', 'c1', 'E1', 'Amaya'), ...over };
}
function line(result: ReturnType<typeof calculatePayrollForEmployee>, type: string) {
  return result.lines.find(l => l.type === type)?.amount;
}
function calc(monthlyEntry: PayrollMonthlyEntry, settingsOver: Partial<PayrollSettings> = {}, employeeOver: Partial<PayrollEmployee> = {}) {
  return calculatePayrollForEmployee({
    settings: settings(settingsOver),
    components: new Map<string, PayrollComponent>(),
    employee: employee(employeeOver),
    monthlyEntry,
    activeLoans: [],
    activeSalaryAdvances: [],
  });
}

test('OT/PH/Poya pay lines are zero with an all-zero monthly entry', () => {
  const r = calc(entry());
  assert.equal(line(r, 'ot_normal'), 0);
  assert.equal(line(r, 'ot_double'), 0);
  assert.equal(line(r, 'ph_overtime'), 0);
  assert.equal(line(r, 'poya_overtime'), 0);
});

test('an attendance-shaped field (total_hours) never moves OT/PH/Poya pay — only the four synced fields do', () => {
  const baseline = calc(entry());
  // total_hours, ph_hours_normal, poya_hours_normal are direct-input "informational" fields
  // (see PayrollMonthlyEntry's own doc comments) — none of them price a line on their own.
  const withExtraHours = calc(entry({ total_hours: 999, ph_hours_normal: 40, poya_hours_normal: 40 }));
  assert.equal(line(withExtraHours, 'ot_normal'), line(baseline, 'ot_normal'));
  assert.equal(line(withExtraHours, 'ot_double'), line(baseline, 'ot_double'));
  assert.equal(line(withExtraHours, 'ph_overtime'), line(baseline, 'ph_overtime'));
  assert.equal(line(withExtraHours, 'poya_overtime'), line(baseline, 'poya_overtime'));
});

test('ot_hours_normal/ot_hours_double DO price ot_normal/ot_double, at the employee multipliers', () => {
  const r = calc(entry({ ot_hours_normal: 10, ot_hours_double: 2 }));
  // hourlyRate = basic_salary / default_target_hours = 100000 / 200 = 500
  assert.equal(line(r, 'ot_normal'), 10 * 500 * 1.5);
  assert.equal(line(r, 'ot_double'), 2 * 500 * 2.0);
});

test('ph_hours_overtime/poya_hours_overtime DO price ph_overtime/poya_overtime, at the settings multipliers', () => {
  const r = calc(entry({ ph_hours_overtime: 5, poya_hours_overtime: 4 }), { ph_overtime_multiplier: 3, poya_overtime_multiplier: 3 });
  assert.equal(line(r, 'ph_overtime'), 5 * 500 * 3);
  assert.equal(line(r, 'poya_overtime'), 4 * 500 * 3);
});

test('ph_days prices at (basic_salary / ph_day_rate_divisor) × ph_day_multiplier — a full statutory day, not the derived hourly rate', () => {
  // Defaults from draftPayrollSettings(): ph_day_rate_divisor 25, ph_day_multiplier 2.
  const r = calc(entry({ ph_days: 1 }));
  assert.equal(line(r, 'ph_day'), (100000 / 25) * 2);
});

test('poya_days prices at (basic_salary / poya_day_rate_divisor) × poya_day_multiplier — the statutory half-day rate, not the derived hourly rate', () => {
  // Defaults from draftPayrollSettings(): poya_day_rate_divisor 25, poya_day_multiplier 0.5.
  const r = calc(entry({ poya_days: 1 }));
  assert.equal(line(r, 'poya_day'), (100000 / 25) * 0.5);
});

test('PH and Poya Day pay are both independent of default_hours_per_day — only PH/Poya Overtime and No-Pay still depend on it', () => {
  const withHoursPerDay8 = calc(entry({ ph_days: 1, poya_days: 1 }), { default_hours_per_day: 8 });
  const withHoursPerDay4 = calc(entry({ ph_days: 1, poya_days: 1 }), { default_hours_per_day: 4 });
  assert.equal(line(withHoursPerDay8, 'ph_day'), line(withHoursPerDay4, 'ph_day'));
  assert.equal(line(withHoursPerDay4, 'ph_day'), (100000 / 25) * 2);
  assert.equal(line(withHoursPerDay8, 'poya_day'), line(withHoursPerDay4, 'poya_day'));
  assert.equal(line(withHoursPerDay4, 'poya_day'), (100000 / 25) * 0.5);
});

test('mercantile_days prices at (basic_salary / mercantile_day_rate_divisor) × mercantile_day_multiplier — a full statutory day, not the derived hourly rate', () => {
  // Defaults from draftPayrollSettings(): mercantile_day_rate_divisor 25, mercantile_day_multiplier 1.
  const r = calc(entry({ mercantile_days: 1 }));
  assert.equal(line(r, 'mercantile_day'), (100000 / 25) * 1);
});

test('Mercantile Day pay is independent of default_hours_per_day, same as Poya Day pay', () => {
  const withHoursPerDay8 = calc(entry({ mercantile_days: 1 }), { default_hours_per_day: 8 });
  const withHoursPerDay4 = calc(entry({ mercantile_days: 1 }), { default_hours_per_day: 4 });
  assert.equal(line(withHoursPerDay8, 'mercantile_day'), line(withHoursPerDay4, 'mercantile_day'));
  assert.equal(line(withHoursPerDay4, 'mercantile_day'), (100000 / 25) * 1);
});

test('mercantile_hours_overtime prices mercantile_overtime at the plain hourly rate — same basis as PH/Poya overtime, not the statutory day rate', () => {
  const r = calc(entry({ mercantile_hours_overtime: 6 }), { mercantile_overtime_multiplier: 3 });
  // hourlyRate = basic_salary / default_target_hours = 100000 / 200 = 500
  assert.equal(line(r, 'mercantile_overtime'), 6 * 500 * 3);
});

test('EPF/ETF base includes Basic Salary plus PH/Poya/Mercantile Day pay, but not their Overtime lines or ordinary OT', () => {
  const r = calc(entry({
    ph_days: 1, poya_days: 1, mercantile_days: 1,
    ot_hours_normal: 10, ph_hours_overtime: 2,
  }));
  // Defaults: ph_day_rate_divisor 25/multiplier 2 → 100000/25*2=8000
  //           poya_day_rate_divisor 25/multiplier 0.5 → 100000/25*0.5=2000
  //           mercantile_day_rate_divisor 25/multiplier 1 → 100000/25*1=4000
  // ot_hours_normal and ph_hours_overtime must NOT be in the base.
  assert.equal(r.epf_base, 100000 + 8000 + 2000 + 4000);
  assert.equal(r.etf_base, 100000 + 8000 + 2000 + 4000);
  // epf_employee_rate defaults to 8 in draftPayrollSettings().
  assert.equal(line(r, 'epf_employee'), (100000 + 8000 + 2000 + 4000) * 0.08);
});

test('EPF/ETF base propagates null when a Day pay amount is unresolved, rather than silently excluding it', () => {
  const r = calc(entry({ poya_days: 1 }), { poya_day_rate_divisor: null });
  assert.equal(r.epf_base, null);
  assert.equal(r.etf_base, null);
  assert.equal(line(r, 'epf_employee'), null);
});

function stampFeeLine(r: ReturnType<typeof calculatePayrollForEmployee>) {
  return r.lines.find(l => l.type === 'deduction' && l.name === 'Stamp Fee')?.amount;
}

// EPF/ETF/Tax all disabled on this fixture so total_deductions isolates stamp duty alone —
// with them on (emptyPayrollEmployee()'s own default), EPF/APIT would also contribute.
const noStatutoryEmployee = { is_epf_applicable: false, is_etf_applicable: false, is_tax_applicable: false };

test('Stamp Duty is deducted from every employee unconditionally, at the configured flat amount', () => {
  const r = calc(entry(), { stamp_duty_amount: 25 }, noStatutoryEmployee);
  assert.equal(stampFeeLine(r), 25);
  assert.equal(r.total_deductions, 25);
});

test('Stamp Duty is a "deduction" line named exactly "Stamp Fee" — the physical payslip template\'s pre-existing row, matched by name (see payrollPayslipExport.ts NAMED_DEDUCTIONS)', () => {
  const r = calc(entry(), { stamp_duty_amount: 25 }, noStatutoryEmployee);
  const found = r.lines.find(l => l.name === 'Stamp Fee');
  assert.equal(found?.type, 'deduction');
});

test('Stamp Duty unresolved (not configured) nulls total_deductions and net_pay rather than silently charging nothing', () => {
  const r = calc(entry(), { stamp_duty_amount: null }, noStatutoryEmployee);
  assert.equal(stampFeeLine(r), null);
  assert.equal(r.total_deductions, null);
  assert.equal(r.net_pay, null);
});

test('calculateProgressiveTax: each bracket taxes only its own slice', () => {
  const slabs = [
    { from: 0, to: 100000, rate: 0 },
    { from: 100000, to: 200000, rate: 10 },
    { from: 200000, to: null, rate: 20 },
  ];
  assert.equal(calculateProgressiveTax(50000, slabs), 0);
  assert.equal(calculateProgressiveTax(150000, slabs), 5000); // 50,000 taxed at 10%
  assert.equal(calculateProgressiveTax(250000, slabs), 10000 + 10000); // bracket 2 full + 50k at 20%
  assert.equal(calculateProgressiveTax(0, slabs), 0);
  assert.equal(calculateProgressiveTax(100000, []), 0);
});

test('calculateProgressiveTax: Southern Lanka\'s configured APIT table (2025 monthly slabs, tax-free up to 150,000)', () => {
  // Exactly what's entered on the Payroll Settings page — the "150,001" / "233,334" style
  // `from` values are the human-readable convention (one rupee after the previous bracket's
  // `to`); the engine always splits on the previous bracket's own `to`, never on `from` (see
  // calculateProgressiveTax's own comment), so this is the real, saved table, not a
  // reconstruction of it.
  const slabs = [
    { from: 0,      to: 150000, rate: 0 },
    { from: 150001, to: 233333, rate: 6 },
    { from: 233334, to: 275000, rate: 18 },
    { from: 275001, to: 316666, rate: 24 },
    { from: 316667, to: 358333, rate: 30 },
    { from: 358334, to: null,   rate: 36 },
  ];
  assert.equal(calculateProgressiveTax(100000, slabs), 0); // below the tax-free threshold
  assert.equal(calculateProgressiveTax(150000, slabs), 0); // exactly at the threshold — still tax-free
  // Exactly at the 6% bracket's own ceiling — loop exits via the `<= upper` branch, not the
  // final iteration's open-ended one; worth pinning since that's a different code path.
  assert.equal(calculateProgressiveTax(233333, slabs), 4999.98);
  // Straddles brackets 4 and 5 (275,000 / 316,666 boundary).
  assert.equal(calculateProgressiveTax(300000, slabs), 18500.04);
  // Deep in the open-ended top bracket (36%) — every lower bracket's full slice, plus 36% of
  // the remainder above 358,333. Compared with a cent-level tolerance: summing six floating-
  // point slices lands on 86000.09999999999, not a bug, just binary floating point — the same
  // tolerance any real money comparison here would need.
  assert.ok(Math.abs(calculateProgressiveTax(500000, slabs) - 86000.1) < 0.01);
});
