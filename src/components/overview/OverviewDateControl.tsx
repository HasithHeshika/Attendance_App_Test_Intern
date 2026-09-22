'use client';

import { useState, useEffect } from 'react';
import {
  format, addDays, subDays, parseISO,
  startOfMonth, getDaysInMonth, isAfter, startOfDay, getDay,
  addMonths, subMonths,
} from 'date-fns';
import { ChevronLeft, ChevronRight, CalendarDays } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { useT } from '@/store/appStore';

// Per-day attendance summary supplied by the page (from its month load): how many of
// that day's eligible users logged in, plus whose birthday it is.
export interface DayCellInfo {
  present: number;
  total: number;
  onLeave?: number;
  birthdays?: string[];
}

interface OverviewDateControlProps {
  date: string;
  onChange: (date: string) => void;
  maxDate?: string;
  /** Look up the day summary for a calendar cell (null/undefined when not loaded). */
  dayInfo?: (ds: string) => DayCellInfo | null | undefined;
  /** Called when the picker navigates months so the parent can load that month's data. */
  onMonthChange?: (month: Date) => void;
}

export default function OverviewDateControl({ date, onChange, maxDate, dayInfo, onMonthChange }: OverviewDateControlProps) {
  const t = useT();

  // Resolve effective maxDate — defaults to today when omitted
  const effectiveMaxDate = maxDate ?? format(new Date(), 'yyyy-MM-dd');

  // The parsed date objects we work with
  const currentDate = parseISO(date);

  // Calendar popover state
  const [open, setOpen] = useState(false);
  const [calMonth, setCalMonth] = useState(currentDate);

  // Sync popover month to the active date
  useEffect(() => {
    setCalMonth(parseISO(date));
  }, [date]);

  // Whether a date string is after the maxDate
  const isAfterMax = (ds: string) => ds > effectiveMaxDate;

  // Navigate to previous day
  const handlePrev = () => {
    const prev = subDays(currentDate, 1);
    onChange(format(prev, 'yyyy-MM-dd'));
  };

  // Navigate to next day — disabled when already at maxDate
  const handleNext = () => {
    const next = addDays(currentDate, 1);
    const nextStr = format(next, 'yyyy-MM-dd');
    if (nextStr <= effectiveMaxDate) {
      onChange(nextStr);
    }
  };

  // Jump to today
  const handleToday = () => {
    onChange(effectiveMaxDate);
  };

  // Select a day from the calendar grid
  const handleDaySelect = (ds: string) => {
    if (isAfterMax(ds)) return;
    onChange(ds);
    setOpen(false);
  };

  // Calendar grid math — Monday-first week layout (same as overview/page.tsx)
  const daysInMonth = getDaysInMonth(calMonth);
  const firstDayOfWeek = (startOfMonth(calMonth).getDay() + 6) % 7; // 0=Mon…6=Sun

  const isNextDisabled = date >= effectiveMaxDate;

  // Prevent advancing calendar month past maxDate month
  const maxDateParsed = parseISO(effectiveMaxDate);
  const isNextMonthDisabled = isAfter(startOfDay(addMonths(startOfMonth(calMonth), 1)), startOfDay(maxDateParsed));

  return (
    <div className="flex items-center gap-2">
      {/* Previous day */}
      <Button
        variant="outline"
        size="icon-sm"
        onClick={handlePrev}
        aria-label="Previous day"
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>

      {/* Current date label */}
      <span className="text-sm font-semibold text-foreground min-w-[9rem] text-center tabular-nums">
        {format(currentDate, 'EEE, MMM d, yyyy')}
      </span>

      {/* Next day */}
      <Button
        variant="outline"
        size="icon-sm"
        onClick={handleNext}
        disabled={isNextDisabled}
        aria-label="Next day"
      >
        <ChevronRight className="h-4 w-4" />
      </Button>

      {/* Today shortcut */}
      <Button
        variant="outline"
        size="sm"
        onClick={handleToday}
        disabled={date === effectiveMaxDate}
        className="text-xs"
      >
        {t.todayWord}
      </Button>

      {/* Calendar icon — opens popover month picker */}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="icon-sm" aria-label="Open date picker">
            <CalendarDays className="h-4 w-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-3" align="end">
          {/* Month navigation */}
          <div className="flex items-center justify-between mb-2">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setCalMonth(m => { const n = subMonths(m, 1); onMonthChange?.(n); return n; })}
              aria-label="Previous month"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-xs font-semibold text-foreground">
              {format(calMonth, 'MMMM yyyy')}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => { if (!isNextMonthDisabled) setCalMonth(m => { const n = addMonths(m, 1); onMonthChange?.(n); return n; }); }}
              disabled={isNextMonthDisabled}
              aria-label="Next month"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>

          {/* Weekday headers — Monday first */}
          <div className="grid grid-cols-7 mb-1">
            {['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map(d => (
              <div
                key={d}
                className="text-center text-[10px] font-semibold text-muted-foreground pb-1 uppercase tracking-wide"
              >
                {d}
              </div>
            ))}
          </div>

          {/* Day grid */}
          <div className="grid grid-cols-7 gap-0.5">
            {/* Leading empty cells for offset */}
            {Array.from({ length: firstDayOfWeek }).map((_, i) => (
              <div key={`e${i}`} />
            ))}

            {/* Day cells */}
            {Array.from({ length: daysInMonth }, (_, i) => {
              const dayNum = i + 1;
              const ds = `${format(calMonth, 'yyyy-MM')}-${String(dayNum).padStart(2, '0')}`;
              const isSelected = ds === date;
              const isToday = ds === effectiveMaxDate;
              const isFuture = isAfterMax(ds);
              // Attendance summary for the cell: ratio dot (present vs expected) + birthday mark.
              const info = !isFuture ? dayInfo?.(ds) : null;
              const expected = info ? Math.max(1, info.total - (info.onLeave ?? 0)) : 0;
              const ratio = info && info.total > 0 ? info.present / expected : null;
              const dotClass = ratio == null ? null
                : ratio >= 0.8 ? 'bg-success'
                : ratio >= 0.5 ? 'bg-warning'
                : 'bg-destructive';
              const bdays = info?.birthdays ?? [];
              const cellTitle = info && info.total > 0
                ? `${info.present}/${info.total}${bdays.length ? ` · 🎂 ${bdays.join(', ')}` : ''}`
                : undefined;

              return (
                <button
                  key={dayNum}
                  type="button"
                  onClick={() => handleDaySelect(ds)}
                  disabled={isFuture}
                  title={cellTitle}
                  className={[
                    'relative aspect-square flex flex-col items-center justify-center rounded-md text-xs font-medium transition-colors',
                    isSelected
                      ? 'bg-primary text-primary-foreground'
                      : isToday
                        ? 'ring-1 ring-primary text-primary font-semibold hover:bg-accent'
                        : isFuture
                          ? 'text-muted-foreground opacity-30 cursor-not-allowed'
                          : 'hover:bg-accent hover:text-accent-foreground text-foreground',
                  ].join(' ')}
                  aria-label={cellTitle ? `${ds} — ${cellTitle}` : ds}
                  aria-pressed={isSelected}
                >
                  {dayNum}
                  {dotClass && (
                    <span className={`absolute bottom-0.5 h-1 w-1 rounded-full ${isSelected ? 'bg-primary-foreground/80' : dotClass}`} />
                  )}
                  {bdays.length > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 text-[8px] leading-none" aria-hidden>🎂</span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Selected-day summary — X of Y logged in + birthdays */}
          {(() => {
            const info = dayInfo?.(date);
            if (!info || info.total === 0) return null;
            return (
              <div className="mt-2 border-t border-border pt-2 space-y-1">
                <p className="text-[11px] text-muted-foreground">
                  <span className="font-semibold text-foreground">{format(currentDate, 'MMM d')}:</span>{' '}
                  {t.loggedInOf.replace('{a}', String(info.present)).replace('{b}', String(info.total))}
                </p>
                {(info.birthdays?.length ?? 0) > 0 && (
                  <div className="flex items-center gap-1.5 rounded-lg bg-pink-500/10 border border-pink-500/25 px-2 py-1 text-[11px] text-pink-700 dark:text-pink-300 font-medium">
                    <span className="text-xs">🎂</span>
                    <span className="truncate">{info.birthdays!.join(', ')}</span>
                  </div>
                )}
              </div>
            );
          })()}
        </PopoverContent>
      </Popover>
    </div>
  );
}
