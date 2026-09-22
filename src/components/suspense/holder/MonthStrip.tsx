'use client';
// "This month at a glance" for one account holder: a month stepper and four numbers — what
// they spent, what is still waiting on someone, what they were given, and what they charged to
// colleagues. The daily bars under the spend figure answer "on which days" without a chart.
import { ChevronLeft, ChevronRight, Clock, TrendingDown, TrendingUp, Users } from 'lucide-react';
import { StatCard } from '@/components/ui/stat-card';
import { Button } from '@/components/ui/button';
import Sparkline from '@/components/ui/Sparkline';
import { formatSuspenseAmount } from '@/services/suspenseService';
import type { HolderMonthSummary } from '@/lib/suspenseMonthView';
import { MONTHS, prettyDay } from '@/components/suspense/shared';
import { cn } from '@/lib/utils';

export interface MonthCursor { year: number; month: number }

/** The stepper never walks past this month, and never further back than January of last year
 *  — the page loads a bounded window of history and anything older is not on screen. */
export function monthBounds(now = new Date()): { min: MonthCursor; max: MonthCursor } {
  return { min: { year: now.getFullYear() - 1, month: 1 }, max: { year: now.getFullYear(), month: now.getMonth() + 1 } };
}

const cmp = (a: MonthCursor, b: MonthCursor) => (a.year - b.year) || (a.month - b.month);

export function stepMonth(c: MonthCursor, delta: 1 | -1): MonthCursor {
  const m = c.month + delta;
  if (m < 1)  return { year: c.year - 1, month: 12 };
  if (m > 12) return { year: c.year + 1, month: 1 };
  return { year: c.year, month: m };
}

export function MonthStepper({ cursor, onChange, className }: {
  cursor: MonthCursor; onChange: (c: MonthCursor) => void; className?: string;
}) {
  const { min, max } = monthBounds();
  const canBack = cmp(cursor, min) > 0;
  const canFwd  = cmp(cursor, max) < 0;
  return (
    <div className={cn('flex items-center gap-1', className)}>
      <Button type="button" variant="ghost" size="icon-sm" aria-label="Previous month" disabled={!canBack}
        onClick={() => onChange(stepMonth(cursor, -1))}>
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <span className="min-w-[8.5rem] text-center text-sm font-semibold text-foreground" aria-live="polite">
        {MONTHS[cursor.month - 1]} {cursor.year}
      </span>
      <Button type="button" variant="ghost" size="icon-sm" aria-label="Next month" disabled={!canFwd}
        onClick={() => onChange(stepMonth(cursor, 1))}>
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  );
}

export function MonthStrip({ cursor, onChange, summary, billCount, currency }: {
  cursor:    MonthCursor;
  onChange:  (c: MonthCursor) => void;
  summary:   HolderMonthSummary;
  /** Approved bills that landed in this month — the summary carries the money, not the count. */
  billCount: number;
  currency:  string;
}) {
  const showSplit = summary.splitToOthers > 0;
  const busiest   = summary.busiestDay;
  const spentHint = billCount === 0
    ? 'No approved bills this month'
    : `${billCount} bill${billCount === 1 ? '' : 's'}${busiest ? ` · busiest ${prettyDay(busiest.date, { day: 'numeric', month: 'short' })} ${formatSuspenseAmount(busiest.spent, currency)}` : ''}`;

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">This month</div>
        <MonthStepper cursor={cursor} onChange={onChange} />
      </div>
      <div className={cn('grid gap-4 sm:grid-cols-2', showSplit ? 'lg:grid-cols-4' : 'lg:grid-cols-3')}>
        <StatCard
          label="Spent this month" icon={TrendingDown} tone="primary"
          value={<span className="tabular-nums">{formatSuspenseAmount(summary.spent, currency)}</span>}
          hint={spentHint}
          trailing={<Sparkline values={summary.daily} height={28} className="text-primary" />}
        />
        {/* The one tile here that is NOT about the month on the stepper: a bill is either
            still waiting or it is not, and scoping it to a month hid the older ones nobody
            was chasing. The hint says so, since it sits under a "This month" heading. */}
        <StatCard
          label="Awaiting approval" icon={Clock} tone="warning"
          value={<span className="tabular-nums">{formatSuspenseAmount(summary.pending, currency)}</span>}
          hint={summary.pendingCount > 0 ? `${summary.pendingCount} pending · any month` : undefined}
        />
        <StatCard
          label="Credit received" icon={TrendingUp} tone="brand"
          value={<span className="tabular-nums">{formatSuspenseAmount(summary.credit, currency)}</span>}
          hint={summary.creditPending > 0 ? `${formatSuspenseAmount(summary.creditPending, currency)} still requested` : undefined}
        />
        {showSplit && (
          <StatCard
            label="Split to colleagues" icon={Users} tone="muted"
            value={<span className="tabular-nums">{formatSuspenseAmount(summary.splitToOthers, currency)}</span>}
            hint="recovered from their salary"
          />
        )}
      </div>
    </div>
  );
}
