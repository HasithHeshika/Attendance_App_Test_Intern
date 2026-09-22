'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Check, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useT } from '@/store/appStore';
import { MEAL_TYPES, mealOf, type MealType } from '@/lib/meals';
import type { LunchRequest } from '@/lib/types';
import { getChamaryMealsForDay } from '@/services/mealService';
import type { ChamaryWithPlace } from '@/services/workingPlaceService';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/Skeleton';
import { prettyDateShort } from '@/components/chamary/chamaryFormat';
import { MEAL_ACCENT } from './foodFormat';

interface Props {
  /** The day the page has selected — the calendar drives this card too, so there is one date
   *  control on the page instead of two that can disagree. */
  date:      string;
  chamaries: ChamaryWithPlace[];
}

// Who else is down for a meal on the selected day, for whoever answers for the food spend.
//
// One read per chamary per day, so the day is CACHED for the life of the page: clicking around
// the calendar is a normal thing to do and this backend is shared by 300+ people. The cache is
// per (scope, date) and capped, because the scope changes when the visible chamary list does.
const CACHE_MAX = 40;

export default function WhoIsEatingCard({ date, chamaries }: Props) {
  const t = useT();
  const [rows, setRows]     = useState<LunchRequest[] | null>(null);
  const [failed, setFailed] = useState(false);
  const cache = useRef(new Map<string, LunchRequest[]>());

  const idsKey = chamaries.map(c => c.id).sort().join(',');

  const load = useCallback(async (force = false) => {
    if (!idsKey || !date) { setRows([]); return; }
    const key = `${idsKey}|${date}`;
    if (!force) {
      const hit = cache.current.get(key);
      if (hit) { setRows(hit); setFailed(false); return; }
    }
    setRows(null);
    setFailed(false);
    try {
      const lists = await Promise.all(idsKey.split(',').map(id => getChamaryMealsForDay(id, date)));
      const flat  = lists.flat();
      if (cache.current.size >= CACHE_MAX) cache.current.clear();
      cache.current.set(key, flat);
      setRows(flat);
    } catch {
      setRows(null);
      setFailed(true);
    }
  }, [idsKey, date]);

  useEffect(() => { void load(); }, [load]);

  const mealName: Record<MealType, string> = {
    breakfast: t.mealBreakfast, lunch: t.mealLunch, dinner: t.mealDinner,
  };

  const scopeLine = chamaries.length === 1
    ? chamaries[0].name
    : t.foodChamaryCountTpl.replace('{count}', String(chamaries.length));

  return (
    <Card className="p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-border/40 pb-3">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-primary" aria-hidden />
          <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
            {t.foodWhoEatingTitle}
          </span>
          {rows && rows.length > 0 && (
            <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-primary">
              {rows.length}
            </span>
          )}
        </div>
        <span className="text-[11px] text-muted-foreground">
          {prettyDateShort(date)} · {scopeLine}
        </span>
      </div>

      {failed ? (
        <div className="flex flex-col items-start gap-2 py-3">
          <p className="inline-flex items-center gap-1.5 text-sm text-warn-strong">
            <AlertCircle className="h-4 w-4 shrink-0" aria-hidden />
            {t.foodLoadFailed}
          </p>
          <Button size="sm" variant="outline" onClick={() => void load(true)}>{t.tryAgain}</Button>
        </div>
      ) : rows === null ? (
        <div className="space-y-3" aria-busy="true">
          {[0, 1].map(i => (
            <div key={i} className="space-y-1.5">
              <Skeleton className="h-3 w-24" />
              <div className="flex flex-wrap gap-1.5">
                {[0, 1, 2, 3].map(j => <Skeleton key={j} className="h-7 w-24 rounded-lg" />)}
              </div>
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="py-3 text-sm text-muted-foreground">{t.noOneRequestedYet}</p>
      ) : (
        <div className="space-y-4">
          {MEAL_TYPES.map(meal => {
            const forMeal = rows
              .filter(r => mealOf(r.meal) === meal)
              .sort((a, b) => a.employee_name.localeCompare(b.employee_name));
            if (!forMeal.length) return null;
            const accent = MEAL_ACCENT[meal];
            const done   = forMeal.filter(r => r.served === true).length;

            return (
              <div key={meal}>
                <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className={cn('h-2 w-2 rounded-full', accent.dot)} aria-hidden />
                  <span className={cn('text-xs font-semibold', accent.text)}>{mealName[meal]}</span>
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-muted-foreground">
                    {forMeal.length}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {done} {t.collectedWord.toLowerCase()}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {forMeal.map(r => (
                    // Collected is marked with a tick and extra weight, not a hue — success and
                    // primary are the same azure here, so colour alone would say nothing.
                    <span
                      key={`${r.epf_number}__${mealOf(r.meal)}__${r.chamary_id}`}
                      className={cn(
                        'inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs',
                        r.served === true
                          ? 'border-success/40 bg-success/10 font-semibold text-foreground'
                          : 'border-dashed border-border bg-muted/30 text-muted-foreground',
                      )}
                    >
                      {r.served === true && <Check className="h-3 w-3 shrink-0 text-success" aria-hidden />}
                      {r.employee_name}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
