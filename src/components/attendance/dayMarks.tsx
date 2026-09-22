'use client';
import type { DayMark } from './workDayModel';

/* ═══════════════════════════════════════════════════════════════════════════════
   The marks the attendance calendar draws on a day, and the tokens they are made
   of. One module so the grid, the legend and the month summary physically cannot
   drift from each other — the legend swatch is the cell's own <Gauge/> at 20px.
   ═══════════════════════════════════════════════════════════════════════════════ */

// ─── Hours gauge ──────────────────────────────────────────────────────────────
// A worked day wears exactly ONE mark: a gauge around the date number, filled with the hours
// worked against that weekday's expected hours. No disc, no second concentric ring, no
// coloured digit — "this day was worked" is stated once, by the gauge, and the amount is the
// only thing the gauge's shape varies with.
//
// The hierarchy the grid is built around, quietest first:
//   full day     thin closed gauge, emerald held well below full strength   ← ~20 of these
//   extra hours  the same quiet closed gauge, plus one solid bead at its finish line
//   no hours     the gauge's bare track and nothing in it — a conspicuous hollow
//   short day    a heavier amber arc that stops short, leaving an open gap
// Every one of those differs from the others in SHAPE (closed / hollow / broken / beaded), so
// colour is never the only signal — which matters doubly here, because --success, --primary
// and --brand all resolve to the same azure in this app's palette.

// r=11.5 with a 1.75 stroke keeps the whole gauge inside 26px of the 36px cell, so gauges stop
// well short of their neighbours (the grid read cramped when they nearly touched) and never
// collide with the edit-status outline the same cell draws at its 36px rim.
export const RING_R = 11.5;
// A hairline for the twenty ordinary days, and a stroke two thirds heavier for the one or two
// that need finding. That WEIGHT ratio is the hierarchy; the hue difference only confirms it,
// which is why a colour-blind reader still sees which day is the odd one out.
export const RING_WIDTH = 1.5;             // the track, and the ordinary day's arc
export const RING_ATTENTION_WIDTH = 2.5;   // the short-day arc
export const RING_CAP_R = 2.4;             // the bead marking hours past the expectation
// A worked day ALWAYS draws the gauge's empty track, arc or no arc. A day checked in but never
// checked out has zero completed hours and so nothing to fill the gauge with; without the track
// it would carry no mark of its own and read as a day that was never worked. Neutral rather
// than emerald: an empty gauge must not borrow the colour that means "the hours are in".
export const RING_TRACK_STROKE = 'stroke-muted-foreground';
// Strong enough that a gauge with NOTHING in it is still legible as a hollow on a white card
// (slate-500 at 0.28 all but vanished there), weak enough to stay behind the arc that covers it.
export const RING_TRACK_OPACITY = 0.32;
export const RING_ARC_STROKE = 'stroke-emerald-600 dark:stroke-emerald-400';
// Held at half strength so twenty complete gauges recede into texture; the amber runs at full.
// This one number is most of what makes the commonest day the calmest thing on the grid.
export const RING_ARC_OPACITY = 0.5;
// The app's own "needs attention" token, the same hue as the missing-checkout badge — an
// unexplained shortfall belongs to that family, not to a colour of its own.
export const RING_ATTENTION_STROKE = 'stroke-warning';
// The bead is the only mark on the grid drawn at full emerald, and it is 2px wide. That is the
// whole point: significance without a second ring.
export const RING_CAP_FILL = 'fill-emerald-600 dark:fill-emerald-400';

// ─── Non-working days ─────────────────────────────────────────────────────────
// Leave and holidays are drawn as a tinted disc with an inset rim — a FILLED shape, which no
// worked day ever draws. That is what keeps them unmistakably apart from a worked day: fill
// versus gauge, not one green versus another.
// The rim is `boxShadow` and not `border` on purpose: react-day-picker signals keyboard focus
// with `border: var(--rdp-outline)` from a class, and an inline border would silently win over
// it and leave exactly these days with no visible focus ring.
export const LEAVE_TINT   = 'rgba(34,211,238,0.18)';
export const LEAVE_RIM    = 'inset 0 0 0 1.5px rgba(34,211,238,0.9)';
export const LEAVE_INK    = '#22d3ee';
export const HOLIDAY_TINT = 'rgba(167,139,250,0.18)';
export const HOLIDAY_RIM  = 'inset 0 0 0 1.5px rgba(167,139,250,0.9)';
export const HOLIDAY_INK  = '#a78bfa';

