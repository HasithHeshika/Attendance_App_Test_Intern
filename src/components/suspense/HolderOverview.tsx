'use client';
// The account holder's view of /suspense. What they should see at a glance, top to bottom:
// how much float they have, what this month cost them and on which days, what is still waiting
// on someone, and what they were given — then the submit form beside the day-by-day activity.
//
// The page owns the data, the dialogs and the submit form; this component only lays them out.
// Month arithmetic comes from summarizeHolderMonth and the feed groups on the very same day
// keys, so the strip and the list can never disagree about which month a bill belongs to.
import { useEffect, useMemo, useState } from 'react';
import { Wallet } from 'lucide-react';
import type {
  SuspenseAccount, SuspenseCloseRequest, SuspenseLedgerEntry, SuspenseRequest, SuspenseSubmission,
} from '@/lib/types';
import { billDayOf, floatCostOf, monthPrefix, summarizeHolderMonth } from '@/lib/suspenseMonthView';
import type { ResolvedLimit } from '@/lib/suspenseLimits';
import { cn } from '@/lib/utils';
import { resolveLimitCached } from '@/components/suspense/shared';
import { CompanyBalanceCard, NO_PENDING, TotalBalanceCard, type AccountPending } from './holder/BalanceCards';
import { MonthStrip, monthBounds, type MonthCursor } from './holder/MonthStrip';
import ActivityFeed from './holder/ActivityFeed';

export interface HolderOverviewProps {
  accounts: SuspenseAccount[]; currency: string;
  mySubs: SuspenseSubmission[]; myReqs: SuspenseRequest[]; closes: SuspenseCloseRequest[]; loading: boolean;
  /** The holder's own ledger — the record of what actually reached the float. Both the month
   *  strip's credit figure and the feed's non-request movements are read from here, because a
   *  credit request is only one of several ways money arrives (see summarizeHolderMonth). */
  ledger: SuspenseLedgerEntry[];
  ctx: { epf: string; name: string; companyId: string; companyName: string };
  multiCompany: boolean;
  /** Whether the submit form is usable — the page computes it and its form shows its own warning. */
  canSubmit: boolean;
  /** The page's existing NewExpenseForm card, rendered as-is in the left column. */
  submitForm: React.ReactNode;
  onRequest: (a: SuspenseAccount) => void; onClose: (a: SuspenseAccount) => void;
  onEditExpense: (s: SuspenseSubmission) => void; onDeleteExpense: (id: string) => void;
  onEditRequest: (r: SuspenseRequest) => void; onDeleteRequest: (id: string) => void;
  onRefresh: () => void | Promise<void>;
}

