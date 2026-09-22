// Who took how much, on which days — the arithmetic behind the suspense Ledger tab and the
// holder's own month strip.
//
// Pure, free of React and Firestore so it can be unit tested without a stub (see
// src/lib/__tests__/suspenseMonthView.test.ts). Firestore Timestamps are read through msOf(),
// which also accepts {seconds}, Date and ISO strings so test fixtures stay plain.

import type {
  SuspenseAccount, SuspenseLedgerEntry, SuspenseRequest, SuspenseStatus, SuspenseSubmission,
} from './types';

const pad2 = (n: number) => String(n).padStart(2, '0');
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/** Firestore Timestamp | {seconds} | Date | ISO string | ms number → ms, or null when absent. */
export function msOf(ts: unknown): number | null {
  if (ts == null) return null;
  if (typeof ts === 'number') return Number.isFinite(ts) ? ts : null;
  if (ts instanceof Date) return Number.isNaN(ts.getTime()) ? null : ts.getTime();
  if (typeof ts === 'object') {
    const o = ts as { toMillis?: () => number; seconds?: number };
    if (typeof o.toMillis === 'function') return o.toMillis();
    if (typeof o.seconds === 'number') return o.seconds * 1000;
    return null;
  }
  if (typeof ts === 'string') { const t = Date.parse(ts); return Number.isNaN(t) ? null : t; }
  return null;
}

/** Local calendar day of a moment (YYYY-MM-DD). Bill dates are written as local midnight
 *  (see dateStrToTimestamp on the suspense page), so reading them back as local days is the
 *  only projection that never shifts a bill onto the day before. */
export function localDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export const monthPrefix = (year: number, month: number) => `${year}-${pad2(month)}`;
export const daysInMonth = (year: number, month: number) => new Date(year, month, 0).getDate();
export const dayKey = (year: number, month: number, day: number) => `${monthPrefix(year, month)}-${pad2(day)}`;

/** The day a bill belongs to — the date on the bill, else when it was submitted. */
export function billDayOf(s: Pick<SuspenseSubmission, 'bill_date' | 'created_at'>): string {
  const ms = msOf(s.bill_date) ?? msOf(s.created_at) ?? 0;
  return localDayKey(ms);
}

/** The day a credit request counts on — when it was decided, else when it was raised. */
export function requestDayOf(r: Pick<SuspenseRequest, 'considered_at' | 'created_at'>): string {
  const ms = msOf(r.considered_at) ?? msOf(r.created_at) ?? 0;
  return localDayKey(ms);
}

export const splitsSum = (s?: SuspenseSubmission['splits']) =>
  round2((s ?? []).reduce((t, x) => t + (Number(x?.amount) || 0), 0));

/** The part of a bill that is genuinely the holder's own cost — the bill less what was split to
 *  colleagues. This is NOT what the float pays: the whole bill leaves the float on approval and
 *  the splits come back as they are recovered (see floatCostOf). Kept for the places that mean
 *  "whose expense was this really", e.g. a per-person cost breakdown. */
export const ownShareOf = (s: Pick<SuspenseSubmission, 'amount' | 'splits'>) =>
  round2((Number(s.amount) || 0) - splitsSum(s.splits));

/** What a bill takes out of its holder's float: the WHOLE bill. The cash left their hand, so it
 *  leaves the balance; a split is a receivable that returns via recoverSplit, not a discount. */
export const floatCostOf = (s: Pick<SuspenseSubmission, 'amount'>) => round2(Number(s.amount) || 0);

/** Split away and not yet deducted from the colleague's salary — money the holder is still
 *  carrying for other people, and the figure that tells them what is coming back. */
export const splitsOwedBack = (s?: SuspenseSubmission['splits']) =>
  round2((s ?? []).filter(x => x && !x.recovered_at).reduce((t, x) => t + (Number(x?.amount) || 0), 0));

// ─── Lines, days, people ────────────────────────────────────────────────────────

export type LedgerLineKind = 'bill' | 'credit';

