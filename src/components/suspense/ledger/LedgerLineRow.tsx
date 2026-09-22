'use client';
// One line of the approver ledger — a bill or a credit — rendered the same way in the
// per-person expansion and the by-day list so the two never disagree on what a line looks
// like. Bills show the holder's own share (what actually left their float); when part of the
// bill was split to colleagues the full bill is written small beside it.
import type { ReactNode } from 'react';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import type { LedgerLine } from '@/lib/suspenseMonthView';
import { formatSuspenseAmount } from '@/services/suspenseService';
import { cn } from '@/lib/utils';
import { BillLink, StatusBadge } from '@/components/suspense/shared';

export function LedgerLineRow({ line, currency, showName = false }: {
  line: LedgerLine;
  currency: string;
  /** Put the person's name first — for lists where the person is not already the heading. */
  showName?: boolean;
}) {
  if (line.kind === 'credit') {
    // A float-side line can go either way — an adjustment that takes money back (a carry-forward
    // of an overdrawn float, an admin correction) is negative. Draw the direction from the sign
    // rather than assuming a plus: the arrow, the sign and the tone all follow it, because
    // "+LKR -1,760.00" under an up-arrow is worse than not showing the line at all.
    const back = line.amount < 0;
    const Arrow = back ? ArrowDownRight : ArrowUpRight;
    return (
      <div className="flex items-center gap-3 rounded-lg border border-border/60 bg-card/50 px-2.5 py-2">
        <span aria-hidden className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-md',
          back ? 'bg-muted text-muted-foreground' : 'bg-primary/10 text-primary',
        )}>
          <Arrow className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm text-foreground">
            {showName && <span className="font-medium">{line.name} · </span>}
            {line.label}
          </div>
          {line.sublabel && <div className="truncate text-[11px] text-muted-foreground">{line.sublabel}</div>}
        </div>
        <div className={cn('shrink-0 text-sm font-semibold tabular-nums', back ? 'text-muted-foreground' : 'text-primary')}>
          {back ? '−' : '+'}{formatSuspenseAmount(Math.abs(line.amount), currency)}
        </div>
      </div>
    );
  }

  const rejected = line.status === 'rejected';
  const pending  = line.status === 'pending';
  const owedBack = line.recoverable;
  return (
    <div className={cn('flex items-center gap-3 rounded-lg border border-border/60 bg-card/50 px-2.5 py-2', rejected && 'opacity-70')}>
      <BillLink url={line.bill?.bill_url ?? null} type={line.bill?.bill_type ?? null} size="sm" />
      <div className="min-w-0 flex-1">
        <div className={cn('flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm', rejected ? 'text-muted-foreground line-through' : 'text-foreground')}>
          {showName && <span className="font-medium">{line.name}</span>}
          <span className="truncate">{line.label}</span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          {line.sublabel && <span className={cn('truncate text-[11px] text-muted-foreground', rejected && 'line-through')}>{line.sublabel}</span>}
          <StatusBadge status={line.status === 'posted' ? 'approved' : line.status} />
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className={cn(
          'text-sm font-semibold tabular-nums',
          rejected ? 'text-muted-foreground line-through' : pending ? 'text-warning' : 'text-foreground',
        )}>
          −{formatSuspenseAmount(line.floatAmount, currency)}
        </div>
        {/* The whole bill leaves the float; a split is money the holder is carrying for someone
            else until payroll deducts it. Say what is coming back, not a smaller headline — the
            old "own share" figure made a fully-split bill read as costing nothing. */}
        {owedBack > 0 && (
          <div className="text-[10px] tabular-nums text-muted-foreground">
            {formatSuspenseAmount(owedBack, currency)} owed back
          </div>
        )}
      </div>
    </div>
  );
}

/** "−spent · pending · +credit" — the subtotal strip used on day headers. Zeroes are omitted. */
export function DaySubtotals({ spent, pending, credit, currency, className }: {
  spent: number; pending: number; credit: number; currency: string; className?: string;
}) {
  const parts: ReactNode[] = [];
  if (spent > 0)   parts.push(<span key="s" className="tabular-nums text-foreground">−{formatSuspenseAmount(spent, currency)}</span>);
  if (pending > 0) parts.push(<span key="p" className="tabular-nums text-warning">{formatSuspenseAmount(pending, currency)} pending</span>);
  if (credit > 0)  parts.push(<span key="c" className="tabular-nums text-primary">+{formatSuspenseAmount(credit, currency)}</span>);
  if (!parts.length) return null;
  return (
    <div className={cn('flex flex-wrap items-center gap-x-1.5 text-xs', className)}>
      {parts.map((p, i) => (
        <span key={i} className="inline-flex items-center gap-1.5">
          {i > 0 && <span aria-hidden className="text-muted-foreground/60">·</span>}
          {p}
        </span>
      ))}
    </div>
  );
}
