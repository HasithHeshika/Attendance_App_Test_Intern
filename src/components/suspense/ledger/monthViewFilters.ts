// In-memory slicing of a SuspenseMonthView for the approver Ledger tab: company filter,
// name/EPF search, hiding idle holders, sorting the people table and regrouping the same
// lines by day. Nothing here touches Firestore or re-runs buildSuspenseMonthView — the view
// is fetched once per month and every control on the tab is answered from it.
//
// Kept free of React so it can be reasoned about (and tested) as plain functions.

import type { DayTotal, LedgerLine, MonthTotals, PersonRow } from '@/lib/suspenseMonthView';
import { dayKey, daysInMonth } from '@/lib/suspenseMonthView';

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export type PeopleSortKey = 'spent' | 'pending' | 'credit' | 'balance' | 'name';
export type SortDir = 'asc' | 'desc';

/** A person stays under a company filter when any of their lines that month, or any of their
 *  accounts, belongs to the company. The person is kept whole — their lines for other companies
 *  are not stripped — so the row still answers "how much did this person take" in full. */
export function belongsToCompany(p: PersonRow, companyId: string): boolean {
  if (!companyId) return true;
  if (p.balances.some(b => b.company_id === companyId)) return true;
  return p.days.some(d => d.lines.some(l => l.company_id === companyId));
}

export function matchesSearch(p: PersonRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return p.name.toLowerCase().includes(q) || p.epf.toLowerCase().includes(q);
}

/** Same reducer buildSuspenseMonthView uses for its totals, over whatever subset is on screen. */
export function sumPeople(people: PersonRow[]): MonthTotals {
  return people.reduce<MonthTotals>((t, p) => ({
    spent:        round2(t.spent + p.spent),
    billed:       round2(t.billed + p.billed),
    pending:      round2(t.pending + p.pending),
    pendingCount: t.pendingCount + p.pendingCount,
    rejected:     round2(t.rejected + p.rejected),
    credit:       round2(t.credit + p.credit),
    billCount:    t.billCount + p.billCount,
    activePeople: t.activePeople + (p.active ? 1 : 0),
    holders:      t.holders + (p.balance !== null ? 1 : 0),
  }), { spent: 0, billed: 0, pending: 0, rejected: 0, credit: 0, pendingCount: 0, billCount: 0, activePeople: 0, holders: 0 });
}

/** Day totals for the heat grid, rebuilt from a subset of people (every calendar day present). */
export function rebuildDays(people: PersonRow[], year: number, month: number): DayTotal[] {
  const byDate = new Map<string, DayTotal>();
  const seen   = new Map<string, Set<string>>();
  for (let d = 1; d <= daysInMonth(year, month); d++) {
    const date = dayKey(year, month, d);
    byDate.set(date, { date, day: d, spent: 0, pending: 0, credit: 0, people: 0 });
    seen.set(date, new Set());
  }
  for (const p of people) {
    for (const b of p.days) {
      const t = byDate.get(b.date);
      if (!t) continue;
      t.spent   = round2(t.spent + b.spent);
      t.pending = round2(t.pending + b.pending);
      t.credit  = round2(t.credit + b.credit);
      if (b.lines.length) seen.get(b.date)?.add(p.epf);
    }
  }
  for (const [date, set] of seen) { const t = byDate.get(date); if (t) t.people = set.size; }
  return [...byDate.values()];
}

export function sortPeople(people: PersonRow[], key: PeopleSortKey, dir: SortDir): PersonRow[] {
  const sign = dir === 'asc' ? 1 : -1;
  const byName = (a: PersonRow, b: PersonRow) => a.name.localeCompare(b.name);
  return [...people].sort((a, b) => {
    if (key === 'name') return sign * byName(a, b);
    if (key === 'balance') {
      // People without an account have no balance to compare — they sit at the end either way.
      if (a.balance === null && b.balance === null) return byName(a, b);
      if (a.balance === null) return 1;
      if (b.balance === null) return -1;
      return sign * (a.balance - b.balance) || byName(a, b);
    }
    return sign * (a[key] - b[key]) || byName(a, b);
  });
}

export interface DayGroupPerson {
  epf:     string;
  name:    string;
  spent:   number;
  pending: number;
  credit:  number;
  lines:   LedgerLine[];
}

export interface DayGroup {
  date:    string;
  spent:   number;
  pending: number;
  credit:  number;
  people:  DayGroupPerson[];
}

/** The same lines regrouped day-first (newest day first), each day's people biggest spender
 *  first. Days with no lines are skipped — the heat grid already shows the quiet ones. */
export function groupByDayThenPerson(people: PersonRow[]): DayGroup[] {
  const days = new Map<string, DayGroup>();
  for (const p of people) {
    for (const b of p.days) {
      if (!b.lines.length) continue;
      let g = days.get(b.date);
      if (!g) { g = { date: b.date, spent: 0, pending: 0, credit: 0, people: [] }; days.set(b.date, g); }
      g.spent   = round2(g.spent + b.spent);
      g.pending = round2(g.pending + b.pending);
      g.credit  = round2(g.credit + b.credit);
      g.people.push({ epf: p.epf, name: p.name, spent: b.spent, pending: b.pending, credit: b.credit, lines: b.lines });
    }
  }
  return [...days.values()]
    .sort((a, b) => b.date.localeCompare(a.date))
    .map(g => ({ ...g, people: [...g.people].sort((x, y) => (y.spent - x.spent) || (y.pending - x.pending) || x.name.localeCompare(y.name)) }));
}

/** 0 = nothing, 1..4 = how a day's spend sits against the month's busiest day. */
export function heatBucket(spent: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (spent <= 0 || max <= 0) return 0;
  const r = spent / max;
  if (r > 0.75) return 4;
  if (r > 0.5)  return 3;
  if (r > 0.25) return 2;
  return 1;
}