export interface LedgerLine {
  kind:          LedgerLineKind;
  id:            string;
  date:          string;                       // YYYY-MM-DD
  at:            number;                       // ms, for ordering within a day
  epf:           string;
  name:          string;
  company_id:    string;
  company_name:  string;
  /** Bills: the full bill amount. Credits: the amount credited. Always positive. */
  amount:        number;
  /** What the line does to the float — the whole bill, or the credit. Every "spent" figure sums
   *  THIS, so the totals and the balance can never tell different stories. */
  floatAmount:   number;
  /** Bills: split away and not yet recovered from the colleagues' salaries, i.e. money the
   *  holder is still carrying. 0 for credits and for a fully-recovered bill. */
  recoverable:   number;
  status:        SuspenseStatus | 'posted';    // ledger credits are already posted
  label:         string;                       // bill: category · subcategory; credit: kind
  sublabel:      string;                       // bill: item @ shop; credit: note
  bill?:         SuspenseSubmission;
  entry?:        SuspenseLedgerEntry;
}

export interface DayBucket {
  date:         string;
  spent:        number;   // approved bills, own share
  pending:      number;   // pending bills, own share
  credit:       number;   // credits posted
  lines:        LedgerLine[];
}

export interface PersonRow {
  epf:          string;
  name:         string;
  companies:    string[];
  balances:     Array<{ company_id: string; company_name: string; balance: number; is_active: boolean; is_closed: boolean }>;
  /** Sum of every open account's balance. null when this person holds no account. */
  balance:      number | null;
  spent:        number;
  billed:       number;   // approved bills, full amount (incl. what was split to others)
  pending:      number;
  pendingCount: number;
  rejected:     number;
  credit:       number;
  billCount:    number;   // approved + pending bills
  days:         DayBucket[];   // newest first
  active:       boolean;       // had any line this month
}

export interface DayTotal {
  date:    string;
  day:     number;
  spent:   number;
  pending: number;
  credit:  number;
  people:  number;   // distinct people with a line that day
}

export interface MonthTotals {
  spent:        number;
  billed:       number;
  pending:      number;
  pendingCount: number;
  rejected:     number;
  credit:       number;
  billCount:    number;
  activePeople: number;
  holders:      number;
}

export interface SuspenseMonthView {
  year:   number;
  month:  number;
  people: PersonRow[];   // most spent first, then name
  days:   DayTotal[];    // every calendar day of the month, in order
  totals: MonthTotals;
}

/** Ledger kinds that belong to the FLOAT side of the story — money put in, or taken back out by
 *  a correction. The AMOUNT carries the direction (every ledger amount is signed: approveSubmission
 *  writes `amount: -debit`), so a negative adjustment is a real movement and counts here.
 *
 *  It used to be excluded as "not a credit", which silently deleted it from every total built on
 *  this predicate: the approver's month credit, the day heat grid, and the history dialog's
 *  "Credited all-time". Live data had seven of them — the month's carry-forward of an overdrawn
 *  float, one as large as −127,001 — so those figures read high by the whole amount while the
 *  history dialog drew the −127,001 line and then left it out of its own subtotal.
 *
 *  'debit' is an approved bill (already counted from the bill itself) and 'settlement' closes an
 *  account, so neither belongs here. A zero movement is not a line. */
export function isCreditEntry(e: Pick<SuspenseLedgerEntry, 'kind' | 'amount'>): boolean {
  if (!(Number(e.amount) || 0)) return false;
  return e.kind === 'credit' || e.kind === 'opening' || e.kind === 'adjustment';
}

const CREDIT_LABEL: Record<SuspenseLedgerEntry['kind'], string> = {
  credit:     'Credit approved',
  opening:    'Opening balance',
  adjustment: 'Adjustment',
  debit:      'Debit',
  settlement: 'Settlement',
};

function billLabel(s: SuspenseSubmission): string {
  return [s.category, s.subcategory].filter(Boolean).join(' · ') || s.expense_type || 'Expense';
}

export function billLine(s: SuspenseSubmission): LedgerLine {
  return {
    kind: 'bill', id: s.id, date: billDayOf(s),
    at: msOf(s.bill_date) ?? msOf(s.created_at) ?? 0,
    epf: s.epf_number, name: s.employee_name,
    company_id: s.company_id, company_name: s.company_name,
    amount: round2(Number(s.amount) || 0), floatAmount: floatCostOf(s), recoverable: splitsOwedBack(s.splits),
    status: s.status, label: billLabel(s),
    sublabel: [s.item, s.shop_name].filter(Boolean).join(' @ '),
    bill: s,
  };
}

