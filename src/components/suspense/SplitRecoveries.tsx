'use client';
// The approver's Recoveries tab: money one employee is carrying for another.
//
// A bill's full amount leaves the payer's float on approval, because the full amount left their
// hand. Anything split to colleagues is a RECEIVABLE — payroll deducts it from those colleagues'
// salaries, and until someone says so here, the payer is out of pocket. Marking a row recovered
// credits that money straight back to the payer's float (recoverSplit in suspenseService).
//
// Grouped by the person who OWES, because that is the shape payroll works in: one employee, one
// month, one deduction. The payer is named on every row so it is always clear whose float the
// money is going back to.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { HandCoins, Loader2, RefreshCw, Search, Undo2, UserRound, Wallet } from 'lucide-react';
import toast from 'react-hot-toast';
import type { OutstandingSplit, Actor } from '@/services/suspenseService';
import { formatSuspenseAmount, listOutstandingSplits, recoverSplit } from '@/services/suspenseService';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { ListSkeleton } from '@/components/ui/Skeleton';
import { StatCard } from '@/components/ui/stat-card';
import { errMsg, prettyDay } from '@/components/suspense/shared';

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

interface OwedGroup {
  epf:    string;
  name:   string;
  total:  number;
  rows:   OutstandingSplit[];
  /** Days since the oldest unrecovered row was approved — how long someone has been waiting. */
  oldest: number;
}

const DAY = 24 * 60 * 60 * 1000;

/** Group by the colleague who owes, largest debt first. Exported for the unit test. */
export function groupOwed(rows: OutstandingSplit[], now = Date.now()): OwedGroup[] {
  const byEpf = new Map<string, OwedGroup>();
  for (const r of rows) {
    let g = byEpf.get(r.owed_by_epf);
    if (!g) { g = { epf: r.owed_by_epf, name: r.owed_by_name, total: 0, rows: [], oldest: 0 }; byEpf.set(r.owed_by_epf, g); }
    g.rows.push(r);
    g.total = round2(g.total + r.amount);
    g.oldest = Math.max(g.oldest, Math.floor((now - r.at) / DAY));
  }
  return [...byEpf.values()].sort((a, b) => (b.total - a.total) || a.name.localeCompare(b.name));
}

