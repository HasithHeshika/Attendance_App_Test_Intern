import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSuspenseMonthView, summarizeHolderMonth, billDayOf, ownShareOf, floatCostOf, splitsOwedBack, isCreditEntry,
  groupByDay, compactAmount, localDayKey,
} from '../suspenseMonthView';
import type { SuspenseAccount, SuspenseLedgerEntry, SuspenseRequest, SuspenseSubmission } from '../types';

// Local-midnight timestamps, exactly as the submit form writes bill_date.
const at = (y: number, m: number, d: number, h = 9) => ({ seconds: Math.floor(new Date(y, m - 1, d, h).getTime() / 1000) });
type TS = SuspenseSubmission['created_at'];

function bill(over: Partial<SuspenseSubmission> & { id: string; epf_number: string }): SuspenseSubmission {
  return {
    employee_name: over.epf_number === 'E1' ? 'Amal' : over.epf_number === 'E2' ? 'Nimal' : over.epf_number,
    company_id: 'c1', company_name: 'Alta Vision',
    expense_type: 'Fuel · Van', category: 'Fuel', subcategory: 'Van',
    shop_name: 'Shell', item: 'Diesel', amount: 100,
    bill_url: null, bill_type: null, bill_name: null, bill_kind: null,
    note: '', status: 'approved',
    considered_by: null, considered_by_name: null, considered_at: null, reject_reason: null,
    created_at: at(2026, 8, 5) as unknown as TS, updated_at: at(2026, 8, 5) as unknown as TS,
    ...over,
  } as SuspenseSubmission;
}
function entry(over: Partial<SuspenseLedgerEntry> & { id: string; epf_number: string }): SuspenseLedgerEntry {
  return {
    company_id: 'c1', kind: 'credit', amount: 500, balance_after: 500,
    ref_type: 'request', ref_id: null, note: 'Top-up', actor_epf: 'A', actor_name: 'Admin',
    created_at: at(2026, 8, 3) as unknown as SuspenseLedgerEntry['created_at'],
    ...over,
  } as SuspenseLedgerEntry;
}
function account(over: Partial<SuspenseAccount> & { epf_number: string }): SuspenseAccount {
  return {
    employee_name: over.epf_number === 'E1' ? 'Amal' : 'Nimal', company_id: 'c1', company_name: 'Alta Vision',
    balance: 1000, currency: 'LKR', is_active: true, created_by: 'A', created_by_name: 'Admin',
    created_at: at(2026, 1, 1) as unknown as SuspenseAccount['created_at'],
    updated_at: at(2026, 1, 1) as unknown as SuspenseAccount['updated_at'],
    ...over,
  } as SuspenseAccount;
}

// ─── day keys ─────────────────────────────────────────────────────────────────

test('a bill belongs to its bill date, falling back to when it was submitted', () => {
  const dated = bill({ id: 'a', epf_number: 'E1', bill_date: at(2026, 7, 31) as unknown as TS, created_at: at(2026, 8, 2) as unknown as TS });
  assert.equal(billDayOf(dated), '2026-07-31');
  const undated = bill({ id: 'b', epf_number: 'E1', created_at: at(2026, 8, 2) as unknown as TS });
  assert.equal(billDayOf(undated), '2026-08-02');
});

test('local midnight stays on its own day', () => {
  assert.equal(localDayKey(new Date(2026, 8, 1, 0, 0).getTime()), '2026-09-01');
  assert.equal(localDayKey(new Date(2026, 8, 1, 23, 59).getTime()), '2026-09-01');
});

test('own share is the bill less what was split away', () => {
  assert.equal(ownShareOf({ amount: 100, splits: [{ epf_number: 'X', employee_name: 'X', amount: 30 }] }), 70);
  assert.equal(ownShareOf({ amount: 25.005, splits: [] }), 25.01);
});

test('the float pays the WHOLE bill; a split is a receivable, not a discount', () => {
  const split = (epf: string, amount: number, recovered_at?: unknown) =>
    ({ epf_number: epf, employee_name: epf, amount, recovered_at: recovered_at ?? null });
  const b = bill({
    id: 'x', epf_number: 'E1', amount: 1900,
    splits: [split('A', 475), split('B', 475), split('C', 475), split('D', 475)] as never,
  });
  // Every rupee left the payer's hand, so every rupee leaves the balance. Netting the splits off
  // is what let two fully-split bills debit exactly nothing and put a payer LKR 12,792 down.
  assert.equal(floatCostOf(b), 1900);
  assert.equal(ownShareOf(b), 0);        // still true, and still meaningless to the float
  assert.equal(splitsOwedBack(b.splits), 1900);

  // As payroll deducts each colleague, less is owed back — the float is credited separately.
  const partly = bill({
    id: 'y', epf_number: 'E1', amount: 1900,
    splits: [split('A', 475, at(2026, 9, 1)), split('B', 475, at(2026, 9, 1)), split('C', 475), split('D', 475)] as never,
  });
  assert.equal(splitsOwedBack(partly.splits), 950);
  assert.equal(floatCostOf(partly), 1900);   // what it cost never changes as recoveries land
  assert.equal(splitsOwedBack(bill({ id: 'z', epf_number: 'E1', amount: 500 }).splits), 0);
});

