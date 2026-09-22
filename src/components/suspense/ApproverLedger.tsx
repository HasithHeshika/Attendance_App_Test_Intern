'use client';
// The approver's Ledger tab: who took how much, on which days, and the month's total.
//
// One fetch per month (getSuspenseMonthData) feeds buildSuspenseMonthView; every control on
// the tab — company, search, by person / by day, the heat grid, idle holders, sorting — is
// answered in memory from that one view (see ./ledger/monthViewFilters.ts). A refreshKey
// change from the page re-fetches quietly, without dropping back to the skeleton.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, Clock, Coins, RefreshCw, Receipt, Scale, Search, Users, Wallet, X,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { tenant } from '@/lib/firebase';
import { buildSuspenseMonthView, type PersonRow, type SuspenseMonthView } from '@/lib/suspenseMonthView';
import type { Company, SuspenseAccount, SuspenseRequest } from '@/lib/types';
import { cn } from '@/lib/utils';
import { formatSuspenseAmount, getSuspenseMonthData } from '@/services/suspenseService';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { StatCardsSkeleton, TableSkeleton } from '@/components/ui/Skeleton';
import { StatCard } from '@/components/ui/stat-card';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import MonthYearPicker from '@/components/MonthYearPicker';
import Select from '@/components/Select';
import { MONTHS, errMsg, prettyDay } from '@/components/suspense/shared';

// A money figure for a KPI tile. StatCard's default value size (text-2xl) is set for short
// numbers; a full "LKR 276,000.00" broke after the currency and left "LKR" stranded on its own
// line. One step down plus whitespace-nowrap keeps it on one line at five tiles across, and the
// title attribute carries the exact string for anyone who needs to read it back.
function TileMoney({ value, className }: { value: string; className?: string }) {
  return (
    <span title={value} className={cn('block whitespace-nowrap text-lg font-semibold leading-tight sm:text-xl', className)}>
      {value}
    </span>
  );
}
import PersonHistoryDialog, { PersonButton } from '@/components/suspense/PersonHistoryDialog';
import DayHeatGrid from './ledger/DayHeatGrid';
import { DaySubtotals, LedgerLineRow } from './ledger/LedgerLineRow';
import {
  belongsToCompany, groupByDayThenPerson, matchesSearch, rebuildDays, sortPeople, sumPeople,
  type PeopleSortKey, type SortDir,
} from './ledger/monthViewFilters';

type ViewMode = 'people' | 'days';

const LONG_DAY: Intl.DateTimeFormatOptions = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' };

const SORT_LABEL: Record<PeopleSortKey, string> = {
  name: 'Person', balance: 'Balance', spent: 'Spent', pending: 'Awaiting', credit: 'Credit',
};

