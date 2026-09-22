import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBalanceAmount,
  buildBalanceDraftRows,
  carryForwardPeriod,
  carryForwardHeader,
  defaultCarryForwardDate,
  findAmountColumn,
  formatCarryForwardDate,
  toDateInputValue,
  fromDateInputValue,
  type ParsedBalanceRow,
} from '../suspenseBalanceImport';
import type { AppUser, SuspenseAccount } from '../types';

// Only the fields the resolver actually reads — the rest of AppUser/SuspenseAccount is
// irrelevant here and would just be noise.
const acct = (epf: string, companyId: string, balance: number, extra: Partial<SuspenseAccount> = {}): SuspenseAccount =>
  ({
    epf_number: epf, employee_name: `Emp ${epf}`, company_id: companyId,
    company_name: companyId.toUpperCase(), balance, currency: 'LKR', is_active: true, ...extra,
  } as SuspenseAccount);

const user = (epf: string, companyId: string): AppUser =>
  ({
    epf_number: epf, display_name: `Emp ${epf}`, company_id: companyId,
    company_name: companyId.toUpperCase(), is_active: true,
  } as AppUser);

const row = (epfRaw: string, balanceRaw: string, companyRaw = ''): ParsedBalanceRow =>
  ({ epfRaw, nameRaw: '', companyRaw, balanceRaw });

// ─── parseBalanceAmount ───────────────────────────────────────────────────────
test('parseBalanceAmount reads the shapes a real ledger export uses', () => {
  assert.equal(parseBalanceAmount('1500'), 1500);
  assert.equal(parseBalanceAmount('1,234.50'), 1234.5);
  assert.equal(parseBalanceAmount('-2500'), -2500);
  assert.equal(parseBalanceAmount('(1,500)'), -1500);      // accounting negative
  assert.equal(parseBalanceAmount('1500-'), -1500);        // trailing minus
  assert.equal(parseBalanceAmount('LKR 1,500.25'), 1500.25);
  assert.equal(parseBalanceAmount('Rs. 300'), 300);
  assert.equal(parseBalanceAmount('+750'), 750);
  assert.equal(parseBalanceAmount('0'), 0);
});

test('parseBalanceAmount rounds to 2dp and never returns -0', () => {
  assert.equal(parseBalanceAmount('10.005'), 10.01);
  assert.equal(Object.is(parseBalanceAmount('-0.001'), 0), true);
});

test('parseBalanceAmount refuses anything it cannot read with certainty', () => {
  assert.equal(parseBalanceAmount(''), null);
  assert.equal(parseBalanceAmount('   '), null);
  assert.equal(parseBalanceAmount('n/a'), null);
  assert.equal(parseBalanceAmount('1500 approx'), null);
  assert.equal(parseBalanceAmount('1.234,50'), null);   // European — stripping commas would give 1.23
});

// ─── Periods ──────────────────────────────────────────────────────────────────
test('the period is the month the as-at date falls in, and defaults to the 1st of this month', () => {
  assert.equal(carryForwardPeriod(new Date(2026, 8, 1)), '2026-09');
  assert.equal(carryForwardPeriod(new Date(2026, 0, 31)), '2026-01');
  const d = defaultCarryForwardDate(new Date(2026, 8, 9));
  assert.equal(toDateInputValue(d), '2026-09-01');
});

test('date input values round-trip through LOCAL midnight, never UTC', () => {
  const d = fromDateInputValue('2026-09-01');
  assert.ok(d);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 8);
  assert.equal(d.getDate(), 1);           // would slip to Aug 31 in a negative-offset zone via toISOString
  assert.equal(toDateInputValue(d), '2026-09-01');
  assert.equal(fromDateInputValue('nonsense'), null);
  assert.equal(fromDateInputValue(''), null);
});