test('only money coming in is a credit', () => {
  assert.equal(isCreditEntry({ kind: 'credit', amount: 100 }), true);
  assert.equal(isCreditEntry({ kind: 'opening', amount: 100 }), true);
  assert.equal(isCreditEntry({ kind: 'adjustment', amount: 100 }), true);
  // A negative adjustment IS a float movement — money taken back. Excluding it deleted it from
  // every credit total on the page while its line was still drawn (live data: 7 of them, one
  // −127,001), so the kind decides and the amount carries the direction.
  assert.equal(isCreditEntry({ kind: 'adjustment', amount: -100 }), true);
  assert.equal(isCreditEntry({ kind: 'debit', amount: -100 }), false);
  assert.equal(isCreditEntry({ kind: 'settlement', amount: 100 }), false);
  // A zero movement is not a line (the balance import writes opening entries of 0).
  assert.equal(isCreditEntry({ kind: 'opening', amount: 0 }), false);
});

// ─── month view ───────────────────────────────────────────────────────────────

test('who took how much, on which days, with totals', () => {
  const view = buildSuspenseMonthView({
    year: 2026, month: 8,
    accounts: [
      account({ epf_number: 'E1', balance: 400 }),
      account({ epf_number: 'E2', balance: -50 }),
      account({ epf_number: 'E4', balance: 10 }),   // a holder with nothing at all this month
    ],
    submissions: [
      bill({ id: 's1', epf_number: 'E1', amount: 100, bill_date: at(2026, 8, 5) as unknown as TS }),
      bill({ id: 's2', epf_number: 'E1', amount: 200, bill_date: at(2026, 8, 5) as unknown as TS,
             splits: [{ epf_number: 'E2', employee_name: 'Nimal', amount: 50 }] }),
      bill({ id: 's3', epf_number: 'E1', amount: 999, status: 'pending', bill_date: at(2026, 8, 20) as unknown as TS }),
      bill({ id: 's4', epf_number: 'E1', amount: 5, status: 'rejected', bill_date: at(2026, 8, 21) as unknown as TS }),
      bill({ id: 's5', epf_number: 'E1', amount: 77, bill_date: at(2026, 7, 30) as unknown as TS }),  // last month
      bill({ id: 's6', epf_number: 'E1', amount: 88, deleted: true, bill_date: at(2026, 8, 6) as unknown as TS }),
      bill({ id: 's1', epf_number: 'E1', amount: 100, bill_date: at(2026, 8, 5) as unknown as TS }),   // duplicate from the 2nd query
    ],
    ledger: [
      entry({ id: 'l1', epf_number: 'E1', amount: 500 }),
      entry({ id: 'l2', epf_number: 'E1', kind: 'debit', amount: -100 }),
      entry({ id: 'l3', epf_number: 'E2', kind: 'adjustment', amount: -20 }),
      entry({ id: 'l4', epf_number: 'E3', kind: 'opening', amount: 300, created_at: at(2026, 8, 10) as unknown as SuspenseLedgerEntry['created_at'] }),
    ],
  });

  const amal = view.people.find(p => p.epf === 'E1')!;
  assert.equal(amal.spent, 300);          // 100 + 200 — the WHOLE bill leaves the float, split included
  assert.equal(amal.billed, 300);
  assert.equal(amal.pending, 999);
  assert.equal(amal.pendingCount, 1);
  assert.equal(amal.rejected, 5);
  assert.equal(amal.credit, 500);
  assert.equal(amal.billCount, 3);        // approved + pending; rejected and deleted are not "taken"
  assert.equal(amal.balance, 400);
  assert.deepEqual(amal.days.map(d => d.date), ['2026-08-21', '2026-08-20', '2026-08-05', '2026-08-03']);
  const fifth = amal.days.find(d => d.date === '2026-08-05')!;
  assert.equal(fifth.spent, 300);
  assert.equal(fifth.lines.length, 2);

  // A NEGATIVE adjustment is a float movement and counts — it used to be dropped entirely, which
  // left the month's credit reading high and this person looking idle when money had moved.
  const nimal = view.people.find(p => p.epf === 'E2')!;
  assert.equal(nimal.active, true);
  assert.equal(nimal.credit, -20);
  assert.equal(nimal.spent, 0);
  assert.equal(nimal.balance, -50);

  // An account holder with nothing this month is still listed, so "took nothing" is visible.
  const idle = view.people.find(p => p.epf === 'E4')!;
  assert.equal(idle.active, false);
  assert.equal(idle.credit, 0);
  assert.equal(idle.balance, 10);

  // Someone with a ledger credit but no account row still appears, named by EPF.
  const e3 = view.people.find(p => p.epf === 'E3')!;
  assert.equal(e3.credit, 300);
  assert.equal(e3.balance, null);
  assert.equal(e3.name, 'E3');

  assert.equal(view.people[0].epf, 'E1');   // most spent first
  assert.equal(view.days.length, 31);
  assert.equal(view.days[4].spent, 300);     // the 5th
  assert.equal(view.days[4].people, 1);
  assert.equal(view.days[2].credit, 480);    // the 3rd: +500 to E1 and −20 back from E2
  assert.equal(view.days[9].credit, 300);    // the 10th
  assert.deepEqual(view.totals, {
    spent: 300, billed: 300, pending: 999, pendingCount: 1, rejected: 5,
    credit: 780,                             // 500 + 300 − 20: the NET put into floats this month
    billCount: 3, activePeople: 3, holders: 3,
  });
});

