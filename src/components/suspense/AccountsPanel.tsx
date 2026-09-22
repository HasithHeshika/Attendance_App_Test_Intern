'use client';
// The approver's Accounts tab: every suspense account with its balance and the actions an
// approver can take on it. The page owns the dialogs and the data — this component only
// decides what to show and hands each click back up through the callbacks.
import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Building2, Lock, Plus, RotateCcw, Search, Trash2, UserPlus, Users, Wallet, AlertTriangle, Clock, Archive } from 'lucide-react';
import type { SuspenseAccount } from '@/lib/types';
import { cn } from '@/lib/utils';
import { formatSuspenseAmount } from '@/services/suspenseService';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { TableSkeleton } from '@/components/ui/Skeleton';
import { StatCard } from '@/components/ui/stat-card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import ImportBalancesDialog from '@/components/suspense/ImportBalancesDialog';
import PersonHistoryDialog, { PersonButton } from '@/components/suspense/PersonHistoryDialog';

type StatusFilter = 'all' | 'active' | 'overspent' | 'closePending' | 'closed';
type BalanceSort  = 'none' | 'desc' | 'asc';

// Firestore Timestamp → "1 Sep 2026". Defensive about the shape: an account written by an older
// client, or read back before the SDK has rehydrated it, can carry a plain date-like object.
const fmtCarryDate = (t: { toDate?: () => Date } | null | undefined): string => {
  const d = t?.toDate?.();
  return d ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
};

const isClosed      = (a: SuspenseAccount) => !!a.is_closed;
const isClosePending = (a: SuspenseAccount) => !a.is_closed && !a.is_active;
const isOpen        = (a: SuspenseAccount) => !a.is_closed && a.is_active;
const isOverspent   = (a: SuspenseAccount) => a.balance < 0;

const FILTERS: Array<{ key: StatusFilter; label: string; test: (a: SuspenseAccount) => boolean }> = [
  { key: 'all',          label: 'All',           test: () => true },
  { key: 'active',       label: 'Active',        test: isOpen },
  { key: 'overspent',    label: 'Overspent',     test: isOverspent },
  { key: 'closePending', label: 'Close pending', test: isClosePending },
  { key: 'closed',       label: 'Closed',        test: isClosed },
];

