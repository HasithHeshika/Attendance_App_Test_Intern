'use client';
import { useMemo } from 'react';
import { AlertTriangle, Calendar as CalendarIcon, Flame } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useT } from '@/store/appStore';
import type { MealType } from '@/lib/meals';
import { dayKey, daysInMonth, mealsWithActivity, type ChamaryMonthView } from '@/lib/chamaryMonth';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/Skeleton';
import { mealInitial, prettyDate, prettyDateShort } from './chamaryFormat';

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']; // week starts Monday

/**
 * How busy a day was, as a tint. The old buckets topped out at 4 % alpha for a quiet day and 22 %
 * for the busiest — under 1.1:1 against --card, which is to say invisible, while the legend
 * advertised a swatch nobody could match to a cell.
 *
 * The top bucket now clears roughly 3:1 against --card in the dark theme (the default). In light
 * it cannot: even a SOLID --primary is only ~4:1 on white, so a translucent tint has nowhere to
 * go. The tint is therefore density, not state — the state that has to survive greyscale is the
 * bold `text-foreground` count in the cell, which is what anyone actually reads.
 *
 * LEGEND_BOOKED_FILL is the same top bucket. Keep them together or the legend starts lying again.
 */
const LEGEND_BOOKED_FILL = 'bg-primary/[0.55] border-primary/50';

function fillFor(total: number, max: number): string {
  if (total <= 0 || max <= 0) return '';
  const r = total / max;
  if (r <= 0.25) return 'bg-primary/[0.12] border-primary/20';
  if (r <= 0.5)  return 'bg-primary/[0.24] border-primary/30';
  if (r <= 0.75) return 'bg-primary/[0.38] border-primary/40';
  return `${LEGEND_BOOKED_FILL} font-semibold`;
}

interface Props {
  view:     ChamaryMonthView | null;
  loading:  boolean;
  /** Meals at least one chamary in scope serves — decides what "every meal off" means. */
  served:   MealType[];
  year:     number;
  month:    number;
  selected: string;
  today:    string;
  onSelect: (date: string) => void;
  /** The month could not be read. Skeletons would promise numbers that are not coming, and an
   *  empty grid would state as fact that nobody booked anything. */
  failed?:  boolean;
}