test('a closed account does not count toward the balance', () => {
  const view = buildSuspenseMonthView({
    year: 2026, month: 8, submissions: [], ledger: [],
    accounts: [
      account({ epf_number: 'E1', company_id: 'c1', balance: 100 }),
      account({ epf_number: 'E1', company_id: 'c2', company_name: 'Other', balance: 900, is_closed: true, is_active: false }),
    ],
  });
  const amal = view.people[0];
  assert.equal(amal.balance, 100);
  assert.equal(amal.balances.length, 2);
  assert.deepEqual(amal.companies, ['Alta Vision', 'Other']);
});

// ─── holder month ─────────────────────────────────────────────────────────────

test('the holder strip counts bills by bill day and credits by decision day', () => {
  const req = (over: Partial<SuspenseRequest> & { id: string }): SuspenseRequest => ({
    epf_number: 'E1', employee_name: 'Amal', company_id: 'c1', company_name: 'Alta Vision',
    amount: 1000, approved_amount: null, reason: '', status: 'pending',
    considered_by: null, considered_by_name: null, considered_at: null, reject_reason: null,
    created_at: at(2026, 8, 1) as unknown as SuspenseRequest['created_at'],
    updated_at: at(2026, 8, 1) as unknown as SuspenseRequest['updated_at'],
    ...over,
  } as SuspenseRequest);

  const s = summarizeHolderMonth({
    year: 2026, month: 8,
    submissions: [
      bill({ id: 'a', epf_number: 'E1', amount: 120, bill_date: at(2026, 8, 2) as unknown as TS,
             splits: [{ epf_number: 'E2', employee_name: 'Nimal', amount: 20 }] }),
      bill({ id: 'b', epf_number: 'E1', amount: 80, bill_date: at(2026, 8, 2) as unknown as TS }),
      bill({ id: 'c', epf_number: 'E1', amount: 30, bill_date: at(2026, 8, 9) as unknown as TS }),
      bill({ id: 'd', epf_number: 'E1', amount: 40, status: 'pending' }),
      bill({ id: 'e', epf_number: 'E1', amount: 10, status: 'rejected' }),
      bill({ id: 'f', epf_number: 'E1', amount: 500, bill_date: at(2026, 9, 1) as unknown as TS }),
    ],
    requests: [
      req({ id: 'r1', status: 'approved', amount: 1000, approved_amount: 800, considered_at: at(2026, 8, 4) as unknown as SuspenseRequest['considered_at'] }),
      req({ id: 'r2', status: 'approved', amount: 300, considered_at: at(2026, 7, 4) as unknown as SuspenseRequest['considered_at'] }),
      req({ id: 'r3', status: 'pending', amount: 250 }),
      req({ id: 'r4', status: 'rejected', amount: 9, considered_at: at(2026, 8, 4) as unknown as SuspenseRequest['considered_at'] }),
    ],
  });
  assert.equal(s.spent, 230);            // 120 + 80 + 30 — full bills; the 20 split is a receivable
  assert.equal(s.billed, 230);
  assert.equal(s.splitToOthers, 20);
  assert.equal(s.pending, 40);
  assert.equal(s.pendingCount, 1);
  assert.equal(s.rejected, 10);
  assert.equal(s.credit, 0);             // no ledger passed → nothing actually landed
  assert.equal(s.creditPending, 250);
  assert.equal(s.daily.length, 31);
  assert.equal(s.daily[1], 200);
  assert.equal(s.daily[8], 30);
  assert.deepEqual(s.busiestDay, { date: '2026-08-02', spent: 200 });
});

