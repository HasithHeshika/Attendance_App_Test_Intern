'use client';
// "Which days" — a month of suspense spend as a Monday-first calendar. Fill depth follows
// approved spend against the month's busiest day; pending sits under it in amber and credit as
// a "+" line, so a glance shows where the money went and where a decision is still owed.
// Each cell is a real button: pressing one narrows the list below to that day.
import { compactAmount, localDayKey } from '@/lib/suspenseMonthView';
import type { DayTotal } from '@/lib/suspenseMonthView';
import { formatSuspenseAmount } from '@/services/suspenseService';
import { cn } from '@/lib/utils';
import { prettyDay } from '@/components/suspense/shared';
import { heatBucket } from './monthViewFilters';

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

// Spent-only intensity. A day with credit and no spend gets a left rule instead so the two
// never compete on the same axis (both are azure — hue alone cannot tell them apart here).
const FILL: Record<0 | 1 | 2 | 3 | 4, string> = {
  0: 'bg-card',
  1: 'bg-primary/5',
  2: 'bg-primary/10',
  3: 'bg-primary/20',
  4: 'bg-primary/30',
};

export default function DayHeatGrid({ year, month, days, selectedDay, onSelectDay, currency }: {
  year: number;
  month: number;
  days: DayTotal[];
  selectedDay: string;
  onSelectDay: (date: string) => void;
  currency: string;
}) {
  const max   = days.reduce((m, d) => Math.max(m, d.spent), 0);
  const today = localDayKey(Date.now());
  // getDay() is Sunday-first; shift so Monday lands in the first column.
  const lead  = (new Date(year, month - 1, 1).getDay() + 6) % 7;

  return (
    <div>
      <div className="grid grid-cols-7 gap-1">
        {WEEKDAYS.map((w, i) => (
          <div key={i} aria-hidden className="pb-1 text-center text-[10px] font-bold uppercase tracking-widest text-muted-foreground">{w}</div>
        ))}
        {Array.from({ length: lead }).map((_, i) => <div key={`lead-${i}`} aria-hidden />)}
        {days.map(d => {
          const bucket     = heatBucket(d.spent, max);
          const creditOnly = d.spent <= 0 && d.credit > 0;
          const empty      = d.spent <= 0 && d.pending <= 0 && d.credit <= 0;
          const selected   = selectedDay === d.date;
          const isToday    = today === d.date;
          const full = `${prettyDay(d.date)}: spent ${formatSuspenseAmount(d.spent, currency)}, pending ${formatSuspenseAmount(d.pending, currency)}, credit ${formatSuspenseAmount(d.credit, currency)}`;
          return (
            <button
              key={d.date}
              type="button"
              aria-pressed={selected}
              aria-label={full}
              title={`${full}${d.people ? ` · ${d.people} ${d.people === 1 ? 'person' : 'people'}` : ''}`}
              onClick={() => onSelectDay(d.date)}
              className={cn(
                'relative flex min-h-[52px] flex-col items-start rounded-lg border border-border/60 px-1.5 py-1 text-left transition-colors sm:min-h-[60px]',
                'hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                FILL[bucket],
                creditOnly && 'border-l-2 border-l-primary/70',
                isToday && !selected && 'ring-1 ring-primary/50',
                selected && 'ring-2 ring-primary',
              )}
            >
              <span className={cn('text-[10px] leading-none tabular-nums', empty ? 'text-muted-foreground/60' : 'text-muted-foreground')}>{d.day}</span>
              {d.spent > 0 && <span className="mt-1 text-xs font-bold leading-tight tabular-nums text-foreground">{compactAmount(d.spent)}</span>}
              {d.pending > 0 && <span className="text-[10px] leading-tight tabular-nums text-warning">{compactAmount(d.pending)}</span>}
              {d.credit > 0 && <span className="text-[10px] leading-tight tabular-nums text-primary">+{compactAmount(d.credit)}</span>}
            </button>
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
        <span className="inline-flex items-center gap-1"><span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm bg-primary/30" /> spent</span>
        <span className="inline-flex items-center gap-1"><span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm bg-warning/60" /> pending</span>
        <span className="inline-flex items-center gap-1"><span aria-hidden className="inline-block h-2.5 w-0.5 rounded-sm bg-primary/70" /> + credit</span>
        <span className="inline-flex items-center gap-1"><span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm ring-1 ring-primary/50" /> today</span>
      </div>
    </div>
  );
}
