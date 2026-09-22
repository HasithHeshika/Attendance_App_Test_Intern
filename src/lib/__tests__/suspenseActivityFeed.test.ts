import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_FILTERS, applyActivityFilters, buildActivityItems, groupActivityByDay, isCarriedIn,
  type ActivityFilters,
} from '../../components/suspense/holder/activityItems';
import type { SuspenseRequest, SuspenseSubmission } from '../types';

// Local-midnight timestamps, exactly as the submit form writes bill_date.
const at = (y: number, m: number, d: number, h = 9) => ({ seconds: Math.floor(new Date(y, m - 1, d, h).getTime() / 1000) });
type TS = SuspenseSubmission['created_at'];

function bill(over: Partial<SuspenseSubmission> & { id: string }): SuspenseSubmission {
  return {
    epf_number: 'E1', employee_name: 'Amal',
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

function req(over: Partial<SuspenseRequest> & { id: string }): SuspenseRequest {
  return {
    epf_number: 'E1', employee_name: 'Amal', company_id: 'c1', company_name: 'Alta Vision',
    amount: 500, approved_amount: null, reason: '', status: 'pending',
    considered_by: null, considered_by_name: null, considered_at: null, reject_reason: null,
    created_at: at(2026, 8, 1) as unknown as SuspenseRequest['created_at'],
    updated_at: at(2026, 8, 1) as unknown as SuspenseRequest['updated_at'],
    ...over,
  } as SuspenseRequest;
}

const AUG = '2026-08';
const monthView = (over: Partial<ActivityFilters> = {}): ActivityFilters => ({ ...DEFAULT_FILTERS, ...over });

// The feed is scoped to the month the strip is on. Anything still waiting is the exception:
// the strip's "Awaiting approval" counts it all-time, so a list that dropped it left that
// figure standing over bills the holder could not find anywhere on the page.
const ITEMS = () => buildActivityItems({
  subs: [
    bill({ id: 'aug-ok',   bill_date: at(2026, 8, 4) as unknown as TS }),
    bill({ id: 'jul-ok',   bill_date: at(2026, 7, 4) as unknown as TS }),
    bill({ id: 'jul-wait', bill_date: at(2026, 7, 9) as unknown as TS, status: 'pending' }),
    bill({ id: 'aug-wait', bill_date: at(2026, 8, 9) as unknown as TS, status: 'pending' }),
    bill({ id: 'jul-no',   bill_date: at(2026, 7, 2) as unknown as TS, status: 'rejected' }),
  ],
  reqs: [
    req({ id: 'jul-req', created_at: at(2026, 7, 1) as unknown as SuspenseRequest['created_at'] }),
  ],
  closes: [],
});

test('the month view carries in anything still awaiting, from any month', () => {
  const ids = applyActivityFilters(ITEMS(), monthView(), AUG).map(it => it.id).sort();
  // August's own bill, both pending bills wherever they fell, and the July credit request
  // nobody has decided yet. July's approved and rejected bills stay in July.
  assert.deepEqual(ids, ['aug-ok', 'aug-wait', 'jul-req', 'jul-wait']);
});

test('a carried-in item is only ever one that fell outside the month', () => {
  const shown = applyActivityFilters(ITEMS(), monthView(), AUG);
  const carried = shown.filter(it => isCarriedIn(it, 'month', AUG)).map(it => it.id).sort();
  assert.deepEqual(carried, ['jul-req', 'jul-wait']);
  // Nothing is "carried in" once the reader has asked for all time — the month is not the frame.
  assert.equal(shown.filter(it => isCarriedIn(it, 'all', AUG)).length, 0);
});

test('carrying pending in does not override the other filters', () => {
  const items = ITEMS();
  // Asking for approved must not smuggle a pending bill back in through the range exemption.
  assert.deepEqual(
    applyActivityFilters(items, monthView({ status: 'approved' }), AUG).map(it => it.id),
    ['aug-ok'],
  );
  // Nor may the kind chips.
  assert.deepEqual(
    applyActivityFilters(items, monthView({ kind: 'credit' }), AUG).map(it => it.id),
    ['jul-req'],
  );
  // Nor the search box.
  assert.deepEqual(
    applyActivityFilters(items, monthView({ text: 'nothing matches this' }), AUG).map(it => it.id),
    [],
  );
});

test('ledger movements with no request behind them get their own rows', () => {
  const led = (over: Record<string, unknown> & { id: string }) => ({
    epf_number: 'E1', company_id: 'c1', kind: 'adjustment', amount: 5000, balance_after: 5000,
    ref_type: 'account', ref_id: null, note: 'Manual credit', actor_epf: 'A', actor_name: 'Admin',
    created_at: at(2026, 8, 6), ...over,
  }) as never;

  const items = buildActivityItems({
    subs: [], closes: [],
    reqs: [req({ id: 'r1', status: 'approved', considered_at: at(2026, 8, 4) as unknown as SuspenseRequest['considered_at'] })],
    ledger: [
      led({ id: 'l1', ref_type: 'request', ref_id: 'r1', kind: 'credit', amount: 500 }),  // the request above already shows this
      led({ id: 'l2' }),                                                                  // a manual credit — nothing else explains it
      led({ id: 'l3', kind: 'adjustment', amount: -1760, note: 'Carried forward' }),
      led({ id: 'l4', kind: 'debit', amount: -300 }),                                     // a bill's debit is not float-side
      led({ id: 'l5', kind: 'adjustment', amount: 0 }),                                   // a zero movement is not a row
    ],
  });
  assert.deepEqual(items.map(i => i.id).sort(), ['ledger:l2', 'ledger:l3', 'r1']);
  // Day subtotals net the signed amounts, so a clawback reduces the day rather than adding to it.
  const aug6 = groupActivityByDay(items).find(g => g.date === '2026-08-06');
  assert.equal(aug6?.credit, 3240);   // 5000 − 1760
});

test('all time is still all time', () => {
  const ids = applyActivityFilters(ITEMS(), monthView({ range: 'all' }), AUG).map(it => it.id).sort();
  assert.deepEqual(ids, ['aug-ok', 'aug-wait', 'jul-no', 'jul-ok', 'jul-req', 'jul-wait']);
});
