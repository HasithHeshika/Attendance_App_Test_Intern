'use client';
import { UtensilsCrossed } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useT } from '@/store/appStore';
import { MEAL_TYPES, mealOf, type MealType } from '@/lib/meals';
import type { LunchRequest } from '@/lib/types';
import { formatSuspenseAmount } from '@/services/suspenseService';
import { Card } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { MEAL_ACCENT } from './foodFormat';

export interface ChamaryGroup {
  id:   string;
  name: string;
  rows: LunchRequest[];
}

interface Props {
  groups:  ChamaryGroup[];
  /** What this person's meals at each chamary came to, keyed by chamary id — the real split of
   *  that kitchen's bills (see /api/food/my-cost). A chamary with no bills filed for the month
   *  is absent, which is how "not priced yet" stays distinguishable from "cost nothing". */
  charges: Record<string, number>;
  loading: boolean;
}

// Where this person's month went, canteen by canteen. The money sits under the counts rather
// than above them: the count is what the person can check against their own memory, and the
// charge follows from it.
export default function MyChamaryBreakdown({ groups, charges, loading }: Props) {
  const t = useT();
  const mealName: Record<MealType, string> = {
    breakfast: t.mealBreakfast, lunch: t.mealLunch, dinner: t.mealDinner,
  };

  // One canteen is not a breakdown. A progress bar exists to compare, and with a single row
  // there is nothing to compare it against — so the whole card collapses to the one sentence
  // it was trying to say. Most months look like this; the bars are for the months that don't.
  if (!loading && groups.length === 1) {
    const g = groups[0];
    const served = g.rows.filter(r => r.served).length;
    const charge = charges[g.id];
    return (
      <Card className="flex flex-wrap items-center gap-x-2 gap-y-1 p-4 text-sm sm:p-5">
        <UtensilsCrossed className="h-4 w-4 shrink-0 text-primary" aria-hidden />
        <span className="font-semibold text-foreground">{g.name}</span>
        <span className="text-muted-foreground">
          · {g.rows.length} {t.mealsWord.toLowerCase()} · {served}/{g.rows.length} {t.collectedWord.toLowerCase()}
        </span>
        {charge !== undefined && (
          <span className="font-semibold tabular-nums text-foreground">
            · {formatSuspenseAmount(charge, 'LKR')}
          </span>
        )}
      </Card>
    );
  }

  return (
    <Card className="p-4 sm:p-5">
      <div className="mb-3 flex items-center gap-2 border-b border-border/40 pb-3">
        <UtensilsCrossed className="h-4 w-4 text-primary" aria-hidden />
        <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
          {t.foodWhereYouAte}
        </span>
      </div>

      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-busy="true">
          {[0, 1, 2].map(i => (
            <div key={i} className="space-y-2.5 rounded-xl border border-border/60 p-3">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-1.5 w-full rounded-full" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          ))}
        </div>
      ) : groups.length === 0 ? (
        <EmptyState
          icon={UtensilsCrossed}
          title={t.foodNoMealsMonthTitle}
          description={t.foodBookFromDashboard}
          className="py-8"
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {groups.map(g => {
            const total = g.rows.length;
            const done  = g.rows.filter(r => r.served === true).length;
            const pct    = total > 0 ? Math.round((done / total) * 100) : 0;
            // Absent, not zero, when this kitchen has filed no bills for the month — printing
            // LKR 0.00 for a cost nobody has worked out yet is the bug this replaced.
            const charge = charges[g.id];

            return (
              <div key={g.id} className="rounded-xl border border-border/60 bg-card/40 p-3">
                <div className="mb-2 flex items-start justify-between gap-2">
                  <span className="text-sm font-semibold leading-tight text-foreground">{g.name}</span>
                  <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold tabular-nums text-foreground">
                    {total}
                  </span>
                </div>

                <Progress value={pct} className="h-1.5" aria-label={`${t.collectedWord} ${pct}%`} />
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  {done} / {total} {t.collectedWord.toLowerCase()}
                  {charge !== undefined && (
                    <>
                      {' · '}
                      <span className="font-semibold tabular-nums text-foreground">
                        {formatSuspenseAmount(charge, 'LKR')}
                      </span>
                    </>
                  )}
                </p>

                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                  {MEAL_TYPES.map(m => {
                    const n = g.rows.filter(r => mealOf(r.meal) === m).length;
                    if (!n) return null;
                    return (
                      <span key={m} className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                        <span className={cn('h-1.5 w-1.5 rounded-full', MEAL_ACCENT[m].dot)} aria-hidden />
                        <span className="tabular-nums">{n}</span> {mealName[m].toLowerCase()}
                      </span>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