test('the holder strip reads credit off the LEDGER, not off approved requests', () => {
  // Money reaches a float by routes that never create a request: an approver's manual credit, an
  // opening balance, the month's carry-forward. Counting requests left 21 holder-months wrong on
  // live data — LKR 4.3M in total, one showing 0 against LKR 1,013,124 actually received.
  const led = (over: Partial<SuspenseLedgerEntry> & { id: string }): SuspenseLedgerEntry => ({
    epf_number: 'E1', company_id: 'c1', kind: 'credit', amount: 0, balance_after: 0,
    ref_type: 'account', ref_id: null, note: '', actor_epf: 'A', actor_name: 'Admin',
    created_at: at(2026, 8, 6) as unknown as SuspenseLedgerEntry['created_at'],
    ...over,
  } as SuspenseLedgerEntry);

  const s = summarizeHolderMonth({
    year: 2026, month: 8,
    submissions: [],
    // An approved request the holder raised — it must NOT be counted on its own; its ledger
    // twin below is the money. Counting both would double it.
    requests: [{
      id: 'r1', epf_number: 'E1', status: 'approved', amount: 1000, approved_amount: 900,
      considered_at: at(2026, 8, 4), created_at: at(2026, 8, 1),
    } as unknown as SuspenseRequest],
    ledger: [
      led({ id: 'l1', kind: 'credit', amount: 900, ref_type: 'request', ref_id: 'r1' }),
      led({ id: 'l2', kind: 'adjustment', amount: 50_000, note: 'Manual credit' }),
      led({ id: 'l3', kind: 'opening', amount: 2_000 }),
      led({ id: 'l4', kind: 'adjustment', amount: -1_760, note: 'Carried forward' }),
      led({ id: 'l5', kind: 'debit', amount: -300 }),                    // a bill — counted from the bill
      led({ id: 'l6', kind: 'settlement', amount: -100 }),               // closing an account
      led({ id: 'l7', kind: 'credit', amount: 7, created_at: at(2026, 9, 2) as unknown as SuspenseLedgerEntry['created_at'] }),
    ],
  });
  assert.equal(s.credit, 51_140);        // 900 + 50,000 + 2,000 − 1,760; debit/settlement/next month excluded
  assert.equal(s.creditPending, 0);      // the request was decided, so nothing is still being asked for
});

test('a bill still awaiting approval counts whatever month it fell in', () => {
  // August is on the stepper. The two pending bills sit either side of it — one from July,
  // one dated into September — and both are money this holder has not accounted for. Scoping
  // them to the month left the "Awaiting approval" tile reading 0 over real unpaid bills.
  const s = summarizeHolderMonth({
    year: 2026, month: 8,
    submissions: [
      bill({ id: 'p1', epf_number: 'E1', amount: 60, status: 'pending', bill_date: at(2026, 7, 28) as unknown as TS }),
      bill({ id: 'p2', epf_number: 'E1', amount: 100, status: 'pending', bill_date: at(2026, 9, 3) as unknown as TS,
             splits: [{ epf_number: 'E2', employee_name: 'Nimal', amount: 25 }] }),
      bill({ id: 'ok', epf_number: 'E1', amount: 200, bill_date: at(2026, 8, 4) as unknown as TS }),
      // Rejected and cancelled stay month-scoped and never count as waiting.
      bill({ id: 'rj', epf_number: 'E1', amount: 300, status: 'pending', deleted: true }),
    ],
    requests: [],
  });
  assert.equal(s.pending, 160);          // 60 + 100 — the split does not shrink what will leave the float
  assert.equal(s.pendingCount, 2);
  assert.equal(s.spent, 200);            // spend is still August's alone
  assert.equal(s.daily[3], 200);
  assert.equal(s.daily.reduce((a, b) => a + b, 0), 200);   // no pending bill leaked into the bars
});

test('groupByDay is newest day first and keeps insertion order inside a day', () => {
  const g = groupByDay([{ d: '2026-08-01', n: 1 }, { d: '2026-08-03', n: 2 }, { d: '2026-08-01', n: 3 }], x => x.d);
  assert.deepEqual(g.map(x => x.date), ['2026-08-03', '2026-08-01']);
  assert.deepEqual(g[1].items.map(x => x.n), [1, 3]);
});

test('compact amounts fit a calendar cell', () => {
  assert.equal(compactAmount(850), '850');
  assert.equal(compactAmount(12_500), '12.5k');
  assert.equal(compactAmount(250_000), '250k');
  assert.equal(compactAmount(1_250_000), '1.3M');
  assert.equal(compactAmount(-999), '999');
});