export function creditLine(e: SuspenseLedgerEntry, nameOf: (epf: string) => string, companyOf: (id: string) => string): LedgerLine {
  const at  = msOf(e.created_at) ?? 0;
  const amt = round2(Number(e.amount) || 0);
  return {
    kind: 'credit', id: e.id, date: localDayKey(at), at,
    epf: e.epf_number, name: nameOf(e.epf_number),
    company_id: e.company_id ?? '', company_name: companyOf(e.company_id ?? ''),
    amount: amt, floatAmount: amt, recoverable: 0, status: 'posted',
    label: CREDIT_LABEL[e.kind] ?? 'Credit', sublabel: e.note ?? '',
    entry: e,
  };
}

/**
 * The month's picture: every account holder (so "took nothing" is visible too) plus anyone
 * with a line that month, each with their own day-by-day breakdown, and the day totals that
 * feed the heat grid.
 *
 * `submissions` and `ledger` may reach further than the month — anything outside it is
 * dropped here by day, so callers can pass whatever window their queries returned. Soft-deleted
 * bills are skipped: a cancelled bill was withdrawn and must not count as money taken.
 */
export function buildSuspenseMonthView(opts: {
  submissions: SuspenseSubmission[];
  ledger:      SuspenseLedgerEntry[];
  accounts:    SuspenseAccount[];
  year:        number;
  month:       number;
}): SuspenseMonthView {
  const { year, month } = opts;
  const prefix = monthPrefix(year, month);

  // Names: accounts first, then bills — a ledger entry carries only an EPF.
  const nameByEpf = new Map<string, string>();
  const companyById = new Map<string, string>();
  for (const a of opts.accounts) {
    if (a.employee_name && !nameByEpf.has(a.epf_number)) nameByEpf.set(a.epf_number, a.employee_name);
    if (a.company_id && a.company_name) companyById.set(a.company_id, a.company_name);
  }
  for (const s of opts.submissions) {
    if (s.employee_name && !nameByEpf.has(s.epf_number)) nameByEpf.set(s.epf_number, s.employee_name);
    if (s.company_id && s.company_name && !companyById.has(s.company_id)) companyById.set(s.company_id, s.company_name);
  }
  const nameOf    = (epf: string) => nameByEpf.get(epf) ?? epf;
  const companyOf = (id: string) => companyById.get(id) ?? '';

  // Dedupe bills by id — the caller merges two queries that can both return the same doc.
  const seen = new Set<string>();
  const lines: LedgerLine[] = [];
  for (const s of opts.submissions) {
    if (!s || s.deleted || seen.has(s.id)) continue;
    seen.add(s.id);
    const line = billLine(s);
    if (line.date.startsWith(prefix)) lines.push(line);
  }
  for (const e of opts.ledger) {
    if (!e || !isCreditEntry(e) || seen.has(e.id)) continue;
    seen.add(e.id);
    const line = creditLine(e, nameOf, companyOf);
    if (line.date.startsWith(prefix)) lines.push(line);
  }

  // People: every account holder, then anyone else with a line.
  const people = new Map<string, PersonRow>();
  const ensure = (epf: string, name: string): PersonRow => {
    let p = people.get(epf);
    if (!p) {
      p = {
        epf, name, companies: [], balances: [], balance: null,
        spent: 0, billed: 0, pending: 0, pendingCount: 0, rejected: 0, credit: 0, billCount: 0,
        days: [], active: false,
      };
      people.set(epf, p);
    }
    return p;
  };
  for (const a of opts.accounts) {
    const p = ensure(a.epf_number, a.employee_name || a.epf_number);
    p.balances.push({
      company_id: a.company_id, company_name: a.company_name, balance: round2(a.balance),
      is_active: a.is_active !== false, is_closed: !!a.is_closed,
    });
    if (!a.is_closed) p.balance = round2((p.balance ?? 0) + (Number(a.balance) || 0));
    if (a.company_name && !p.companies.includes(a.company_name)) p.companies.push(a.company_name);
  }

  const dayBucketsByPerson = new Map<string, Map<string, DayBucket>>();
  const dayTotals = new Map<string, DayTotal>();
  const peopleByDay = new Map<string, Set<string>>();
  for (let d = 1; d <= daysInMonth(year, month); d++) {
    const date = dayKey(year, month, d);
    dayTotals.set(date, { date, day: d, spent: 0, pending: 0, credit: 0, people: 0 });
    peopleByDay.set(date, new Set());
  }

  for (const line of lines) {
    const p = ensure(line.epf, line.name);
    p.active = true;
    if (line.company_name && !p.companies.includes(line.company_name)) p.companies.push(line.company_name);

    let byDay = dayBucketsByPerson.get(line.epf);
    if (!byDay) { byDay = new Map(); dayBucketsByPerson.set(line.epf, byDay); }
    let bucket = byDay.get(line.date);
    if (!bucket) { bucket = { date: line.date, spent: 0, pending: 0, credit: 0, lines: [] }; byDay.set(line.date, bucket); }
    bucket.lines.push(line);

    const total = dayTotals.get(line.date);
    peopleByDay.get(line.date)?.add(line.epf);

    if (line.kind === 'credit') {
      p.credit = round2(p.credit + line.amount);
      bucket.credit = round2(bucket.credit + line.amount);
      if (total) total.credit = round2(total.credit + line.amount);
    } else if (line.status === 'approved') {
      p.spent  = round2(p.spent + line.floatAmount);
      p.billed = round2(p.billed + line.amount);
      p.billCount += 1;
      bucket.spent = round2(bucket.spent + line.floatAmount);
      if (total) total.spent = round2(total.spent + line.floatAmount);
    } else if (line.status === 'pending') {
      p.pending = round2(p.pending + line.floatAmount);
      p.pendingCount += 1;
      p.billCount += 1;
      bucket.pending = round2(bucket.pending + line.floatAmount);
      if (total) total.pending = round2(total.pending + line.floatAmount);
    } else {
      p.rejected = round2(p.rejected + line.floatAmount);
    }
  }

  for (const [epf, byDay] of dayBucketsByPerson) {
    const p = people.get(epf)!;
    p.days = [...byDay.values()]
      .sort((a, b) => b.date.localeCompare(a.date))
      .map(b => ({ ...b, lines: [...b.lines].sort((x, y) => y.at - x.at) }));
  }
  for (const [date, set] of peopleByDay) {
    const t = dayTotals.get(date);
    if (t) t.people = set.size;
  }

  const rows = [...people.values()].sort((a, b) =>
    (b.spent - a.spent) || (b.pending - a.pending) || (b.credit - a.credit) || a.name.localeCompare(b.name));

  const totals: MonthTotals = rows.reduce((t, p) => ({
    spent:        round2(t.spent + p.spent),
    billed:       round2(t.billed + p.billed),
    pending:      round2(t.pending + p.pending),
    pendingCount: t.pendingCount + p.pendingCount,
    rejected:     round2(t.rejected + p.rejected),
    credit:       round2(t.credit + p.credit),
    billCount:    t.billCount + p.billCount,
    activePeople: t.activePeople + (p.active ? 1 : 0),
    holders:      t.holders + (p.balance !== null ? 1 : 0),
  }), { spent: 0, billed: 0, pending: 0, pendingCount: 0, rejected: 0, credit: 0, billCount: 0, activePeople: 0, holders: 0 });

  return { year, month, people: rows, days: [...dayTotals.values()], totals };
}

