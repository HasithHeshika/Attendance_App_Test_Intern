'use client';
import { CalendarOff, Loader2, CookingPot, Clock, AlertTriangle } from 'lucide-react';
import { useT } from '@/store/appStore';
import type { MealType } from '@/lib/meals';
import { Button } from '@/components/ui/button';
import { prettyDateRange, type ClosureRun } from './chamaryFormat';

interface Props {
  runs:    ClosureRun[];
  /** Which run is being reopened, as `chamaryId:from:to`; null when idle. */
  busyKey: string | null;
  onReopen: (run: ClosureRun) => void;
}

export default function ChamaryClosures({ runs, busyKey, onReopen }: Props) {
  const t = useT();
  const mealName: Record<MealType, string> = {
    breakfast: t.mealBreakfast, lunch: t.mealLunch, dinner: t.mealDinner,
  };
  if (runs.length === 0) return null;

  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3.5 sm:p-4 space-y-3">
      <div className="flex items-center justify-between gap-2 border-b border-amber-500/20 pb-2.5">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-amber-500/20 text-amber-600 dark:text-amber-400">
            <CalendarOff className="h-3.5 w-3.5" aria-hidden />
          </span>
          <div>
            <span className="text-xs font-bold uppercase tracking-wider text-amber-800 dark:text-amber-200">
              Kitchen Closures & Disruptions
            </span>
          </div>
        </div>
        <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-bold text-amber-800 dark:text-amber-200">
          {runs.length} active
        </span>
      </div>

      <ul className="space-y-2.5">
        {runs.map(run => {
          const key = `${run.chamaryId}:${run.from}:${run.to}`;
          const isBusy = busyKey === key;

          return (
            <li
              key={key}
              className="rounded-lg border border-amber-500/20 bg-background/60 p-3 transition-colors hover:bg-background/90"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5 text-xs font-semibold text-foreground">
                    <span>{run.chamaryName || t.chamaryLabel}</span>
                    <span className="text-muted-foreground font-normal">·</span>
                    <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                      <Clock className="h-3 w-3" />
                      {prettyDateRange(run.from, run.to)}
                      {run.days > 1 && ` (${run.days} ${t.daysWord})`}
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                    <span>Affected meals:</span>
                    {run.meals.map(m => (
                      <span key={m} className="rounded bg-muted/80 px-1.5 py-0.5 text-[10px] font-medium text-foreground">
                        {mealName[m]}
                      </span>
                    ))}
                  </div>

                  {run.reason && (
                    <p className="mt-1 text-xs italic text-muted-foreground border-l-2 border-amber-500/40 pl-2">
                      &ldquo;{run.reason}&rdquo;
                    </p>
                  )}
                </div>

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1.5 border-amber-500/30 text-xs font-medium text-amber-800 dark:text-amber-200 hover:bg-amber-500/10"
                  disabled={isBusy}
                  onClick={() => onReopen(run)}
                >
                  {isBusy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  ) : (
                    <CookingPot className="h-3.5 w-3.5 text-emerald-500" aria-hidden />
                  )}
                  <span>Reopen Kitchen</span>
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
