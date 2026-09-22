'use client';
import { motion, useReducedMotion } from 'framer-motion';

const EASE = [0.22, 1, 0.36, 1] as const;

// Tiny donut/ring chart (no chart library) for a part-to-whole split, e.g. full vs half
// leave days. A faint full-circle track sits behind one accent arc per value (decreasing
// opacity), and the arcs sweep in clockwise on mount. Colour inherits via `currentColor` —
// pass a `text-*` class. An all-zero series shows just the track. Respects reduced-motion.
export default function Donut({
  values, className = 'text-primary', size = 52, stroke = 7,
}: { values: number[]; className?: string; size?: number; stroke?: number }) {
  const reduce = useReducedMotion();
  const total = values.reduce((a, b) => a + (b > 0 ? b : 0), 0);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const cx = size / 2;
  let offset = 0;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}
      className={className} aria-hidden="true">
      {/* track */}
      <circle cx={cx} cy={cx} r={r} fill="none" stroke="currentColor" strokeOpacity={0.12} strokeWidth={stroke} />
      {/* segments (rotate so they start at 12 o'clock) */}
      <g transform={`rotate(-90 ${cx} ${cx})`}>
        {total > 0 && values.map((v, i) => {
          if (v <= 0) return null;
          const len = (v / total) * c;
          const thisOffset = offset;
          offset += len;
          return (
            <motion.circle
              key={i} cx={cx} cy={cx} r={r} fill="none" stroke="currentColor"
              strokeOpacity={i === 0 ? 0.95 : 0.4} strokeWidth={stroke} strokeLinecap="butt"
              strokeDashoffset={-thisOffset}
              initial={reduce ? false : { strokeDasharray: `0 ${c}` }}
              animate={{ strokeDasharray: `${len} ${c - len}` }}
              transition={{ duration: 0.75, ease: EASE, delay: reduce ? 0 : 0.18 + i * 0.14 }}
            />
          );
        })}
      </g>
    </svg>
  );
}
