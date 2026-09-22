'use client';
import { motion, useReducedMotion } from 'framer-motion';
import { Cake, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';

// The field behind a greeting. It fills the whole screen, because a greeting IS the whole
// screen now, and it is the main thing telling the three occasions apart: a birthday drops
// confetti under the fireworks, a work anniversary sends slow rings across the field, a special
// day is a quiet sky of sparks. --primary, --brand and --success are all the same azure in this
// theme, so hue can never do that job — shape and movement have to.
//
// Every position here is a constant, never Math.random(). The card re-renders while it is open,
// and a random layout would teleport every piece of confetti each time React came back through.
// Motion is transform/opacity only.
//
// Reduced motion keeps the SHAPES and drops the movement — the treatment is how you tell the
// three apart, so hiding it entirely would take information away, not just decoration. That is
// why each piece of confetti carries a parked position of its own: sixteen of them stacked on
// one line would read as a line ruled across the screen, not as confetti.

export type BackdropOccasion = 'birthday' | 'anniversary' | 'special';

// x = % across the field, p = % down it when parked (reduced motion), d = start delay,
// dur = seconds to fall the whole way.
const CONFETTI = [
  { x: 4,  p: 12, d: 0.0,  dur: 5.2, tone: 'bg-primary' },
  { x: 11, p: 68, d: 1.4,  dur: 6.1, tone: 'bg-warning' },
  { x: 17, p: 34, d: 0.6,  dur: 4.6, tone: 'bg-brand' },
  { x: 24, p: 82, d: 2.1,  dur: 5.7, tone: 'bg-primary' },
  { x: 31, p: 20, d: 0.9,  dur: 6.4, tone: 'bg-warning' },
  { x: 37, p: 55, d: 1.7,  dur: 4.9, tone: 'bg-brand' },
  { x: 44, p: 8,  d: 0.3,  dur: 5.5, tone: 'bg-primary' },
  { x: 50, p: 74, d: 2.4,  dur: 6.0, tone: 'bg-warning' },
  { x: 56, p: 42, d: 1.1,  dur: 4.7, tone: 'bg-brand' },
  { x: 63, p: 88, d: 0.45, dur: 5.9, tone: 'bg-primary' },
  { x: 69, p: 26, d: 1.9,  dur: 6.3, tone: 'bg-warning' },
  { x: 75, p: 60, d: 0.75, dur: 5.0, tone: 'bg-brand' },
  { x: 81, p: 16, d: 2.6,  dur: 5.4, tone: 'bg-primary' },
  { x: 87, p: 78, d: 1.25, dur: 6.2, tone: 'bg-warning' },
  { x: 92, p: 38, d: 0.15, dur: 4.8, tone: 'bg-brand' },
  { x: 96, p: 64, d: 2.0,  dur: 5.6, tone: 'bg-primary' },
];

// 1400px of fall covers a full-screen phone and a laptop alike; the piece is off the bottom
// long before it reaches the end on anything smaller, and the loop simply restarts.
const FALL_DISTANCE = 1400;

/**
 * How strongly a piece paints, by how close to the middle of the field it falls.
 *
 * The card's words are centred, so the pieces at x = 37..63 fall straight down through the
 * name, the message and the signatures. At a flat opacity-60 they stop reading as confetti
 * behind the text and start reading as damage ON it — a blob beside a line of type looks like
 * something failed to load, not like a celebration. It is worse on some tenants than others:
 * `--brand` is overridden per tenant (src/lib/brandColor.ts), so a brand piece can arrive fully
 * saturated against the navy field while its azure and amber neighbours stay soft, and the eye
 * goes straight to it.
 *
 * So the field is dense at the edges and thins toward the middle. Nothing is moved and nothing
 * is removed — the confetti still crosses the whole screen, it just gets out of the way of the
 * words. Opacity rather than a scrim over the centre, because a scrim would flatten the wash
 * that is doing the job of telling the three occasions apart.
 */
const confettiOpacity = (x: number): number => {
  const fromCentre = Math.abs(x - 50) / 50;      // 0 dead centre, 1 at either edge
  return 0.18 + 0.42 * Math.min(1, fromCentre / 0.55);
};

// x/y in percent of the field, so they hold their arrangement at every viewport.
const SPARKS = [
  { x: 8,  y: 14, s: 8,  d: 0.0 },
  { x: 19, y: 38, s: 6,  d: 0.6 },
  { x: 27, y: 72, s: 9,  d: 1.1 },
  { x: 13, y: 58, s: 5,  d: 1.7 },
  { x: 35, y: 22, s: 7,  d: 0.3 },
  { x: 44, y: 84, s: 6,  d: 1.4 },
  { x: 52, y: 12, s: 9,  d: 0.9 },
  { x: 61, y: 46, s: 5,  d: 2.0 },
  { x: 68, y: 76, s: 8,  d: 0.2 },
  { x: 77, y: 20, s: 6,  d: 1.3 },
  { x: 84, y: 62, s: 9,  d: 0.75 },
  { x: 91, y: 32, s: 7,  d: 1.9 },
  { x: 95, y: 80, s: 5,  d: 0.5 },
  { x: 71, y: 8,  s: 6,  d: 2.3 },
];

// A soft field of light in the occasion's own tone. A gradient, not a blurred blob: a 64px
// filter over the whole viewport is real work for a mid-range phone and this costs nothing.
const WASH: Record<BackdropOccasion, string> = {
  birthday:    'radial-gradient(65% 45% at 50% 18%, hsl(var(--primary) / 0.18), transparent 72%)',
  anniversary: 'radial-gradient(58% 42% at 50% 40%, hsl(var(--brand) / 0.16), transparent 70%)',
  special:     'radial-gradient(70% 50% at 50% 26%, hsl(var(--warning) / 0.16), transparent 72%)',
};

export default function GreetingBackdrop({
  occasion, className,
}: {
  occasion: BackdropOccasion;
  className?: string;
}) {
  const reduce = useReducedMotion();
  const loop = (duration: number, delay: number) =>
    reduce ? { duration: 0 } : { duration, delay, repeat: Infinity, ease: 'easeInOut' as const };

  return (
    <div
      aria-hidden
      className={cn(
        // isolate: the decoration must not climb out and paint over the close button.
        'pointer-events-none isolate overflow-hidden',
        className,
      )}
    >
      <div className="absolute inset-0" style={{ background: WASH[occasion] }} />

      {occasion === 'birthday' && CONFETTI.map((c, i) => (
        <motion.span
          key={i}
          className={cn('absolute h-3.5 w-1.5 rounded-full', c.tone)}
          style={{ left: `${c.x}%`, top: reduce ? `${c.p}%` : 0, opacity: confettiOpacity(c.x) }}
          initial={reduce ? { rotate: 24 } : { y: -60, rotate: 0 }}
          animate={reduce ? { rotate: 24 } : { y: FALL_DISTANCE, rotate: 540 }}
          transition={reduce ? { duration: 0 } : { duration: c.dur, delay: c.d, repeat: Infinity, ease: 'linear' }}
        />
      ))}

      {occasion === 'anniversary' && [0, 1, 2].map(i => (
        <motion.span
          key={i}
          className="absolute left-1/2 top-1/2 h-[42vmin] w-[42vmin] rounded-full border border-brand/30"
          // x/y live in the motion style rather than in -translate-x-1/2 classes: framer-motion
          // writes the whole `transform`, so a Tailwind translate on the same element is thrown
          // away the moment the scale animates.
          style={{ x: '-50%', y: '-50%' }}
          initial={reduce ? { scale: 0.9 + i * 0.45, opacity: 0.22 } : { scale: 0.55, opacity: 0.45 }}
          animate={reduce ? { scale: 0.9 + i * 0.45, opacity: 0.22 } : { scale: 2.3, opacity: 0 }}
          transition={loop(4.2, i * 1.4)}
        />
      ))}

      {occasion === 'special' && SPARKS.map((s, i) => (
        <motion.span
          key={i}
          className="absolute rounded-full bg-warning"
          style={{ left: `${s.x}%`, top: `${s.y}%`, height: s.s, width: s.s }}
          // Same reasoning as the confetti: a spark sitting on the centred text reads as a
          // rendering fault. Here the opacity is animated, so the centre factor scales the
          // KEYFRAMES rather than replacing them — a middle spark still breathes, quietly.
          initial={reduce ? { opacity: 0.5 * confettiOpacity(s.x) / 0.6, scale: 1 } : { opacity: 0.15, scale: 0.6 }}
          animate={reduce
            ? { opacity: 0.5 * confettiOpacity(s.x) / 0.6, scale: 1 }
            : { opacity: [0.15, 0.9, 0.15].map(o => o * confettiOpacity(s.x) / 0.6), scale: [0.6, 1.15, 0.6] }}
          transition={loop(2.8, s.d)}
        />
      ))}
    </div>
  );
}

/**
 * The mark at the top of the card — the single shape that says which of the three this is.
 * A birthday gets a cake, a special day gets sparks, and an anniversary gets the year count
 * itself, because the number is the whole point of that card.
 */
export function OccasionMark({
  occasion, years, yearsLabel, className,
}: {
  occasion: BackdropOccasion;
  /** Anniversary only — the number at the centre of the medal. */
  years?: number | null;
  /** Anniversary only — the translated "year" / "years" beneath the number. */
  yearsLabel?: string;
  className?: string;
}) {
  const reduce = useReducedMotion();
  const enter = {
    initial: reduce ? false : { scale: 0.7, opacity: 0 },
    animate: { scale: 1, opacity: 1 },
    transition: reduce ? { duration: 0 } : { type: 'spring' as const, stiffness: 260, damping: 18 },
  };

  if (occasion === 'anniversary') {
    return (
      <motion.div
        {...enter}
        className={cn(
          'flex h-28 w-28 flex-col items-center justify-center rounded-full border-2 border-brand/45 bg-card shadow-popover',
          className,
        )}
      >
        <span className="text-4xl font-bold leading-none tabular-nums text-brand">{years ?? '—'}</span>
        <span className="mt-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          {yearsLabel ?? (years === 1 ? 'year' : 'years')}
        </span>
      </motion.div>
    );
  }

  const birthday = occasion === 'birthday';
  return (
    <motion.div
      {...enter}
      className={cn(
        'flex h-20 w-20 items-center justify-center rounded-[1.75rem] border bg-card shadow-popover',
        birthday ? 'border-primary/30' : 'border-warning/35',
        className,
      )}
    >
      {birthday
        ? <Cake className="h-10 w-10 text-primary" />
        : <Sparkles className="h-10 w-10 text-warning" />}
    </motion.div>
  );
}
