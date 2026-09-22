'use client';
import { useState, type ReactNode } from 'react';
import { AlertTriangle, CalendarOff, ChevronDown } from 'lucide-react';
import type { DayMark } from './workDayModel';
import {
  RingSwatch, EditRingSwatch, EDIT_RING_COLORS,
  LEAVE_TINT, LEAVE_RIM, HOLIDAY_TINT, HOLIDAY_RIM, HOLIDAY_INK,
} from './dayMarks';

/* ═══════════════════════════════════════════════════════════════════════════════
   The calendar's key, behind a disclosure.

   Every day cell already answers "what is this?" in its hover tooltip and in its
   screen-reader note, so a standing key re-explained every marker on the grid to a
   reader who needed none of them, and spent the calendar's own card space doing it.
   Collapsed it costs one line. Opened, the gauge leads — it is the only marker whose
   meaning is a scale rather than a name — and the named markers follow it as flat lists.

   The gauge is SHOWN rather than described: every state it can be in, drawn by the
   same <Gauge/> the day cell draws, so the key physically cannot drift from the grid.
   ═══════════════════════════════════════════════════════════════════════════════ */

const RING_SCALE_HINT =
  'A complete gauge is the day’s expected hours — 8 on Mon–Fri, and 4 on a Saturday, drawn as a half circle because Saturday is a half day. The figure under a date is the hours that day logged; a day with nothing recorded shows no figure at all. An ordinary complete day is left quiet on purpose.';


// `half` is the legend's only piece of licence: the Saturday entry shows a COMPLETE half
// circle, because that is what a normal Saturday looks like in the grid.
const ringScaleFor = (l: CalendarLegendLabels): { tick: string; mark: DayMark }[] => [
  { tick: l.noHours,    mark: { kind: 'empty', fraction: 0,    half: false } },
  { tick: l.short,      mark: { kind: 'short', fraction: 0.55, half: false } },
  { tick: l.fullDay,    mark: { kind: 'full',  fraction: 1,    half: false } },
  { tick: l.extraHours, mark: { kind: 'over',  fraction: 1,    half: false } },
  { tick: l.halfDay,    mark: { kind: 'full',  fraction: 1,    half: true  } },
];

// Every entry is the same shape — a 20px swatch box, then the label — so swatch sizes and
// baselines cannot drift row to row the way they had. A key is a list, so entries are <li>
// and their containers <ul>; Tailwind's preflight already strips the markers.
function LegendItem({ swatch, label }: { swatch: ReactNode; label: string }) {
  return (
    <li className="flex items-center gap-2">
      <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center">{swatch}</span>
      <span className="text-xs leading-snug text-muted-foreground">{label}</span>
    </li>
  );
}

export interface CalendarLegendLabels {
  workedDay: string;
  halfDay: string;
  leaveDay: string;
  publicHoliday: string;
  companyHoliday: string;
  missingCheckout: string;
  selectedToday: string;
  editPending: string;
  editApproved: string;
  editRejected: string;
  /** Gauge scale ticks, and the two prose hints. Previously English literals in this file —
   *  every user-facing string here needs en + si + ta (CLAUDE.md). */
  whatMarksMean: string;
  gaugeHint: string;
  editRingHint: string;
  noHours: string;
  short: string;
  fullDay: string;
  extraHours: string;
}