// ─── Holder-side helpers ────────────────────────────────────────────────────────

/** Group anything with a day key into newest-day-first buckets. */
export function groupByDay<T>(items: T[], dayOf: (t: T) => string): Array<{ date: string; items: T[] }> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const d = dayOf(it);
    const arr = m.get(d);
    if (arr) arr.push(it); else m.set(d, [it]);
  }
  return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([date, its]) => ({ date, items: its }));
}

export interface HolderMonthSummary {
  spent:        number;   // approved bills, full amount (what left the float), by bill day
  billed:       number;
  /** Bills still awaiting approval, full amount — ALL-TIME, not scoped to the month. Waiting is
   *  not a property of a month: see the loop below. */
  pending:      number;
  pendingCount: number;
  rejected:     number;
  credit:       number;   // approved credit requests (granted amount), by decision day
  creditPending: number;  // credit still awaiting a decision (whatever day it was raised)
  splitToOthers: number;  // portions of approved bills charged to colleagues
  /** Own-share approved spend per calendar day, index 0 = the 1st. */
  daily:        number[];
  busiestDay:   { date: string; spent: number } | null;
}

/** One holder's month: what they spent, what is waiting, what they were given. Spend, credit
 *  and rejections belong to the month; the two "still waiting" figures (`pending` and
 *  `creditPending`) are all-time, because nothing else on the page ever surfaces them.
 *
 *  `credit` comes from the LEDGER, not from approved credit requests. A request is one way money
 *  reaches a float and not the common one — a manual credit from an approver, an opening balance,
 *  a bulk import and the month's carry-forward all post a ledger entry and no request at all
 *  (see adjustAccountBalance, which writes kind 'adjustment' with ref_type 'account'). Counting
 *  requests meant the holder's "Credit received" disagreed with their own balance: on live data
 *  21 holder-months were wrong by LKR 4.3M in total, one of them showing 0 against LKR 1,013,124
 *  actually received. The ledger is the money; the request is only a way of asking for it. */
