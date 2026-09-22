'use client';
import { useMemo } from 'react';
import { Calendar as CalendarIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useT } from '@/store/appStore';
import { mealOf, type MealType } from '@/lib/meals';
import { dayKey, daysInMonth } from '@/lib/chamaryMonth';
import type { LunchRequest } from '@/lib/types';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/Skeleton';
import { mealInitial, prettyDate } from '@/components/chamary/chamaryFormat';
import MealChip from './MealChip';
import { MEAL_ACCENT, bookingState, mealsPresent, sortMeals } from './foodFormat';

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']; // Monday-first, as on /chamary

interface Props {
  /** This person's bookings for `monthKey`, keyed by 'YYYY-MM-DD'. */
  mealsByDate: Record<string, LunchRequest[]>;
  /** The month `mealsByDate` was built for ('YYYY-MM'). */
  monthKey: string;
  loading:  boolean;
  year:     number;
  month:    number;
  selected: string;
  today:    string;
  onSelect: (date: string) => void;
}

// The month, from one person's side of the counter.
//
// Deliberately NOT ChamaryCalendar. That one answers "how many people ate here" — a count, a
// heat map and a busiest day — and every one of those numbers is 0-3 for a single person, so
// the map would be noise and the count would say nothing. What an employee needs from their
// own month is per MEAL, not per day: which of breakfast / lunch / dinner they were down for,
// and which of them were actually ticked as collected. That is a chip per meal, and it is the
// one thing a shared component could not show. The DATA is still shared — the page folds the
// same bookings through buildChamaryMonth for its totals.
export default function MyMealCalendar({
  mealsByDate, monthKey, loading, year, month, selected, today, onSelect,
}: Props) {
  const t = useT();

  // The page is told the month twice — by year/month and by the data's own monthKey — and on
  // the first render after a month change they disagree, because the refetch effect has not run
  // yet. Showing the previous month's bookings under this month's dates would be a lie, so a
  // mismatch is treated exactly like "still loading". (ChamaryCalendar guards the same trap.)
  const stale = monthKey !== `${year}-${String(month).padStart(2, '0')}`;
  const busy  = loading || stale;

  const leadBlanks = (new Date(year, month - 1, 1).getDay() + 6) % 7; // Mon→0 … Sun→6
  const n = daysInMonth(year, month);
  const cells = useMemo<(number | null)[]>(() => [
    ...Array.from({ length: leadBlanks }, () => null),
    ...Array.from({ length: n }, (_, i) => i + 1),
  ], [leadBlanks, n]);

  const activeDays = useMemo(
    () => (busy ? 0 : Object.values(mealsByDate).filter(rows => rows.length > 0).length),
    [mealsByDate, busy],
  );

  // Only the meals this person actually books get a key. A lunch-only eater has no use for a
  // breakfast swatch, and the state legend below reads best with a letter they will really see.
  const present = useMemo(
    () => mealsPresent(Object.values(mealsByDate).flat()),
    [mealsByDate],
  );
  const sample: MealType = present[0] ?? 'lunch';
  const mealName: Record<MealType, string> = {
    breakfast: t.mealBreakfast, lunch: t.mealLunch, dinner: t.mealDinner,
  };

  return (
    <Card className="overflow-hidden border-border/80 p-4 shadow-sm sm:p-5">
      <div className="mb-4 flex items-center justify-between gap-2 border-b border-border/40 pb-3">
        <div className="flex items-center gap-2">
          <CalendarIcon className="h-4 w-4 text-primary" aria-hidden />
          <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{t.calendarWord}</span>
        </div>
        {activeDays > 0 && (
          <span className="inline-flex items-center rounded-full bg-primary/10 px-2.5 py-0.5 text-[11px] font-semibold tabular-nums text-primary">
            {activeDays} {t.activeDaysLabel.toLowerCase()}
          </span>
        )}
      </div>

      <div className="mb-1.5 grid grid-cols-7 gap-1">
        {WEEKDAYS.map((w, i) => (
          <div key={i} className="text-center text-[10px] font-bold text-muted-foreground/70">{w}</div>
        ))}
      </div>

      {busy ? (
        <div className="grid grid-cols-7 gap-1" aria-busy="true">
          {cells.map((d, i) => (d === null
            ? <div key={i} />
            : <Skeleton key={i} className="min-h-[58px] rounded-lg sm:min-h-[70px]" />))}
        </div>
      ) : (
        <div className="grid grid-cols-7 gap-1">
          {cells.map((dn, i) => {
            if (dn === null) return <div key={i} />;
            const date    = dayKey(year, month, dn);
            const rows    = sortMeals(mealsByDate[date] ?? []);
            const isToday = date === today;
            const isSel   = date === selected;
            const hasAny  = rows.length > 0;
            const missed  = rows.some(r => bookingState(r, today) === 'missed');

            return (
              <button
                key={i}
                type="button"
                onClick={() => onSelect(date)}
                aria-pressed={isSel}
                aria-label={`${prettyDate(date)} — ${rows.length} ${t.mealsWord.toLowerCase()}`}
                className={cn(
                  'group relative flex min-h-[58px] flex-col items-stretch rounded-lg border p-1 text-left transition-colors sm:min-h-[70px] sm:p-1.5',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  hasAny
                    ? 'border-primary/15 bg-primary/[0.05] hover:border-primary/40 hover:bg-primary/10'
                    : 'border-border/40 hover:border-border hover:bg-accent/60',
                  isSel
                    ? 'z-10 border-primary bg-primary/15 font-medium shadow-xs ring-2 ring-primary'
                    : isToday
                      ? 'border-emerald-500/40 bg-emerald-500/5 ring-1 ring-emerald-500/70'
                      : '',
                )}
              >
                <div className="flex items-center justify-between">
                  <span className={cn(
                    'text-[10px] leading-none tabular-nums',
                    isToday ? 'font-black text-emerald-600 dark:text-emerald-400' : 'font-semibold text-muted-foreground',
                  )}>
                    {dn}
                  </span>
                  {isToday && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />}
                </div>

                {hasAny && (
                  <>
                    <span className="mt-1 text-sm font-black leading-none tabular-nums text-foreground">
                      {rows.length}
                    </span>
                    <div className="mt-auto flex flex-wrap gap-0.5 pt-1">
                      {rows.map(r => (
                        <MealChip
                          key={`${mealOf(r.meal)}__${r.chamary_id}`}
                          meal={mealOf(r.meal)}
                          state={bookingState(r, today)}
                          title={r.chamary_name}
                        />
                      ))}
                    </div>
                  </>
                )}

                {/* A day with a missed meal is worth spotting from across the grid — a corner
                    notch, not another colour, because the palette is already saying "meal". */}
                {missed && (
                  <span
                    aria-hidden
                    className="absolute right-1 top-1 h-1.5 w-1.5 rotate-45 bg-warn-strong/70"
                  />
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Two legends, because the cell says two things at once: the chip's TREATMENT is the
          state, its COLOUR and letter are which meal. */}
      <div className="mt-4 space-y-2 border-t border-border/40 pt-3 text-[11px] text-muted-foreground">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <span className="flex items-center gap-1.5">
            <MealChip meal={sample} state="collected" />
            {t.collectedWord}
          </span>
          <span className="flex items-center gap-1.5">
            <MealChip meal={sample} state="booked" />
            {t.bookedWord}
          </span>
          <span className="flex items-center gap-1.5">
            <MealChip meal={sample} state="missed" />
            {t.foodNotCollectedLabel}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded border border-emerald-500/70 bg-emerald-500/20" aria-hidden />
            {t.legendToday}
          </span>
        </div>
        {present.length > 1 && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            {present.map(m => (
              <span key={m} className="flex items-center gap-1.5">
                <span className={cn('h-2 w-2 rounded-full', MEAL_ACCENT[m].dot)} aria-hidden />
                {mealInitial(m)} · {mealName[m]}
              </span>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
