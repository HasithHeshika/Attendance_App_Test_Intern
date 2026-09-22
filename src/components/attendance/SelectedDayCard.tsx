'use client';
import { X } from 'lucide-react';
import { AnimatedItem } from '@/components/ui/motion';
import {
  dayMark, formatHours, isHalfDay,
  EXTRA_HOURS_NOTE, SHORT_DAY_NOTE, NO_HOURS_NOTE,
} from './workDayModel';

/* ═══════════════════════════════════════════════════════════════════════════════
   One picked calendar day, summarised directly under the grid it was picked from.

   WHY IT LIVES HERE AND NOT IN THE CHECK-IN SLOT. This panel used to replace
   <TodayCheckInOut/> — the page's one action — and it did so on HOVER, so simply
   moving a pointer across the calendar made "check out" disappear, and a click
   pinned it away until the reader found "Back to today". A readout must never
   evict a control: they answer different questions ("what happened on the 12th?"
   versus "clock me out"), and only one of them is time-critical. It now sits with
   the calendar, which is also where the pointer and the thumb already are.

   Deliberately a summary: it is built entirely from the month data the page
   already holds — hours, worked / leave / holiday flags, edit-request state — so
   picking across a month is instant and costs no reads. The click-through modal
   is where times, locations and edits live, and duplicating those here would mean
   two places to keep true.
   ═══════════════════════════════════════════════════════════════════════════════ */

export interface SelectedDayLabels {
  loggedHours: string;
  halfDay: string;
  leaveDay: string;
  missingCheckout: string;
  editPending: string;
  editApproved: string;
  editRejected: string;
  noDetails: string;
  close: string;
}

export function SelectedDayCard({
  day, hours, worked, onLeave, holidayName, missingCheckout, editState, onClear, labels,
}: {
  day: Date;
  hours?: number;
  worked: boolean;
  onLeave: boolean;
  holidayName: string | null;
  missingCheckout: boolean;
  editState: 'pending' | 'approved' | 'rejected' | null;
  onClear: () => void;
  labels: SelectedDayLabels;
}) {
  const hrs = Number.isFinite(Number(hours)) && Number(hours) > 0 ? Number(hours) : 0;
  const future = day > new Date();
  const mark = dayMark(hrs, day, worked);

  // Chips carry every named fact about the day. Each is distinguished by its WORD first —
  // --success, --primary and --brand all resolve to the same azure in this app, so a tint on
  // its own could never separate "Leave" from "Company holiday".
  const chips: Array<{ label: string; className: string }> = [];
  if (holidayName)     chips.push({ label: holidayName, className: 'border-primary/25 bg-primary/10 text-primary' });
  if (onLeave)         chips.push({ label: labels.leaveDay, className: 'border-brand/25 bg-brand/10 text-brand' });
  if (isHalfDay(day))  chips.push({ label: labels.halfDay, className: 'border-border bg-muted text-muted-foreground' });
  // The same three words the gauge, the hover tooltip and the cell's screen-reader note use —
  // all four come out of the one model, so they cannot drift.
  if (mark.kind === 'over')  chips.push({ label: EXTRA_HOURS_NOTE, className: 'border-border bg-muted text-muted-foreground' });
  if (mark.kind === 'short') chips.push({ label: SHORT_DAY_NOTE,   className: 'border-warning/25 bg-warning/10 text-warning' });
  if (mark.kind === 'empty') chips.push({ label: NO_HOURS_NOTE,    className: 'border-warning/25 bg-warning/10 text-warning' });
  if (missingCheckout) chips.push({ label: labels.missingCheckout, className: 'border-destructive/25 bg-destructive/10 text-destructive' });
  if (editState)       chips.push({
    label: editState === 'pending' ? labels.editPending
         : editState === 'approved' ? labels.editApproved
         : labels.editRejected,
    className: 'border-border bg-muted text-muted-foreground',
  });

  // A future day with no approved leave and no holiday has nothing to report — the calendar
  // knows nothing about tomorrow. Rendering the panel anyway left a date over a bare em dash,
  // and saying "no attendance details found" about a day that has not happened would be a
  // misreport rather than an empty state.
  if (future && hrs === 0 && chips.length === 0) return null;

  return (
    <AnimatedItem className="mt-3">
      <div className="rounded-xl border border-border bg-muted/40 p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-foreground">
              {day.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
            </div>
            {/* One number, because on a past day one number is the whole answer. Hours the
                calendar does not know print as an em dash, never as "0": zero is a claim
                (somebody was here and did nothing) where "unknown" is what is actually known. */}
            <div className="mt-1.5 flex items-baseline gap-1.5">
              <span className={`text-2xl font-bold leading-none tabular-nums ${hrs > 0 ? 'text-foreground' : 'text-muted-foreground'}`}>
                {hrs > 0 ? formatHours(hrs) : '—'}
              </span>
              <span className="text-[11px] text-muted-foreground">
                {hrs > 0 ? labels.loggedHours : future ? '' : chips.length === 0 ? labels.noDetails : ''}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClear}
            aria-label={labels.close}
            className="-mr-1 -mt-1 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {chips.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {chips.map(c => (
              <span key={c.label} className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${c.className}`}>
                {c.label}
              </span>
            ))}
          </div>
        )}
      </div>
    </AnimatedItem>
  );
}
