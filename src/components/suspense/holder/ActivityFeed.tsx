'use client';
// The holder's activity, day by day. Expenses, credit requests and close requests are one list
// here, grouped on the day each one counts on (see activityItems.ts), so the day headers add
// up to the same numbers as the month strip above them. A row is one line — what, status,
// how much — and opens in place for the bill, the splits, who decided it and the actions.
import { useMemo, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import {
  ArrowDownRight, ArrowUpRight, Building2, ChevronDown, Clock, History as HistoryIcon, Lock, Pencil,
  RefreshCw, Search, Tags, Trash2, UserPlus, X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/empty-state';
import { ListSkeleton } from '@/components/ui/Skeleton';
import { formatSuspenseAmount, requestStage } from '@/services/suspenseService';
import { monthPrefix, splitsOwedBack } from '@/lib/suspenseMonthView';
import type {
  SuspenseCloseRequest, SuspenseLedgerEntry, SuspenseRequest, SuspenseSubmission,
} from '@/lib/types';
import { cn } from '@/lib/utils';
import { BillLink, ConsideredBy, MONTHS, SplitsLine, StatusBadge, fmtDateTime, prettyDay } from '@/components/suspense/shared';
import {
  DEFAULT_FILTERS, LEDGER_LABEL, applyActivityFilters, buildActivityItems, grantedOf,
  groupActivityByDay, inMonthRange, isCarriedIn, isLedgerItem,
  type ActivityFilters, type ActivityItem, type DayGroup, type KindFilter, type StatusFilter,
} from './activityItems';
import type { MonthCursor } from './MonthStrip';

export interface ActivityFeedProps {
  subs:    SuspenseSubmission[];
  reqs:    SuspenseRequest[];
  closes:  SuspenseCloseRequest[];
  /** The holder's ledger. Float movements with no request behind them get their own rows, so a
   *  balance that moved on its own has something on the page that explains it. */
  ledger:  SuspenseLedgerEntry[];
  loading: boolean;
  currency: string;
  multiCompany: boolean;
  /** The month the strip above is showing — "This month" in the feed follows it. */
  cursor:  MonthCursor;
  onEditExpense:   (s: SuspenseSubmission) => void;
  onDeleteExpense: (id: string) => void;
  onEditRequest:   (r: SuspenseRequest) => void;
  onDeleteRequest: (id: string) => void;
  /** Re-fetch the holder's lists. Optional so the feed can stand alone. */
  onRefresh?:      () => void | Promise<void>;
}

const KIND_CHIPS: Array<{ value: KindFilter; label: string }> = [
  { value: 'all',     label: 'All' },
  { value: 'expense', label: 'Expenses' },
  { value: 'credit',  label: 'Credit' },
  { value: 'close',   label: 'Close requests' },
];
const STATUS_CHIPS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'pending',  label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
];

// Pill buttons with a real pressed state — the same look the page uses for its own chips, at
// a height a thumb can hit.
function Chip({ active, onClick, children, className }: {
  active: boolean; onClick: () => void; children: React.ReactNode; className?: string;
}) {
  return (
    <button
      type="button" onClick={onClick} aria-pressed={active}
      className={cn(
        'inline-flex min-h-9 items-center gap-1 rounded-full border px-3 text-[11px] font-medium transition-colors',
        active ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-card/60 text-muted-foreground hover:bg-accent',
        className,
      )}
    >
      {children}
    </button>
  );
}

// "Tue, 5 Aug" — the year only once it is not this one.
function dayLabel(iso: string): string {
  const sameYear = iso.slice(0, 4) === String(new Date().getFullYear());
  return prettyDay(iso, sameYear
    ? { weekday: 'short', day: 'numeric', month: 'short' }
    : { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

// Who can still clear a request's category stage, read off the snapshot the request carries.
function categoryApproverLabel(r: SuspenseRequest): string {
  const names = (r.category_approvers ?? []).map(a => a.name).filter(Boolean);
  if (names.length === 0) return 'Awaiting category approver';
  if (names.length === 1) return `Awaiting ${names[0]}`;
  return `Awaiting any of ${names.join(', ')}`;
}

export default function ActivityFeed({
  subs, reqs, closes, ledger, loading, currency, multiCompany, cursor,
  onEditExpense, onDeleteExpense, onEditRequest, onDeleteRequest, onRefresh,
}: ActivityFeedProps) {
  const [filters, setFilters] = useState<ActivityFilters>(DEFAULT_FILTERS);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [refreshing, setRefreshing] = useState(false);
  const reduce = useReducedMotion();

  const refresh = async () => {
    if (!onRefresh || refreshing) return;
    setRefreshing(true);
    try { await onRefresh(); } finally { setRefreshing(false); }
  };

  // Which of a bill's two dates the list groups and orders by. Bill date by default — the month
  // strip above counts that way, so the two agree until the reader deliberately asks otherwise.
  const [dateField, setDateField] = useState<'bill' | 'submitted'>('bill');
  const all = useMemo(() => buildActivityItems({ subs, reqs, closes, ledger, dateField }), [subs, reqs, closes, ledger, dateField]);
  const prefix = monthPrefix(cursor.year, cursor.month);
  const inRange = useMemo(
    () => all.filter(it => inMonthRange(it, filters.range, prefix)),
    [all, filters.range, prefix],
  );
  const shown  = useMemo(() => applyActivityFilters(all, filters, prefix), [all, filters, prefix]);
  const groups = useMemo(() => groupActivityByDay(shown), [shown]);
  // Anything on screen that belongs to another month and is here only because it is still
  // waiting. The day headers already carry its real date; this is what lets the count line say
  // why September is showing an August bill instead of just looking wrong.
  const carriedIn = useMemo(
    () => shown.filter(it => isCarriedIn(it, filters.range, prefix)).length,
    [shown, filters.range, prefix],
  );

  const set = (patch: Partial<ActivityFilters>) => setFilters(f => ({ ...f, ...patch }));
  const narrowed = filters.kind !== 'all' || filters.status !== 'all' || filters.text.trim() !== '';
  const clearFilters = () => setFilters(f => ({ ...DEFAULT_FILTERS, range: f.range }));
  const toggle = (key: string) => setOpen(prev => {
    const n = new Set(prev);
    if (n.has(key)) n.delete(key); else n.add(key);
    return n;
  });

  const monthName = `${MONTHS[cursor.month - 1]}`;

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
          <HistoryIcon className="h-3.5 w-3.5" /> Activity
        </div>
        {/* Range: the feed follows the month stepper by default; "All time" widens it. */}
        <div className="flex items-center gap-1">
          <Button type="button" size="sm" variant={filters.range === 'month' ? 'secondary' : 'ghost'}
            className="h-8" aria-pressed={filters.range === 'month'} onClick={() => set({ range: 'month' })}>
            This month
          </Button>
          <Button type="button" size="sm" variant={filters.range === 'all' ? 'secondary' : 'ghost'}
            className="h-8" aria-pressed={filters.range === 'all'} onClick={() => set({ range: 'all' })}>
            All time
          </Button>
          {onRefresh && (
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Refresh activity" disabled={refreshing || loading} onClick={refresh}>
              <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
            </Button>
          )}
        </div>
      </div>

      <div className="mb-3 space-y-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={filters.text} onChange={e => set({ text: e.target.value })}
            placeholder="Search item, shop, category, reason, bill no, amount…" aria-label="Search activity" className="pl-9 pr-9" />
          {filters.text && (
            <button type="button" aria-label="Clear search" onClick={() => set({ text: '' })}
              className="absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {KIND_CHIPS.map(c => (
            <Chip key={c.value} active={filters.kind === c.value} onClick={() => set({ kind: c.value })}>{c.label}</Chip>
          ))}
          <span aria-hidden className="mx-1 hidden h-4 w-px bg-border sm:block" />
          {STATUS_CHIPS.map(c => (
            <Chip key={c.value} active={filters.status === c.value}
              onClick={() => set({ status: filters.status === c.value ? 'all' : c.value })}>
              {c.label}
            </Chip>
          ))}
          {narrowed && (
            <Button type="button" size="sm" variant="ghost" className="h-8 text-muted-foreground" onClick={clearFilters}>
              <X className="h-3.5 w-3.5" /> Clear
            </Button>
          )}
        </div>
        {/* Group and order by the date on the receipt, or by the day it was handed in. A batch
            of receipts submitted together spans weeks by bill date and collapses onto one day
            by submitted date — both are worth seeing, and neither is the "right" one. */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-medium text-muted-foreground">Order by</span>
          <Chip active={dateField === 'bill'} onClick={() => setDateField('bill')}>Bill date</Chip>
          <Chip active={dateField === 'submitted'} onClick={() => setDateField('submitted')}>Submitted date</Chip>
        </div>
      </div>

      {/* The strip above always counts by bill date, so say when the list has stopped matching
          it rather than letting the two quietly disagree. */}
      {dateField === 'submitted' && (
        <p className="mb-2 px-1 text-[11px] text-muted-foreground">
          Grouped by the day each bill was handed in. The month totals above still count by bill date.
        </p>
      )}

      {loading ? (
        <ListSkeleton rows={4} />
      ) : all.length === 0 ? (
        <EmptyState icon={HistoryIcon} title="No activity yet"
          description="Your expenses and credit requests will show up here with their status." />
      ) : (
        <>
          <div className="mb-2 px-1 text-[11px] text-muted-foreground">
            Showing <span className="tabular-nums">{shown.length}</span> of <span className="tabular-nums">{inRange.length}</span>
            {filters.range === 'month' ? ` in ${monthName}` : ' all time'}
            {carriedIn > 0 && (
              <>
                {' · '}
                <span className="text-warning">
                  including <span className="font-semibold tabular-nums">{carriedIn}</span> still awaiting from
                  {' '}{carriedIn === 1 ? 'an earlier month' : 'earlier months'}
                </span>
              </>
            )}
          </div>

          {shown.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              {filters.range === 'month' && !narrowed ? (
                <>
                  Nothing in {monthName}.{' '}
                  <button type="button" onClick={() => set({ range: 'all' })} className="font-medium text-primary hover:underline">Show all time</button>
                </>
              ) : (
                <>
                  No activity matches your filters.{' '}
                  <button type="button" onClick={clearFilters} className="font-medium text-primary hover:underline">Clear filters</button>
                  {filters.range === 'month' && (
                    <>
                      {' '}or{' '}
                      <button type="button" onClick={() => set({ range: 'all' })} className="font-medium text-primary hover:underline">show all time</button>
                    </>
                  )}
                </>
              )}
            </div>
          ) : (
            /* Capped and self-scrolling only where the two columns exist. Below `lg` they
               stack, and a 36rem window becomes a second scroller filling a phone screen with
               no edge to show it is one — while the shell's pull-to-refresh (a non-passive
               touchmove on the page scroller) cancels a downward swipe inside it whenever the
               page sits at the top, which is where this tab opens. Let it flow into the page. */
            <div className="space-y-4 scrollbar-thin lg:max-h-[36rem] lg:overflow-y-auto lg:pr-1">
              {groups.map(g => (
                <DayBlock key={g.date} group={g} currency={currency} multiCompany={multiCompany}
                  open={open} toggle={toggle} reduce={!!reduce}
                  onEditExpense={onEditExpense} onDeleteExpense={onDeleteExpense}
                  onEditRequest={onEditRequest} onDeleteRequest={onDeleteRequest} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── One day ────────────────────────────────────────────────────────────────────

function DayBlock({ group, currency, multiCompany, open, toggle, reduce, onEditExpense, onDeleteExpense, onEditRequest, onDeleteRequest }: {
  group: DayGroup; currency: string; multiCompany: boolean;
  open: Set<string>; toggle: (key: string) => void; reduce: boolean;
  onEditExpense: (s: SuspenseSubmission) => void; onDeleteExpense: (id: string) => void;
  onEditRequest: (r: SuspenseRequest) => void; onDeleteRequest: (id: string) => void;
}) {
  return (
    <section aria-label={dayLabel(group.date)}>
      {/* Sticky inside the scrolling list, so the day stays named while its rows go by. The
          numbers on the right are the day's own: approved spend bold, pending in amber, credit
          with a plus. Both spend figures show when both exist. */}
      <div className="sticky top-0 z-10 flex items-baseline justify-between gap-3 bg-background/95 px-1 py-1.5 backdrop-blur-sm">
        <div className="text-xs font-semibold text-foreground">{dayLabel(group.date)}</div>
        <div className="flex items-baseline gap-2.5 text-[11px] tabular-nums">
          {group.spent > 0 && <span className="font-bold text-foreground">−{formatSuspenseAmount(group.spent, currency)}</span>}
          {group.pending > 0 && (
            <span className="font-medium text-warning">−{formatSuspenseAmount(group.pending, currency)}<span className="ml-0.5 font-normal opacity-80">pending</span></span>
          )}
          {group.credit > 0 && <span className="font-bold text-primary">+{formatSuspenseAmount(group.credit, currency)}</span>}
        </div>
      </div>
      <div className="space-y-1.5">
        {group.items.map(it => {
          const key = `${it.kind}-${it.id}`;
          const isOpen = open.has(key);
          return (
            <div key={key} className="overflow-hidden rounded-lg border border-border/60 bg-card/50">
              <button type="button" onClick={() => toggle(key)} aria-expanded={isOpen}
                className="flex w-full items-center gap-3 px-2.5 py-2.5 text-left transition-colors hover:bg-accent/40">
                <RowSummary item={it} currency={currency} multiCompany={multiCompany} />
                <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200', isOpen && 'rotate-180')} />
              </button>
              <AnimatePresence initial={false}>
                {isOpen && (
                  <motion.div
                    initial={reduce ? false : { height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={reduce ? undefined : { height: 0, opacity: 0 }}
                    transition={{ duration: 0.22, ease: 'easeInOut' }}
                    className="overflow-hidden"
                  >
                    <div className="border-t border-border/60 px-3 py-3">
                      <RowDetails item={it} currency={currency} multiCompany={multiCompany}
                        onEditExpense={onEditExpense} onDeleteExpense={onDeleteExpense}
                        onEditRequest={onEditRequest} onDeleteRequest={onDeleteRequest} />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ─── Collapsed row ──────────────────────────────────────────────────────────────

const ICON_DISC: Record<ActivityItem['kind'], string> = {
  expense: 'bg-destructive/10 text-destructive',
  credit:  'bg-primary/10 text-primary',
  close:   'bg-muted text-muted-foreground',
};

function RowSummary({ item, currency, multiCompany }: { item: ActivityItem; currency: string; multiCompany: boolean }) {
  const rejected = item.status === 'rejected';
  const Icon = item.kind === 'expense' ? ArrowDownRight : item.kind === 'credit' ? ArrowUpRight : Lock;

  let primary: React.ReactNode;
  let secondary = '';
  let amount: React.ReactNode;
  let under: React.ReactNode = null;

  if (item.kind === 'expense') {
    const s = item.sub;
    primary   = [s.category, s.subcategory].filter(Boolean).join(' · ') || s.expense_type || 'Expense';
    secondary = [s.item, s.shop_name].filter(Boolean).join(' @ ');
    const owedBack = splitsOwedBack(s.splits);
    amount = <>−{formatSuspenseAmount(s.amount, currency)}</>;
    // The whole bill left the float. What is still out with colleagues is money coming BACK, so
    // say that rather than a smaller "your share" headline — that reading made a fully-split bill
    // look as though it had cost nothing at all.
    if (owedBack > 0) under = <div className="text-[10px] text-muted-foreground">{formatSuspenseAmount(owedBack, currency)} owed back to you</div>;
  } else if (isLedgerItem(item)) {
    // Money that moved with no request behind it — an approver's manual credit, an opening
    // balance, the month's carry-forward. Signed, so a correction reads as money going back.
    const e = item.entry;
    const amt = Number(e.amount) || 0;
    primary   = LEDGER_LABEL[e.kind] ?? 'Balance adjustment';
    secondary = e.note || '';
    amount = <>{amt < 0 ? '−' : '+'}{formatSuspenseAmount(Math.abs(amt), currency)}</>;
  } else if (item.kind === 'credit') {
    const r = item.req;
    primary = (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        Credit request
        {r.category_name && <Badge variant="outline" className="gap-1 py-0 text-[10px]"><Tags className="h-3 w-3" /> {r.category_name}</Badge>}
      </span>
    );
    secondary = r.reason || '';
    amount = <>+{formatSuspenseAmount(r.amount, currency)}</>;
  } else {
    const c = item.close;
    primary   = 'Close account';
    secondary = c.note || '';
    amount = <>{formatSuspenseAmount(c.balance_at_request, currency)}</>;
    under = <div className="text-[10px] text-muted-foreground">balance at request</div>;
  }

  return (
    <>
      <span aria-hidden className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', ICON_DISC[item.kind])}>
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className={cn('flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm', rejected ? 'text-muted-foreground' : 'text-foreground')}>
          <span className="truncate font-medium">{primary}</span>
          <StatusBadge status={item.status} />
        </div>
        {(secondary || multiCompany) && (
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
            {multiCompany && item.company && (
              <span className="inline-flex shrink-0 items-center gap-1"><Building2 className="h-3 w-3" /> {item.company}</span>
            )}
            {secondary && <span className="truncate">{multiCompany && item.company ? `· ${secondary}` : secondary}</span>}
          </div>
        )}
      </div>
      <div className="shrink-0 text-right">
        <div className={cn(
          'text-sm font-bold tabular-nums',
          rejected ? 'text-muted-foreground line-through'
            : item.kind === 'credit' ? 'text-primary'
            : item.kind === 'close' && item.close.balance_at_request < 0 ? 'text-destructive'
            : 'text-foreground',
        )}>
          {amount}
        </div>
        {under}
      </div>
    </>
  );
}

// ─── Expanded details ───────────────────────────────────────────────────────────

function Meta({ children }: { children: React.ReactNode }) {
  return <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">{children}</span>;
}

function RowDetails({ item, currency, multiCompany, onEditExpense, onDeleteExpense, onEditRequest, onDeleteRequest }: {
  item: ActivityItem; currency: string; multiCompany: boolean;
  onEditExpense: (s: SuspenseSubmission) => void; onDeleteExpense: (id: string) => void;
  onEditRequest: (r: SuspenseRequest) => void; onDeleteRequest: (id: string) => void;
}) {
  if (item.kind === 'expense') {
    const s = item.sub;
    const filedByOther = !!s.submitted_by_epf && s.submitted_by_epf !== s.epf_number;
    const billDate = s.bill_date?.toDate?.();
    return (
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <BillLink url={s.bill_url} type={s.bill_type} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            {s.bill_no && <Badge variant="muted">Bill No. {s.bill_no}</Badge>}
            {s.type && <Badge variant="outline">{s.type}</Badge>}
            {multiCompany && <Badge variant="outline" className="gap-1"><Building2 className="h-3 w-3" /> {s.company_name}</Badge>}
          </div>
          {s.item && <div className="mt-1.5 whitespace-pre-line text-sm text-muted-foreground">{s.item}</div>}
          {s.note && <div className="mt-1 text-xs text-muted-foreground">Note: {s.note}</div>}
          {s.is_vat && (
            <div className="mt-1 text-[11px] font-medium text-primary">
              VAT {formatSuspenseAmount(s.vat_amount ?? 0, currency)}{s.vat_number ? ` · Reg ${s.vat_number}` : ''}
            </div>
          )}
          <SplitsLine splits={s.splits} currency={currency} />
          {filedByOther && (
            <div className="mt-1 flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
              <UserPlus className="h-3 w-3 shrink-0" /> Submitted by {s.submitted_by_name || s.submitted_by_epf}
            </div>
          )}
          <ConsideredBy status={s.status} byName={s.considered_by_name} by={s.considered_by} reason={s.reject_reason} />
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            {billDate && <Meta>Bill date {billDate.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</Meta>}
            <Meta><Clock className="h-3 w-3" /> Submitted {fmtDateTime(s.created_at)}</Meta>
            {s.considered_at && <Meta>Decided {fmtDateTime(s.considered_at)}</Meta>}
          </div>
          {s.status === 'pending' && (
            <div className="mt-2.5 flex flex-wrap justify-end gap-1.5">
              <Button type="button" size="sm" variant="outline" onClick={() => onEditExpense(s)}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Button>
              <Button type="button" size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => onDeleteExpense(s.id)}
                title="Cancel — withdraw this bill">
                <Trash2 className="h-3.5 w-3.5" /> Cancel
              </Button>
            </div>
          )}
          {s.status === 'rejected' && (
            <div className="mt-2.5 flex flex-wrap justify-end gap-1.5">
              <Button type="button" size="sm" variant="outline" onClick={() => onEditExpense(s)} title="Fix and resubmit">
                <RefreshCw className="h-3.5 w-3.5" /> Resubmit
              </Button>
              <Button type="button" size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => onDeleteExpense(s.id)}
                title="Cancel — withdraw this bill">
                <Trash2 className="h-3.5 w-3.5" /> Cancel
              </Button>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (isLedgerItem(item)) {
    // Nothing to approve, edit or chase — it already happened. Who did it and when is the whole
    // story, and it is exactly what the holder needs to reconcile a balance that moved on its own.
    const e = item.entry;
    return (
      <div className="min-w-0">
        {e.note && <div className="text-sm text-muted-foreground">{e.note}</div>}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          <Meta><Clock className="h-3 w-3" /> Posted {fmtDateTime(e.created_at)}</Meta>
          {e.actor_name && <Meta>by {e.actor_name}</Meta>}
          <Meta>balance after {formatSuspenseAmount(e.balance_after, currency)}</Meta>
        </div>
      </div>
    );
  }

  if (item.kind === 'credit') {
    const r = item.req;
    const stage = r.status === 'pending' ? requestStage(r) : null;
    const granted = grantedOf(r);
    return (
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          {stage === 'supervisor' && <Badge variant="warning">Awaiting supervisor</Badge>}
          {stage === 'category'   && <Badge variant="warning">{categoryApproverLabel(r)}</Badge>}
          {stage === 'approver'   && <Badge variant="warning">With the suspense approvers</Badge>}
          {r.status === 'approved' && r.approved_amount != null && r.approved_amount !== r.amount && (
            <Badge variant="brand">Granted {formatSuspenseAmount(granted, currency)}</Badge>
          )}
          {multiCompany && <Badge variant="outline" className="gap-1"><Building2 className="h-3 w-3" /> {r.company_name}</Badge>}
        </div>
        {r.reason && <div className="mt-1.5 text-sm text-muted-foreground">{r.reason}</div>}
        <ConsideredBy status={r.status} byName={r.considered_by_name} by={r.considered_by} reason={r.reject_reason} />
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          <Meta><Clock className="h-3 w-3" /> Raised {fmtDateTime(r.created_at)}</Meta>
          {r.considered_at && <Meta>Decided {fmtDateTime(r.considered_at)}</Meta>}
        </div>
        {r.status === 'pending' && (
          <div className="mt-2.5 flex flex-wrap justify-end gap-1.5">
            <Button type="button" size="sm" variant="outline" onClick={() => onEditRequest(r)}>
              <Pencil className="h-3.5 w-3.5" /> Edit
            </Button>
            <Button type="button" size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => onDeleteRequest(r.id)}>
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          </div>
        )}
      </div>
    );
  }

  const c = item.close;
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-1.5">
        {multiCompany && <Badge variant="outline" className="gap-1"><Building2 className="h-3 w-3" /> {c.company_name}</Badge>}
        {c.transfer_amount > 0 && <Badge variant="muted">Transfer {formatSuspenseAmount(c.transfer_amount, currency)}</Badge>}
      </div>
      {c.note && <div className="mt-1.5 text-sm text-muted-foreground">{c.note}</div>}
      {c.requested_by && c.requested_by !== c.epf_number && (
        <div className="mt-1 flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
          <UserPlus className="h-3 w-3 shrink-0" /> Requested by {c.requested_by_name || c.requested_by}
        </div>
      )}
      <ConsideredBy status={c.status} byName={c.considered_by_name} by={c.considered_by} reason={c.reject_reason} />
      <div className="mt-2 flex flex-wrap items-center gap-3">
        {c.transfer_url && <BillLink url={c.transfer_url} type={c.transfer_type} />}
        <Meta><Clock className="h-3 w-3" /> Requested {fmtDateTime(c.created_at)}</Meta>
        {c.considered_at && <Meta>Decided {fmtDateTime(c.considered_at)}</Meta>}
      </div>
    </div>
  );
}
