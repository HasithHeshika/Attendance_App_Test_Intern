'use client';
import { useMemo, useState } from 'react';
import { Search, Users, AlertTriangle, Trophy, Filter, User } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useT } from '@/store/appStore';
import type { MealType } from '@/lib/meals';
import type { ChamaryMonthView, ChamaryPersonRow } from '@/lib/chamaryMonth';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { TableSkeleton } from '@/components/ui/Skeleton';
import {
  Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell,
} from '@/components/ui/table';

const PAGE = 15;
type FilterTab = 'all' | 'no_shows' | 'frequent';

interface Props {
  view:    ChamaryMonthView | null;
  loading: boolean;
  served:  MealType[];
}

export default function ChamaryPeopleTable({ view, loading, served }: Props) {
  const t = useT();
  const [search, setSearch]       = useState('');
  const [activeTab, setActiveTab] = useState<FilterTab>('all');
  const [showAll, setShowAll]     = useState(false);

  const mealName: Record<MealType, string> = {
    breakfast: t.mealBreakfast, lunch: t.mealLunch, dinner: t.mealDinner,
  };

  const allPeople = view?.people ?? [];
  const noShowPeopleCount = useMemo(() => allPeople.filter(p => p.noShows > 0).length, [allPeople]);

  const rows = useMemo(() => {
    let list = [...allPeople];

    // Filter tab logic
    if (activeTab === 'no_shows') {
      list = list.filter(p => p.noShows > 0).sort((a, b) => b.noShows - a.noShows);
    } else if (activeTab === 'frequent') {
      list = [...list].sort((a, b) => b.total - a.total).slice(0, 20);
    }

    // Search query filter
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(p =>
        `${p.name} ${p.epf} ${p.company_name ?? ''} ${p.chamaries.join(' ')}`.toLowerCase().includes(q),
      );
    }

    return list;
  }, [allPeople, activeTab, search]);

  const shown = showAll ? rows : rows.slice(0, PAGE);
  const totals = view?.totals;

  return (
    <Card className="overflow-hidden border-border/80 bg-card p-4 shadow-sm sm:p-5">
      {/* ── Table Header & Controls ── */}
      <div className="flex flex-col gap-3 border-b border-border/40 pb-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Users className="h-4 w-4" />
          </span>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-bold tracking-tight text-foreground">{t.whoAteTitle}</h3>
              {totals && totals.people > 0 && (
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground">
                  {totals.people} {t.peopleWord}
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Monthly diners, meal allocation breakdown, and fulfillment tracking.
            </p>
          </div>
        </div>

        {/* Search input */}
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={t.searchPeopleWord}
            aria-label={t.searchPeopleWord}
            className="pl-9 text-xs bg-muted/20"
          />
        </div>
      </div>

      {/* ── Filter Tabs ── */}
      <div className="mt-3 flex flex-wrap items-center gap-1.5 border-b border-border/30 pb-3">
        <button
          type="button"
          onClick={() => setActiveTab('all')}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-lg px-3 py-1 text-xs font-medium transition-colors',
            activeTab === 'all'
              ? 'bg-primary text-primary-foreground font-semibold shadow-xs'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
        >
          <Filter className="h-3 w-3" />
          <span>All Diners</span>
          <span className="text-[10px] opacity-80">({allPeople.length})</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('no_shows')}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-lg px-3 py-1 text-xs font-medium transition-colors',
            activeTab === 'no_shows'
              ? 'bg-destructive text-destructive-foreground font-semibold shadow-xs'
              : 'text-muted-foreground hover:bg-destructive/10 hover:text-destructive',
          )}
        >
          <AlertTriangle className="h-3 w-3" />
          <span>High No-Shows</span>
          {noShowPeopleCount > 0 && (
            <span className="rounded-full bg-destructive-foreground/20 px-1.5 text-[10px] font-bold">
              {noShowPeopleCount}
            </span>
          )}
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('frequent')}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-lg px-3 py-1 text-xs font-medium transition-colors',
            activeTab === 'frequent'
              ? 'bg-amber-600 text-white font-semibold shadow-xs'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
        >
          <Trophy className="h-3 w-3" />
          <span>Top Consumers</span>
        </button>
      </div>

      {/* ── Content Matrix ── */}
      {loading || !view ? (
        <TableSkeleton rows={6} cols={7} className="mt-3" />
      ) : view.people.length === 0 ? (
        <EmptyState icon={Users} title={t.noBookingsMonth} className="py-12" />
      ) : rows.length === 0 ? (
        <EmptyState icon={Search} title={t.noMatchingEmployees} className="py-12" />
      ) : (
        <div className="mt-2 overflow-x-auto">
          <Table className="min-w-[620px] lg:min-w-[780px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="font-bold text-xs uppercase text-muted-foreground">{t.nameWord}</TableHead>
                <TableHead className="hidden lg:table-cell font-bold text-xs uppercase text-muted-foreground">{t.chamaryLabel}</TableHead>
                {served.map(m => (
                  <TableHead key={m} className="text-right font-bold text-xs uppercase text-muted-foreground">
                    {mealName[m]}
                  </TableHead>
                ))}
                <TableHead className="text-right font-bold text-xs uppercase text-muted-foreground">{t.totalWord}</TableHead>
                <TableHead className="text-right font-bold text-xs uppercase text-muted-foreground">{t.collectedWord}</TableHead>
                <TableHead className="text-right font-bold text-xs uppercase text-muted-foreground">{t.noShowsLabel}</TableHead>
                <TableHead className="text-right font-bold text-xs uppercase text-muted-foreground">{t.daysWord}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map(p => {
                const rate = p.total > 0 ? Math.round((p.served / p.total) * 100) : 0;
                return (
                  <TableRow key={p.epf} className="transition-colors hover:bg-muted/30">
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-bold text-muted-foreground">
                          {p.name.slice(0, 1).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-baseline gap-x-2">
                            <span className="font-semibold text-foreground text-xs sm:text-sm">{p.name}</span>
                            <span className="text-[11px] tabular-nums text-muted-foreground font-mono">{p.epf}</span>
                          </div>
                          {p.company_name && (
                            <span className="block truncate text-[10px] text-muted-foreground/80">
                              {p.company_name}
                            </span>
                          )}
                          {p.chamaries.length > 0 && (
                            <span className="block truncate text-[10px] text-muted-foreground lg:hidden" title={p.chamaries.join(' · ')}>
                              {p.chamaries.join(' · ')}
                            </span>
                          )}
                        </div>
                      </div>
                    </TableCell>

                    <TableCell className="hidden lg:table-cell text-xs">
                      <span className="block max-w-[190px] truncate text-muted-foreground" title={p.chamaries.join(' · ')}>
                        {p.chamaries.length > 0 ? p.chamaries.join(' · ') : '–'}
                      </span>
                    </TableCell>

                    {served.map(m => (
                      <TableCell key={m} className="text-right tabular-nums text-xs text-muted-foreground">
                        {p.byMeal[m] > 0 ? (
                          <span className="font-medium text-foreground">{p.byMeal[m]}</span>
                        ) : '–'}
                      </TableCell>
                    ))}

                    <TableCell className="text-right font-bold tabular-nums text-foreground text-sm">
                      {p.total}
                    </TableCell>

                    <TableCell className="text-right tabular-nums text-xs">
                      <div className="flex items-center justify-end gap-1.5">
                        <span className="font-semibold text-emerald-600 dark:text-emerald-400">{p.served}</span>
                        <span className="text-[10px] text-muted-foreground">({rate}%)</span>
                      </div>
                    </TableCell>

                    <TableCell className="text-right tabular-nums text-xs">
                      {p.noShows > 0 ? (
                        <span className="inline-flex items-center rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-bold text-destructive">
                          {p.noShows}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">0</span>
                      )}
                    </TableCell>

                    <TableCell className="text-right tabular-nums text-xs font-medium text-muted-foreground">
                      {p.days}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>

            {totals && (
              <TableFooter>
                <TableRow className="border-t-2 border-border/70 font-bold bg-muted/40">
                  <TableCell className="text-xs text-foreground font-bold">
                    {t.thisMonth} · {totals.people} {t.peopleWord}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell" />
                  {served.map(m => (
                    <TableCell key={m} className="text-right tabular-nums text-xs font-bold text-foreground">
                      {totals.byMeal[m]}
                    </TableCell>
                  ))}
                  <TableCell className="text-right font-black tabular-nums text-foreground text-sm">
                    {totals.meals}
                  </TableCell>
                  <TableCell className="text-right font-bold tabular-nums text-emerald-600 dark:text-emerald-400 text-xs">
                    {totals.served}
                  </TableCell>
                  <TableCell className={cn('text-right tabular-nums text-xs font-bold', totals.noShows > 0 ? 'text-destructive' : 'text-muted-foreground')}>
                    {totals.noShows}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-xs font-bold text-foreground">
                    {totals.activeDays}
                  </TableCell>
                </TableRow>
              </TableFooter>
            )}
          </Table>
        </div>
      )}

      {/* Pagination / Expand Button */}
      {rows.length > PAGE && (
        <div className="mt-4 flex justify-center border-t border-border/30 pt-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="text-xs font-medium"
            onClick={() => setShowAll(v => !v)}
          >
            {showAll ? t.showFewerWord : `${t.showAllWord} (${rows.length})`}
          </Button>
        </div>
      )}
    </Card>
  );
}
