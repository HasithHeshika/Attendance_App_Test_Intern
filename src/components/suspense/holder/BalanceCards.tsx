'use client';
// The holder's balance hero. One account → one wide card, laid out across, because the balance
// is the number the whole page is about. Several accounts → a grid of compact company cards
// plus a combined total, with the same wash so the total reads as "one more card" rather than a
// separate summary. The pending lines are THIS company's own, not the org-wide totals.
import { Building2, Lock, TrendingDown, TrendingUp, Wallet } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { formatSuspenseAmount } from '@/services/suspenseService';
import { limitHeadroom, type ResolvedLimit } from '@/lib/suspenseLimits';
import { cn } from '@/lib/utils';
import type { SuspenseAccount } from '@/lib/types';

export interface AccountPending {
  expenseCount: number;
  expenseSum:   number;
  reqCount:     number;
  reqSum:       number;
}

export const NO_PENDING: AccountPending = { expenseCount: 0, expenseSum: 0, reqCount: 0, reqSum: 0 };

export function CompanyBalanceCard({ account, pending, limit, onRequest, onClose, wide }: {
  account:   SuspenseAccount;
  pending:   AccountPending;
  /** The float ceiling on THIS account (see src/lib/suspenseLimits.ts), or null/undefined when
   *  none applies or it hasn't resolved yet — the meter is simply absent then, which is the
   *  honest rendering of "you have no limit". */
  limit?:    ResolvedLimit | null;
  onRequest: (a: SuspenseAccount) => void;
  onClose:   (a: SuspenseAccount) => void;
  /** The page's hero — only when this is the holder's single account. */
  wide?:     boolean;
}) {
  const bal      = account.balance;
  const negative = bal < 0;
  const closed   = !!account.is_closed;
  const active   = account.is_active !== false;
  const frozen   = !active && !closed;
  const statusBadge = (
    <Badge variant={active ? 'success' : closed ? 'muted' : 'warning'}>{active ? 'Active' : closed ? 'Closed' : 'Close pending'}</Badge>
  );

  return (
    <Card className={cn('relative isolate overflow-hidden p-4', wide && 'p-5 sm:p-6')}>
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-bl from-primary/[0.07] to-transparent" />
      <div className={cn('flex items-start justify-between gap-2', wide && 'sm:items-center')}>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            <Building2 className="h-3.5 w-3.5 shrink-0" /> <span className="truncate">{account.company_name}</span>
          </div>
          <div className={cn(
            'mt-1 font-bold tabular-nums leading-tight',
            wide ? 'text-3xl sm:text-4xl' : 'text-2xl',
            negative ? 'text-destructive' : 'text-foreground',
          )}>
            {formatSuspenseAmount(bal, account.currency)}
          </div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {negative && active ? <span className="text-destructive">Overspent — awaiting top-up</span> : 'Available to spend'}
          </div>
        </div>
        {/* On the hero the actions sit beside the number, where the eye already is; the narrow
            card keeps them stacked underneath (there is no room across). */}
        <div className={cn('flex shrink-0 items-center gap-2', wide && 'flex-col items-end sm:flex-row sm:items-center')}>
          {wide && !closed && !frozen && (
            <div className="hidden gap-2 sm:flex">
              <Button type="button" size="sm" variant="outline" onClick={() => onRequest(account)}>
                <TrendingUp className="h-3.5 w-3.5" /> Request credit
              </Button>
              <Button type="button" size="sm" variant="outline" className="text-destructive hover:text-destructive" onClick={() => onClose(account)}>
                <Lock className="h-3.5 w-3.5" /> Close account
              </Button>
            </div>
          )}
          {statusBadge}
        </div>
      </div>

      <LimitMeter account={account} limit={limit} />

      {pending.expenseCount > 0 && (
        <div className="mt-2.5 flex items-center gap-1.5 rounded-md border border-warning/20 bg-warning/10 px-2.5 py-1.5 text-[11px] text-warning">
          <TrendingDown className="h-3 w-3 shrink-0" />
          {pending.expenseCount} expense{pending.expenseCount > 1 ? 's' : ''} pending · {formatSuspenseAmount(pending.expenseSum, account.currency)}
        </div>
      )}
      {pending.reqCount > 0 && (
        <div className="mt-1.5 flex items-center gap-1.5 rounded-md border border-primary/20 bg-primary/5 px-2.5 py-1.5 text-[11px] text-primary">
          <TrendingUp className="h-3 w-3 shrink-0" />
          {pending.reqCount} credit request{pending.reqCount > 1 ? 's' : ''} pending · {formatSuspenseAmount(pending.reqSum, account.currency)}
        </div>
      )}

      {closed ? (
        <p className="mt-3 text-[11px] text-muted-foreground">Closed &amp; settled.</p>
      ) : frozen ? (
        <p className="mt-3 rounded-md border border-warning/20 bg-warning/10 px-2.5 py-1.5 text-[11px] text-warning">Close request pending — frozen.</p>
      ) : (
        <div className={cn('mt-3 flex gap-2', wide && 'sm:hidden')}>
          <Button type="button" size="sm" variant="outline" className="flex-1" onClick={() => onRequest(account)}>
            <TrendingUp className="h-3.5 w-3.5" /> Request credit
          </Button>
          <Button type="button" size="sm" variant="outline" className="flex-1 text-destructive hover:text-destructive" onClick={() => onClose(account)}>
            <Lock className="h-3.5 w-3.5" /> Close
          </Button>
        </div>
      )}
    </Card>
  );
}

