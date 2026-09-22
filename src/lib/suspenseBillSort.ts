// Filtering and ordering a list of suspense bills by DATE.
//
// A bill carries two dates and they routinely disagree: `bill_date` is the day printed on the
// receipt, `created_at` is the day it reached the system. Someone hands in a fortnight of
// receipts at once and every one of them shares a submit date while spanning two weeks of bill
// dates — so "show me what came in on Monday" and "show me what was spent on Monday" are
// different questions, and the reader has to be able to ask either.
//
// Pure and Firestore-free so the ordering is unit-tested (src/lib/__tests__/suspenseBillSort
// .test.ts) rather than eyeballed in a list.
import { msOf } from './suspenseMonthView';

/** Which of a bill's two dates a filter or a sort is talking about. */
export type BillDateField = 'bill' | 'submitted';

export const BILL_DATE_LABEL: Record<BillDateField, string> = {
  bill:      'Bill date',
  submitted: 'Submitted date',
};

/** The minimum a bill needs for any of this — both real submissions and test fixtures fit. */
export interface DatedBill {
  bill_date?:  unknown;
  created_at?: unknown;
}

/** The moment a bill counts at for `field`, in ms. Falls back the way billDayOf does: a bill with
 *  no bill_date is dated by when it arrived, which is the only other thing known about it. */
export function billMoment(b: DatedBill, field: BillDateField): number {
  if (field === 'submitted') return msOf(b.created_at) ?? 0;
  return msOf(b.bill_date) ?? msOf(b.created_at) ?? 0;
}

/** Local-day bounds for a YYYY-MM-DD string, or null when it is blank/unparseable. Inclusive of
 *  the whole day at both ends — a "from 12 Sept to 12 Sept" filter must keep 12 September, which
 *  a naive `new Date(str)` comparison drops because it lands on midnight UTC. */
export function dayBounds(day: string): { from: number; to: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((day ?? '').trim());
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]);
  const from = new Date(y, mo, d, 0, 0, 0, 0).getTime();
  const to   = new Date(y, mo, d, 23, 59, 59, 999).getTime();
  return Number.isFinite(from) ? { from, to } : null;
}

export interface BillDateRange {
  /** YYYY-MM-DD, inclusive. Blank = open-ended on that side. */
  from?: string;
  to?:   string;
}

/** Keep the bills whose `field` date falls inside `range`. An empty or unparseable bound is
 *  simply not applied, so a half-filled filter narrows one end instead of returning nothing. */
export function filterBillsByDate<T extends DatedBill>(
  bills: T[], field: BillDateField, range: BillDateRange,
): T[] {
  const lo = dayBounds(range.from ?? '')?.from ?? null;
  const hi = dayBounds(range.to ?? '')?.to ?? null;
  if (lo === null && hi === null) return bills;
  return bills.filter(b => {
    const at = billMoment(b, field);
    if (lo !== null && at < lo) return false;
    if (hi !== null && at > hi) return false;
    return true;
  });
}

export type SortDir = 'desc' | 'asc';

/** Newest first by default. Stable: bills sharing a moment — a whole batch handed in together
 *  shares one submit time to the second — keep the order they arrived in, so the list does not
 *  reshuffle itself between renders. */
export function sortBillsByDate<T extends DatedBill>(
  bills: T[], field: BillDateField, dir: SortDir = 'desc',
): T[] {
  return bills
    .map((b, i) => ({ b, i, at: billMoment(b, field) }))
    .sort((x, y) => (dir === 'desc' ? y.at - x.at : x.at - y.at) || (x.i - y.i))
    .map(x => x.b);
}
