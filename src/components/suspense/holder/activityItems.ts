// The holder's activity feed as one flat list — expenses, credit requests and close requests
// share a shape here so the feed can sort, filter, search and group them without a three-way
// branch at every step. Pure: no React, no Firestore, so the day arithmetic can be checked
// against the month KPIs it must agree with.
//
// The day an item lands on is the SAME day the month strip counts it on (billDayOf for
// bills, requestDayOf for credit), so a bill dated last month but uploaded today sits in last
// month's group — deliberately, because that is the month it was spent in.
//
// The month RANGE has one exception, and the strip shares it: anything still awaiting a
// decision shows whatever month it fell in (see inMonthRange). It keeps its own day, so the
// day headers still add up; it is simply also visible from a month it does not belong to.
import type {
  SuspenseCloseRequest, SuspenseLedgerEntry, SuspenseRequest, SuspenseStatus, SuspenseSubmission,
} from '@/lib/types';
// Relative, not the `@/` alias: npm test runs plain `node --test` over the compiled output in
// .test-out, where tsconfig path aliases are not resolved. An alias here silently fails the
// WHOLE test file at load time rather than failing one assertion. (The type-only import above
// is erased at compile time, so it never reaches node.)
import {
  billDayOf, floatCostOf, groupByDay, isCreditEntry, localDayKey, msOf, splitsOwedBack, requestDayOf,
} from '../../../lib/suspenseMonthView';

export type ActivityKind = 'expense' | 'credit' | 'close';

interface ActivityBase {
  kind:   ActivityKind;
  id:     string;
  /** YYYY-MM-DD, the day the item counts on. */
  day:    string;
  /** ms, for ordering within a day (newest first). */
  at:     number;
  status: SuspenseStatus;
  company: string;
}

export type ActivityItem =
  | (ActivityBase & { kind: 'expense'; sub: SuspenseSubmission })
  | (ActivityBase & { kind: 'credit';  req: SuspenseRequest })
  | (ActivityBase & { kind: 'credit';  entry: SuspenseLedgerEntry })
  | (ActivityBase & { kind: 'close';   close: SuspenseCloseRequest });

/** A credit item backed by a ledger entry rather than by a request the holder raised. */
export const isLedgerItem = (it: ActivityItem): it is ActivityBase & { kind: 'credit'; entry: SuspenseLedgerEntry } =>
  it.kind === 'credit' && 'entry' in it;

export type KindFilter   = 'all' | ActivityKind;
export type StatusFilter = 'all' | SuspenseStatus;
export type RangeFilter  = 'month' | 'all';

export interface ActivityFilters {
  kind:   KindFilter;
  status: StatusFilter;
  range:  RangeFilter;
  text:   string;
}

export const DEFAULT_FILTERS: ActivityFilters = { kind: 'all', status: 'all', range: 'month', text: '' };

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/** What an approved credit request actually put into the float. */
export const grantedOf = (r: Pick<SuspenseRequest, 'amount' | 'approved_amount'>) =>
  round2(Number(r.approved_amount ?? r.amount) || 0);

/** How a float movement with no request behind it is named to the holder. */
export const LEDGER_LABEL: Record<SuspenseLedgerEntry['kind'], string> = {
  credit:     'Credit added',
  opening:    'Opening balance',
  adjustment: 'Balance adjustment',
  debit:      'Debit',
  settlement: 'Settlement',
};

/** Flatten the sources, newest first. Soft-deleted bills never reach the page (the service
 *  filters them) but a cancelled bill must never show as money taken, so guard anyway.
 *
 *  `ledger` fills the hole the other three leave: money reaches a float by several routes and
 *  only one of them is a request the holder raised. An approver's manual credit, an opening
 *  balance, a bulk import and the month's carry-forward all post a ledger entry and no request,
 *  so the holder used to watch their balance move with nothing on the page to explain it. Only
 *  entries NOT backed by a request are taken — an approved request already has its own item
 *  here, and adding its ledger twin as well would show the same money twice. */