export default function ApproverLedger({ accounts, companies, currency, pendingRequests, refreshKey }: {
  accounts:        SuspenseAccount[];
  companies:       Company[];
  currency:        string;
  pendingRequests: SuspenseRequest[];
  /** Bump to re-fetch the month quietly (after an approval, a credit, an import…). */
  refreshKey?:     number;
}) {
  const [year, setYear]   = useState(() => new Date().getFullYear());
  const [month, setMonth] = useState(() => new Date().getMonth() + 1);
  const [years]           = useState(() => { const y = new Date().getFullYear(); return [y - 2, y - 1, y]; });

  const [companyId, setCompanyId]     = useState('');
  const [search, setSearch]           = useState('');
  const [mode, setMode]               = useState<ViewMode>('people');
  const [selectedDay, setSelectedDay] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [sortKey, setSortKey]         = useState<PeopleSortKey>('spent');
  const [sortDir, setSortDir]         = useState<SortDir>('desc');
  const [expanded, setExpanded]       = useState<Set<string>>(new Set());
  // The person whose full history is open. Kept after the dialog closes so its contents don't
  // blank out mid-fade; `historyOpen` is what actually shows it.
  const [history, setHistory]         = useState<{ epf: string; name: string } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  type MonthData = Awaited<ReturnType<typeof getSuspenseMonthData>>;
  // `key` records which month the data belongs to: a refresh for the same month keeps the
  // old numbers on screen while the new ones load, a month change drops to the skeleton.
  const [raw, setRaw]         = useState<{ key: string; data: MonthData } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const loadedKey = useRef('');
  // Only the latest request may touch state — flipping months quickly must not let a slow
  // earlier fetch land its data on top of the newer one.
  const reqId = useRef(0);

  const load = useCallback(async (y: number, m: number) => {
    if (!tenant.features.suspense) { setLoading(false); return; }
    const id  = ++reqId.current;
    const key = `${y}-${m}`;
    if (loadedKey.current !== key) setLoading(true);
    setError(null);
    try {
      const data = await getSuspenseMonthData(y, m);
      if (id !== reqId.current) return;
      loadedKey.current = key;
      setRaw({ key, data });
    } catch (e) {
      if (id !== reqId.current) return;
      const msg = errMsg(e, 'Could not load the month');
      setError(msg);
      toast.error(msg);
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void load(year, month); }, [year, month, refreshKey, load]);

  // The full month view; recomputed when accounts change (balances move after a credit).
  const view: SuspenseMonthView | null = useMemo(() => {
    if (!raw || raw.key !== `${year}-${month}`) return null;
    return buildSuspenseMonthView({ ...raw.data, accounts, year, month });
  }, [raw, accounts, year, month]);

  // Company filter first — it decides the KPIs and the heat grid. Search and the idle-holder
  // switch only narrow the list below.
  const scoped = useMemo(() => {
    if (!view) return null;
    const people = view.people.filter(p => belongsToCompany(p, companyId));
    return {
      people,
      totals: companyId ? sumPeople(people) : view.totals,
      days:   companyId ? rebuildDays(people, year, month) : view.days,
    };
  }, [view, companyId, year, month]);

  const listed = useMemo(() => {
    if (!scoped) return { people: [] as PersonRow[], hiddenIdle: 0, searchMiss: false };
    const searched = scoped.people.filter(p => matchesSearch(p, search));
    const idle = searched.filter(p => !p.active).length;
    const people = showInactive ? searched : searched.filter(p => p.active);
    return { people, hiddenIdle: showInactive ? 0 : idle, searchMiss: search.trim() !== '' && searched.length === 0 };
  }, [scoped, search, showInactive]);

  const sorted = useMemo(() => sortPeople(listed.people, sortKey, sortDir), [listed.people, sortKey, sortDir]);
  const listedTotals = useMemo(() => sumPeople(listed.people), [listed.people]);
  const dayGroups = useMemo(() => {
    const groups = groupByDayThenPerson(listed.people);
    return selectedDay ? groups.filter(g => g.date === selectedDay) : groups;
  }, [listed.people, selectedDay]);

  const pendingCreditSum = useMemo(() => pendingRequests
    .filter(r => r.status === 'pending' && (!companyId || r.company_id === companyId))
    .reduce((t, r) => t + (Number(r.amount) || 0), 0), [pendingRequests, companyId]);

  const effectiveMode: ViewMode = selectedDay ? 'days' : mode;
  const monthLabel = `${MONTHS[month - 1]} ${year}`;

  const changeMonth = (y: number, m: number) => {
    setYear(y); setMonth(m);
    setSelectedDay(''); setExpanded(new Set());
  };
  const pickMode = (m: ViewMode) => { setMode(m); if (m === 'people') setSelectedDay(''); };
  const toggleDay = (date: string) => setSelectedDay(d => (d === date ? '' : date));
  const toggleExpanded = (epf: string) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(epf)) next.delete(epf); else next.add(epf);
    return next;
  });
  const openHistory = (epf: string, name: string) => { setHistory({ epf, name }); setHistoryOpen(true); };
  const clickSort = (key: PeopleSortKey) => {
    if (key === sortKey) { setSortDir(d => (d === 'asc' ? 'desc' : 'asc')); return; }
    setSortKey(key);
    setSortDir(key === 'name' ? 'asc' : 'desc');
  };

  if (!tenant.features.suspense) {
    return <EmptyState icon={Wallet} title="Not available" description="The suspense module isn’t enabled for this workspace." />;
  }

  const companyOptions = [{ value: '', label: 'All companies' }, ...companies.map(c => ({ value: c.id, label: c.name }))];

  return (
    <div className="space-y-4">
      {/* ── Toolbar ── */}
      <div className="flex flex-col gap-2 lg:flex-row lg:flex-wrap lg:items-center">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:flex lg:flex-1 lg:items-center">
          <MonthYearPicker year={year} month={month} years={years} onChange={changeMonth} className="!h-9 lg:w-48" />
          <div className="lg:w-56">
            <Select value={companyId} onChange={setCompanyId} options={companyOptions} placeholder="All companies" />
          </div>
          <div className="relative sm:col-span-2 lg:flex-1 lg:min-w-[200px]">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by name or EPF…" className="pl-9" aria-label="Search by name or EPF" />
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex rounded-lg border border-border bg-card p-0.5" role="group" aria-label="List layout">
            {(['people', 'days'] as const).map(m => (
              <button
                key={m}
                type="button"
                aria-pressed={effectiveMode === m}
                onClick={() => pickMode(m)}
                className={cn(
                  'h-9 rounded-md px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  effectiveMode === m ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                {m === 'people' ? 'By person' : 'By day'}
              </button>
            ))}
          </div>
          <label className="flex min-h-[36px] cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <Switch checked={showInactive} onCheckedChange={setShowInactive} aria-label="Show holders with no activity" />
            Show holders with no activity
          </label>
        </div>
      </div>

      {loading || !scoped ? (
        error ? (
          <Card>
            <EmptyState
              icon={Wallet}
              title="Couldn’t load the month"
              description={error}
              action={<Button type="button" variant="outline" size="sm" onClick={() => load(year, month)}><RefreshCw className="h-3.5 w-3.5" /> Retry</Button>}
            />
          </Card>
        ) : (
          <div className="space-y-4">
            <StatCardsSkeleton count={5} />
            <TableSkeleton rows={6} cols={5} />
          </div>
        )
      ) : (
        <>
          {/* ── KPIs ── */}
          {/* Three across on a tablet before five on a laptop — at five, a money tile on a
              narrow laptop had nowhere to put the currency. */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
            <StatCard
              label="Spent"
              value={<TileMoney value={formatSuspenseAmount(scoped.totals.spent, currency)} />}
              icon={Receipt}
              hint={`${scoped.totals.billCount - scoped.totals.pendingCount} bills · ${scoped.people.filter(p => p.spent > 0).length} people`}
            />
            <StatCard
              label="Awaiting approval"
              value={<TileMoney value={formatSuspenseAmount(scoped.totals.pending, currency)} />}
              icon={Clock}
              tone="warning"
              hint={`${scoped.totals.pendingCount} bill${scoped.totals.pendingCount === 1 ? '' : 's'}`}
            />
            <StatCard
              label="Credit given"
              value={<TileMoney value={formatSuspenseAmount(scoped.totals.credit, currency)} />}
              icon={Coins}
              tone="brand"
              hint={pendingCreditSum > 0 ? `${formatSuspenseAmount(pendingCreditSum, currency)} requested, not yet decided` : 'No credit requests waiting'}
            />
            <StatCard
              label="Net float movement"
              value={(() => {
                const net = Math.round((scoped.totals.credit - scoped.totals.spent) * 100) / 100;
                return <TileMoney value={`${net < 0 ? '−' : net > 0 ? '+' : ''}${formatSuspenseAmount(Math.abs(net), currency)}`} />;
              })()}
              icon={Scale}
              tone="muted"
              hint={scoped.totals.credit > scoped.totals.spent ? 'float grew' : scoped.totals.credit < scoped.totals.spent ? 'float shrank' : 'no change'}
            />
            <StatCard
              label="Holders"
              value={scoped.totals.holders}
              icon={Users}
              tone="muted"
              hint={`${scoped.totals.activePeople} active this month`}
              className="col-span-2 md:col-span-1"
            />
          </div>

          {/* ── Which days ── */}
          <Card className="p-4 sm:p-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Which days · {monthLabel}</div>
              {selectedDay && (
                <button
                  type="button"
                  onClick={() => setSelectedDay('')}
                  className="inline-flex h-7 items-center gap-1 rounded-full border border-primary/50 bg-primary/10 px-2.5 text-[11px] font-medium text-primary hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {prettyDay(selectedDay)} <X className="h-3 w-3" aria-hidden /> <span className="sr-only">Clear day</span>
                </button>
              )}
            </div>
            <DayHeatGrid year={year} month={month} days={scoped.days} selectedDay={selectedDay} onSelectDay={toggleDay} currency={currency} />
          </Card>

          {/* ── List ── */}
          {scoped.totals.activePeople === 0 && !showInactive ? (
            <Card>
              <EmptyState
                icon={Wallet}
                title={`Nothing recorded in ${monthLabel}`}
                description={scoped.totals.holders > 0
                  ? `${scoped.totals.holders} holder${scoped.totals.holders === 1 ? '' : 's'} with nothing this month.`
                  : 'No bills or credits fell in this month.'}
                action={scoped.totals.holders > 0
                  ? <Button type="button" variant="outline" size="sm" onClick={() => setShowInactive(true)}>Show holders</Button>
                  : undefined}
              />
            </Card>
          ) : listed.searchMiss ? (
            <p className="py-4 text-center text-sm text-muted-foreground">Nobody matches “{search.trim()}”.</p>
          ) : effectiveMode === 'people' ? (
            <Card className="overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <SortHead k="name" sortKey={sortKey} sortDir={sortDir} onClick={clickSort} className="min-w-[220px]" />
                    <SortHead k="balance" sortKey={sortKey} sortDir={sortDir} onClick={clickSort} align="right" />
                    <SortHead k="spent" sortKey={sortKey} sortDir={sortDir} onClick={clickSort} align="right" />
                    <SortHead k="pending" sortKey={sortKey} sortDir={sortDir} onClick={clickSort} align="right" />
                    <SortHead k="credit" sortKey={sortKey} sortDir={sortDir} onClick={clickSort} align="right" />
                    <TableHead className="text-right">Bills</TableHead>
                    <TableHead className="w-10"><span className="sr-only">Days</span></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sorted.map(p => {
                    const open = expanded.has(p.epf);
                    const panelId = `ledger-person-${p.epf}`;
                    return (
                      <PersonRows key={p.epf} p={p} open={open} panelId={panelId} currency={currency} onToggle={() => toggleExpanded(p.epf)} onOpenHistory={() => openHistory(p.epf, p.name)} />
                    );
                  })}
                </TableBody>
                <TableFooter>
                  <TableRow className="hover:bg-transparent">
                    <TableCell className="text-xs text-muted-foreground">
                      {listed.people.length} {listed.people.length === 1 ? 'person' : 'people'}
                      {companyId || search ? ' shown' : ''}
                    </TableCell>
                    <TableCell />
                    <TableCell className="text-right tabular-nums">{formatSuspenseAmount(listedTotals.spent, currency)}</TableCell>
                    <TableCell className={cn('text-right tabular-nums', listedTotals.pending > 0 && 'text-warning')}>{formatSuspenseAmount(listedTotals.pending, currency)}</TableCell>
                    <TableCell className="text-right tabular-nums text-primary">+{formatSuspenseAmount(listedTotals.credit, currency)}</TableCell>
                    <TableCell className="text-right tabular-nums">{listedTotals.billCount}</TableCell>
                    <TableCell />
                  </TableRow>
                </TableFooter>
              </Table>
              {listed.hiddenIdle > 0 && (
                <div className="border-t border-border/60 px-4 py-2 text-[11px] text-muted-foreground">
                  {listed.hiddenIdle} holder{listed.hiddenIdle === 1 ? '' : 's'} with nothing this month ·{' '}
                  <button type="button" onClick={() => setShowInactive(true)} className="font-medium text-primary underline-offset-2 hover:underline">Show</button>
                </div>
              )}
            </Card>
          ) : (
            <div className="space-y-3">
              {dayGroups.length === 0 ? (
                <Card>
                  <EmptyState
                    icon={Wallet}
                    title={selectedDay ? `Nothing on ${prettyDay(selectedDay)}` : `Nothing recorded in ${monthLabel}`}
                    action={selectedDay ? <Button type="button" variant="outline" size="sm" onClick={() => setSelectedDay('')}>Clear day</Button> : undefined}
                  />
                </Card>
              ) : dayGroups.map(g => (
                <Card key={g.date} className="p-4 sm:p-5">
                  <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="text-sm font-semibold text-foreground">{prettyDay(g.date, LONG_DAY)}</div>
                      <div className="text-[11px] text-muted-foreground">{g.people.length} {g.people.length === 1 ? 'person' : 'people'}</div>
                    </div>
                    <DaySubtotals spent={g.spent} pending={g.pending} credit={g.credit} currency={currency} />
                  </div>
                  <div className="space-y-3">
                    {g.people.map(gp => (
                      <div key={gp.epf}>
                        <div className="mb-1.5 flex items-center gap-2">
                          <PersonButton name={gp.name} size="sm" onClick={() => openHistory(gp.epf, gp.name)} className="gap-2">
                            <span className="block truncate text-[11px] text-muted-foreground">{gp.epf}</span>
                          </PersonButton>
                          <DaySubtotals spent={gp.spent} pending={gp.pending} credit={gp.credit} currency={currency} className="ml-auto text-[11px]" />
                        </div>
                        <div className="space-y-1.5">
                          {gp.lines.map(l => <LedgerLineRow key={l.id} line={l} currency={currency} />)}
                        </div>
                      </div>
                    ))}
                  </div>
                </Card>
              ))}
              {listed.hiddenIdle > 0 && !selectedDay && (
                <p className="px-1 text-[11px] text-muted-foreground">
                  {listed.hiddenIdle} holder{listed.hiddenIdle === 1 ? '' : 's'} with nothing this month ·{' '}
                  <button type="button" onClick={() => { setShowInactive(true); setMode('people'); }} className="font-medium text-primary underline-offset-2 hover:underline">Show</button>
                </p>
              )}
            </div>
          )}

          <p className="px-1 text-[11px] text-muted-foreground">
            Bills are placed on their bill date (the submission date when a bill has none). Credits are placed on the day they were posted.
          </p>
        </>
      )}

      <PersonHistoryDialog
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        epf={history?.epf ?? ''}
        name={history?.name ?? ''}
        currency={currency}
        accounts={accounts}
      />
    </div>
  );
}

// ─── Pieces ─────────────────────────────────────────────────────────────────────

function SortHead({ k, sortKey, sortDir, onClick, align = 'left', className }: {
  k: PeopleSortKey; sortKey: PeopleSortKey; sortDir: SortDir; onClick: (k: PeopleSortKey) => void;
  align?: 'left' | 'right'; className?: string;
}) {
  const active = k === sortKey;
  const Icon = !active ? ArrowUpDown : sortDir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <TableHead aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'} className={cn(align === 'right' && 'text-right', className)}>
      <button
        type="button"
        onClick={() => onClick(k)}
        className={cn(
          'inline-flex h-9 items-center gap-1 rounded-md px-1 -mx-1 text-xs font-semibold uppercase tracking-wide hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          active ? 'text-foreground' : 'text-muted-foreground',
        )}
      >
        {SORT_LABEL[k]}
        <Icon className={cn('h-3 w-3', !active && 'opacity-50')} aria-hidden />
      </button>
    </TableHead>
  );
}