export default function SplitRecoveries({ actor, refreshKey, onRecovered }: {
  actor: Actor;
  /** Bump to re-fetch quietly after something elsewhere on the page moved money. */
  refreshKey?: number;
  /** Balances changed — the page re-reads its accounts so the Ledger and Accounts tabs agree. */
  onRecovered?: () => void | Promise<void>;
}) {
  const [rows, setRows]       = useState<OutstandingSplit[] | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const [search, setSearch]   = useState('');
  // Keyed `submissionId__epf` — the same key recoverSplit is addressed by, so two rows of the
  // same bill can be marked independently and neither spinner leaks onto the other.
  const [busy, setBusy]       = useState<Set<string>>(new Set());
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (quiet = false) => {
    if (quiet) setRefreshing(true); else setRows(null);
    setError(null);
    try {
      setRows(await listOutstandingSplits());
    } catch (e) {
      const msg = errMsg(e, 'Could not load the outstanding splits');
      setError(msg); setRows([]); toast.error(msg);
    } finally { setRefreshing(false); }
  }, []);

  useEffect(() => { void load(refreshKey !== undefined && refreshKey > 0); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [refreshKey]);

  const keyOf = (r: OutstandingSplit) => `${r.submission_id}__${r.owed_by_epf}`;

  const mark = async (r: OutstandingSplit) => {
    const key = keyOf(r);
    if (busy.has(key)) return;
    setBusy(prev => new Set(prev).add(key));
    try {
      await recoverSplit({ submissionId: r.submission_id, owedByEpf: r.owed_by_epf, actor });
      // Drop it locally rather than re-fetching the whole list: the approver is usually working
      // down one person's rows and a full reload would scroll the ground out from under them.
      setRows(prev => (prev ?? []).filter(x => keyOf(x) !== key));
      toast.success(`${formatSuspenseAmount(r.amount, 'LKR')} returned to ${r.payer_name}’s float.`);
      await onRecovered?.();
    } catch (e) {
      toast.error(errMsg(e, 'Could not record that recovery.'));
      void load(true);   // something moved underneath us — re-read rather than guess
    } finally {
      setBusy(prev => { const n = new Set(prev); n.delete(key); return n; });
    }
  };

  const markAll = async (g: OwedGroup) => {
    for (const r of g.rows) await mark(r);   // sequential: each one is its own transaction
  };

  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = !q ? (rows ?? []) : (rows ?? []).filter(r =>
      [r.owed_by_name, r.owed_by_epf, r.payer_name, r.payer_epf, r.bill_no, r.expense_type, r.item, r.shop_name, r.company_name]
        .some(v => (v ?? '').toString().toLowerCase().includes(q)));
    return groupOwed(filtered);
  }, [rows, search]);

  const total  = useMemo(() => round2((rows ?? []).reduce((t, r) => t + r.amount, 0)), [rows]);
  const payers = useMemo(() => new Set((rows ?? []).map(r => r.payer_epf)).size, [rows]);

  if (rows === null) return <Card className="p-5 sm:p-6"><ListSkeleton rows={5} /></Card>;

  return (
    <Card className="p-5 sm:p-6">
      <div className="mb-4 flex flex-wrap items-start gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-brand text-primary-foreground shadow-soft ring-1 ring-inset ring-[hsl(0_0%_100%/0.15)]">
          <HandCoins className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold tracking-tight text-foreground">Recoveries</h2>
          <p className="text-sm text-muted-foreground">
            Bill portions charged to a colleague. Deduct it from their salary, then mark it here — the money goes straight back to whoever paid.
          </p>
        </div>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Refresh recoveries"
          disabled={refreshing} onClick={() => load(true)}>
          <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
        </Button>
      </div>

      {rows.length > 0 && (
        <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <StatCard label="Owed by colleagues" icon={HandCoins} tone="warning"
            value={<span className="tabular-nums">{formatSuspenseAmount(total, 'LKR')}</span>}
            hint={`${rows.length} split${rows.length === 1 ? '' : 's'}`} />
          <StatCard label="People who owe" icon={UserRound} tone="muted"
            value={<span className="tabular-nums">{groupOwed(rows).length}</span>} />
          <StatCard label="People out of pocket" icon={Wallet} tone="primary"
            value={<span className="tabular-nums">{payers}</span>}
            hint="waiting for it back" />
        </div>
      )}

      {rows.length > 0 && (
        <div className="relative mb-3 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={e => setSearch(e.target.value)} className="h-9 pl-9 text-xs"
            placeholder="Person, bill no, shop…" aria-label="Search recoveries" />
        </div>
      )}

      {error && rows.length === 0 ? (
        <EmptyState icon={HandCoins} title="Couldn’t load recoveries" description={error}
          action={<Button type="button" variant="outline" size="sm" onClick={() => load()}><RefreshCw className="h-3.5 w-3.5" /> Retry</Button>} />
      ) : rows.length === 0 ? (
        <EmptyState icon={HandCoins} title="Nothing outstanding"
          description="Every split bill has been recovered — no one is carrying money for a colleague." />
      ) : groups.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Nothing matches.</p>
      ) : (
        <div className="space-y-4">
          {groups.map(g => {
            const groupBusy = g.rows.some(r => busy.has(keyOf(r)));
            return (
              <section key={g.epf} className="overflow-hidden rounded-xl border border-border bg-card/40">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/60 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-foreground">{g.name}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {g.epf} · {g.rows.length} split{g.rows.length === 1 ? '' : 's'}
                      {g.oldest > 0 && ` · oldest ${g.oldest} day${g.oldest === 1 ? '' : 's'}`}
                    </div>
                  </div>
                  <div className="text-right text-sm font-bold tabular-nums text-warning">
                    {formatSuspenseAmount(g.total, 'LKR')}
                  </div>
                  <Button type="button" size="sm" variant="outline" disabled={groupBusy} onClick={() => markAll(g)}>
                    {groupBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <HandCoins className="h-3.5 w-3.5" />}
                    Mark all deducted
                  </Button>
                </div>
                <div className="divide-y divide-border/60">
                  {g.rows.map(r => {
                    const key = keyOf(r);
                    const rowBusy = busy.has(key);
                    return (
                      <div key={key} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-foreground">
                            {r.bill_no && <Badge variant="outline" className="py-0 text-[10px]">Bill {r.bill_no}</Badge>}
                            <span className="truncate">{r.expense_type || 'Expense'}</span>
                          </div>
                          <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                            {[r.item, r.shop_name].filter(Boolean).join(' @ ')}
                            {' · paid by '}<span className="font-medium text-foreground">{r.payer_name}</span>
                            {' · '}{prettyDay(new Date(r.at).toISOString().slice(0, 10), { day: 'numeric', month: 'short' })}
                          </div>
                        </div>
                        <div className="w-24 shrink-0 text-right text-xs font-semibold tabular-nums text-foreground">
                          {formatSuspenseAmount(r.amount, 'LKR')}
                        </div>
                        <Button type="button" size="sm" variant="secondary" disabled={rowBusy} onClick={() => mark(r)}>
                          {rowBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <HandCoins className="h-3.5 w-3.5" />}
                          Deducted
                        </Button>
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}

      <p className="mt-4 flex items-start gap-1.5 text-[11px] text-muted-foreground">
        <Undo2 className="mt-0.5 h-3 w-3 shrink-0" />
        Marked one by mistake? It can be reversed from the payer&apos;s history — the reversal posts its own ledger line rather than erasing the original.
      </p>
    </Card>
  );
}