export function summarizeHolderMonth(opts: {
  submissions: SuspenseSubmission[];
  requests:    SuspenseRequest[];
  /** The holder's own ledger. Entries outside the month are ignored here. */
  ledger?:     SuspenseLedgerEntry[];
  year:        number;
  month:       number;
}): HolderMonthSummary {
  const { year, month } = opts;
  const prefix = monthPrefix(year, month);
  const n = daysInMonth(year, month);
  const daily = Array.from({ length: n }, () => 0);
  const out: HolderMonthSummary = {
    spent: 0, billed: 0, pending: 0, pendingCount: 0, rejected: 0, credit: 0, creditPending: 0,
    splitToOthers: 0, daily, busiestDay: null,
  };

  for (const s of opts.submissions) {
    if (!s || s.deleted) continue;
    // The WHOLE bill, not the own share — that is what leaves the float (see floatCostOf), and
    // "Spent" has to mean the same thing the balance does or the two disagree on screen.
    const cost = floatCostOf(s);
    // Waiting is not a property of a month, so pending is counted whatever month it fell in.
    // A bill raised in August and still unapproved in September is money this holder has not
    // accounted for whichever way the stepper is pointed, and month-scoping it hid exactly the
    // bills they open this page to chase. creditPending below has always been all-time and the
    // balance cards count pending all-time too — scoping only this one made the same screen
    // show two different "awaiting" figures with nothing to say which was which.
    if (s.status === 'pending') {
      out.pending = round2(out.pending + cost);
      out.pendingCount += 1;
      continue;
    }
    const date = billDayOf(s);
    if (!date.startsWith(prefix)) continue;
    if (s.status === 'approved') {
      out.spent  = round2(out.spent + cost);
      out.billed = round2(out.billed + (Number(s.amount) || 0));
      out.splitToOthers = round2(out.splitToOthers + splitsSum(s.splits));
      const idx = Number(date.slice(8, 10)) - 1;
      if (idx >= 0 && idx < n) daily[idx] = round2(daily[idx] + cost);
    } else {
      out.rejected = round2(out.rejected + cost);
    }
  }

  // Still-open asks only. What was GRANTED is read off the ledger below, where the money is.
  for (const r of opts.requests) {
    if (!r) continue;
    if (r.status === 'pending') out.creditPending = round2(out.creditPending + (Number(r.amount) || 0));
  }

  // What actually landed in the float this month, however it got there — an approved request, an
  // approver's manual credit, an opening balance, a carry-forward. Amounts are signed, so a
  // correction that takes money back nets off rather than being silently dropped.
  for (const e of opts.ledger ?? []) {
    if (!e || !isCreditEntry(e)) continue;
    if (!localDayKey(msOf(e.created_at) ?? 0).startsWith(prefix)) continue;
    out.credit = round2(out.credit + (Number(e.amount) || 0));
  }

  let best = -1;
  daily.forEach((v, i) => { if (v > 0 && v > best) { best = v; out.busiestDay = { date: dayKey(year, month, i + 1), spent: v }; } });
  return out;
}

/** "12.5k" / "1.2M" / "850" — a number that fits in a calendar cell. */
export function compactAmount(n: number): string {
  const v = Math.abs(n);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M`;
  if (v >= 1_000)     return `${(v / 1_000).toFixed(v >= 100_000 ? 0 : 1)}k`;
  return String(Math.round(v));
}
