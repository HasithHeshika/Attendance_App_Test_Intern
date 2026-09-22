'use client';
import { useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';

const EASE = [0.22, 1, 0.36, 1] as const;
const DAY_MS = 1000 * 60 * 60;

// Parse the app's "YYYY-MM-DD HH:MM:SS" (local) timestamps safely across engines
// (Safari rejects the space form) — returns null for empty/invalid input.
function parseTs(s?: string | null): number | null {
  if (!s) return null;
  const t = new Date(s.replace(' ', 'T')).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * Card 1 micro-graph — "how far through your working day are you?"
 * A slim meter of time worked today against a standard shift, with the live
 * elapsed duration in mono. Ticks itself once a minute while a session is open
 * (isolated re-render — doesn't touch the rest of the dashboard). Colour inherits
 * via the tone class on the wrapper; the track is neutral. Reduced-motion safe.
 */
export default function DayProgress({
  checkIn, checkOut, sessions, targetHours = 8, className = 'text-primary',
  hShort = 'h', mShort = 'm', showTarget = true,
}: {
  checkIn?: string | null;
  checkOut?: string | null;
  sessions?: any[] | null;
  targetHours?: number;
  className?: string;
  hShort?: string;
  mShort?: string;
  // Executives meter against an 8h shift (marker at 8h + red overtime past it).
  // Technicians have no fixed shift → just the elapsed time, no 8h target.
  showTarget?: boolean;
}) {
  const reduce = useReducedMotion();
  const [now, setNow] = useState(() => Date.now());

  // Determine if there is any active (live) session.
  const hasLiveSession = sessions
    ? sessions.some(s => s.check_in && !s.check_out)
    : (checkIn != null && checkOut == null);

  useEffect(() => {
    if (!hasLiveSession) return;
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [hasLiveSession]);

  const actualSessions = sessions ?? (checkIn ? [{ check_in: checkIn, check_out: checkOut }] : []);

  // Not checked in yet — show a faint, empty track so the card still has a base.
  if (actualSessions.length === 0) {
    return <div className={`h-2 w-full rounded-full bg-current/10 ${className}`} aria-hidden />;
  }

  let elapsedMs = 0;
  for (const s of actualSessions) {
    const start = parseTs(s.check_in);
    if (start == null) continue;
    const end = parseTs(s.check_out);
    elapsedMs += Math.max(0, (end ?? now) - start);
  }

  const h = Math.floor(elapsedMs / DAY_MS);
  const m = Math.floor((elapsedMs % DAY_MS) / 60_000);
  const label = h > 0 ? `${h}${hShort} ${m}${mShort}` : `${m}${mShort}`;

  // Technicians: no fixed shift → just an active bar + the elapsed time (no 8h target).
  if (!showTarget) {
    return (
      <div className={className}>
        <div className="h-2 w-full overflow-hidden rounded-full bg-current/10">
          <motion.div
            className="h-full rounded-full bg-current"
            initial={reduce ? false : { width: 0 }}
            animate={{ width: '100%' }}
            transition={{ duration: 0.7, ease: EASE, delay: reduce ? 0 : 0.1 }}
          />
        </div>
        <div className="mt-1.5">
          <span className="font-mono text-xs font-semibold tabular-nums text-foreground">{label}</span>
        </div>
      </div>
    );
  }

  // Executives: meter against an 8h shift — fill to 8h in the tone colour, a marker line at
  // the 8h mark, and any overtime past 8h drawn in red.
  const targetMs = targetHours * DAY_MS;
  const scaleMs = Math.max(targetMs, elapsedMs);
  const normalFrac = Math.min(elapsedMs, targetMs) / scaleMs;
  const overMs = Math.max(0, elapsedMs - targetMs);
  const redFrac = overMs / scaleMs;
  const markerFrac = targetMs / scaleMs;
  const over = overMs > 0;

  return (
    <div className={className}>
      <div className="relative h-2 w-full overflow-hidden rounded-full bg-current/10">
        <motion.div
          className="absolute left-0 top-0 h-full rounded-full bg-current"
          initial={reduce ? false : { width: 0 }}
          animate={{ width: `${Math.max(normalFrac * 100, 4)}%` }}
          transition={{ duration: 0.7, ease: EASE, delay: reduce ? 0 : 0.1 }}
        />
        {over && (
          <motion.div
            className="absolute top-0 h-full bg-destructive"
            style={{ left: `${normalFrac * 100}%` }}
            initial={reduce ? false : { width: 0 }}
            animate={{ width: `${redFrac * 100}%` }}
            transition={{ duration: 0.7, ease: EASE, delay: reduce ? 0 : 0.2 }}
          />
        )}
        {/* 8-hour shift marker */}
        <div
          className="absolute top-0 h-full w-[2px] -translate-x-1/2 bg-foreground/60"
          style={{ left: `${markerFrac * 100}%` }}
          aria-hidden
        />
      </div>
      <div className="mt-1.5 flex items-baseline justify-between">
        <span className={`font-mono text-xs font-semibold tabular-nums ${over ? 'text-destructive' : 'text-foreground'}`}>{label}</span>
        <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
          / {targetHours}{hShort}
        </span>
      </div>
    </div>
  );
}