export default function AccountsPanel({ accounts, loading, actor, onOpenAccount, onAddCredit, onClose, onDelete, onReopen, onImported }: {
  accounts:      SuspenseAccount[];
  loading:       boolean;
  actor:         { epf: string; name: string };
  onOpenAccount: () => void;
  onAddCredit:   (a: SuspenseAccount) => void;
  onClose:       (a: SuspenseAccount) => void;
  onDelete:      (a: SuspenseAccount) => void;
  onReopen:      (a: SuspenseAccount) => void;
  onImported:    () => void | Promise<void>;
}) {
  const [search, setSearch]   = useState('');
  const [filter, setFilter]   = useState<StatusFilter>('all');
  const [balSort, setBalSort] = useState<BalanceSort>('none');
  // Whose full history is open. The person is kept after closing so the dialog can fade out
  // with its contents still in place.
  const [history, setHistory]         = useState<{ epf: string; name: string } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  const currency = accounts[0]?.currency ?? 'LKR';

  const summary = useMemo(() => ({
    float:        accounts.filter(a => !isClosed(a)).reduce((t, a) => t + (Number(a.balance) || 0), 0),
    overspent:    accounts.filter(isOverspent).length,
    closePending: accounts.filter(isClosePending).length,
    closed:       accounts.filter(isClosed).length,
  }), [accounts]);

  const counts = useMemo(() => Object.fromEntries(FILTERS.map(f => [f.key, accounts.filter(f.test).length])) as Record<StatusFilter, number>, [accounts]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    const test = FILTERS.find(f => f.key === filter)?.test ?? (() => true);
    const rows = accounts.filter(a => test(a) && (!q
      || a.employee_name.toLowerCase().includes(q)
      || a.epf_number.toLowerCase().includes(q)
      || a.company_name.toLowerCase().includes(q)));
    // listSuspenseAccounts already returns name-then-company order; only re-sort on request.
    if (balSort === 'none') return rows;
    const sign = balSort === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => sign * (a.balance - b.balance) || a.employee_name.localeCompare(b.employee_name));
  }, [accounts, search, filter, balSort]);

  const cycleBalanceSort = () => setBalSort(s => (s === 'none' ? 'desc' : s === 'desc' ? 'asc' : 'none'));
  const BalIcon = balSort === 'none' ? ArrowUpDown : balSort === 'asc' ? ArrowUp : ArrowDown;

  if (loading) {
    return (
      <div className="space-y-3">
        <TableSkeleton rows={6} cols={7} />
      </div>
    );
  }

  const openButton = (
    <Button type="button" size="sm" onClick={onOpenAccount}><UserPlus className="h-4 w-4" /> Open account</Button>
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-muted-foreground">{accounts.length} account{accounts.length === 1 ? '' : 's'}</div>
        <div className="flex flex-wrap items-center gap-2">
          <ImportBalancesDialog accounts={accounts} actor={actor} onImported={onImported} />
          {openButton}
        </div>
      </div>

      {accounts.length === 0 ? (
        <Card>
          <EmptyState
            icon={Users}
            title="No suspense accounts"
            description="Open one for a user so they can submit expenses and request credit."
            action={openButton}
          />
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Total float held" value={formatSuspenseAmount(summary.float, currency)} icon={Wallet} hint="open accounts" />
            <StatCard
              label="Overspent"
              value={<span className={cn(summary.overspent > 0 && 'text-destructive')}>{summary.overspent}</span>}
              icon={AlertTriangle}
              tone={summary.overspent > 0 ? 'destructive' : 'muted'}
              hint={summary.overspent === 1 ? 'account below zero' : 'accounts below zero'}
            />
            <StatCard label="Close pending" value={summary.closePending} icon={Clock} tone={summary.closePending > 0 ? 'warning' : 'muted'} hint="frozen until decided" />
            <StatCard label="Closed" value={summary.closed} icon={Archive} tone="muted" hint="settled — reopenable" />
          </div>

          <div className="space-y-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search by name, EPF or company…"
                className="pl-9"
                aria-label="Search accounts"
              />
            </div>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by status">
              {FILTERS.map(f => {
                const active = filter === f.key;
                return (
                  <button
                    key={f.key}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setFilter(f.key)}
                    className={cn(
                      'inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      active ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground',
                    )}
                  >
                    {f.label}
                    <span className={cn('tabular-nums', active ? 'text-primary/80' : 'text-muted-foreground/70')}>{counts[f.key]}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {shown.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              {search.trim() ? <>No accounts match “{search.trim()}”.</> : 'No accounts in this state.'}
            </p>
          ) : (
            <Card className="overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="min-w-[200px]">Person</TableHead>
                    <TableHead>Company</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Opened by</TableHead>
                    <TableHead className="text-right whitespace-nowrap">Carry forward</TableHead>
                    <TableHead className="text-right" aria-sort={balSort === 'none' ? 'none' : balSort === 'asc' ? 'ascending' : 'descending'}>
                      <button
                        type="button"
                        onClick={cycleBalanceSort}
                        className={cn(
                          'inline-flex h-9 items-center gap-1 rounded-md px-1 -mx-1 text-xs font-semibold uppercase tracking-wide hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          balSort === 'none' ? 'text-muted-foreground' : 'text-foreground',
                        )}
                      >
                        Balance <BalIcon className={cn('h-3 w-3', balSort === 'none' && 'opacity-50')} aria-hidden />
                      </button>
                    </TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shown.map(a => (
                    <TableRow key={`${a.epf_number}__${a.company_id}`}>
                      <TableCell className="py-2.5">
                        <PersonButton name={a.employee_name} onClick={() => { setHistory({ epf: a.epf_number, name: a.employee_name }); setHistoryOpen(true); }}>
                          <Badge variant="muted" className="mt-0.5">{a.epf_number}</Badge>
                        </PersonButton>
                      </TableCell>
                      <TableCell className="py-2.5 text-sm text-foreground">
                        <span className="inline-flex items-center gap-1.5 whitespace-nowrap"><Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> {a.company_name}</span>
                      </TableCell>
                      <TableCell className="py-2.5">
                        {a.is_closed
                          ? <Badge variant="muted">Closed</Badge>
                          : !a.is_active
                            ? <Badge variant="warning">Close pending</Badge>
                            : <Badge variant="success">Active</Badge>}
                      </TableCell>
                      <TableCell className="py-2.5 text-xs text-muted-foreground whitespace-nowrap">{a.created_by_name || a.created_by}</TableCell>
                      {/* The last balance carried into this account, and the date it was as at.
                          A movement, not a second balance — Balance beside it already includes it. */}
                      <TableCell className="py-2.5 text-right whitespace-nowrap">
                        {a.carry_forward == null ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : (
                          <>
                            <div className={cn('text-sm font-semibold tabular-nums', a.carry_forward < 0 ? 'text-destructive' : 'text-foreground')}>
                              {a.carry_forward > 0 ? '+' : ''}{formatSuspenseAmount(a.carry_forward, a.currency)}
                            </div>
                            {a.carry_forward_at && (
                              <div className="text-[10px] text-muted-foreground">as at {fmtCarryDate(a.carry_forward_at)}</div>
                            )}
                          </>
                        )}
                      </TableCell>
                      <TableCell className={cn('py-2.5 text-right text-base font-bold tabular-nums whitespace-nowrap', a.balance < 0 ? 'text-destructive' : 'text-foreground')}>
                        {formatSuspenseAmount(a.balance, a.currency)}
                      </TableCell>
                      <TableCell className="py-2.5">
                        {isOpen(a) && (
                          <div className="flex items-center justify-end gap-2">
                            <Button type="button" size="sm" variant="outline" onClick={() => onAddCredit(a)}>
                              <Plus className="h-3.5 w-3.5" /> Add credit
                            </Button>
                            {a.balance === 0 ? (
                              <Button type="button" size="sm" variant="outline" className="text-destructive hover:text-destructive" onClick={() => onDelete(a)}>
                                <Trash2 className="h-3.5 w-3.5" /> Delete
                              </Button>
                            ) : (
                              <Button type="button" size="sm" variant="outline" className="text-destructive hover:text-destructive" onClick={() => onClose(a)}>
                                <Lock className="h-3.5 w-3.5" /> Close
                              </Button>
                            )}
                          </div>
                        )}
                        {isClosed(a) && (
                          <div className="flex items-center justify-end">
                            <Button type="button" size="sm" variant="outline" onClick={() => onReopen(a)}>
                              <RotateCcw className="h-3.5 w-3.5" /> Reopen
                            </Button>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
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
