'use client';
import {
  AlertCircle, Calendar as CalendarIcon, Check, ChevronLeft, ChevronRight, Clock,
  Loader2, Pencil, UtensilsCrossed, X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useT } from '@/store/appStore';
import { mealOf, type MealType } from '@/lib/meals';
import type { LunchRequest, MealChangeRequest } from '@/lib/types';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { dayPhase, prettyDate } from '@/components/chamary/chamaryFormat';
import MultiplierBadge from './MultiplierBadge';
import { MEAL_ACCENT, bookingKey, bookingState, shiftDate, sortMeals } from './foodFormat';

interface Props {
  date:     string;
  today:    string;
  loading:  boolean;
  /** This person's bookings on `date`. */
  rows:     LunchRequest[];
  /** Their change requests, any day — the panel picks out the one matching each booking. */
  changes:  MealChangeRequest[];
  busyKey:  string | null;
  onCancel: (row: LunchRequest) => void;
  /** The person's own statement that they did not take a meal recorded as collected. */
  onNotTaken: (row: LunchRequest, notTaken: boolean) => void;
  onRequestChange: (row: LunchRequest) => void;
  onSelectDate: (date: string) => void;
}

// One day of a person's own meals, and the only two things they can do about them.
//
// The rules are not symmetric and the panel has to show why: TODAY's untouched booking can be
// cancelled outright, because nothing has been cooked on the strength of it yet. A PAST one
// cannot — the kitchen cooked and was billed, and the deduction is that chamary's spend split
// across every booking, so quietly deleting yesterday's meal pushes its cost onto everyone
// else who ate. That is what the change request is for (see mealChangeService). A day still
// ahead is simply booked; it is cancelled on the day.
export default function MealDayPanel({
  date, today, loading, rows, changes, busyKey, onCancel, onNotTaken, onRequestChange, onSelectDate,
}: Props) {
  const t = useT();
  const mealName: Record<MealType, string> = {
    breakfast: t.mealBreakfast, lunch: t.mealLunch, dinner: t.mealDinner,
  };

  const phase   = dayPhase(date, today);
  const isToday = phase === 'today';
  const meals   = sortMeals(rows);
  const served  = meals.filter(r => r.served === true).length;

  const pendingFor = (row: LunchRequest) => changes.find(c =>
    c.date === row.date && mealOf(c.meal) === mealOf(row.meal) && c.status === 'pending') ?? null;

  return (
    <Card className="overflow-hidden border-border/80 shadow-sm">
      {/* ── Header: which day, how it went, and how to walk to the next one ── */}
      <div className="border-b border-border/60 bg-muted/20 px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex min-w-0 items-center gap-2">
            {isToday ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />
                {t.todayWord}
              </span>
            ) : phase === 'future' ? (
              <Badge variant="outline" className="gap-1 py-0.5 text-[11px] font-semibold">
                <CalendarIcon className="h-3 w-3" aria-hidden />
                {t.foodAheadWord}
              </Badge>
            ) : (
              <Badge variant="muted" className="py-0.5 text-[11px] font-medium">{t.foodPastWord}</Badge>
            )}
            <span className="truncate text-sm font-semibold text-foreground">{prettyDate(date)}</span>
          </div>

          <div className="flex items-center gap-1">
            <Button
              type="button" variant="outline" size="icon-sm"
              aria-label={t.foodPrevDayLabel} title={t.foodPrevDayLabel}
              onClick={() => onSelectDate(shiftDate(date, -1))}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            {!isToday && (
              <Button type="button" variant="outline" size="sm" className="h-8" onClick={() => onSelectDate(today)}>
                {t.todayWord}
              </Button>
            )}
            <Button
              type="button" variant="outline" size="icon-sm"
              aria-label={t.foodNextDayLabel} title={t.foodNextDayLabel}
              onClick={() => onSelectDate(shiftDate(date, 1))}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {!loading && meals.length > 0 && (
          <p className="mt-2 text-[11px] text-muted-foreground">
            {meals.length} {t.mealsWord.toLowerCase()} · {served} {t.collectedWord.toLowerCase()}
          </p>
        )}
      </div>

      {/* ── The day itself ── */}
      {loading ? (
        <div className="space-y-2 p-4 sm:p-5" aria-busy="true">
          {[0, 1].map(i => (
            <div key={i} className="flex items-center gap-3 rounded-xl border border-border/60 p-3">
              <Skeleton className="h-9 w-9 rounded-lg" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3.5 w-1/3" />
                <Skeleton className="h-3 w-2/3" />
              </div>
              <Skeleton className="h-8 w-20 rounded-md" />
            </div>
          ))}
        </div>
      ) : meals.length === 0 ? (
        <EmptyState
          icon={UtensilsCrossed}
          title={phase === 'past' ? t.foodDayNoMealsPast : t.foodDayNoMealsAhead}
          description={phase === 'past' ? undefined : t.foodBookFromDashboard}
          className="py-10"
        />
      ) : (
        <div className="divide-y divide-border/60">
          {meals.map(row => {
            const meal    = mealOf(row.meal);
            const accent  = MEAL_ACCENT[meal];
            const state   = bookingState(row, today);
            const key     = bookingKey(row);
            const pending = pendingFor(row);
            const isBusy  = busyKey === key;

            return (
              <div key={key} className="flex items-start gap-3 px-4 py-3 sm:px-5">
                <span className={cn('mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg', accent.fill)}>
                  <UtensilsCrossed className={cn('h-4 w-4', accent.text)} aria-hidden />
                </span>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className={cn('text-sm font-semibold', accent.text)}>{mealName[meal]}</span>
                    <span className="truncate text-sm text-foreground">{row.chamary_name}</span>
                    {/* Charged at something other than the normal rate. On the row that charges
                        them, with the reason — nobody should have to decompose a month's total
                        to find out why it is higher than they expected. */}
                    <MultiplierBadge row={row} detail />
                  </div>
                  {row.working_place_name && (
                    <p className="truncate text-[11px] text-muted-foreground">{row.working_place_name}</p>
                  )}
                  <p className={cn(
                    'mt-1 inline-flex items-center gap-1 text-[11px]',
                    state === 'collected' ? 'font-semibold text-foreground'
                      : state === 'missed' ? 'font-semibold text-warn-strong'
                        : 'text-muted-foreground',
                  )}>
                    {state === 'collected' ? <Check className="h-3 w-3" aria-hidden />
                      : state === 'missed' ? <AlertCircle className="h-3 w-3" aria-hidden />
                        : <Clock className="h-3 w-3" aria-hidden />}
                    {state === 'collected' ? t.collectedWord
                      : state === 'missed' ? t.foodNotCollectedLabel
                        : t.foodNotCollectedYet}
                  </p>
                </div>

                <div className="shrink-0">
                  {pending ? (
                    <Badge variant="warning">{t.foodWaitingWord}</Badge>
                  ) : isToday && row.served !== true ? (
                    <Button size="sm" variant="outline" disabled={isBusy} onClick={() => onCancel(row)}>
                      {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
                      {t.cancelMealWord}
                    </Button>
                  ) : phase === 'past' ? (
                    <Button size="sm" variant="ghost" onClick={() => onRequestChange(row)}>
                      <Pencil className="h-3.5 w-3.5" />
                      {t.foodChangeWord}
                    </Button>
                  ) : phase === 'future' ? (
                    <Badge variant="muted">{t.bookedWord}</Badge>
                  ) : isToday && state === 'missed' && row.served_source === 'employee' ? (
                    /* They already said they did not take it. Let them take it back — a
                       mis-tap must not need an approval request to undo. */
                    <Button size="sm" variant="ghost" disabled={isBusy} onClick={() => onNotTaken(row, false)}>
                      {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                      {t.foodTookItAfterAll}
                    </Button>
                  ) : isToday ? (
                    /* Today, already recorded as collected. This is the branch that used to
                       render nothing at all: auto-serve ticks the meal when its window closes,
                       and the cancel button above is gated on `served !== true`, so from noon
                       a person who never collected their lunch had no way to say so and was
                       pushed into the approval-based change-request flow to correct a fact
                       about their own day. */
                    <Button size="sm" variant="outline" disabled={isBusy} onClick={() => onNotTaken(row, true)}>
                      {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
                      {t.foodDidNotTakeIt}
                    </Button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