export function CalendarLegend({ labels }: { labels: CalendarLegendLabels }) {
  const [open, setOpen] = useState(false);
  const RING_SCALE = ringScaleFor(labels);

  return (
    <div className="mt-3 border-t border-border pt-3">
      {/* w-fit because `flex` makes the button block-level: without it the hit area and its
          hover fill would span the whole card. Label is constant across both states — the
          chevron and aria-expanded carry open/shut, and a label that stays put reads as the
          question the panel answers. */}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-controls="calendar-legend-panel"
        className="mx-auto flex w-fit items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <ChevronDown
          aria-hidden="true"
          className={`h-3.5 w-3.5 transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
        />
        {/* "marks", not "colours": half the key is shape — a closed gauge, a broken one, a
            hollow one, a half circle — and colour is deliberately never the only thing
            telling two states apart. */}
        {labels.whatMarksMean}
      </button>

      {/* Wrapper stays mounted so aria-controls always resolves to a real element. */}
      <div id="calendar-legend-panel">
        {open && (
          <div className="mt-3 border-t border-border/60 pt-3">

            {/* The gauge leads — the only marker here whose meaning is a scale rather than a
                name. Its label sits ABOVE it, so the swatches start on the same left edge as
                every entry below and no row is left centred against a two-line neighbour. */}
            <p className="text-xs font-medium text-foreground">{labels.workedDay}</p>
            <ul className="mt-2 flex flex-wrap items-start gap-x-3.5 gap-y-2.5">
              {RING_SCALE.map(step => {
                // The half-circle entry is the only one with a translated name.
                const label = step.mark.half ? labels.halfDay : step.tick;
                return (
                  <li key={label} className="flex w-12 flex-col items-center gap-1">
                    <RingSwatch mark={step.mark} />
                    <span className="text-center text-[10px] leading-tight text-muted-foreground">
                      {label}
                    </span>
                  </li>
                );
              })}
            </ul>
            {/* Visible rather than a title/sr-only aside: a reader who opened a panel headed
                "what do the marks mean?" is already reading. */}
            <p className="mt-2.5 text-[11px] leading-relaxed text-muted-foreground">
              {RING_SCALE_HINT}
            </p>

            {/* The named markers, drawn with the very same tints and rims the day modifiers
                apply, so the key cannot drift from the grid. A closed office is a FILLED disc
                — the one shape no worked day wears — which is what keeps it apart from a
                gauge at a glance. */}
            <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-2 border-t border-border/60 pt-3">
              <LegendItem
                label={labels.leaveDay}
                swatch={<span className="h-5 w-5 rounded-full" style={{ background: LEAVE_TINT, boxShadow: LEAVE_RIM }} />}
              />
              <LegendItem
                label={labels.publicHoliday}
                swatch={<span className="h-5 w-5 rounded-full" style={{ background: HOLIDAY_TINT, boxShadow: HOLIDAY_RIM }} />}
              />
              {/* A company holiday is the same holiday disc PLUS the brand dot the cell draws
                  under the digit — because that is literally what it is. Showing the dot alone
                  described a mark that never appears without the disc behind it. */}
              <LegendItem
                label={labels.companyHoliday}
                swatch={
                  <span className="relative flex h-5 w-5 items-center justify-center rounded-full"
                    style={{ background: HOLIDAY_TINT, boxShadow: HOLIDAY_RIM }}>
                    <CalendarOff className="h-2.5 w-2.5" style={{ color: HOLIDAY_INK }} strokeWidth={2.5} />
                    <span className="absolute -bottom-0.5 left-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-brand ring-1 ring-white/80 dark:ring-black/40" />
                  </span>
                }
              />
              <LegendItem
                label={labels.missingCheckout}
                swatch={
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-amber-500 ring-1 ring-white/80 dark:ring-black/40">
                    <AlertTriangle className="h-3 w-3 text-white" strokeWidth={3} />
                  </span>
                }
              />
              <LegendItem
                label={labels.selectedToday}
                swatch={<span className="h-5 w-5 rounded-full bg-primary" />}
              />
            </ul>

            {/* The edit outlines, kept together: they are the one group that marks a day's rim
                rather than its fill, which is what the sentence explains. */}
            <div className="mt-3 border-t border-border/60 pt-3">
              <ul className="flex flex-wrap gap-x-4 gap-y-2">
                <LegendItem label={labels.editPending}  swatch={<EditRingSwatch color={EDIT_RING_COLORS[0]} />} />
                <LegendItem label={labels.editApproved} swatch={<EditRingSwatch color={EDIT_RING_COLORS[1]} />} />
                <LegendItem label={labels.editRejected} swatch={<EditRingSwatch color={EDIT_RING_COLORS[2]} />} />
              </ul>
              <p className="mt-2.5 text-[11px] leading-relaxed text-muted-foreground">
                {labels.editRingHint}
              </p>
            </div>

          </div>
        )}
      </div>
    </div>
  );
}
