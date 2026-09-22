'use client';
// One person's whole suspense story in a popup: every bill they ever submitted, every credit
// that landed on their float, every credit and close request, and the account events in
// between (opening balance, adjustments, settlement) — newest first, month by month.
//
// Opened from the approver's Ledger and Accounts tabs when a name is clicked. It reads the
// person's collections fresh on every open — money moves, and a stale popup would tell the
// approver the wrong balance — and keeps nothing once it is closed.
//
// The Ledger tab's numbers are not touched here; this is a read-only companion to them.
import { useCallback, useEffect, useMemo, useRef, useState, type ElementType, type ReactNode } from 'react';
import {
  Archive, ArrowDownRight, ArrowUpRight, ChevronDown, Coins, HandCoins, Lock, Receipt, RefreshCw,
  Scale, Search, SlidersHorizontal, Wallet,
} from 'lucide-react';
import toast from 'react-hot-toast';
import {
  billDayOf, floatCostOf, groupByDay, isCreditEntry, localDayKey, msOf, requestDayOf, splitsSum, splitsOwedBack,
} from '@/lib/suspenseMonthView';
import type {
  SuspenseAccount, SuspenseCloseRequest, SuspenseLedgerEntry, SuspenseRequest, SuspenseSubmission,
} from '@/lib/types';
import { cn } from '@/lib/utils';
import {
  formatSuspenseAmount, getLedger, getMyCloseRequests, getMyRequests, getMySubmissions, getUserAccounts, requestStage,
} from '@/services/suspenseService';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { ListSkeleton, StatCardsSkeleton } from '@/components/ui/Skeleton';
import { StatCard } from '@/components/ui/stat-card';
import {
  BillLink, ConsideredBy, MONTHS, PersonAvatar, SplitsLine, StatusBadge, errMsg, fmtDateTime, prettyDay,
} from '@/components/suspense/shared';
import BillThumb from '@/components/BillThumb';

// ─── The clickable name ─────────────────────────────────────────────────────────

/** A person's avatar + name as the button that opens their history. Shared by the Ledger and
 *  Accounts tabs so the affordance looks the same wherever a name can be clicked. */