export function buildActivityItems(opts: {
  subs:   SuspenseSubmission[];
  reqs:   SuspenseRequest[];
  closes: SuspenseCloseRequest[];
  ledger?: SuspenseLedgerEntry[];
  /** Which of a bill's two dates decides the day it groups under — the date on the receipt
   *  (default) or the day it was handed in. A fortnight of receipts submitted at once spans two
   *  weeks by bill date and lands on one day by submitted date, and the reader needs both views.
   *  Only expenses have two dates; credits and closes are unaffected. */
  dateField?: 'bill' | 'submitted';
}): ActivityItem[] {
  const items: ActivityItem[] = [];
  const seen = new Set<string>();
  for (const s of opts.subs) {
    if (!s || s.deleted || seen.has(`e-${s.id}`)) continue;
    seen.add(`e-${s.id}`);
    const submitted = opts.dateField === 'submitted';
    const at = submitted ? (msOf(s.created_at) ?? 0) : (msOf(s.bill_date) ?? msOf(s.created_at) ?? 0);
    items.push({
      kind: 'expense', id: s.id, day: submitted ? localDayKey(at) : billDayOf(s), at,
      status: s.status, company: s.company_name ?? '', sub: s,
    });
  }
  for (const r of opts.reqs) {
    if (!r || seen.has(`r-${r.id}`)) continue;
    seen.add(`r-${r.id}`);
    items.push({
      kind: 'credit', id: r.id, day: requestDayOf(r),
      at: msOf(r.considered_at) ?? msOf(r.created_at) ?? 0,
      status: r.status, company: r.company_name ?? '', req: r,
    });
  }
  for (const c of opts.closes) {
    if (!c || seen.has(`c-${c.id}`)) continue;
    seen.add(`c-${c.id}`);
    const at = msOf(c.created_at) ?? 0;
    items.push({
      kind: 'close', id: c.id, day: localDayKey(at), at,
      status: c.status, company: c.company_name ?? '', close: c,
    });
  }
  for (const e of opts.ledger ?? []) {
    // ref_type 'request' means an approved request already speaks for this money above.
    if (!e || e.ref_type === 'request' || !isCreditEntry(e) || seen.has(`l-${e.id}`)) continue;
    seen.add(`l-${e.id}`);
    const at = msOf(e.created_at) ?? 0;
    items.push({
      // 'approved' because it is done — this is money that has already moved, not a request.
      kind: 'credit', id: `ledger:${e.id}`, day: localDayKey(at), at,
      status: 'approved', company: '', entry: e,
    });
  }
  return items.sort((a, b) => b.day.localeCompare(a.day) || b.at - a.at);
}

/** Everything the search box can match on, lower-cased. Kept in one place so the search
 *  placeholder and the actual behaviour never drift. */
export function searchTextOf(it: ActivityItem): string {
  const parts: Array<string | number | null | undefined> =
    it.kind === 'expense'
      ? ['expense', it.sub.expense_type, it.sub.category, it.sub.subcategory, it.sub.type, it.sub.item, it.sub.shop_name,
         it.sub.company_name, it.sub.note, it.sub.status, it.sub.amount, it.sub.bill_no]
      : isLedgerItem(it)
      ? [LEDGER_LABEL[it.entry.kind] ?? 'Adjustment', it.entry.note, it.entry.actor_name, it.entry.amount]
      : it.kind === 'credit'
      ? ['credit request', it.req.company_name, it.req.category_name, it.req.reason, it.req.status, it.req.amount, it.req.approved_amount]
      : ['close account', it.close.company_name, it.close.note, it.close.status, it.close.balance_at_request];
  return parts.filter(p => p != null && p !== '').join(' ').toLowerCase();
}

/** Does the month range let this item through? Anything still awaiting a decision always
 *  passes, whatever month it fell in — it is the one thing the holder is here to chase, the
 *  month strip's "Awaiting approval" counts it all-time (see summarizeHolderMonth), and a list
 *  that dropped it left that figure standing over bills nobody could find. Every other filter
 *  still applies to it normally. */
export const inMonthRange = (it: ActivityItem, range: RangeFilter, monthPrefix: string): boolean =>
  range !== 'month' || it.status === 'pending' || it.day.startsWith(monthPrefix);

/** An item the month view is showing only because it is still waiting — it fell outside the
 *  month on screen. What the feed counts to explain itself. */
export const isCarriedIn = (it: ActivityItem, range: RangeFilter, monthPrefix: string): boolean =>
  range === 'month' && it.status === 'pending' && !it.day.startsWith(monthPrefix);

export function applyActivityFilters(items: ActivityItem[], f: ActivityFilters, monthPrefix: string): ActivityItem[] {
  const q = f.text.trim().toLowerCase();
  return items.filter(it => {
    if (!inMonthRange(it, f.range, monthPrefix)) return false;
    if (f.kind !== 'all' && it.kind !== f.kind) return false;
    if (f.status !== 'all' && it.status !== f.status) return false;
    if (q && !searchTextOf(it).includes(q)) return false;
    return true;
  });
}

export interface DayGroup {
  date:     string;
  items:    ActivityItem[];
  /** Approved bills, own share. */
  spent:    number;
  /** Pending bills, own share. */
  pending:  number;
  /** Approved credit, granted amount. */
  credit:   number;
}

/** Newest day first, each with the day's own numbers for its header. Rejected items are listed
 *  but count for nothing — a rejected bill never left the float. */
export function groupActivityByDay(items: ActivityItem[]): DayGroup[] {
  return groupByDay(items, it => it.day).map(({ date, items: its }) => {
    let spent = 0, pending = 0, credit = 0;
    for (const it of its) {
      if (it.kind === 'expense') {
        // The whole bill — that is what leaves the float (floatCostOf). A split returns later as
        // its own credit once payroll has deducted it, so it must not be netted off here.
        if (it.status === 'approved')     spent   = round2(spent + floatCostOf(it.sub));
        else if (it.status === 'pending') pending = round2(pending + floatCostOf(it.sub));
      } else if (isLedgerItem(it)) {
        // Signed: a correction that takes money back nets off the day rather than adding to it.
        credit = round2(credit + (Number(it.entry.amount) || 0));
      } else if (it.kind === 'credit' && it.status === 'approved') {
        credit = round2(credit + grantedOf(it.req));
      }
    }
    return { date, items: [...its].sort((a, b) => b.at - a.at), spent, pending, credit };
  });
}