// How much of the ceiling this balance has eaten. Amber past 80% is a warning, not an error —
// the account is still usable; rose is the only state that means "you are over".
function LimitMeter({ account, limit }: { account: SuspenseAccount; limit?: ResolvedLimit | null }) {
  if (!limit || limit.limit === null) return null;
  const ceiling = limit.limit;
  const left    = limitHeadroom(ceiling, account.balance) ?? 0;
  const over    = left < 0;
  // A ceiling of 0 means "no float at all" — any positive balance is already over it, and
  // dividing by it would give Infinity, so it is read as full-or-empty rather than a ratio.
  const pct  = ceiling === 0 ? (account.balance > 0 ? 100 : 0) : Math.min(100, Math.max(0, (account.balance / ceiling) * 100));
  const tone = over ? 'bg-destructive' : pct >= 80 ? 'bg-warning' : 'bg-primary';
  return (
    <div className="mt-2.5">
      <div className="flex items-baseline justify-between gap-2 text-[11px] text-muted-foreground">
        <span>Limit <span className="font-medium tabular-nums text-foreground">{formatSuspenseAmount(ceiling, account.currency)}</span></span>
        <span className={cn('tabular-nums', over ? 'text-destructive' : pct >= 80 ? 'text-warning' : '')}>
          {over
            ? `${formatSuspenseAmount(-left, account.currency)} over`
            : `${formatSuspenseAmount(left, account.currency)} left`}
        </span>
      </div>
      <Progress value={pct} className="mt-1 h-1" indicatorClassName={tone} />
    </div>
  );
}

export function TotalBalanceCard({ total, currency, companyCount }: { total: number; currency: string; companyCount: number }) {
  const negative = total < 0;
  return (
    <Card className="relative isolate overflow-hidden p-4">
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-bl from-primary/[0.07] to-transparent" />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            <Wallet className="h-3.5 w-3.5 shrink-0" /> <span className="truncate">Total balance</span>
          </div>
          <div className={cn('mt-1 text-2xl font-bold tabular-nums leading-tight', negative ? 'text-destructive' : 'text-foreground')}>
            {formatSuspenseAmount(total, currency)}
          </div>
        </div>
        <Badge variant="muted">{companyCount} compan{companyCount === 1 ? 'y' : 'ies'}</Badge>
      </div>
    </Card>
  );
}