// ─── Header resolution ────────────────────────────────────────────────────────
// parseBalanceWorkbook normalizes headers to lowercase alphanumerics before matching, so these
// are the strings findAmountColumn actually sees.
test('the dated Carry Forward header the template writes is matched by prefix', () => {
  const header = carryForwardHeader(new Date(2026, 8, 1));
  assert.equal(header, 'Carry Forward as at 01 Sep 2026');
  assert.equal(formatCarryForwardDate(new Date(2026, 8, 1)), '01 Sep 2026');
  // ['epfnumber', 'employeename', 'company', 'currentbalance', 'carryforwardasat01sep2026']
  const normalized = ['epfnumber', 'employeename', 'company', 'currentbalance', 'carryforwardasat01sep2026'];
  assert.equal(findAmountColumn(normalized), 4);
  // …and an undated one, and a differently dated one, resolve to the same column.
  assert.equal(findAmountColumn(['epfnumber', 'carryforward']), 1);
  assert.equal(findAmountColumn(['epfnumber', 'carryforwardasat01jan2027']), 1);
  assert.equal(findAmountColumn(['epfnumber', 'broughtforward']), 1);
});

test('"Current Balance" is never mistaken for the column to read', () => {
  // Reference-only: a sheet carrying just it has nothing to import, and must say so rather than
  // silently re-applying every current balance as a movement.
  assert.equal(findAmountColumn(['epfnumber', 'employeename', 'currentbalance']), -1);
  // Beside a real carry-forward column, the carry-forward one wins wherever it sits.
  assert.equal(findAmountColumn(['currentbalance', 'carryforward']), 1);
  assert.equal(findAmountColumn(['carryforward', 'currentbalance']), 0);
});

test('"New Balance" is no longer a column this importer reads', () => {
  assert.equal(findAmountColumn(['epfnumber', 'currentbalance', 'newbalance']), -1);
});

// ─── buildBalanceDraftRows ────────────────────────────────────────────────────
test('the uploaded figure is ADDED to the balance, not set as it', () => {
  const rows = buildBalanceDraftRows([row('E1', '2500')], [acct('E1', 'c1', 1000)], [user('E1', 'c1')]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].issue, '');
  assert.equal(rows[0].action, 'adjust');
  assert.equal(rows[0].current, 1000);
  assert.equal(rows[0].amount, 2500);
  assert.equal(rows[0].resulting, 3500);
});

test('a negative figure reduces the balance', () => {
  const rows = buildBalanceDraftRows([row('E1', '-2000')], [acct('E1', 'c1', 500)], [user('E1', 'c1')]);
  assert.equal(rows[0].amount, -2000);
  assert.equal(rows[0].resulting, -1500);
  assert.equal(rows[0].action, 'adjust');
});

test('0.00 carries nothing and LEAVES a funded account alone', () => {
  // The whole point of the movement model: 10,000 against 0.00 stays 10,000, it is not zeroed.
  const rows = buildBalanceDraftRows([row('E1', '0.00')], [acct('E1', 'c1', 10000)], [user('E1', 'c1')]);
  assert.equal(rows[0].action, 'unchanged');
  assert.equal(rows[0].amount, 0);
  assert.equal(rows[0].resulting, 10000);
});

test('an employee with no account yet resolves to their own company and opens one', () => {
  const rows = buildBalanceDraftRows([row('E2', '-750')], [], [user('E2', 'c9')]);
  assert.equal(rows[0].issue, '');
  assert.equal(rows[0].action, 'open');
  assert.equal(rows[0].company_id, 'c9');
  assert.equal(rows[0].current, null);
  assert.equal(rows[0].amount, -750);
  assert.equal(rows[0].resulting, -750);   // opening straight into the negative
});

test('a blank amount cell leaves that account alone', () => {
  const rows = buildBalanceDraftRows([row('E1', ''), row('E1', '  ')], [acct('E1', 'c1', 1000)], [user('E1', 'c1')]);
  assert.deepEqual(rows, []);
});

test('whitespace inside an EPF still matches the account', () => {
  const rows = buildBalanceDraftRows([row('SLH/E 378', '400')], [acct('SLH/E378', 'c1', 100)], []);
  assert.equal(rows[0].issue, '');
  assert.equal(rows[0].resulting, 500);
});

