import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculatePayrollForEmployee, type PayrollCalculationInput } from '../payroll/payrollCalculationEngine';
import type { SuspenseSplitCharge } from '../payrollTypes';

// A deliberately boring, fully-configured employee: every rate and multiplier set so nothing in
// the engine goes null, and no OT/no-pay/holiday hours so the arithmetic is easy to reason about.
// The assertions below are all DELTAS against this same base, which is what keeps the test about
// suspense splits rather than about payroll's own figures.
const base = (): PayrollCalculationInput => ({
  settings: {
    id: 'global',
    tax_slabs: [{ from: 0, to: null, rate: 0 }],
    default_hours_per_day: 8, default_target_hours: 200,
    epf_employee_rate: 8, epf_employer_rate: 12, etf_employer_rate: 3,
    // Every figure gross_pay and total_deductions guard on must be configured, or they go null
    // and the deltas below compare null to null — which is 0, not a failure anyone can read.
    // Keep this in step with the engine's null-guards when new pay components are added.
    stamp_duty_amount: 25,
    ph_day_rate_divisor: 240, poya_day_rate_divisor: 240,
    mercantile_day_multiplier: 2, mercantile_day_rate_divisor: 240, mercantile_overtime_multiplier: 2,
    ph_day_multiplier: 2, ph_overtime_multiplier: 2,
    poya_day_multiplier: 2, poya_overtime_multiplier: 2,
  } as unknown as PayrollCalculationInput['settings'],
  components: new Map(),
  employee: {
    id: 'e1', epf_number: 'E1', company_id: 'c1', basic_salary: 100_000,
    allowances: [], deductions: [],
    ot_rate_mode: 'TARGET_HOURS', ot_multiplier_normal: 1.5, ot_multiplier_double: 2,
    epf_eligible: true, target_hours_override: null, ot_fixed_hourly_rate: null,
    tax_override_amount: null,
  } as unknown as PayrollCalculationInput['employee'],
  monthlyEntry: {
    id: 'm1', run_id: 'r1', epf_number: 'E1', employee_name: 'Amal',
    ot_hours_normal: 0, ot_hours_double: 0, no_pay_hours: 0, no_pay_days: 0,
    ph_days: 0, ph_hours_overtime: 0, poya_days: 0, poya_hours_overtime: 0,
    one_off_lines: [],
  } as unknown as PayrollCalculationInput['monthlyEntry'],
  activeLoans: [],
  activeSalaryAdvances: [],
});

const charge = (over: Partial<SuspenseSplitCharge> = {}): SuspenseSplitCharge => ({
  submission_id: 'bill1', bill_no: '77', owed_by_epf: 'E1',
  payer_epf: 'PAYER', payer_name: 'Amila Nuwan', amount: 475,
  ...over,
});

test('the payroll engine stays untouched when nobody split a bill to this employee', () => {
  const none = calculatePayrollForEmployee(base());
  const empty = calculatePayrollForEmployee({ ...base(), suspenseSplits: [] });
  assert.equal(none.lines.some(l => l.type === 'suspense_recovery'), false);
  assert.equal(empty.lines.some(l => l.type === 'suspense_recovery'), false);
  assert.equal(empty.total_deductions, none.total_deductions);
  assert.equal(empty.net_pay, none.net_pay);
});

test('a suspense split becomes one deduction line and comes straight off net pay', () => {
  const before = calculatePayrollForEmployee(base());
  const after = calculatePayrollForEmployee({
    ...base(),
    suspenseSplits: [charge({ amount: 475 }), charge({ submission_id: 'bill2', bill_no: '76', amount: 275 })],
  });

  const line = after.lines.find(l => l.type === 'suspense_recovery')!;
  assert.ok(line, 'a suspense_recovery line should exist');
  assert.equal(line.amount, 750);
  assert.equal(line.units, 2);              // two bills behind the one figure
  assert.equal(line.code, 'SUSPENSE_SPLITS');

  // Gross is untouched — this is a deduction, never a change to what was earned.
  assert.equal(after.gross_pay, before.gross_pay);
  assert.equal(after.total_deductions! - before.total_deductions!, 750);
  assert.equal(before.net_pay! - after.net_pay!, 750);
  // EPF/tax bases must NOT move: a suspense split is a recovery of someone else's money, not a
  // reduction in earnings, so it cannot quietly lower this employee's statutory contributions.
  assert.equal(after.epf_base, before.epf_base);
  assert.equal(after.taxable_base, before.taxable_base);
  assert.equal(after.apit_amount, before.apit_amount);
});

test('the line carries the exact splits it deducted, so finalising credits only those', () => {
  // Finalising reads these refs rather than re-querying: a split raised between generating and
  // finalising must not be credited to a payer who was never charged for it on this payslip.
  const refs = [charge({ submission_id: 'a', amount: 100 }), charge({ submission_id: 'b', amount: 250 })];
  const r = calculatePayrollForEmployee({ ...base(), suspenseSplits: refs });
  const line = r.lines.find(l => l.type === 'suspense_recovery')!;
  assert.deepEqual(line.suspense_refs?.map(x => [x.submission_id, x.amount]), [['a', 100], ['b', 250]]);
  assert.equal(line.suspense_refs?.every(x => x.payer_epf === 'PAYER'), true);
});

test('zero and negative splits are ignored rather than printed as an empty deduction', () => {
  const r = calculatePayrollForEmployee({
    ...base(),
    suspenseSplits: [charge({ amount: 0 }), charge({ submission_id: 'b', amount: -50 })],
  });
  assert.equal(r.lines.some(l => l.type === 'suspense_recovery'), false);
  assert.equal(r.total_deductions, calculatePayrollForEmployee(base()).total_deductions);
});
