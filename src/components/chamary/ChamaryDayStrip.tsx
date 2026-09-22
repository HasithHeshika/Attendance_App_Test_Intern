'use client';
import { useEffect, useMemo, useRef } from 'react';
import { cn } from '@/lib/utils';
import { useT } from '@/store/appStore';
import { dayKey, daysInMonth, type ChamaryMonthView } from '@/lib/chamaryMonth';

// The month as a single scrollable row of days, for a screen whose job is one day at a time.
//
// The grid is still there behind a toggle — it answers "how did the month go", which is a real
// question, just not the one someone standing in a canteen at noon is asking. They want today,
// yesterday if they forgot to mark it, and tomorrow's count. A row gives them that in one reach
// on a phone, where the 7-column grid costs most of a screen to say the same thing.

interface Props {
  view:     ChamaryMonthView | null;
  loading:  boolean;
  year:     number;
  month:    number;
  selected: string;
  today:    string;
  onSelect: (date: string) => void;
}

/** One letter per weekday, indexed by JS getDay() — Sunday first, as getDay() counts. */
const WEEKDAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

export default function ChamaryDayStrip({ view: incoming, loading, year, month, selected, today, onSelect }: Props) {
  const t = useT();
  const scroller = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);

  // Same guard the grid needs, for the same reason: this component is told the month twice — by
  // year/month and by `view` — and on the first render after a month change they disagree, so
  // every lookup into the previous month's byDate comes back undefined.
  const view = incoming && incoming.year === year && incoming.month === month ? incoming : null;

  const n = daysInMonth(year, month);
  const days = useMemo(() => Array.from({ length: n }, (_, i) => i + 1), [n]);

  // Keep the chosen day in sight. Changing month lands on the 1st or on today, and either way
  // the strip must not open scrolled to the wrong end of itself.
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }, [selected, year, month]);

  const max = useMemo(() => (view ? view.days.reduce((m, d) => Math.max(m, d.total), 0) : 0), [view]);

  return (
    <div
      ref={scroller}
      role="group"
      aria-label={t.calendarWord}
      className="flex snap-x gap-1.5 overflow-x-auto scrollbar-thin pb-1"
    >
      {days.map(dn => {
        const date = dayKey(year, month, dn);
        const day  = view?.byDate[date] ?? null;
        const isSel    = date === selected;
        const isToday  = date === today;
        const isFuture = date > today;
        const total    = day?.total ?? 0;
        const allOff   = !!day && day.off.length > 0 && total === 0;
        const done     = !!day && total > 0 && day.served >= total;
        // The weekday from a real local date rather than an offset calculation, so the strip and
        // the grid can never disagree about which column a day belongs to.
        const letter = WEEKDAY_LETTERS[new Date(year, month - 1, dn).getDay()];

        return (
          <button
            key={date}
            ref={isSel ? selectedRef : undefined}
            type="button"
            onClick={() => onSelect(date)}
            aria-pressed={isSel}
            aria-label={`${date}${total ? `, ${total} ${t.mealsWord}` : ''}`}
            className={cn(
              'group flex min-w-[3.25rem] shrink-0 snap-center flex-col items-center gap-0.5 rounded-xl border px-2 py-2 transition-all',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              isSel
                ? 'border-primary bg-primary text-primary-foreground shadow-sm'
                : 'border-border/80 bg-card hover:border-border hover:bg-accent/70',
              // Today is marked even when it is not the chosen day — it is the anchor a person
              // navigates from, and it has to stay findable in a row of 31.
              !isSel && isToday && 'border-primary/60 ring-1 ring-primary/30',
              !isSel && isFuture && 'opacity-70',
            )}
          >
            <span className={cn('text-[10px] font-medium uppercase', isSel ? 'opacity-80' : 'text-muted-foreground')}>
              {letter}
            </span>
            <span className="text-sm font-bold leading-none tabular-nums">{dn}</span>

            {/* One glyph, four states: still loading, kitchen closed, booked (bar width = how
                busy, filled green once everything is collected), nothing booked. A number would
                be unreadable at this size and the day panel is one tap away for the detail. */}
            {loading && !view ? (
              <span className="mt-0.5 h-1.5 w-6 animate-pulse rounded-full bg-muted" />
            ) : allOff ? (
              <span className={cn('mt-0.5 text-[9px] font-semibold uppercase', isSel ? 'opacity-90' : 'text-warning')}>
                {t.chamaryOffShort}
              </span>
            ) : total > 0 ? (
              <span
                className={cn(
                  'mt-0.5 h-1.5 rounded-full transition-all',
                  isSel ? 'bg-primary-foreground/70' : done ? 'bg-emerald-500' : 'bg-primary/60',
                )}
                // Width carries how busy the day was relative to the busiest one. Shape, not hue:
                // --success and --primary resolve to the same azure in this palette, so an
                // explicit emerald marks "all collected" and width alone carries volume.
                style={{ width: `${Math.max(24, Math.round((total / Math.max(max, 1)) * 100))}%` }}
                aria-hidden
              />
            ) : (
              <span className="mt-0.5 h-1.5 w-1.5 rounded-full bg-border" aria-hidden />
            )}
          </button>
        );
      })}
    </div>
  );
}