export default function ChamaryCalendar({
  view: incoming, loading, served, year, month, selected, today, onSelect, failed = false,
}: Props) {
  const t = useT();

  // This component is told the month TWICE — once by year/month, once inside `view` — and on the
  // first render after a month change those two disagree: the grid already builds the new
  // month's cells while `view` is still the previous month's, because the page's refetch effect
  // (which flips `loading`) only runs after the render. Indexing the new month's dates into the
  // old month's byDate returned undefined for every one of them and the page died on the first
  // cell reading `day.byMeal` — most visibly stepping from a 28-day month to a 31-day one.
  //
  // A view built for a different month is therefore no view at all: the grid shows the loading
  // skeletons it already has for that single frame.
  const view = incoming && incoming.year === year && incoming.month === month ? incoming : null;

  // Monday-first: shift JS getDay() (0=Sun) so Mon→0 … Sun→6.
  const leadBlanks = (new Date(year, month - 1, 1).getDay() + 6) % 7;
  const n = daysInMonth(year, month);
  const cells = useMemo<(number | null)[]>(() => [
    ...Array.from({ length: leadBlanks }, () => null),
    ...Array.from({ length: n }, (_, i) => i + 1),
  ], [leadBlanks, n]);

  const max = useMemo(() => (view ? view.days.reduce((m, d) => Math.max(m, d.total), 0) : 0), [view]);
  const busiest = view?.totals.busiest ?? null;

  return (
    <Card className="overflow-hidden border-border/80 bg-card p-4 shadow-sm sm:p-5">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between gap-2 border-b border-border/40 pb-3">
        <div className="flex items-center gap-2">
          <CalendarIcon className="h-4 w-4 text-primary" />
          <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{t.calendarWord}</span>
        </div>
        {view && !failed && view.totals.activeDays > 0 && (
          <span className="inline-flex items-center rounded-full bg-primary/10 px-2.5 py-0.5 text-[11px] font-semibold tabular-nums text-primary">
            {view.totals.activeDays} {t.activeDaysLabel.toLowerCase()}
          </span>
        )}
      </div>

      {/* Weekday columns */}
      <div className="mb-1.5 grid grid-cols-7 gap-1">
        {WEEKDAYS.map((w, i) => (
          <div key={i} className="text-center text-[10px] font-bold text-muted-foreground/70">
            {w}
          </div>
        ))}
      </div>

      {/* Grid */}
      {failed && !loading ? (
        <div className="rounded-lg border border-dashed border-destructive/40 bg-destructive/5 px-3 py-8 text-center text-xs text-foreground">
          <AlertTriangle className="mx-auto mb-1.5 h-4 w-4 text-destructive" aria-hidden />
          {t.chamaryMonthLoadFailed}
        </div>
      ) : loading || !view ? (
        <div className="grid grid-cols-7 gap-1" aria-busy="true">
          {cells.map((d, i) => (d === null
            ? <div key={i} />
            : <Skeleton key={i} className="min-h-[60px] rounded-lg sm:min-h-[72px]" />))}
        </div>
      ) : (
        <div className="grid grid-cols-7 gap-1">
          {cells.map((dn, i) => {
            if (dn === null) return <div key={i} />;
            const date     = dayKey(year, month, dn);
            const d        = view.byDate[date];
            // buildChamaryMonth fills every day of the month it was asked for, and the guard
            // above makes sure this view IS that month — so a miss here means the data itself is
            // malformed. An empty cell is the right answer to that; a dead page is not.
            if (!d) return <div key={i} />;
            const isToday  = date === today;
            const isSel    = date === selected;
            const isFuture = date > today;
            const active   = mealsWithActivity(d, served);
            const allOff   = served.length > 0 && served.every(m => d.off.includes(m));

            return (
              <button
                key={i}
                type="button"
                onClick={() => onSelect(date)}
                aria-pressed={isSel}
                aria-label={`${prettyDate(date)}, ${d.total} ${t.mealsWord}`}
                className={cn(
                  'group relative flex min-h-[60px] flex-col items-stretch rounded-lg border p-1 text-left transition-all sm:min-h-[72px] sm:p-1.5',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  allOff
                    ? 'border-dashed border-border/80 bg-muted/20 opacity-70 hover:opacity-100 hover:bg-muted/40'
                    // A day with nothing booked keeps a full-strength border. At /40 it was about
                    // 1.05:1 against --card, so "nobody booked" and "this page is broken" were the
                    // same picture — which is exactly how a whole blank month went unquestioned.
                    : cn('border-border/70 hover:border-border hover:bg-accent/60', fillFor(d.total, max)),
                  isSel
                    ? 'ring-2 ring-primary border-primary bg-primary/15 shadow-xs font-medium z-10'
                    : isToday
                      // ring-1.5 is not a Tailwind width (ringWidth stops at 1, 2, 4, 8) so this
                      // generated no CSS and today has never actually had its ring. The emerald
                      // background went with it: twMerge used it to strip the density tint, so the
                      // busiest day of the month lost its fill precisely when it was today.
                      ? 'ring-2 ring-emerald-500/70 border-emerald-500/40'
                      : '',
                )}
              >
                {/* Day number top row */}
                <div className="flex items-center justify-between">
                  <span className={cn(
                    'text-[10px] leading-none tabular-nums',
                    isToday ? 'font-black text-emerald-600 dark:text-emerald-400' : 'font-semibold text-muted-foreground',
                  )}>
                    {dn}
                  </span>
                  {isToday && (
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" title="Today" />
                  )}
                </div>

                {/* Total count, or the resting state. A day still ahead dims the FIGURE rather
                    than the whole cell — fading the border too is what made a future week read as
                    absent instead of simply not booked yet. */}
                {d.total > 0 ? (
                  <span className={cn(
                    'mt-1 text-sm font-black leading-none tabular-nums',
                    isFuture ? 'text-muted-foreground' : 'text-foreground',
                  )}>
                    {d.total}
                  </span>
                ) : !allOff ? (
                  <span className="mt-1 text-sm font-black leading-none text-muted-foreground/60" aria-hidden>
                    ·
                  </span>
                ) : null}

                {/* Bottom meal indicators */}
                {allOff ? (
                  <span className="mt-auto pt-0.5 text-[9px] font-medium leading-tight text-muted-foreground">
                    {t.nothingCookedDay}
                  </span>
                ) : active.length > 0 ? (
                  <div className={cn(
                    'mt-auto flex flex-wrap gap-x-1 gap-y-0.5 pt-1 text-[9px] tabular-nums',
                    isFuture && 'opacity-75',
                  )}>
                    {active.map(m => {
                      const isOff = d.off.includes(m);
                      const color = m === 'breakfast'
                        ? 'text-amber-600 dark:text-amber-400'
                        : m === 'lunch'
                          ? 'text-orange-600 dark:text-orange-400'
                          : 'text-indigo-600 dark:text-indigo-400';

                      return isOff ? (
                        <span
                          key={m}
                          className="rounded border border-dashed border-muted-foreground/50 px-0.5 text-muted-foreground line-through"
                          title={d.offReason[m] || undefined}
                        >
                          {mealInitial(m)}
                        </span>
                      ) : (
                        <span key={m} className={cn('font-semibold', color)}>
                          {mealInitial(m)}<span className="font-normal text-muted-foreground">{d.byMeal[m]}</span>
                        </span>
                      );
                    })}
                  </div>
                ) : null}
              </button>
            );
          })}
        </div>
      )}

      {/* Legend. Every swatch is built from the SAME classes the grid uses, and the majority state
          — a day nobody booked — is in it now. It was the one state the grid spends most of the
          month in and the only one the legend never named. */}
      {!failed && (
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-border/40 pt-3 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className={cn('h-2.5 w-2.5 rounded border', LEGEND_BOOKED_FILL)} />
            {t.legendBooked}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded border border-border/70" />
            {t.legendNoBookings}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="rounded border border-dashed border-muted-foreground/60 px-1 text-[9px] font-medium line-through">L</span>
            {t.legendPartlyOff}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded border border-dashed border-border bg-muted/40" />
            {t.legendOff}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded border-2 border-emerald-500/70" />
            {t.legendToday}
          </span>
        </div>
      )}

      {/* Busiest day highlight card */}
      {busiest && !failed && (
        <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs text-muted-foreground">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 font-medium text-amber-700 dark:text-amber-300">
              <Flame className="h-3.5 w-3.5 text-amber-500" />
              <span>{t.busiestDayLabel}:</span>
            </span>
            <button
              type="button"
              onClick={() => onSelect(busiest.date)}
              className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-2 py-0.5 text-xs font-bold text-amber-800 dark:text-amber-200 transition-colors hover:bg-amber-500/20"
            >
              <span>{prettyDateShort(busiest.date)}</span>
              <span>·</span>
              <span className="tabular-nums">{busiest.total} {t.mealsWord.toLowerCase()}</span>
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}