export default function HolderOverview({
  accounts, currency, mySubs, myReqs, closes, ledger, loading, ctx, multiCompany, submitForm,
  onRequest, onClose, onEditExpense, onDeleteExpense, onEditRequest, onDeleteRequest, onRefresh,
}: HolderOverviewProps) {
  const [cursor, setCursor] = useState<MonthCursor>(() => monthBounds().max);

  // The float ceiling per account, resolved once here rather than inside each card — the cards
  // render on every month change and a per-card fetch would re-read the settings doc each time.
  // A company with no limit simply never lands in the map, and its card shows no meter.
  const [limits, setLimits] = useState<Record<string, ResolvedLimit>>({});
  const accountKey = accounts.map(a => a.company_id).join(',');
  useEffect(() => {
    if (!ctx.epf || accounts.length === 0) { setLimits({}); return; }
    let alive = true;
    Promise.all(accounts.map(a =>
      resolveLimitCached(ctx.epf, a.company_id)
        .then(r => [a.company_id, r] as const)
        .catch(() => null),
    )).then(pairs => {
      if (!alive) return;
      setLimits(Object.fromEntries(pairs.filter((x): x is readonly [string, ResolvedLimit] => x !== null)));
    });
    return () => { alive = false; };
    // `accountKey` stands in for the account list — only the set of companies matters here, and
    // depending on `accounts` itself would refetch on every balance refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.epf, accountKey]);

  // Pending is all-time here, not month-scoped: a bill from last month still waiting on an
  // approver is exactly the thing the holder wants to know about. The month strip and the
  // activity feed count it the same way, so the three agree.
  const pendingExpenses = mySubs.filter(s => s.status === 'pending' && !s.deleted);
  const pendingReqs     = myReqs.filter(r => r.status === 'pending');
  const hasPending      = pendingExpenses.length > 0 || pendingReqs.length > 0;

  // NOTE: a pending bill for a company this holder has no account row for yet is not counted
  // on any card — there is no card to put it on. approveSubmission auto-creates that account,
  // so this is reachable. The month strip's "Awaiting approval" counts every pending bill and
  // is the complete figure; these badges are the per-company breakdown of it.
  const pendingByCompany = new Map<string, AccountPending>(accounts.map(a => [a.company_id, { ...NO_PENDING }]));
  for (const s of pendingExpenses) {
    const p = pendingByCompany.get(s.company_id); if (!p) continue;
    // The face value: approveSubmission debits the WHOLE bill, because the whole bill left the
    // payer's hand. Splits return afterwards through recoverSplit, one credit at a time, so
    // netting them off here would understate what this bill is about to take.
    p.expenseCount++; p.expenseSum += floatCostOf(s);
  }
  for (const r of pendingReqs) {
    const p = pendingByCompany.get(r.company_id); if (!p) continue;
    p.reqCount++; p.reqSum += r.amount;
  }

  // The holder's own-company account leads the grid; the rest keep the order they came in.
  const ordered = useMemo(() => {
    const own = accounts.filter(a => a.company_id === ctx.companyId);
    return [...own, ...accounts.filter(a => a.company_id !== ctx.companyId)];
  }, [accounts, ctx.companyId]);
  const totalBalance = accounts.reduce((t, a) => t + (Number(a.balance) || 0), 0);

  const summary = useMemo(
    () => summarizeHolderMonth({ submissions: mySubs, requests: myReqs, ledger, year: cursor.year, month: cursor.month }),
    [mySubs, myReqs, ledger, cursor.year, cursor.month],
  );
  const prefix = monthPrefix(cursor.year, cursor.month);
  const billCount = useMemo(
    () => mySubs.filter(s => s && !s.deleted && s.status === 'approved' && billDayOf(s).startsWith(prefix)).length,
    [mySubs, prefix],
  );

  return (
    <div className="space-y-6">
      {/* 1. Balance hero */}
      <div>
        <div className="mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
          <Wallet className="h-3.5 w-3.5" /> Balances{accounts.length > 1 ? ` · ${accounts.length} companies` : ''}
        </div>
        <div className={cn('grid gap-4', accounts.length > 1 && 'sm:grid-cols-2 lg:grid-cols-3')}>
          {ordered.map(a => (
            <CompanyBalanceCard key={a.company_id} account={a}
              pending={pendingByCompany.get(a.company_id) ?? NO_PENDING}
              limit={limits[a.company_id] ?? null}
              onRequest={onRequest} onClose={onClose} wide={accounts.length === 1} />
          ))}
          {accounts.length > 1 && (
            <TotalBalanceCard total={totalBalance} currency={currency} companyCount={accounts.length} />
          )}
        </div>
        {/* With nothing in flight one quiet line says so; when something is, the cards above
            and the amber KPI below already carry it. */}
        {!loading && !hasPending && (
          <p className="mt-3 text-xs text-muted-foreground">Nothing awaiting approval — everything you&apos;ve submitted has been settled.</p>
        )}
      </div>

      {/* 2. Month strip */}
      <MonthStrip cursor={cursor} onChange={setCursor} summary={summary} billCount={billCount} currency={currency} />

      {/* 3. Submit beside activity. The form is the one action here, so it leads; activity is
          the wider column because it is what you come back to read. */}
      <div className="grid gap-6 lg:grid-cols-5 lg:items-start">
        <div className="lg:col-span-2">{submitForm}</div>
        <div className="lg:col-span-3">
          <ActivityFeed
            subs={mySubs} reqs={myReqs} closes={closes} ledger={ledger} loading={loading}
            currency={currency} multiCompany={multiCompany} cursor={cursor}
            onEditExpense={onEditExpense} onDeleteExpense={onDeleteExpense}
            onEditRequest={onEditRequest} onDeleteRequest={onDeleteRequest}
            onRefresh={onRefresh}
          />
        </div>
      </div>
    </div>
  );
}