function PersonRows({ p, open, panelId, currency, onToggle, onOpenHistory }: {
  p: PersonRow; open: boolean; panelId: string; currency: string; onToggle: () => void; onOpenHistory: () => void;
}) {
  const overspent = p.balance !== null && p.balance < 0;
  return (
    <>
      <TableRow className={cn(open && 'bg-muted/30')}>
        <TableCell className="py-2.5">
          {/* The name opens the person's full history; the chevron at the row's end is what
              expands this month's days — two different things, so two different buttons. */}
          <PersonButton name={p.name} onClick={onOpenHistory} className="w-full">
            <span className="block truncate text-[11px] text-muted-foreground">
              {p.epf}{p.companies.length ? ` · ${p.companies.join(', ')}` : ''}
            </span>
          </PersonButton>
        </TableCell>
        <TableCell className="py-2.5 text-right tabular-nums">
          {p.balance === null ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            <span className={cn(overspent ? 'font-semibold text-destructive' : 'text-foreground')}>
              {formatSuspenseAmount(p.balance, currency)}
              {overspent && <span className="ml-1 text-[10px] font-medium uppercase tracking-wide">overspent</span>}
            </span>
          )}
        </TableCell>
        <TableCell className="py-2.5 text-right font-semibold tabular-nums text-foreground">{formatSuspenseAmount(p.spent, currency)}</TableCell>
        <TableCell className={cn('py-2.5 text-right tabular-nums', p.pending > 0 ? 'text-warning' : 'text-muted-foreground')}>
          {formatSuspenseAmount(p.pending, currency)}
          {p.pendingCount > 0 && <span className="ml-1 text-[10px]">({p.pendingCount})</span>}
        </TableCell>
        <TableCell className={cn('py-2.5 text-right tabular-nums', p.credit > 0 ? 'text-primary' : 'text-muted-foreground')}>
          {p.credit > 0 ? '+' : ''}{formatSuspenseAmount(p.credit, currency)}
        </TableCell>
        <TableCell className="py-2.5 text-right tabular-nums text-muted-foreground">{p.billCount}</TableCell>
        <TableCell className="py-2.5 pr-3">
          <button
            type="button"
            aria-label={open ? `Hide ${p.name}'s days` : `Show ${p.name}'s days`}
            aria-expanded={open}
            aria-controls={panelId}
            onClick={onToggle}
            className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronDown className={cn('h-4 w-4 transition-transform', open && 'rotate-180')} aria-hidden />
          </button>
        </TableCell>
      </TableRow>
      {open && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={7} id={panelId} className="bg-muted/20 p-3 sm:p-4">
            {p.days.length === 0 ? (
              <p className="text-xs text-muted-foreground">Nothing recorded this month.</p>
            ) : (
              <div className="space-y-3">
                {p.days.map(d => (
                  <div key={d.date}>
                    <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                      <div className="text-xs font-semibold text-foreground">{prettyDay(d.date)}</div>
                      <DaySubtotals spent={d.spent} pending={d.pending} credit={d.credit} currency={currency} className="text-[11px]" />
                    </div>
                    <div className="space-y-1.5">
                      {d.lines.map(l => <LedgerLineRow key={l.id} line={l} currency={currency} />)}
                    </div>
                  </div>
                ))}
                {p.rejected > 0 && (
                  <div className="text-[11px] text-muted-foreground">
                    <Badge variant="destructive" className="mr-1">Rejected</Badge>
                    {formatSuspenseAmount(p.rejected, currency)} was rejected this month and never left the float.
                  </div>
                )}
              </div>
            )}
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