test('several company accounts with no Company column is flagged, never guessed', () => {
  const accounts = [acct('E1', 'c1', 100), acct('E1', 'c2', 200)];
  const rows = buildBalanceDraftRows([row('E1', '500')], accounts, [user('E1', 'c1')]);
  assert.match(rows[0].issue, /Holds 2 company accounts/);
});

test('a Company column picks the right one of several accounts', () => {
  const accounts = [acct('E1', 'c1', 100), acct('E1', 'c2', 200)];
  const rows = buildBalanceDraftRows([row('E1', '500', 'C2')], accounts, [user('E1', 'c1')]);
  assert.equal(rows[0].issue, '');
  assert.equal(rows[0].company_id, 'c2');
  assert.equal(rows[0].resulting, 700);
});

test('closed and frozen accounts are refused', () => {
  const closed = buildBalanceDraftRows([row('E1', '500')], [acct('E1', 'c1', 0, { is_closed: true })], []);
  assert.match(closed[0].issue, /closed/);
  const frozen = buildBalanceDraftRows([row('E2', '500')], [acct('E2', 'c1', 0, { is_active: false })], []);
  assert.match(frozen[0].issue, /close request is pending/);
});

test('unknown EPFs and unreadable amounts are reported, not applied', () => {
  const unknown = buildBalanceDraftRows([row('NOPE', '500')], [], []);
  assert.match(unknown[0].issue, /not an active employee/);
  const bad = buildBalanceDraftRows([row('E1', 'n/a')], [acct('E1', 'c1', 0)], [user('E1', 'c1')]);
  assert.match(bad[0].issue, /Invalid amount/);
});

test('the same account listed twice only counts once', () => {
  const rows = buildBalanceDraftRows(
    [row('E1', '500'), row('E1', '900')],
    [acct('E1', 'c1', 0)], [user('E1', 'c1')],
  );
  assert.equal(rows[0].issue, '');
  assert.match(rows[1].issue, /more than once/);
});

// ─── The repeat guard ─────────────────────────────────────────────────────────
test('an account that already took this period is flagged as a repeat, not as an issue', () => {
  const accounts = [acct('E1', 'c1', 1000, { carry_forward_periods: ['2026-08', '2026-09'] })];
  const rows = buildBalanceDraftRows([row('E1', '500')], accounts, [user('E1', 'c1')], '2026-09');
  assert.equal(rows[0].alreadyCarried, true);
  assert.equal(rows[0].issue, '');            // the row itself is fine — it just looks re-run
  assert.equal(rows[0].resulting, 1500);      // still previewed, in case it is overridden
});

test('an earlier period already carried is caught too, not just the most recent one', () => {
  const accounts = [acct('E1', 'c1', 1000, { carry_forward_periods: ['2026-08', '2026-09'] })];
  const rows = buildBalanceDraftRows([row('E1', '500')], accounts, [user('E1', 'c1')], '2026-08');
  assert.equal(rows[0].alreadyCarried, true);
});

test('a period never carried, an account with no history, and no period at all are all clear', () => {
  const carried = [acct('E1', 'c1', 1000, { carry_forward_periods: ['2026-08'] })];
  assert.equal(buildBalanceDraftRows([row('E1', '500')], carried, [], '2026-09')[0].alreadyCarried, false);
  const fresh = [acct('E1', 'c1', 1000)];
  assert.equal(buildBalanceDraftRows([row('E1', '500')], fresh, [], '2026-09')[0].alreadyCarried, false);
  // No period passed (the date field is empty) — nothing to compare against, so nothing is flagged.
  assert.equal(buildBalanceDraftRows([row('E1', '500')], carried, [])[0].alreadyCarried, false);
});

test('a new account can never be a repeat — there is nothing to have carried into yet', () => {
  const rows = buildBalanceDraftRows([row('E2', '500')], [], [user('E2', 'c9')], '2026-09');
  assert.equal(rows[0].action, 'open');
  assert.equal(rows[0].alreadyCarried, false);
});
