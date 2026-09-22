import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupBillsByCategory, voucherCategoryOf, UNCATEGORISED } from '../voucherCategories';
import type { SuspenseSubmission } from '../types';

const bill = (over: Partial<SuspenseSubmission> & { id: string }): SuspenseSubmission => ({
  epf_number: 'E1', employee_name: 'Amal', company_id: 'c1', company_name: 'Alta Vision',
  category: 'Fuel', subcategory: 'Van', expense_type: 'Fuel · Van',
  shop_name: 'Shell', item: 'Diesel', amount: 100, vat_amount: 0, status: 'approved',
  ...over,
} as SuspenseSubmission);

test('a bill counts under its category', () => {
  assert.equal(voucherCategoryOf({ category: 'Fuel', expense_type: 'Fuel · Van' }), 'Fuel');
  assert.equal(voucherCategoryOf({ category: '  Food  ', expense_type: '' }), 'Food');
});

test('a legacy bill still groups with its modern siblings', () => {
  // Pre-split bills carry only the derived "Category · Subcategory · Type" label.
  assert.equal(voucherCategoryOf({ category: undefined, expense_type: 'Fuel · Van · Diesel' }), 'Fuel');
  assert.equal(voucherCategoryOf({ category: '', expense_type: 'Highway Expenses' }), 'Highway Expenses');
  assert.equal(voucherCategoryOf({ category: '', expense_type: '' }), UNCATEGORISED);
});

test('groups carry a subtotal that adds back up to the voucher total', () => {
  const bills = [
    bill({ id: 'a', category: 'Fuel', amount: 5000, vat_amount: 750 }),
    bill({ id: 'b', category: 'Food', amount: 1200 }),
    bill({ id: 'c', category: 'Fuel', amount: 2500, vat_amount: 375 }),
    bill({ id: 'd', category: 'Highway', amount: 250 }),
    bill({ id: 'e', category: undefined, expense_type: 'Fuel · Van', amount: 300 }),  // legacy, joins Fuel
  ];
  const groups = groupBillsByCategory(bills);
  assert.deepEqual(groups.map(g => g.category), ['Fuel', 'Food', 'Highway']);   // biggest first
  const fuel = groups[0];
  assert.equal(fuel.total, 7800);          // 5000 + 2500 + 300
  assert.equal(fuel.vat, 1125);
  assert.equal(fuel.count, 3);
  assert.deepEqual(fuel.bills.map(b => b.id), ['a', 'c', 'e']);   // arrival order kept
  assert.equal(
    groups.reduce((t, g) => t + g.total, 0),
    bills.reduce((t, b) => t + b.amount, 0),
  );
});

test('the uncategorised bucket sorts last however large it is', () => {
  const groups = groupBillsByCategory([
    bill({ id: 'x', category: '', expense_type: '', amount: 999_999 }),
    bill({ id: 'y', category: 'Food', amount: 10 }),
  ]);
  assert.deepEqual(groups.map(g => g.category), ['Food', UNCATEGORISED]);
});

test('equal totals order alphabetically, so the list does not jitter between renders', () => {
  const groups = groupBillsByCategory([
    bill({ id: '1', category: 'Water', amount: 500 }),
    bill({ id: '2', category: 'Airtime', amount: 500 }),
    bill({ id: '3', category: 'Postal', amount: 500 }),
  ]);
  assert.deepEqual(groups.map(g => g.category), ['Airtime', 'Postal', 'Water']);
});

test('rounding stays at the cent across a group', () => {
  const groups = groupBillsByCategory([
    bill({ id: 'a', category: 'Fuel', amount: 0.1 }),
    bill({ id: 'b', category: 'Fuel', amount: 0.2 }),
  ]);
  assert.equal(groups[0].total, 0.3);
});

test('an empty voucher groups to nothing', () => {
  assert.deepEqual(groupBillsByCategory([]), []);
});