export function PersonButton({ name, onClick, size = 'md', className, children }: {
  name: string; onClick: () => void; size?: 'sm' | 'md'; className?: string;
  /** Rendered after the name (an EPF, a company) — part of the same click target. */
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Open full history"
      className={cn(
        'group/person flex min-w-0 items-center gap-3 rounded-md text-left hover:text-primary',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
    >
      <PersonAvatar name={name} size={size} />
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-foreground underline-offset-4 group-hover/person:text-primary group-hover/person:underline">
          {name}
        </span>
        {children}
      </span>
    </button>
  );
}

// ─── Timeline model ─────────────────────────────────────────────────────────────

// 'photos' is not another slice of the timeline — it is a different way of looking at the same
// bills. Everything else answers "what happened, in order"; this answers "show me the paperwork",
// which is what someone checking a claim against the receipts actually wants.
type Chip = 'all' | 'bills' | 'credits' | 'requests' | 'account' | 'photos';

const CHIPS: Array<{ key: Chip; label: string }> = [
  { key: 'all',      label: 'All' },
  { key: 'bills',    label: 'Bills' },
  { key: 'credits',  label: 'Credits' },
  { key: 'requests', label: 'Requests' },
  { key: 'account',  label: 'Account' },
  { key: 'photos',   label: 'Bill photos' },
];

// Every line on the timeline is one of these. A ledger debit that belongs to a loaded bill is
// folded INTO the bill item (as `entry`) so the money leaving the float is drawn once, on the
// bill, with the balance it left behind.
type Item =
  | { kind: 'bill';    id: string; day: string; at: number; bill: SuspenseSubmission; entry?: SuspenseLedgerEntry }
  | { kind: 'entry';   id: string; day: string; at: number; entry: SuspenseLedgerEntry }
  | { kind: 'request'; id: string; day: string; at: number; request: SuspenseRequest }
  | { kind: 'close';   id: string; day: string; at: number; close: SuspenseCloseRequest };

interface Loaded {
  ledger:   SuspenseLedgerEntry[];
  bills:    SuspenseSubmission[];
  requests: SuspenseRequest[];
  closes:   SuspenseCloseRequest[];
  accounts: SuspenseAccount[];
}

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const signed = (n: number, currency: string) => `${n < 0 ? '−' : n > 0 ? '+' : ''}${formatSuspenseAmount(Math.abs(n), currency)}`;

const ENTRY_LABEL: Record<SuspenseLedgerEntry['kind'], string> = {
  credit:     'Credit approved',
  opening:    'Opening balance',
  adjustment: 'Adjustment',
  debit:      'Debit',
  settlement: 'Settlement',
};

const ENTRY_ICON: Record<SuspenseLedgerEntry['kind'], ElementType> = {
  credit:     ArrowUpRight,
  opening:    Wallet,
  adjustment: SlidersHorizontal,
  debit:      ArrowDownRight,
  settlement: Lock,
};

function billLabel(s: SuspenseSubmission): string {
  return [s.category, s.subcategory].filter(Boolean).join(' · ') || s.expense_type || 'Expense';
}

function chipOf(it: Item): Exclude<Chip, 'all'> {
  if (it.kind === 'bill' || it.kind === 'request') return it.kind === 'bill' ? 'bills' : 'requests';
  if (it.kind === 'close') return 'account';
  // A stray debit (its bill was not loaded) is still a bill's money; everything else on the
  // ledger besides a plain credit is account housekeeping.
  if (it.entry.kind === 'debit') return 'bills';
  if (it.entry.kind === 'credit') return 'credits';
  return 'account';
}

/** Everything searchable about an item, lowercased once. */
function haystack(it: Item): string {
  const parts: Array<string | number | null | undefined> = [];
  if (it.kind === 'bill') {
    const b = it.bill;
    parts.push(b.shop_name, b.item, b.category, b.subcategory, b.type, b.expense_type, b.note, b.amount, b.bill_no, b.company_name, b.vat_number, b.status);
    if (it.entry) parts.push(it.entry.note, it.entry.actor_name);
  } else if (it.kind === 'entry') {
    parts.push(ENTRY_LABEL[it.entry.kind], it.entry.note, it.entry.actor_name, it.entry.amount, it.entry.balance_after);
  } else if (it.kind === 'request') {
    const r = it.request;
    parts.push('credit request', r.reason, r.category_name, r.amount, r.approved_amount, r.company_name, r.status, r.reject_reason);
  } else {
    const c = it.close;
    parts.push('close request', c.note, c.company_name, c.transfer_amount, c.balance_at_request, c.status, c.reject_reason);
  }
  return parts.filter(p => p !== null && p !== undefined && p !== '').map(String).join(' ').toLowerCase();
}

function buildItems(d: Loaded): Item[] {
  const billById = new Map(d.bills.map(b => [b.id, b]));
  const debitByBill = new Map<string, SuspenseLedgerEntry>();
  const items: Item[] = [];

  for (const e of d.ledger) {
    if (!e) continue;
    if (e.kind === 'debit' && e.ref_id && billById.has(e.ref_id) && !debitByBill.has(e.ref_id)) {
      debitByBill.set(e.ref_id, e);
      continue;
    }
    const at = msOf(e.created_at) ?? 0;
    items.push({ kind: 'entry', id: `e:${e.id}`, day: localDayKey(at), at, entry: e });
  }
  for (const b of d.bills) {
    if (!b || b.deleted) continue;
    items.push({
      kind: 'bill', id: `b:${b.id}`, day: billDayOf(b),
      at: msOf(b.bill_date) ?? msOf(b.created_at) ?? 0,
      bill: b, entry: debitByBill.get(b.id),
    });
  }
  for (const r of d.requests) {
    if (!r) continue;
    items.push({
      kind: 'request', id: `r:${r.id}`, day: requestDayOf(r),
      at: msOf(r.considered_at) ?? msOf(r.created_at) ?? 0,
      request: r,
    });
  }
  for (const c of d.closes) {
    if (!c) continue;
    const at = msOf(c.created_at) ?? 0;
    items.push({ kind: 'close', id: `c:${c.id}`, day: localDayKey(at), at, close: c });
  }
  return items.sort((a, b) => b.day.localeCompare(a.day) || b.at - a.at);
}

interface MonthGroup {
  key:      string;   // YYYY-MM
  label:    string;
  spent:    number;   // approved bills, own share
  credited: number;   // ledger credits (credit / opening / positive adjustment)
  days:     Array<{ date: string; items: Item[] }>;
}

/** Month buckets, newest first. Subtotals are the month's whole picture — they come from every
 *  item that fell in the month, not just the ones the chips and the search leave visible, so
 *  the header keeps meaning "what happened in August" whatever the reader is looking for. */
function groupByMonth(all: Item[], visible: Item[]): MonthGroup[] {
  const totals = new Map<string, { spent: number; credited: number }>();
  for (const it of all) {
    const key = it.day.slice(0, 7);
    const t = totals.get(key) ?? { spent: 0, credited: 0 };
    if (it.kind === 'bill' && it.bill.status === 'approved') t.spent = round2(t.spent + floatCostOf(it.bill));
    if (it.kind === 'entry' && isCreditEntry(it.entry)) t.credited = round2(t.credited + (Number(it.entry.amount) || 0));
    totals.set(key, t);
  }
  const byMonth = new Map<string, Item[]>();
  for (const it of visible) {
    const key = it.day.slice(0, 7);
    const arr = byMonth.get(key);
    if (arr) arr.push(it); else byMonth.set(key, [it]);
  }
  return [...byMonth.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([key, items]) => {
    const [y, m] = key.split('-').map(Number);
    const t = totals.get(key) ?? { spent: 0, credited: 0 };
    return {
      key, label: `${MONTHS[(m || 1) - 1]} ${y}`, spent: t.spent, credited: t.credited,
      days: groupByDay(items, it => it.day),
    };
  });
}

// ─── The dialog ─────────────────────────────────────────────────────────────────

export default function PersonHistoryDialog({ open, onOpenChange, epf, name, currency, accounts }: {
  open:         boolean;
  onOpenChange: (v: boolean) => void;
  epf:          string;
  name:         string;
  currency:     string;
  /** The caller's already-loaded account list; when it has nothing for this EPF the dialog
   *  fetches the person's accounts itself. */
  accounts?:    SuspenseAccount[];
}) {
  const [data, setData]       = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [chip, setChip]       = useState<Chip>('all');
  const [search, setSearch]   = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Only the latest load may land: a quick close-and-reopen on a different person must not let
  // the first person's slower fetch paint over the second.
  const reqId = useRef(0);

  const knownAccounts = useMemo(() => (accounts ?? []).filter(a => a.epf_number === epf), [accounts, epf]);

  const load = useCallback(async () => {
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    try {
      const [ledger, bills, requests, closes, fetchedAccounts] = await Promise.all([
        getLedger(epf),
        getMySubmissions(epf),
        getMyRequests(epf),
        getMyCloseRequests(epf),
        knownAccounts.length ? Promise.resolve(knownAccounts) : getUserAccounts(epf),
      ]);
      if (id !== reqId.current) return;
      setData({ ledger, bills, requests, closes, accounts: fetchedAccounts });
    } catch (e) {
      if (id !== reqId.current) return;
      const msg = errMsg(e, 'Could not load this person’s history');
      setError(msg);
      toast.error(msg);
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [epf, knownAccounts]);

  useEffect(() => {
    if (!open || !epf) {
      // Nothing survives a close: the next open re-reads. Bumping the id also orphans any fetch
      // still in flight so it cannot land on an empty dialog.
      reqId.current += 1;
      setData(null); setError(null); setLoading(false); setChip('all'); setSearch(''); setExpanded(new Set());
      return;
    }
    void load();
  }, [open, epf, load]);

  const items = useMemo(() => (data ? buildItems(data) : []), [data]);
  const searchable = useMemo(() => new Map(items.map(it => [it.id, haystack(it)])), [items]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matches = (it: Item) => !q || (searchable.get(it.id) ?? '').includes(q);
    // 'photos' is every real bill, not a chipOf() slice — a stray ledger debit chips as 'bills'
    // but has no paperwork behind it, so it has no place in a gallery of receipts.
    if (chip === 'photos') return items.filter(it => it.kind === 'bill' && matches(it));
    return items.filter(it => (chip === 'all' || chipOf(it) === chip) && matches(it));
  }, [items, chip, search, searchable]);

  /** The gallery's rows, newest bill first — the same order the timeline reads in. */
  const photoBills = useMemo(
    () => (chip !== 'photos' ? [] : visible.flatMap(it => (it.kind === 'bill' ? [it.bill] : []))),
    [chip, visible],
  );
  const missingPhotos = useMemo(() => photoBills.filter(b => !b.bill_url).length, [photoBills]);

  const months = useMemo(() => groupByMonth(items, visible), [items, visible]);

  const stats = useMemo(() => {
    if (!data) return null;
    const openAccounts = data.accounts.filter(a => !a.is_closed);
    const balance = round2(openAccounts.reduce((t, a) => t + (Number(a.balance) || 0), 0));
    const credited = round2(data.ledger.filter(isCreditEntry).reduce((t, e) => t + (Number(e.amount) || 0), 0));
    const approved = data.bills.filter(b => !b.deleted && b.status === 'approved');
    const spent = round2(approved.reduce((t, b) => t + floatCostOf(b), 0));
    const split = round2(approved.reduce((t, b) => t + splitsSum(b.splits), 0));
    const pendingBills = data.bills.filter(b => !b.deleted && b.status === 'pending');
    const pending = round2(pendingBills.reduce((t, b) => t + floatCostOf(b), 0));
    const requested = round2(data.requests.filter(r => r.status === 'pending').reduce((t, r) => t + (Number(r.amount) || 0), 0));
    return {
      balance, hasAccount: data.accounts.length > 0, openCount: openAccounts.length,
      credited, spent, split, billCount: approved.length,
      pending, pendingCount: pendingBills.length, requested,
    };
  }, [data]);

  const companyOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of data?.accounts ?? []) m.set(a.company_id, a.company_name);
    for (const b of data?.bills ?? []) if (b.company_id && b.company_name && !m.has(b.company_id)) m.set(b.company_id, b.company_name);
    return (id: string | undefined) => (id ? m.get(id) ?? '' : '');
  }, [data]);

  const toggle = (id: string) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-1rem)] w-full max-w-none flex-col gap-0 p-0 sm:w-[calc(100%-2rem)] sm:max-w-2xl">
        {/* Header — who, and the balance of each account they hold. */}
        <DialogHeader className="border-b border-border/60 px-4 pb-3 pt-4 pr-12 sm:px-6 sm:pt-5">
          <div className="flex items-start gap-3">
            <PersonAvatar name={name} />
            <div className="min-w-0 flex-1">
              <DialogTitle className="truncate text-base">{name}</DialogTitle>
              <DialogDescription className="text-xs">{epf} · full suspense history</DialogDescription>
              {data && data.accounts.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {data.accounts.map(a => (
                    <AccountBadge key={`${a.epf_number}__${a.company_id}`} account={a} />
                  ))}
                </div>
              )}
            </div>
          </div>
        </DialogHeader>

        {/* Body — scrolls on its own so the header and footer stay put. */}
        <div className="min-h-0 max-h-[75vh] flex-1 overflow-y-auto px-4 py-4 sm:px-6">
          {loading || (!data && !error) ? (
            <div className="space-y-4">
              <StatCardsSkeleton count={3} />
              <ListSkeleton rows={5} />
            </div>
          ) : error || !data || !stats ? (
            <EmptyState
              icon={Wallet}
              title="Couldn’t load this history"
              description={error ?? undefined}
              action={<Button type="button" variant="outline" size="sm" onClick={() => load()}><RefreshCw className="h-3.5 w-3.5" /> Retry</Button>}
            />
          ) : (
            <div className="space-y-4">
              {/* ── Stat strip ── */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <StatCard
                  label="Current balance"
                  value={stats.hasAccount ? formatSuspenseAmount(stats.balance, currency) : '—'}
                  icon={Wallet}
                  tone={stats.balance < 0 ? 'destructive' : 'primary'}
                  hint={!stats.hasAccount ? 'No account' : stats.openCount > 1 ? `${stats.openCount} accounts` : stats.openCount === 0 ? 'All accounts closed' : undefined}
                />
                <StatCard
                  label="Credited all-time"
                  value={formatSuspenseAmount(stats.credited, currency)}
                  icon={Coins}
                  tone="brand"
                />
                <StatCard
                  label="Spent all-time"
                  value={formatSuspenseAmount(stats.spent, currency)}
                  icon={Receipt}
                  tone="muted"
                  hint={`${stats.billCount} bill${stats.billCount === 1 ? '' : 's'}${stats.split > 0 ? ` · ${formatSuspenseAmount(stats.split, currency)} split to others` : ''}`}
                />
              </div>
              {(stats.pending > 0 || stats.requested > 0) && (
                <div className="flex flex-wrap gap-x-4 gap-y-1 px-1 text-xs">
                  {stats.pending > 0 && (
                    <span className="text-warning">
                      Awaiting approval: <span className="font-semibold tabular-nums">{formatSuspenseAmount(stats.pending, currency)}</span> · {stats.pendingCount} bill{stats.pendingCount === 1 ? '' : 's'}
                    </span>
                  )}
                  {stats.requested > 0 && (
                    <span className="text-muted-foreground">
                      Credit requested, not yet decided: <span className="font-semibold tabular-nums text-foreground">{formatSuspenseAmount(stats.requested, currency)}</span>
                    </span>
                  )}
                </div>
              )}

              {/* ── Filters ── */}
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="Show">
                  {CHIPS.map(c => {
                    const active = chip === c.key;
                    return (
                      <button
                        key={c.key}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setChip(c.key)}
                        className={cn(
                          'inline-flex h-8 items-center rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          active ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground',
                        )}
                      >
                        {c.label}
                      </button>
                    );
                  })}
                </div>
                <div className="relative sm:ml-auto sm:w-56">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Shop, item, note, amount, bill no…" className="h-8 pl-9 text-xs" aria-label="Search this history" />
                </div>
              </div>

              {/* ── Timeline ── */}
              {items.length === 0 ? (
                <EmptyState icon={Wallet} title="Nothing on record" description="No bills, credits or requests for this person yet." className="py-8" />
              ) : visible.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">Nothing matches.</p>
              ) : (
                chip === 'photos' ? (
                <>
                  {missingPhotos > 0 && (
                    <p className="mb-2 text-[11px] text-muted-foreground">
                      <span className="font-semibold tabular-nums text-foreground">{missingPhotos}</span> of these
                      {' '}{photoBills.length} bills have no attached photo — shown as empty tiles so the count still adds up.
                    </p>
                  )}
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    {photoBills.map(b => <BillPhotoTile key={b.id} bill={b} currency={currency} />)}
                  </div>
                </>
                ) : (
                <div className="space-y-5">
                  {months.map(mg => (
                    <section key={mg.key} aria-label={mg.label}>
                      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-b border-border/60 pb-1.5">
                        <h3 className="text-sm font-semibold text-foreground">{mg.label}</h3>
                        <MonthSubtotals spent={mg.spent} credited={mg.credited} currency={currency} />
                      </div>
                      <div className="space-y-3">
                        {mg.days.map(d => (
                          <div key={d.date}>
                            <div className="mb-1 text-[11px] font-medium text-muted-foreground">{prettyDay(d.date)}</div>
                            <div className="space-y-1.5">
                              {d.items.map(it => (
                                <TimelineRow
                                  key={it.id}
                                  item={it}
                                  epf={epf}
                                  currency={currency}
                                  companyOf={companyOf}
                                  open={expanded.has(it.id)}
                                  onToggle={() => toggle(it.id)}
                                />
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
                )
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border/60 px-4 py-3 sm:px-6">
          <span className="text-xs text-muted-foreground">
            {!data ? '' : chip === 'photos'
              // Count bills, not "items": the gallery is showing a subset of a different kind of
              // thing, and "25 items of 36" reads as though eleven bills were hidden.
              ? `Showing ${photoBills.length} bill${photoBills.length === 1 ? '' : 's'}`
              : `Showing ${visible.length} item${visible.length === 1 ? '' : 's'}${visible.length !== items.length ? ` of ${items.length}` : ''}`}
          </span>
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>Close</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Pieces ─────────────────────────────────────────────────────────────────────

/**
 * One receipt in the Bill photos gallery: the image, its bill number, and whether it was
 * approved, rejected or is still waiting — the three things someone checking a claim against the
 * paperwork needs before they click into the full-size view.
 *
 * The status is carried by a StatusBadge and NOT by the tile's colour: --success, --primary and
 * --brand are all the same azure in this app, so approved and pending would be indistinguishable
 * if tone were doing the work. A rejected bill is dimmed and struck through as well, since that
 * one genuinely wants to recede.
 */
function BillPhotoTile({ bill: b, currency }: { bill: SuspenseSubmission; currency: string }) {
  const rejected = b.status === 'rejected';
  return (
    <figure className={cn('min-w-0 overflow-hidden rounded-lg border border-border bg-card/40', rejected && 'opacity-60')}>
      {b.bill_url
        ? <BillThumb url={b.bill_url} type={b.bill_type} size="grid" />
        : (
          // Kept in the grid rather than filtered out: a bill with no photo is exactly what
          // someone auditing the paperwork needs to SEE, not something to quietly omit.
          <div className="flex h-32 w-full items-center justify-center bg-muted text-[11px] text-muted-foreground sm:h-40">
            No photo attached
          </div>
        )}
      <figcaption className="space-y-1 p-2">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-xs font-semibold text-foreground">
            {b.bill_no ? `Bill ${b.bill_no}` : 'No bill no'}
          </span>
          <StatusBadge status={b.status} />
        </div>
        <div className={cn('truncate text-[11px] text-muted-foreground', rejected && 'line-through')}>
          {billLabel(b)}
        </div>
        <div className="flex items-center justify-between gap-2 text-[11px]">
          <span className="truncate text-muted-foreground">{prettyDay(billDayOf(b), { day: 'numeric', month: 'short' })}</span>
          <span className={cn('shrink-0 font-semibold tabular-nums', rejected ? 'text-muted-foreground line-through' : 'text-foreground')}>
            {formatSuspenseAmount(b.amount, currency)}
          </span>
        </div>
      </figcaption>
    </figure>
  );
}

function AccountBadge({ account: a }: { account: SuspenseAccount }) {
  const negative = a.balance < 0;
  if (a.is_closed) return <Badge variant="muted">{a.company_name} · Closed</Badge>;
  return (
    <Badge variant={!a.is_active ? 'warning' : 'outline'} className="gap-1.5">
      <span>{a.company_name}</span>
      <span className={cn('tabular-nums', negative && 'font-semibold text-destructive')}>· {formatSuspenseAmount(a.balance, a.currency)}</span>
      {!a.is_active && <span>· Close pending</span>}
    </Badge>
  );
}

/** "−spent · +credited · net" for a month header. Zeroes are left out; net is always shown. */
function MonthSubtotals({ spent, credited, currency }: { spent: number; credited: number; currency: string }) {
  const net = round2(credited - spent);
  const parts: ReactNode[] = [];
  if (spent > 0)    parts.push(<span key="s" className="tabular-nums text-foreground">−{formatSuspenseAmount(spent, currency)}</span>);
  if (credited > 0) parts.push(<span key="c" className="tabular-nums text-primary">+{formatSuspenseAmount(credited, currency)}</span>);
  parts.push(<span key="n" className={cn('tabular-nums', net < 0 ? 'text-destructive' : 'text-muted-foreground')}>net {signed(net, currency)}</span>);
  return (
    <div className="flex flex-wrap items-center gap-x-1.5 text-[11px]">
      {parts.map((p, i) => (
        <span key={i} className="inline-flex items-center gap-1.5">
          {i > 0 && <span aria-hidden className="text-muted-foreground/60">·</span>}
          {p}
        </span>
      ))}
    </div>
  );
}

function BalanceAfter({ entry, currency }: { entry: SuspenseLedgerEntry | undefined; currency: string }) {
  if (!entry) return null;
  return <div className="text-[10px] tabular-nums text-muted-foreground">→ balance {formatSuspenseAmount(entry.balance_after, currency)}</div>;
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-2 text-[11px]">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 text-foreground/90">{children}</span>
    </div>
  );
}

function TimelineRow({ item, epf, currency, companyOf, open, onToggle }: {
  item: Item; epf: string; currency: string; companyOf: (id: string | undefined) => string;
  open: boolean; onToggle: () => void;
}) {
  const panelId = `history-${item.id}`;
  const head = rowHead(item, currency, companyOf);
  const Icon = head.icon;
  return (
    <div className={cn('rounded-lg border border-border/60 bg-card/50', open && 'bg-muted/30')}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
        className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span aria-hidden className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-md', head.iconCls)}>
          <Icon className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className={cn('flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm', head.struck ? 'text-muted-foreground line-through' : 'text-foreground')}>
            <span className="truncate">{head.label}</span>
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            {head.sublabel && <span className={cn('truncate text-[11px] text-muted-foreground', head.struck && 'line-through')}>{head.sublabel}</span>}
            {head.badge}
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span className={cn('block text-sm font-semibold tabular-nums', head.amountCls)}>{head.amount}</span>
          {head.amountNote && <span className="block text-[10px] tabular-nums text-muted-foreground">{head.amountNote}</span>}
          <BalanceAfter entry={item.kind === 'bill' ? item.entry : item.kind === 'entry' ? item.entry : undefined} currency={currency} />
        </span>
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {open && (
        <div id={panelId} className="border-t border-border/60 px-3 py-2.5">
          <RowDetails item={item} epf={epf} currency={currency} companyOf={companyOf} />
        </div>
      )}
    </div>
  );
}

interface RowHead {
  icon:        ElementType;
  iconCls:     string;
  label:       string;
  sublabel:    string;
  badge?:      ReactNode;
  struck:      boolean;
  amount:      string;
  amountCls:   string;
  amountNote?: string;
}

function rowHead(item: Item, currency: string, companyOf: (id: string | undefined) => string): RowHead {
  if (item.kind === 'bill') {
    const b = item.bill;
    const rejected = b.status === 'rejected';
    const pending  = b.status === 'pending';
    // The whole bill leaves the float; a split is money this person is carrying for colleagues
    // until payroll deducts it, so it belongs on the line as "owed back", not as a smaller cost.
    const cost = floatCostOf(b);
    const owedBack = splitsOwedBack(b.splits);
    return {
      icon: Receipt,
      iconCls: rejected ? 'bg-muted text-muted-foreground' : pending ? 'bg-warning/10 text-warning' : 'bg-muted text-foreground',
      label: billLabel(b),
      sublabel: [b.item, b.shop_name].filter(Boolean).join(' @ ') || b.company_name,
      badge: <StatusBadge status={b.status} />,
      struck: rejected,
      amount: `−${formatSuspenseAmount(cost, currency)}`,
      amountCls: rejected ? 'text-muted-foreground line-through' : pending ? 'text-warning' : 'text-foreground',
      amountNote: owedBack > 0 ? `${formatSuspenseAmount(owedBack, currency)} owed back` : undefined,
    };
  }
  if (item.kind === 'entry') {
    const e = item.entry;
    const amt = round2(Number(e.amount) || 0);
    const company = companyOf(e.company_id);
    return {
      icon: ENTRY_ICON[e.kind] ?? Scale,
      iconCls: amt > 0 ? 'bg-primary/10 text-primary' : 'bg-muted text-foreground',
      label: ENTRY_LABEL[e.kind] ?? 'Ledger entry',
      sublabel: [e.note, company].filter(Boolean).join(' · '),
      struck: false,
      amount: signed(amt, currency),
      amountCls: amt > 0 ? 'text-primary' : 'text-foreground',
    };
  }
  if (item.kind === 'request') {
    const r = item.request;
    const approved = r.status === 'approved';
    const rejected = r.status === 'rejected';
    const badge = approved ? <Badge variant="success">Approved</Badge>
      : rejected ? <Badge variant="destructive">Rejected</Badge>
      : <Badge variant="warning">{requestStage(r) === 'supervisor' ? 'Awaiting supervisor' : requestStage(r) === 'category' ? 'Awaiting category approver' : 'Awaiting approver'}</Badge>;
    const granted = approved ? Number(r.approved_amount ?? r.amount) || 0 : Number(r.amount) || 0;
    return {
      icon: HandCoins,
      iconCls: rejected ? 'bg-muted text-muted-foreground' : 'bg-primary/10 text-primary',
      label: `Credit request${r.category_name ? ` · ${r.category_name}` : ''}`,
      sublabel: [r.reason, r.company_name].filter(Boolean).join(' · '),
      badge,
      struck: rejected,
      amount: formatSuspenseAmount(granted, currency),
      // The request itself moves no money — the matching "Credit approved" line does — so its
      // amount stays quiet rather than reading as a second credit.
      amountCls: rejected ? 'text-muted-foreground line-through' : 'text-muted-foreground',
      amountNote: approved && r.approved_amount !== null && r.approved_amount !== undefined && round2(r.approved_amount) !== round2(r.amount)
        ? `asked ${formatSuspenseAmount(r.amount, currency)}` : undefined,
    };
  }
  const c = item.close;
  return {
    icon: Archive,
    iconCls: c.status === 'rejected' ? 'bg-muted text-muted-foreground' : 'bg-muted text-foreground',
    label: 'Close request',
    sublabel: [c.note, c.company_name].filter(Boolean).join(' · '),
    badge: <StatusBadge status={c.status} />,
    struck: c.status === 'rejected',
    amount: c.transfer_amount > 0 ? formatSuspenseAmount(c.transfer_amount, currency) : '—',
    amountCls: 'text-muted-foreground',
    amountNote: c.transfer_amount > 0 ? 'returned by transfer' : `balance ${formatSuspenseAmount(c.balance_at_request, currency)}`,
  };
}

function RowDetails({ item, epf, currency, companyOf }: {
  item: Item; epf: string; currency: string; companyOf: (id: string | undefined) => string;
}) {
  if (item.kind === 'bill') {
    const b = item.bill;
    const filedByOther = !!b.submitted_by_epf && b.submitted_by_epf !== epf;
    return (
      <div className="flex gap-3">
        <BillLink url={b.bill_url} type={b.bill_type} size="sm" />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
            {b.bill_no && <span>Bill no <span className="font-medium text-foreground">{b.bill_no}</span></span>}
            {b.company_name && <span>{b.company_name}</span>}
            {b.type && <span>{b.type}</span>}
          </div>
          {b.is_vat && (
            <Detail label="VAT">
              {b.vat_number ? `Reg ${b.vat_number}` : 'VAT bill'}{b.vat_amount ? ` · ${formatSuspenseAmount(b.vat_amount, currency)}` : ''}
            </Detail>
          )}
          {b.note && <Detail label="Note">{b.note}</Detail>}
          <SplitsLine splits={b.splits} currency={currency} />
          <ConsideredBy status={b.status} byName={b.considered_by_name} by={b.considered_by} reason={b.reject_reason} />
          {filedByOther && <Detail label="Filed by">{b.submitted_by_name || b.submitted_by_epf}</Detail>}
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
            {b.bill_date && <span>Bill date {fmtDateTime(b.bill_date)}</span>}
            <span>Submitted {fmtDateTime(b.created_at)}</span>
            {b.considered_at && <span>Decided {fmtDateTime(b.considered_at)}</span>}
          </div>
          {item.entry && <EntryFootnote entry={item.entry} currency={currency} companyOf={companyOf} />}
        </div>
      </div>
    );
  }
  if (item.kind === 'entry') {
    return <EntryFootnote entry={item.entry} currency={currency} companyOf={companyOf} full />;
  }
  if (item.kind === 'request') {
    const r = item.request;
    return (
      <div className="space-y-1">
        {r.reason && <Detail label="Reason">{r.reason}</Detail>}
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
          <span>Asked {formatSuspenseAmount(r.amount, currency)}</span>
          {r.status === 'approved' && <span>Granted {formatSuspenseAmount(Number(r.approved_amount ?? r.amount) || 0, currency)}</span>}
          {r.company_name && <span>{r.company_name}</span>}
        </div>
        {r.supervisor_status === 'approved' && (
          <Detail label="Supervisor">{r.supervisor_approved_by_name || r.supervisor_approved_by || '—'}{r.supervisor_approved_at ? ` · ${fmtDateTime(r.supervisor_approved_at)}` : ''}</Detail>
        )}
        {r.category_status === 'approved' && (
          <Detail label="Category">{r.category_approved_by_name || r.category_approved_by || '—'}{r.category_approved_at ? ` · ${fmtDateTime(r.category_approved_at)}` : ''}</Detail>
        )}
        <ConsideredBy status={r.status} byName={r.considered_by_name} by={r.considered_by} reason={r.reject_reason} />
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
          <span>Raised {fmtDateTime(r.created_at)}</span>
          {r.considered_at && <span>Decided {fmtDateTime(r.considered_at)}</span>}
        </div>
      </div>
    );
  }
  const c = item.close;
  return (
    <div className="flex gap-3">
      {c.transfer_url && <BillLink url={c.transfer_url} type={c.transfer_type} size="sm" />}
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
          <span>Balance at request {formatSuspenseAmount(c.balance_at_request, currency)}</span>
          {c.transfer_amount > 0 && <span>Transfer {formatSuspenseAmount(c.transfer_amount, currency)}</span>}
          {c.company_name && <span>{c.company_name}</span>}
        </div>
        {c.note && <Detail label="Note">{c.note}</Detail>}
        <Detail label="Requested by">{c.requested_by_name || c.requested_by}</Detail>
        <ConsideredBy status={c.status} byName={c.considered_by_name} by={c.considered_by} reason={c.reject_reason} />
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
          <span>Raised {fmtDateTime(c.created_at)}</span>
          {c.considered_at && <span>Decided {fmtDateTime(c.considered_at)}</span>}
        </div>
      </div>
    </div>
  );
}

/** The ledger side of a line: who posted it, when, the note, and where the balance landed.
 *  `full` also names the movement — for a line that IS the ledger entry rather than a bill
 *  carrying one. */
function EntryFootnote({ entry: e, currency, companyOf, full }: {
  entry: SuspenseLedgerEntry; currency: string; companyOf: (id: string | undefined) => string; full?: boolean;
}) {
  const company = companyOf(e.company_id);
  return (
    <div className="space-y-1">
      {full && (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
          <span>{ENTRY_LABEL[e.kind] ?? 'Ledger entry'} {signed(round2(Number(e.amount) || 0), currency)}</span>
          <span>Balance after {formatSuspenseAmount(e.balance_after, currency)}</span>
          {company && <span>{company}</span>}
        </div>
      )}
      {e.note && <Detail label={full ? 'Note' : 'Ledger note'}>{e.note}</Detail>}
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
        <span>Posted {fmtDateTime(e.created_at)}</span>
        {(e.actor_name || e.actor_epf) && <span>by {e.actor_name || e.actor_epf}</span>}
        {!full && <span>balance after {formatSuspenseAmount(e.balance_after, currency)}</span>}
      </div>
    </div>
  );
}