/** The three edit-request outlines in the order the legend names them: pending, approved, rejected. */
export const EDIT_RING_COLORS = ['rgba(251,191,36,0.8)', 'rgba(52,211,153,0.8)', 'rgba(239,68,68,0.7)'] as const;

// The swatch is the cell's own gauge shown at 20px instead of 32px, so its radius is the cell's
// and only the strokes are scaled up — otherwise a 1.5px hairline shrinks to under a pixel and
// the key would show something the grid never draws. Both r + stroke/2 and the bead's outer
// edge must stay inside the 32-unit box (11.5 + 2.4 × 1.7 = 15.58 < 16).
export const SWATCH_R = RING_R;
export const SWATCH_STROKE_SCALE = 1.7;

/**
 * The gauge itself — drawn identically for a 36px day cell (r = RING_R, scale 1) and for a
 * 20px legend swatch (r = SWATCH_R, scale 1.7). One component so the key cannot lie.
 *
 * A full-day gauge starts at 12 o'clock and closes there. A half-day (Saturday) gauge is
 * rotated to start at 9 o'clock and sweeps clockwise over the top to 3 o'clock — a semicircle,
 * so a glance says "this day only ever owed half a day" before any colour is read.
 * The bead marking hours past the expectation sits on whichever point is that gauge's finish
 * line: 12 o'clock on a full circle, 3 o'clock on a half one.
 */
export function Gauge({ mark, r, scale }: { mark: DayMark; r: number; scale: number }) {
  const circumference = 2 * Math.PI * r;
  const sweep = mark.half ? circumference / 2 : circumference;
  const arc = sweep * Math.min(1, Math.max(0, mark.fraction));
  const short = mark.kind === 'short';
  return (
    <>
      <g transform={`rotate(${mark.half ? 180 : -90} 16 16)`} fill="none" strokeLinecap="round">
        <circle
          cx="16" cy="16" r={r}
          className={RING_TRACK_STROKE}
          strokeOpacity={RING_TRACK_OPACITY}
          strokeWidth={RING_WIDTH * scale}
          strokeDasharray={`${sweep} ${circumference}`}
        />
        {arc > 0 && (
          <circle
            cx="16" cy="16" r={r}
            className={short ? RING_ATTENTION_STROKE : RING_ARC_STROKE}
            strokeOpacity={short ? 1 : RING_ARC_OPACITY}
            strokeWidth={(short ? RING_ATTENTION_WIDTH : RING_WIDTH) * scale}
            strokeDasharray={`${arc} ${circumference}`}
          />
        )}
      </g>
      {/* Worked a rest day: a DIAMOND at the finish line, where 'over' puts a round bead.
      Two marks that mean different things must differ in shape, not only in position — the
      palette gives no third colour to spend here. */}
      {mark.kind === 'rest' && (
        <rect
          x={(mark.half ? 16 + r : 16) - RING_CAP_R * scale}
          y={(mark.half ? 16 : 16 - r) - RING_CAP_R * scale}
          width={RING_CAP_R * 2 * scale}
          height={RING_CAP_R * 2 * scale}
          transform={`rotate(45 ${mark.half ? 16 + r : 16} ${mark.half ? 16 : 16 - r})`}
          className={RING_CAP_FILL}
          stroke="none"
        />
      )}
      {mark.kind === 'over' && (
        <circle
          cx={mark.half ? 16 + r : 16}
          cy={mark.half ? 16 : 16 - r}
          r={RING_CAP_R * scale}
          className={RING_CAP_FILL}
          stroke="none"
        />
      )}
    </>
  );
}

/** The day cell's gauge, shown at legend size. */
export function RingSwatch({ mark }: { mark: DayMark }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false" className="h-5 w-5 flex-shrink-0">
      <Gauge mark={mark} r={SWATCH_R} scale={SWATCH_STROKE_SCALE} />
    </svg>
  );
}

/**
 * One outline in one colour — what a day carrying that edit status actually wears. The
 * tri-colour swatch this replaces drew a mark the calendar never renders, and could only tell
 * the three states apart by setting each state's NAME in its own colour, which put colour on
 * the words instead of on the swatch where it belongs.
 */
export function EditRingSwatch({ color }: { color: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false" className="h-5 w-5 flex-shrink-0">
      <circle
        cx="16" cy="16" r={SWATCH_R}
        fill="none"
        stroke={color}
        strokeWidth={2 * SWATCH_STROKE_SCALE}
      />
    </svg>
  );
}
