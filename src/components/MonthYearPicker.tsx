'use client';
import { useState } from 'react';
import { Calendar, ChevronLeft, ChevronRight } from 'lucide-react';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';

const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTHS_FULL = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

interface Props {
  year: number;
  month: number;        // 1-12
  years: number[];       // allowed years, ascending
  onChange: (year: number, month: number) => void;
  className?: string;
}

// Calendar-style month/year picker: a single trigger ("August 2026") opens a popover with a
// year stepper and a 12-month grid — replaces two separate Year/Month dropdowns with one control.
export default function MonthYearPicker({ year, month, years, onChange, className }: Props) {
  const [open, setOpen]         = useState(false);
  const [viewYear, setViewYear] = useState(year);

  const minYear = years[0];
  const maxYear = years[years.length - 1];

  const handleOpenChange = (o: boolean) => {
    setOpen(o);
    if (o) setViewYear(year);   // re-sync the popover's year to the current selection each time it opens
  };

  const pickMonth = (m: number) => {
    onChange(viewYear, m);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`flex h-11 w-full items-center gap-2 rounded-lg border bg-card px-3.5 text-left text-sm text-foreground transition-colors hover:bg-accent/50 ${
            open ? 'border-primary/50 ring-2 ring-ring ring-offset-1 ring-offset-background' : 'border-border'
          } ${className ?? ''}`}
        >
          <Calendar className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{MONTHS_FULL[month - 1]} {year}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-3">
        <div className="flex items-center justify-between">
          <button
            type="button"
            aria-label="Previous year"
            disabled={viewYear <= minYear}
            onClick={() => setViewYear(y => y - 1)}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="text-sm font-semibold tabular-nums text-foreground">{viewYear}</span>
          <button
            type="button"
            aria-label="Next year"
            disabled={viewYear >= maxYear}
            onClick={() => setViewYear(y => y + 1)}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-1.5">
          {MONTHS_SHORT.map((m, i) => {
            const mm = i + 1;
            const isSelected = viewYear === year && mm === month;
            return (
              <button
                key={m}
                type="button"
                onClick={() => pickMonth(mm)}
                className={`rounded-md py-2 text-sm font-medium transition-colors ${
                  isSelected ? 'bg-primary text-primary-foreground shadow-soft' : 'text-foreground hover:bg-accent'
                }`}
              >
                {m}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
