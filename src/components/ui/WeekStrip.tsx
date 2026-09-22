'use client';
import { useMemo } from 'react';
import { motion, useReducedMotion } from 'framer-motion';

const EASE = [0.22, 1, 0.36, 1] as const;
const pad2 = (n: number) => String(n).padStart(2, '0');
const key = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/**
 * Card 2 micro-graph — the current week at a glance (Mon→Sun), showing hours worked:
 * Fills up vertically like a liquid gauge based on hours worked relative to 8h.
 * Centered hours value inside each chip with automatic high-contrast text color.
 * Weekday initials are localised via Intl. Reduced-motion safe.
 */
export default function WeekStrip({
  workedDates, workedHours = {}, locale = 'en', hideHoursText = false, overtimeHours = null,
}: {
  workedDates: Set<string>;
  workedHours?: Record<string, number>;
  locale?: string;
  hideHoursText?: boolean;
  // Executives meter against a fixed shift: any day over this many hours is "overtime"
  // and painted red. Technicians have no fixed shift → pass null (always blue).
  overtimeHours?: number | null;
}) {
  const reduce = useReducedMotion();

  const days = useMemo(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const dow = (today.getDay() + 6) % 7; // Monday = 0
    const monday = new Date(today); monday.setDate(today.getDate() - dow);
    const fmt = new Intl.DateTimeFormat(locale, { weekday: 'narrow' });
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(monday); d.setDate(monday.getDate() + i);
      const ds = key(d);
      const hours = workedHours[ds] ?? 0;
      return {
        ds,
        initial: fmt.format(d),
        worked: workedDates.has(ds) || hours > 0,
        hours,
        isToday: d.getTime() === today.getTime(),
        isFuture: d.getTime() > today.getTime(),
      };
    });
  }, [workedDates, workedHours, locale]);

  return (
    <div className="flex items-stretch justify-between gap-1.5">
      {days.map((d, i) => {
        const pct = d.hours > 0 ? Math.min(100, Math.round((d.hours / 8) * 100)) : 0;
        // Executive overtime: a day past the shift threshold goes red (fill, ring, label).
        const over = overtimeHours != null && d.hours > overtimeHours;
        return (
          <div key={d.ds} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
            <div
              className={`relative h-8 w-full rounded-lg overflow-hidden border transition-all flex items-center justify-center ${
                d.isToday
                  ? over
                    ? 'ring-2 ring-inset ring-destructive border-destructive bg-muted/20'
                    : 'ring-2 ring-inset ring-primary border-primary bg-muted/20'
                  : d.worked
                  ? over ? 'border-destructive/30 bg-muted/10' : 'border-primary/20 bg-muted/10'
                  : d.isFuture
                  ? 'border-border/30 bg-muted-foreground/5'
                  : 'border-border bg-muted/40'
              }`}
            >
              {/* Liquid fill — pinned to the bottom (no gap), with a rippling wavy surface */}
              {pct > 0 && (
                <motion.div
                  className={`absolute bottom-0 left-0 right-0 origin-bottom ${
                    d.isToday
                      ? over ? 'bg-destructive animate-liquid-wave' : 'bg-primary animate-liquid-wave'
                      : over ? 'bg-destructive/80' : 'bg-primary/75'
                  }`}
                  initial={reduce ? { height: `${pct}%` } : { height: 0 }}
                  animate={{ height: `${pct}%` }}
                  transition={{ duration: 0.6, ease: EASE, delay: reduce ? 0 : 0.1 + i * 0.04 }}
                >
                  {/* Wave crests sit on the liquid surface (top of the fill). They scroll
                      horizontally at two speeds for a layered, watery look; the body below
                      stays solid so the bottom is always filled. */}
                  {d.isToday && (
                    <>
                      <svg
                        aria-hidden viewBox="0 0 40 12" preserveAspectRatio="none" fill="currentColor"
                        className={`absolute -top-[6px] left-0 h-3 w-[200%] opacity-50 animate-wave-x-slow ${over ? 'text-destructive' : 'text-primary'}`}
                      >
                        <path d="M0 9 Q 5 4 10 9 T 20 9 T 30 9 T 40 9 V12 H0 Z" />
                      </svg>
                      <svg
                        aria-hidden viewBox="0 0 40 12" preserveAspectRatio="none" fill="currentColor"
                        className={`absolute -top-[5px] left-0 h-3 w-[200%] animate-wave-x ${over ? 'text-destructive' : 'text-primary'}`}
                      >
                        <path d="M0 8 Q 5 2 10 8 T 20 8 T 30 8 T 40 8 V12 H0 Z" />
                      </svg>
                      <div className="absolute inset-0 bg-gradient-to-r from-transparent via-primary-foreground/30 to-transparent -skew-x-12 animate-liquid-shimmer" />
                    </>
                  )}
                </motion.div>
              )}

              {/* Exact hours text displayed inside the gauge */}
              {d.hours > 0 && !hideHoursText && (
                <span className={`relative z-10 text-[9px] font-bold tabular-nums tracking-tighter ${
                  pct > 50 ? (over ? 'text-destructive-foreground' : 'text-primary-foreground') : 'text-foreground'
                }`}>
                  {d.hours.toFixed(1)}
                </span>
              )}
            </div>
            <span className={`text-[9px] font-semibold tracking-wider ${
              d.isToday ? (over ? 'text-destructive font-bold' : 'text-primary font-bold') : 'text-muted-foreground'
            }`}>
              {d.initial}
            </span>
          </div>
        );
      })}
    </div>
  );
}

