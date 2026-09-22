'use client';
import { AlertTriangle } from 'lucide-react';
import { formatHours, type MonthStats } from './workDayModel';
import { LEAVE_TINT, LEAVE_RIM, HOLIDAY_TINT, HOLIDAY_RIM } from './dayMarks';

/* ═══════════════════════════════════════════════════════════════════════════════
   The month, read back.

   Sits UNDER the grid, not above it: it is a reading of the month you just scanned,
   and putting it on top would push the calendar — the thing the card is for — below
   the fold on a phone.

   Four figures, no chart. Each answers something a grid of circles cannot: the
   month's total, how many days it took, how much of it was beyond the expectation,
   and how many days fell short. Two columns on a phone rather than four: at ~140px
   per tile the labels stay on one line, where four across forced "Attendance days"
   to wrap to three lines under a one-character figure.

   Hidden entirely when the month failed to load, because zeros would then be a lie
   rather than a fact — that decision belongs to the caller, which is why this
   component renders unconditionally and is simply not mounted on error.
   ═══════════════════════════════════════════════════════════════════════════════ */

export interface MonthSummaryLabels {
  /** "Logged Hours" */
  loggedHours: string;
  /** "Attendance days" */
  daysWorked: string;
  /** Leave — the same word the calendar's day tooltip uses. */
  leaveDay: string;
  /** Public holiday. */
  publicHoliday: string;
  /** Missing checkout. */
  missingCheckout: string;
  /** "Extra hours" — NEVER "Overtime": this app has no overtime pay (CLAUDE.md). */
  extraHours: string;
  /** "Short days" */
  shortDays: string;
}

// NOT "Overtime", anywhere a person can read it. The company pays nothing for hours past the
// expectation, and calling them overtime states a payroll entitlement that does not exist.
// English-only until appStore carries keys for them (see the report note on i18n).

export function MonthSummary({ stats, loading, labels }: {
  stats: MonthStats;
  loading: boolean;
  labels: MonthSummaryLabels;
}) {
  const tiles = [
    { key: 'total', v: formatHours(stats.totalHours), unit: 'h', label: labels.loggedHours },
    { key: 'days',  v: String(stats.daysWorked),      unit: '',  label: labels.daysWorked },
    { key: 'extra', v: formatHours(stats.extraHours), unit: 'h', label: labels.extraHours },
    { key: 'short', v: String(stats.shortDays),       unit: '',  label: labels.shortDays },
  ];

  return (
    <>
      <dl
        aria-busy={loading}
        className={`mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-4 ${loading ? 'opacity-50' : ''}`}
      >
        {tiles.map(tile => (
          // dt before dd in the DOM (the order a definition list requires) but painted the
          // other way up with `order`, so every figure sits on the same line no matter which
          // labels below them wrap to two.
          // gap-px over a bg-border parent draws the dividers — a plain `divide-x` left no
          // rule between the two rows once this wrapped to a 2×2 grid on a phone.
          <div key={tile.key} className="flex flex-col items-center gap-0.5 bg-muted/30 px-1 py-2">
            <dt className="order-2 text-center text-[10px] font-semibold uppercase leading-tight tracking-wide text-muted-foreground">
              {tile.label}
            </dt>
            <dd className="order-1 text-sm font-semibold tabular-nums leading-none text-foreground">
              {tile.v}
              {tile.unit && <span className="ml-0.5 text-[10px] font-medium text-muted-foreground">{tile.unit}</span>}
            </dd>
          </div>
        ))}
      </dl>

      {/* The month's non-working days and its one actionable problem, as counted chips wearing
          the SAME marks the grid uses — so the row doubles as a reminder of what those marks
          mean. Each is dropped entirely at zero rather than shown as "0", which keeps a clean
          month to a single quiet line or to nothing at all. */}
      {(stats.leave > 0 || stats.holidays > 0 || stats.missingCheckouts > 0) && (
        <ul className="mt-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5">
          {stats.leave > 0 && (
            <li className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span aria-hidden="true" className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
                style={{ background: LEAVE_TINT, boxShadow: LEAVE_RIM }} />
              <span className="tabular-nums font-medium text-foreground">{stats.leave}</span>
              <span>{labels.leaveDay}</span>
            </li>
          )}
          {stats.holidays > 0 && (
            <li className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span aria-hidden="true" className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
                style={{ background: HOLIDAY_TINT, boxShadow: HOLIDAY_RIM }} />
              <span className="tabular-nums font-medium text-foreground">{stats.holidays}</span>
              <span>{labels.publicHoliday}</span>
            </li>
          )}
          {stats.missingCheckouts > 0 && (
            <li className="inline-flex items-center gap-1.5 text-[11px] text-warning">
              <AlertTriangle aria-hidden="true" className="h-3 w-3 flex-shrink-0" />
              <span className="tabular-nums font-medium">{stats.missingCheckouts}</span>
              <span>{labels.missingCheckout}</span>
            </li>
          )}
        </ul>
      )}
    </>
  );
}
