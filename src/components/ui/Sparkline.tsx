'use client';
import { motion, useReducedMotion } from 'framer-motion';

const EASE = [0.22, 1, 0.36, 1] as const;

// Tiny bar sparkline (no chart library). One bar per value, scaled to the series max; zero
// values show a faint baseline tick. Bars grow up from the baseline, staggered left→right,
// and the most recent bar (today) gets a soft highlight. Colour is inherited via
// `currentColor` — pass a `text-*` class. Respects prefers-reduced-motion.
export default function Sparkline({
  values, height = 28, className = 'text-primary',
}: { values: number[]; height?: number; className?: string }) {
  const reduce = useReducedMotion();
  if (!values.length) return null;
  const max = Math.max(...values, 1);
  const n = values.length;
  const slot = 100 / n;
  const bw = Math.max(slot * 0.6, 1.2);
  // Index of the last non-zero bar — the "today/most recent" accent.
  const lastActive = values.reduce((acc, v, i) => (v > 0 ? i : acc), -1);

  return (
    <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none"
      className={`w-full ${className}`} style={{ height }} aria-hidden="true">
      {values.map((v, i) => {
        const h = (v / max) * (height - 2);
        const barH = v > 0 ? Math.max(h, 2) : 1.5;
        const x = i * slot + (slot - bw) / 2;
        const y = height - barH;
        const baseOpacity = v > 0 ? (i === lastActive ? 1 : 0.8) : 0.2;
        return (
          <motion.rect
            key={i}
            x={x} y={y} width={bw} height={barH} rx={0.9}
            fill="currentColor"
            style={{ transformBox: 'fill-box', transformOrigin: 'center bottom' }}
            initial={reduce ? false : { scaleY: 0, opacity: 0 }}
            animate={{ scaleY: 1, opacity: baseOpacity }}
            transition={{ duration: 0.5, ease: EASE, delay: reduce ? 0 : 0.12 + i * 0.028 }}
          />
        );
      })}
    </svg>
  );
}
